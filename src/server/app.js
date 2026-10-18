import express from "express";

import { createNoiseConfig } from "../demos/noise.js";
import {
  createRunManager,
  RunManagerError,
} from "./run-manager.js";
import {
  createTargetMapFromEnvironment,
  PUBLIC_TARGET_LABELS,
  TARGET_IDS,
} from "./targets.js";

const API_ERROR_MESSAGES = Object.freeze({
  "active-run-limit": "Too many scans are running",
  "body-too-large": "Request body is too large",
  "internal-error": "Internal server error",
  "invalid-json": "Request body must contain valid JSON",
  "invalid-scan-request": "Scan request is invalid",
  "rate-limit-exceeded": "Scan start rate limit exceeded",
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

export function createWebApp({ environment = process.env, managerOptions = {} } = {}) {
  const targetMap = createTargetMapFromEnvironment(environment);
  const trustProxyHops = parseTrustProxyHops(environment);
  const publicMetadata = Object.freeze({
    noisePresets: createPublicNoiseMetadata(environment),
    targets: createPublicTargetMetadata(),
  });
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

  app.use("/api", (_request, response) => {
    response.status(404).json(createErrorBody("invalid-scan-request"));
  });
  app.use("/api", handleApiError);

  return app;
}

export { parseTrustProxyHops };
