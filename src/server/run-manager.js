import { createSeededPrng } from "../prng.js";
import { buildRequests } from "../http/request.js";
import { createNoiseConfig } from "../demos/noise.js";

export const RUN_SEED_DOMAIN = "web-scan-run";
export const SERVER_SCAN_SEED = "web-scan-seed";
export const WEB_DETECTOR_CONFIG_STATUS = "TBD";

// These are operational rule inputs, not measured performance claims. Their
// calibration remains TBD until the real benchmark task records evidence.
// For the mathematical best case of 8 perfectly separated A/B samples, the
// current continuity-corrected two-sided U rule gives p=0.0009391056991171899;
// with two looks, alphaAtLook=0.05/2=0.025. This is not benchmark evidence.
export const WEB_DETECTOR_CONFIG = Object.freeze({
  alphaTotal: 0.05,
  bootstrapReplicates: 100,
  lookBatchPerGroup: 4,
  materialDiscardRateDifference: 0.2,
  maxAttempts: 20,
  maxConsecutiveFailures: 3,
  maxDiscardRate: 0.5,
  maxValidPerGroup: 8,
  minAttemptsForDiscardRate: 2,
  minValidPerGroup: 4,
  quantile: 0.1,
  targetPower: 0.8,
});

export const DEFAULT_MAX_RUN_DURATION_MS = 30_000;
export const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;
export const MAX_MAX_RUN_DURATION_MS = 120_000;
export const MAX_REQUEST_TIMEOUT_MS = 30_000;
export const DEFAULT_REPORT_RETENTION_MS = 60_000;
export const DEFAULT_RATE_WINDOW_MS = 60_000;
export const DEFAULT_STARTS_PER_WINDOW = 3;
export const DEFAULT_ACTIVE_PER_CLIENT = 1;
export const DEFAULT_ACTIVE_RUNS_WITH_TRUSTED_CLIENT_IP = 2;
// With TRUST_PROXY_HOPS=0, a reverse proxy can make different visitors share
// req.ip. Keep the global cap at three as the bounded fallback; the per-client
// cap remains one, so a shared proxy bucket is intentionally conservative until
// TRUST_PROXY_HOPS is configured for the real ingress.
export const DEFAULT_ACTIVE_RUNS_WITH_SHARED_CLIENT_IP = 3;
export const MAX_RATE_LIMIT_KEYS = 1_000;
export const MAX_RETAINED_RUNS = 64;
export const HISTOGRAM_BIN_LIMIT = 64;

export const RUN_FAILURE_CODE = Object.freeze({
  DETECTOR_FAILED: "detector-failed",
  INTERNAL_FAILED: "internal-failed",
  REPORT_BUILD_FAILED: "report-build-failed",
  RUN_TIMEOUT: "run-timeout",
});

const REQUEST_TEMPLATE_IDS = Object.freeze({
  a: "demo-known-user",
  b: "demo-missing-user",
});

async function defaultDetectorRunner(options) {
  const { runDetector } = await import("../detector/index.js");
  return runDetector(options);
}

async function defaultReportBuilder(options) {
  const { createRunReport } = await import("../report/index.js");
  return createRunReport(options);
}

async function defaultReportValidator(report) {
  const { validateRunReport } = await import("../report/index.js");
  return validateRunReport(report);
}

function createLazyDefaultTransport({ dispatcher, timeoutMs }) {
  let ownedDispatcher = dispatcher;
  let transportPromise;

  async function ensureTransport() {
    if (!transportPromise) {
      transportPromise = (async () => {
        const [{ Agent }, { createHttpTransport }] = await Promise.all([
          import("undici"),
          import("../http/transport.js"),
        ]);
        ownedDispatcher ??= new Agent({ connections: 1 });
        return createHttpTransport({ dispatcher: ownedDispatcher, timeoutMs });
      })();
    }
    return transportPromise;
  }

  return {
    send: (...args) => ensureTransport().then((transport) => transport.send(...args)),
    close: async () => {
      if (!transportPromise) {
        return;
      }
      await transportPromise;
      if (ownedDispatcher && typeof ownedDispatcher.close === "function") {
        await ownedDispatcher.close();
      }
    },
  };
}

export class RunManagerError extends Error {
  constructor(code, statusCode = 429) {
    super(code);
    this.code = code;
    this.statusCode = statusCode;
    this.name = "RunManagerError";
  }
}

