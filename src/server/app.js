import express from "express";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { createNoiseConfig } from "../demos/noise.js";
import {
  createRunManager,
  MAX_SSE_CONNECTIONS,
  DEFAULT_SSE_KEEPALIVE_MS,
  RunManagerError,
} from "./run-manager.js";
import {
  createTargetMapFromEnvironment,
  PUBLIC_TARGET_LABELS,
  TARGET_IDS,
} from "./targets.js";
import { validateBenchmarkArtifact } from "./benchmark-results.js";

const API_ERROR_MESSAGES = Object.freeze({
  "active-run-limit": "Too many scans are running",
  "body-too-large": "Request body is too large",
  "internal-error": "Internal server error",
  "invalid-json": "Request body must contain valid JSON",
  "invalid-run-id": "Scan ID is invalid",
  "invalid-scan-request": "Scan request is invalid",
  "rate-limit-exceeded": "Scan start rate limit exceeded",
  "report-expired": "Scan report has expired",
  "run-not-found": "Scan run was not found",
  "sse-connection-limit": "Too many live scan connections",
});
const API_SCAN_FIELDS = Object.freeze(["noisePresetId", "targetId"]);
const API_SCAN_FIELD_SET = new Set(API_SCAN_FIELDS);
const UNSAFE_SCAN_FIELDS = new Set(["__proto__", "constructor", "prototype"]);
const NOISE_PRESET_LABELS = Object.freeze({
  high: "High noise",
  low: "Low noise",
  none: "No noise",
});
const SCAN_BODY_LIMIT = "1kb";
const RUN_ID_PATTERN = /^run-[0-9]+$/;
const SSE_KEEPALIVE_MS = DEFAULT_SSE_KEEPALIVE_MS;
const TERMINAL_SSE_EVENTS = new Set(["scan:complete", "scan:error", "scan:expired"]);
const PUBLIC_DIRECTORY = fileURLToPath(new URL("../../public/", import.meta.url));
const BENCHMARK_PAGE = fileURLToPath(new URL("../../public/benchmarks.html", import.meta.url));
const BENCHMARK_RESULTS = fileURLToPath(new URL("../../bench/results.json", import.meta.url));
const DASHBOARD_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

class ApiError extends Error {
  constructor(code, statusCode) {
    super(API_ERROR_MESSAGES[code] ?? API_ERROR_MESSAGES["internal-error"]);
    this.code = code;
    this.statusCode = statusCode;
  }
}

function createErrorBody(code) {
  return {
    error: {
      code,
      message: API_ERROR_MESSAGES[code],
    },
  };
}

function createPublicTargetMetadata() {
  return Object.freeze(TARGET_IDS.map((id) => Object.freeze({
    id,
    label: PUBLIC_TARGET_LABELS[id],
  })));
}

function createPublicNoiseMetadata(environment) {
  // Validate only the configured preset; seed and jitter are demo-process details.
  const preset = createNoiseConfig({
    presetId: environment.DEMO_NOISE_PRESET ?? "none",
  });
  return Object.freeze([Object.freeze({
    id: preset.presetId,
    label: NOISE_PRESET_LABELS[preset.presetId],
  })]);
}

function validateScanRequest(request) {
  if (request.is("application/json") !== "application/json") {
    throw new ApiError("invalid-scan-request", 400);
  }

  const body = request.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ApiError("invalid-scan-request", 400);
  }

  const keys = Object.keys(body);
  if (keys.length !== API_SCAN_FIELDS.length
    || keys.some((key) => UNSAFE_SCAN_FIELDS.has(key))
    || keys.some((key) => !API_SCAN_FIELD_SET.has(key))) {
    throw new ApiError("invalid-scan-request", 400);
  }

  if (typeof body.targetId !== "string" || typeof body.noisePresetId !== "string") {
    throw new ApiError("invalid-scan-request", 400);
  }

  return body;
}

function handleApiError(error, _request, response, _next) {
  if (response.headersSent) {
    response.end();
    return;
  }

  if (error?.type === "entity.too.large") {
    response.status(413).json(createErrorBody("body-too-large"));
    return;
  }
  if (error?.type === "entity.parse.failed") {
    response.status(400).json(createErrorBody("invalid-json"));
    return;
  }
  if (error instanceof ApiError) {
    response.status(error.statusCode).json(createErrorBody(error.code));
    return;
  }
  if (error instanceof RunManagerError && API_ERROR_MESSAGES[error.code] !== undefined) {
    response.status(error.statusCode).json(createErrorBody(error.code));
    return;
  }
  response.status(500).json(createErrorBody("internal-error"));
}

function parseTrustProxyHops(environment) {
  const raw = environment.TRUST_PROXY_HOPS ?? "0";
  if (!/^[0-9]+$/.test(String(raw))) {
    throw new TypeError("TRUST_PROXY_HOPS must be a non-negative integer");
  }
  const hops = Number(raw);
  if (!Number.isSafeInteger(hops)) {
    throw new TypeError("TRUST_PROXY_HOPS must be a safe integer");
  }
  return hops;
}

function validateRunId(runId) {
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new ApiError("invalid-run-id", 400);
  }
  return runId;
}

function setSseHeaders(response) {
  response.status(200).set({
    "Cache-Control": "no-cache, no-store, no-transform",
    Connection: "keep-alive",
    "Content-Type": "text/event-stream; charset=utf-8",
    "X-Accel-Buffering": "no",
  });
  if (typeof response.flushHeaders === "function") {
    response.flushHeaders();
  }
}

function canWriteSse(response) {
  return !response.destroyed && !response.writableEnded;
}

function setPublicHeaders(response) {
  response.set({
    "Cache-Control": "no-store",
    "Content-Security-Policy": DASHBOARD_CSP,
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  });
}

function benchmarkUnavailable(response) {
  response.status(404).set({
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  }).json({
    error: {
      code: "benchmark-data-unavailable",
      message: "Benchmark data is not available",
    },
  });
}