function assertFunction(value, name) {
  if (typeof value !== "function") {
    throw new TypeError(`${name} must be a function`);
  }
}

function parseBoundedInteger(value, name, maximum) {
  const text = String(value);
  if (!/^[0-9]+$/.test(text)) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new TypeError(`${name} must be between 1 and ${maximum}`);
  }
  return parsed;
}

function resolveDuration(environment, option, name, defaultValue, maximum) {
  if (option !== undefined) {
    return parseBoundedInteger(option, name, maximum);
  }
  return parseBoundedInteger(environment[name] ?? defaultValue, name, maximum);
}

function validateNonNegativeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function validatePositiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function validateTargetMap(targetMap) {
  if (!targetMap || typeof targetMap !== "object" || Array.isArray(targetMap)) {
    throw new TypeError("targetMap must be an object");
  }
}

function normalizeClientKey(clientKey) {
  return typeof clientKey === "string" && clientKey.length > 0 ? clientKey : "unknown";
}

function createDefaultScheduler() {
  return {
    clearTimeout,
    setTimeout,
  };
}

function createRateLimiter({ limit, maxKeys, now, windowMs }) {
  const timestamps = new Map();

  function prune(currentTime) {
    for (const [key, entries] of timestamps) {
      const recent = entries.filter((timestamp) => currentTime - timestamp < windowMs);
      if (recent.length === 0) {
        timestamps.delete(key);
      } else {
        timestamps.set(key, recent);
      }
    }
  }

  function boundKeys() {
    while (timestamps.size > maxKeys) {
      const oldestKey = timestamps.keys().next().value;
      timestamps.delete(oldestKey);
    }
  }

  function tryAcquire(key, currentTime) {
    prune(currentTime);
    const entries = timestamps.get(key) ?? [];
    if (entries.length >= limit) {
      return false;
    }
    entries.push(currentTime);
    timestamps.set(key, entries);
    boundKeys();
    return true;
  }

  return {
    keyCount: () => timestamps.size,
    prune,
    tryAcquire,
  };
}

function createDemoRequests(targetMap, targetId) {
  const target = Object.hasOwn(targetMap, targetId) ? targetMap[targetId] : undefined;
  if (!target) {
    throw new RunManagerError("invalid-scan-request", 400);
  }
  const baseUrl = `http://${target.host}:${target.port}`;
  return buildRequests({
    a: {
      body: {
        type: "json",
        value: { password: "demo-password", username: "known-user" },
      },
      url: `${baseUrl}/login`,
    },
    b: {
      body: {
        type: "json",
        value: { password: "demo-password", username: "missing-user" },
      },
      url: `${baseUrl}/login`,
    },
    headers: { "content-type": "application/json" },
    method: "POST",
  });
}

function timestampFrom(now) {
  return new Date(now()).toISOString();
}

function copyPublicRecord(record) {
  return {
    expiresAt: record.expiresAt ?? null,
    failureCode: record.failureCode,
    progress: record.progress,
    report: record.report,
    runId: record.runId,
    status: record.status,
    targetId: record.targetId,
    noisePresetId: record.noisePresetId,
    seed: record.seed,
  };
}

export function createRunManager({
  activePerClient = DEFAULT_ACTIVE_PER_CLIENT,
  activeRuns,
  agentFactory = () => undefined,
  detectorRunner = defaultDetectorRunner,
  environment = process.env,
  maxRunDurationMs,
  noisePresetIds = ["none"],
  now = () => Date.now(),
  reportBuilder = defaultReportBuilder,
  reportValidator = defaultReportValidator,
  reportRetentionMs = DEFAULT_REPORT_RETENTION_MS,
  maxRetainedRuns = MAX_RETAINED_RUNS,
  requestTimeoutMs,
  scheduler = createDefaultScheduler(),
  startsPerWindow = DEFAULT_STARTS_PER_WINDOW,
  targetMap,
  transportFactory = ({ dispatcher, timeoutMs }) => {
    return createLazyDefaultTransport({ dispatcher, timeoutMs });
  },
  trustProxyHops = 0,
  rateWindowMs = DEFAULT_RATE_WINDOW_MS,
  serverSeed = environment.SCAN_SEED ?? SERVER_SCAN_SEED,
} = {}) {
  validateTargetMap(targetMap);
  assertFunction(detectorRunner, "detectorRunner");
  assertFunction(reportBuilder, "reportBuilder");
  assertFunction(reportValidator, "reportValidator");
  assertFunction(agentFactory, "agentFactory");
  assertFunction(transportFactory, "transportFactory");
  assertFunction(now, "now");
  if (!scheduler || typeof scheduler !== "object") {
    throw new TypeError("scheduler must be an object");
  }
  assertFunction(scheduler.setTimeout, "scheduler.setTimeout");
  assertFunction(scheduler.clearTimeout, "scheduler.clearTimeout");
  validateNonNegativeInteger(trustProxyHops, "trustProxyHops");
  const resolvedMaxRunDurationMs = resolveDuration(
    environment,
    maxRunDurationMs,
    "SCAN_MAX_DURATION_MS",
    DEFAULT_MAX_RUN_DURATION_MS,
    MAX_MAX_RUN_DURATION_MS,
  );
  const resolvedRequestTimeoutMs = resolveDuration(
    environment,
    requestTimeoutMs,
    "SCAN_REQUEST_TIMEOUT_MS",
    DEFAULT_REQUEST_TIMEOUT_MS,
    MAX_REQUEST_TIMEOUT_MS,
  );
  const resolvedRetentionMs = validatePositiveInteger(reportRetentionMs, "reportRetentionMs");
  const resolvedMaxRetainedRuns = validatePositiveInteger(maxRetainedRuns, "maxRetainedRuns");
  const resolvedRateWindowMs = validatePositiveInteger(rateWindowMs, "rateWindowMs");
  const resolvedStartsPerWindow = validatePositiveInteger(startsPerWindow, "startsPerWindow");
  const resolvedActivePerClient = validatePositiveInteger(activePerClient, "activePerClient");
  const resolvedActiveRuns = validatePositiveInteger(
    activeRuns ?? (trustProxyHops === 0
      ? DEFAULT_ACTIVE_RUNS_WITH_SHARED_CLIENT_IP
      : DEFAULT_ACTIVE_RUNS_WITH_TRUSTED_CLIENT_IP),
    "activeRuns",
  );
  if (!Array.isArray(noisePresetIds) || noisePresetIds.length === 0
    || noisePresetIds.some((id) => typeof id !== "string" || id.length === 0)) {
    throw new TypeError("noisePresetIds must contain non-empty strings");
  }
  if (!(typeof serverSeed === "string" || Number.isSafeInteger(serverSeed))) {
    throw new TypeError("serverSeed must be a string or safe integer");
  }

  const dispatcher = agentFactory();
  const transport = transportFactory({
    dispatcher,
    timeoutMs: resolvedRequestTimeoutMs,
  });
  if (!transport || typeof transport.send !== "function") {
    throw new TypeError("transportFactory must return a send function");
  }

  const runs = new Map();
  const retained = new Map();
  const activeClientCounts = new Map();
  const executions = new Set();
  const executionsByRunId = new Map();
  const rateLimiter = createRateLimiter({
    limit: resolvedStartsPerWindow,
    maxKeys: MAX_RATE_LIMIT_KEYS,
    now,
    windowMs: resolvedRateWindowMs,
  });
  const seedStream = createSeededPrng(JSON.stringify([
    "black-box-timing-leak-detector",
    RUN_SEED_DOMAIN,
    serverSeed,
  ]));
  let nextRunNumber = 1;
  let nextSeedCounter = 1;
  let closing = false;
  let resourcesClosed = false;
  let shutdownPromise;

  function currentTime() {
    const value = now();
    if (!Number.isFinite(value)) {
      throw new TypeError("now must return a finite number");
    }
    return value;
  }

  function allocateRunId() {
    const runNumber = nextRunNumber;
    nextRunNumber += 1;
    return `run-${String(runNumber).padStart(4, "0")}`;
  }

  function allocateRunSeed() {
    const counter = nextSeedCounter;
    nextSeedCounter += 1;
    const draw = seedStream.nextUint32().toString(16).padStart(8, "0");
    return `${RUN_SEED_DOMAIN}-${counter}-${draw}`;
  }

  function incrementClient(clientKey) {
    activeClientCounts.set(clientKey, (activeClientCounts.get(clientKey) ?? 0) + 1);
  }

  function decrementClient(clientKey) {
    const next = (activeClientCounts.get(clientKey) ?? 1) - 1;
    if (next <= 0) {
      activeClientCounts.delete(clientKey);
    } else {
      activeClientCounts.set(clientKey, next);
    }
  }

  function scheduleExpiry(record) {
    if (retained.size >= resolvedMaxRetainedRuns && !retained.has(record.runId)) {
      const oldestRunId = retained.keys().next().value;
      const oldest = retained.get(oldestRunId);
      if (oldest?.retentionTimer !== undefined) {
        scheduler.clearTimeout(oldest.retentionTimer);
        oldest.retentionTimer = undefined;
      }
      retained.delete(oldestRunId);
    }
    record.expiresAt = currentTime() + resolvedRetentionMs;
    record.retentionTimer = scheduler.setTimeout(() => {
      if (retained.get(record.runId) === record) {
        retained.delete(record.runId);
      }
      record.retentionTimer = undefined;
    }, resolvedRetentionMs);
    retained.set(record.runId, record);
  }

  function fail(record, failureCode) {
    if (record.discardOnFinish || closing) {
      return;
    }
    record.status = "failed";
    record.failureCode = failureCode;
    record.report = null;
    scheduleExpiry(record);
  }

  function releaseActive(record) {
    if (record.activeReleased) {
      return;
    }
    record.activeReleased = true;
    if (runs.get(record.runId) === record) {
      runs.delete(record.runId);
    }
    decrementClient(record.clientKey);
  }

  function clearRunTimer(record) {
    if (record.runTimer !== undefined) {
      scheduler.clearTimeout(record.runTimer);
      record.runTimer = undefined;
    }
  }

  async function execute(record) {
    try {
      let detectorResult;
      try {
        detectorResult = await detectorRunner({
          config: { ...WEB_DETECTOR_CONFIG, seed: record.seed },
          onProgress: (progress) => {
            record.progress = progress;
          },
          requests: record.requests,
          send: transport.send,
          signal: record.controller.signal,
        });
      } catch {
        fail(record, RUN_FAILURE_CODE.DETECTOR_FAILED);
        return;
      }

      if (record.discardOnFinish || closing) {
        return;
      }

      try {
        const report = await reportBuilder({
          buildVersion: "web-0.1.0",
          detectorConfig: { ...WEB_DETECTOR_CONFIG, seed: record.seed },
          detectorResult,
          detectorVersion: "detector-0.1.0",
          endedAt: timestampFrom(currentTime),
          noise: record.noise,
          requestMetadata: record.requests,
          requestTemplateIds: REQUEST_TEMPLATE_IDS,
          requestWarnings: record.requests.warnings,
          runSeed: record.seed,
          startedAt: record.startedAt,
          target: { id: record.targetId, kind: "demo" },
        });
        await reportValidator(report);
        record.report = report;
      } catch {
        fail(record, RUN_FAILURE_CODE.REPORT_BUILD_FAILED);
        return;
      }

      if (record.discardOnFinish || closing) {
        return;
      }
      record.status = "complete";
      record.failureCode = null;
      scheduleExpiry(record);
    } catch {
      fail(record, RUN_FAILURE_CODE.INTERNAL_FAILED);
    } finally {
      clearRunTimer(record);
      record.requests = undefined;
      releaseActive(record);
    }
  }

  function sweep() {
    const time = currentTime();
    rateLimiter.prune(time);
    for (const [runId, record] of retained) {
      if (record.expiresAt <= time) {
        retained.delete(runId);
        if (record.retentionTimer !== undefined) {
          scheduler.clearTimeout(record.retentionTimer);
          record.retentionTimer = undefined;
        }
      }
    }
  }

  function start({ clientKey, noisePresetId, targetId } = {}) {
    if (closing) {
      throw new RunManagerError("internal-error", 500);
    }
    sweep();
    const normalizedClientKey = normalizeClientKey(clientKey);
    if (!Object.hasOwn(targetMap, targetId) || !noisePresetIds.includes(noisePresetId)) {
      throw new RunManagerError("invalid-scan-request", 400);
    }
    const noise = createNoiseConfig({ presetId: noisePresetId });
    const requests = createDemoRequests(targetMap, targetId);
    if ((activeClientCounts.get(normalizedClientKey) ?? 0) >= resolvedActivePerClient) {
      throw new RunManagerError("active-run-limit");
    }
    if (runs.size >= resolvedActiveRuns) {
      throw new RunManagerError("active-run-limit");
    }
    const time = currentTime();
    if (!rateLimiter.tryAcquire(normalizedClientKey, time)) {
      throw new RunManagerError("rate-limit-exceeded");
    }

    const runId = allocateRunId();
    const seed = allocateRunSeed();
    const record = {
      activeReleased: false,
      clientKey: normalizedClientKey,
      controller: new AbortController(),
      discardOnFinish: false,
      expiresAt: null,
      failureCode: null,
      noise,
      noisePresetId,
      progress: null,
      report: null,
      requests,
      retentionTimer: undefined,
      runId,
      runTimer: undefined,
      seed,
      startedAt: timestampFrom(() => time),
      status: "running",
      targetId,
    };
    runs.set(runId, record);
    incrementClient(normalizedClientKey);
    try {
      record.runTimer = scheduler.setTimeout(() => {
        record.timedOut = true;
        record.discardOnFinish = true;
        record.controller.abort();
        record.status = "failed";
        record.failureCode = RUN_FAILURE_CODE.RUN_TIMEOUT;
        record.report = null;
        record.requests = undefined;
        scheduleExpiry(record);
        releaseActive(record);
      }, resolvedMaxRunDurationMs);

      const execution = execute(record);
      record.execution = execution;
      executions.add(execution);
      executionsByRunId.set(runId, execution);
      execution.then(() => executions.delete(execution), () => executions.delete(execution));
      execution.then(
        () => executionsByRunId.delete(runId),
        () => executionsByRunId.delete(runId),
      );
      return {
        noisePresetId,
        runId,
        status: "running",
        targetId,
      };
    } catch (error) {
      record.discardOnFinish = true;
      record.controller.abort();
      clearRunTimer(record);
      record.requests = undefined;
      releaseActive(record);
      throw error;
    }
  }

  function get(runId) {
    sweep();
    const record = runs.get(runId) ?? retained.get(runId);
    return record ? copyPublicRecord(record) : null;
  }

  function waitFor(runId) {
    return executionsByRunId.get(runId) ?? Promise.resolve(get(runId));
  }

  function disconnect(runId, clientKey) {
    const record = runs.get(runId);
    if (!record || record.clientKey !== normalizeClientKey(clientKey)) {
      return false;
    }
    record.discardOnFinish = true;
    clearRunTimer(record);
    record.controller.abort();
    record.requests = undefined;
    releaseActive(record);
    return true;
  }

  async function closeResources() {
    if (resourcesClosed) {
      return;
    }
    resourcesClosed = true;
    try {
      if (typeof transport.close === "function") {
        await transport.close();
      }
    } catch {
      // Continue closing the manager-owned dispatcher after transport cleanup fails.
    }
    try {
      if (dispatcher && typeof dispatcher.close === "function") {
        await dispatcher.close();
      }
    } catch {
      // Shutdown is best effort; no transport error is exposed to the client.
    }
  }

  function shutdown() {
    if (shutdownPromise) {
      return shutdownPromise;
    }
    closing = true;
    for (const record of runs.values()) {
      record.discardOnFinish = true;
      clearRunTimer(record);
      record.controller.abort();
      releaseActive(record);
    }
    runs.clear();
    for (const record of retained.values()) {
      if (record.retentionTimer !== undefined) {
        scheduler.clearTimeout(record.retentionTimer);
        record.retentionTimer = undefined;
      }
    }
    retained.clear();
    activeClientCounts.clear();
    executionsByRunId.clear();
    executions.clear();
    shutdownPromise = closeResources();
    return shutdownPromise;
  }

  return {
    activeCount: () => runs.size,
    activeClientCount: (clientKey) => activeClientCounts.get(normalizeClientKey(clientKey)) ?? 0,
    close: shutdown,
    disconnect,
    get,
    histogramBinLimit: HISTOGRAM_BIN_LIMIT,
    limiterKeyCount: () => rateLimiter.keyCount(),
    maxActiveRuns: resolvedActiveRuns,
    maxRetainedRuns: resolvedMaxRetainedRuns,
    maxRunDurationMs: resolvedMaxRunDurationMs,
    requestTimeoutMs: resolvedRequestTimeoutMs,
    shutdown,
    start,
    sweep,
    waitFor,
  };
}

export { createDemoRequests, parseBoundedInteger };