export function writeSseEvent(response, event, payload) {
  if (!canWriteSse(response)) {
    return false;
  }
  try {
    return response.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`) !== false;
  } catch {
    return false;
  }
}

export function writeSseComment(response, comment = "keepalive") {
  if (!canWriteSse(response)) {
    return false;
  }
  try {
    return response.write(`: ${comment}\n\n`) !== false;
  } catch {
    return false;
  }
}

export function createWebApp({ environment = process.env, managerOptions = {} } = {}) {
  const targetMap = createTargetMapFromEnvironment(environment);
  const trustProxyHops = parseTrustProxyHops(environment);
  const publicMetadata = Object.freeze({
    noisePresets: createPublicNoiseMetadata(environment),
    targets: createPublicTargetMetadata(),
  });
  const sseScheduler = managerOptions.scheduler ?? { clearTimeout, setTimeout };
  let sseConnectionCount = 0;
  const app = express();
  app.disable("x-powered-by");
  // Only Express's trusted-hop parser may use forwarded headers; routes read req.ip.
  app.set("trust proxy", trustProxyHops > 0 ? trustProxyHops : false);
  app.locals.demoTargets = targetMap;
  app.locals.publicMetadata = publicMetadata;
  app.locals.runManager = createRunManager({
    ...managerOptions,
    environment,
    noisePresetIds: publicMetadata.noisePresets.map(({ id }) => id),
    targetMap,
    trustProxyHops,
  });

  app.use("/api", (_request, response, next) => {
    response.set("Cache-Control", "no-store");
    next();
  });

  app.get("/healthz", (_request, response) => {
    response.json({ status: "ok" });
  });

  app.get("/api/targets", (_request, response) => {
    response.json(publicMetadata);
  });

  app.post(
    "/api/scans",
    express.json({ limit: SCAN_BODY_LIMIT, strict: true, type: "application/json" }),
    (request, response, next) => {
      try {
        const { noisePresetId, targetId } = validateScanRequest(request);
        const validTarget = Object.hasOwn(targetMap, targetId) ? targetMap[targetId] : undefined;
        const validPreset = publicMetadata.noisePresets.find(
          (preset) => preset.id === noisePresetId,
        );
        if (!validTarget || !validPreset) {
          throw new ApiError("invalid-scan-request", 400);
        }

        const run = app.locals.runManager.start({
          clientKey: request.ip,
          noisePresetId,
          targetId,
        });
        response.status(202).json(run);
      } catch (error) {
        next(error);
      }
    },
  );

  app.get("/api/scans/:runId", (request, response, next) => {
    try {
      const runId = validateRunId(request.params.runId);
      const snapshot = app.locals.runManager.getSnapshot(runId);
      if (!snapshot) {
        throw new ApiError("run-not-found", 404);
      }
      response.json(snapshot);
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/scans/:runId/report", (request, response, next) => {
    try {
      const runId = request.params.runId;
      if (RUN_ID_PATTERN.exec(runId)?.[0] !== runId) {
        throw new ApiError("run-not-found", 404);
      }
      const report = app.locals.runManager.getReport(runId);
      if (!report) {
        const snapshot = app.locals.runManager.getSnapshot(runId);
        if (snapshot?.status === "expired") {
          throw new ApiError("report-expired", 410);
        }
        throw new ApiError("run-not-found", 404);
      }
      response.set("Cache-Control", "no-store");
      response.attachment("timing-leak-report.json");
      response.type("application/json").json(report);
    } catch (error) {
      next(error);
    }
  });

  // Do not put compression middleware before this route: buffering/compressing
  // an SSE stream prevents timely progress delivery and keepalive comments.
  app.get("/api/scans/:runId/events", (request, response, next) => {
    let subscription;
    let keepaliveTimer;
    let cleaned = false;
    let connected = false;

    const cleanup = (terminal = false) => {
      if (cleaned) {
        return;
      }
      cleaned = true;
      if (keepaliveTimer !== undefined) {
        sseScheduler.clearTimeout(keepaliveTimer);
        keepaliveTimer = undefined;
      }
      sseConnectionCount -= 1;
      connected = false;
      if (!terminal) {
        subscription?.unsubscribe();
      }
    };

    const onEvent = (event, payload) => {
      if (!writeSseEvent(response, event, payload)) {
        cleanup();
        if (!response.destroyed && !response.writableEnded) {
          response.destroy();
        }
        return;
      }
      if (TERMINAL_SSE_EVENTS.has(event)) {
        cleanup(true);
        if (!response.writableEnded) {
          response.end();
        }
      }
    };

    try {
      const runId = validateRunId(request.params.runId);
      const snapshot = app.locals.runManager.getSnapshot(runId);
      if (!snapshot) {
        throw new ApiError("run-not-found", 404);
      }
      if (sseConnectionCount >= MAX_SSE_CONNECTIONS) {
        throw new ApiError("sse-connection-limit", 429);
      }

      setSseHeaders(response);
      sseConnectionCount += 1;
      connected = true;
      response.once("close", () => cleanup());
      response.once("error", () => cleanup());
      request.once("aborted", () => cleanup());
      subscription = app.locals.runManager.subscribe(runId, onEvent);
      if (cleaned) {
        subscription?.unsubscribe();
      }
      if (!subscription) {
        cleanup();
        if (!response.writableEnded) {
          response.end();
        }
        return;
      }

      const scheduleKeepalive = () => {
        if (cleaned) {
          return;
        }
        keepaliveTimer = sseScheduler.setTimeout(() => {
          keepaliveTimer = undefined;
          if (!writeSseComment(response)) {
            cleanup();
            if (!response.destroyed && !response.writableEnded) {
              response.destroy();
            }
            return;
          }
          scheduleKeepalive();
        }, SSE_KEEPALIVE_MS);
      };
      scheduleKeepalive();
    } catch (error) {
      if (connected && !cleaned) {
        cleanup();
      }
      next(error);
    }
  });

  app.use("/api", (_request, response) => {
    response.status(404).json(createErrorBody("invalid-scan-request"));
  });
  app.use("/api", handleApiError);

  app.get("/bench/results.json", async (_request, response) => {
    try {
      const contents = await readFile(BENCHMARK_RESULTS, "utf8");
      const results = JSON.parse(contents);
      validateBenchmarkArtifact(results);
      response.set({
        "Cache-Control": "no-store",
        "Content-Type": "application/json; charset=utf-8",
        "X-Content-Type-Options": "nosniff",
      });
      response.send(JSON.stringify(results));
    } catch {
      benchmarkUnavailable(response);
    }
  });

  app.get("/benchmarks", (_request, response, next) => {
    setPublicHeaders(response);
    response.sendFile(BENCHMARK_PAGE, (error) => {
      if (error) {
        next(error);
      }
    });
  });

  // Keep static serving after the explicit API and health routes so it cannot
  // intercept them. Express's static middleware has no directory listing;
  // ignored dotfiles and safe fallthrough preserve the existing 404 behavior.
  app.use(express.static(PUBLIC_DIRECTORY, {
    dotfiles: "ignore",
    fallthrough: true,
    index: "index.html",
    redirect: false,
    setHeaders: setPublicHeaders,
  }));

  return app;
}

export { parseTrustProxyHops };
