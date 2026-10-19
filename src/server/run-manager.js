import { createSeededPrng } from "../prng.js";
import { buildRequests } from "../http/request.js";
import { createNoiseConfig } from "../demos/noise.js";
import { WEB_BUILD_INFO } from "./build-info.js";

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
export const DEFAULT_HISTOGRAM_BIN_COUNT = 20;
export const DEFAULT_SSE_DISCONNECT_GRACE_MS = 5_000;
export const DEFAULT_SSE_KEEPALIVE_MS = 15_000;
export const MAX_SSE_CONNECTIONS = 8;

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

const PUBLIC_VERDICTS = new Set(["LEAK", "NO_LEAK_DETECTED", "INCONCLUSIVE"]);
const PUBLIC_STOP_REASONS = new Set([
  "aborted",
  "baseline-status-mismatch",
  "data-quality-failure",
  "fatal-transport-error",
  "leak-detected",
  "max-attempts-inconclusive",
  "max-samples-inconclusive",
  "max-samples-no-leak",
  "sensitivity-unavailable",
  "warmup-failed",
]);
const PUBLIC_WARNING_CODES = new Set([
  "BODY_LENGTH_DIFFERENCE",
  "DISCARD_RATE_DIFFERENCE",
]);

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
    // Resolve the same lazy path used by send so the shared Agent and its
    // undici transport are ready before a first scan needs them.
    warm: () => ensureTransport().then(() => undefined),
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

function validateNonNegativeDuration(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function finiteDurations(values) {
  return Array.isArray(values)
    ? values.filter((value) => Number.isFinite(value) && value >= 0)
    : [];
}

function emptyPublicCounts() {
  return {
    attempts: { a: 0, b: 0 },
    accepted: { a: 0, b: 0 },
    discarded: { a: 0, b: 0 },
    errors: { a: 0, b: 0 },
  };
}

function countValue(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function groupCount(progress, label) {
  const group = progress?.counts?.[label];
  const discardReasons = group?.discardReasons;
  const errors = discardReasons && typeof discardReasons === "object"
    ? countValue(discardReasons.error) + countValue(discardReasons.timeout)
    : 0;
  return {
    attempts: countValue(group?.attempts),
    accepted: countValue(group?.accepted),
    discarded: countValue(group?.discarded),
    errors,
  };
}

function histogramBins(values, minimum, maximum, binCount) {
  if (values.length === 0) {
    return [];
  }
  if (minimum === maximum) {
    return [{ count: values.length, endMs: maximum, startMs: minimum }];
  }
  const width = (maximum - minimum) / binCount;
  const bins = Array.from({ length: binCount }, (_, index) => ({
    count: 0,
    endMs: index === binCount - 1 ? maximum : minimum + ((index + 1) * width),
    startMs: minimum + (index * width),
  }));
  for (const value of values) {
    const index = Math.min(binCount - 1, Math.floor((value - minimum) / width));
    bins[index].count += 1;
  }
  return bins;
}

function createHistograms(samples) {
  const a = finiteDurations(samples?.a);
  const b = finiteDurations(samples?.b);
  if (a.length + b.length === 0) {
    return { a: [], b: [] };
  }
  let minimum = Infinity;
  let maximum = -Infinity;
  for (const group of [a, b]) {
    for (const value of group) {
      minimum = Math.min(minimum, value);
      maximum = Math.max(maximum, value);
    }
  }
  const binCount = Math.min(DEFAULT_HISTOGRAM_BIN_COUNT, HISTOGRAM_BIN_LIMIT);
  return {
    a: histogramBins(a, minimum, maximum, binCount),
    b: histogramBins(b, minimum, maximum, binCount),
  };
}

function captureProgress(progress) {
  const counts = {
    a: groupCount(progress, "a"),
    b: groupCount(progress, "b"),
  };
  const samples = {
    a: finiteDurations(progress?.samples?.a),
    b: finiteDurations(progress?.samples?.b),
  };
  const hasSamples = Array.isArray(progress?.samples?.a)
    || Array.isArray(progress?.samples?.b);
  const histograms = createHistograms(samples);
  if (hasSamples) {
    counts.a.accepted = samples.a.length;
    counts.b.accepted = samples.b.length;
  }
  return {
    counts,
    histograms,
    lookIndex: countValue(progress?.lookIndex ?? progress?.lookHistory),
  };
}

function cloneHistograms(histograms) {
  return {
    a: (histograms?.a ?? []).map((bin) => ({ ...bin })),
    b: (histograms?.b ?? []).map((bin) => ({ ...bin })),
  };
}

function cloneProgress(progress) {
  const counts = progress?.counts ?? emptyPublicCounts();
  if (counts.a && counts.b) {
    return {
      accepted: {
        a: countValue(counts.a.accepted),
        b: countValue(counts.b.accepted),
      },
      attempts: {
        a: countValue(counts.a.attempts),
        b: countValue(counts.b.attempts),
      },
      discarded: {
        a: countValue(counts.a.discarded),
        b: countValue(counts.b.discarded),
      },
      errors: {
        a: countValue(counts.a.errors),
        b: countValue(counts.b.errors),
      },
    };
  }
  return {
    accepted: { ...(counts.accepted ?? { a: 0, b: 0 }) },
    attempts: { ...(counts.attempts ?? { a: 0, b: 0 }) },
    discarded: { ...(counts.discarded ?? { a: 0, b: 0 }) },
    errors: { ...(counts.errors ?? { a: 0, b: 0 }) },
  };
}

function emptyCapturedProgress() {
  return {
    counts: {
      a: { accepted: 0, attempts: 0, discarded: 0, errors: 0 },
      b: { accepted: 0, attempts: 0, discarded: 0, errors: 0 },
    },
    histograms: { a: [], b: [] },
    lookIndex: 0,
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

const FAILURE_MESSAGES = Object.freeze({
  [RUN_FAILURE_CODE.DETECTOR_FAILED]: "The scan detector failed",
  [RUN_FAILURE_CODE.INTERNAL_FAILED]: "The scan failed internally",
  [RUN_FAILURE_CODE.REPORT_BUILD_FAILED]: "The scan report could not be built",
  [RUN_FAILURE_CODE.RUN_TIMEOUT]: "The scan exceeded its time limit",
});

function failureMessage(code) {
  return FAILURE_MESSAGES[code] ?? "The scan failed";
}

function reportInference(record) {
  const inference = record.report?.inference;
  const observation = record.report?.observation;
  return {
    sensitivityMs: nonNegativeFinite(inference?.sensitivityMs),
    stopReason: typeof observation?.stopReason === "string"
      && PUBLIC_STOP_REASONS.has(observation.stopReason)
      ? observation.stopReason
      : null,
    verdict: PUBLIC_VERDICTS.has(inference?.verdict) ? inference.verdict : null,
  };
}

function nonNegativeFinite(value) {
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function publicWarnings(warnings) {
  if (!Array.isArray(warnings)) {
    return [];
  }
  return warnings.flatMap((warning) => {
    if (!warning || !PUBLIC_WARNING_CODES.has(warning.code)) {
      return [];
    }
    if (warning.code === "BODY_LENGTH_DIFFERENCE") {
      const differenceBytes = nonNegativeFinite(warning.differenceBytes);
      return differenceBytes === null ? [] : [{ code: warning.code, differenceBytes }];
    }
    const rateA = Number.isFinite(warning.rateA) && warning.rateA >= 0 && warning.rateA <= 1
      ? warning.rateA
      : null;
    const rateB = Number.isFinite(warning.rateB) && warning.rateB >= 0 && warning.rateB <= 1
      ? warning.rateB
      : null;
    return rateA === null || rateB === null
      ? []
      : [{ code: warning.code, rateA, rateB }];
  });
}

function publicStatistics(statistics) {
  if (!statistics || typeof statistics !== "object") {
    return null;
  }
  const mannWhitney = statistics.mannWhitney;
  const lowPercentile = statistics.lowPercentile;
  if (!mannWhitney || !lowPercentile || typeof mannWhitney !== "object"
    || typeof lowPercentile !== "object") {
    return null;
  }
  const values = {
    uA: nonNegativeFinite(mannWhitney.uA),
    uB: nonNegativeFinite(mannWhitney.uB),
    pValue: Number.isFinite(mannWhitney.pValue) && mannWhitney.pValue >= 0 && mannWhitney.pValue <= 1
      ? mannWhitney.pValue
      : null,
    z: Number.isFinite(mannWhitney.z) ? mannWhitney.z : null,
    degenerate: typeof mannWhitney.degenerate === "boolean" ? mannWhitney.degenerate : null,
    a: nonNegativeFinite(lowPercentile.a),
    b: nonNegativeFinite(lowPercentile.b),
    signedDelta: Number.isFinite(lowPercentile.signedDelta) ? lowPercentile.signedDelta : null,
    absoluteDelta: nonNegativeFinite(lowPercentile.absoluteDelta),
    probability: Number.isFinite(lowPercentile.probability)
      && lowPercentile.probability >= 0
      && lowPercentile.probability <= 1
      ? lowPercentile.probability
      : null,
    method: lowPercentile.method === "linear-type-7" ? lowPercentile.method : null,
  };
  if (Object.values(values).some((value) => value === null)) {
    return null;
  }
  return {
    lowPercentile: {
      a: values.a,
      absoluteDelta: values.absoluteDelta,
      b: values.b,
      method: values.method,
      probability: values.probability,
      signedDelta: values.signedDelta,
    },
    mannWhitney: {
      degenerate: values.degenerate,
      pValue: values.pValue,
      uA: values.uA,
      uB: values.uB,
      z: values.z,
    },
  };
}

// Completed public evidence is an explicit projection. Never spread the
// report: seeds, request metadata, raw samples, client keys, hosts, ports, and
// internal report fields must remain private to the manager.
function publicEvidence(record) {
  const inference = record.report?.inference;
  const observation = record.report?.observation;
  const stopReason = typeof observation?.stopReason === "string"
    && PUBLIC_STOP_REASONS.has(observation.stopReason)
    ? observation.stopReason
    : null;
  const sensitivityMs = nonNegativeFinite(inference?.sensitivityMs);
  return {
    sensitivityMs,
    statistics: publicStatistics(inference?.statistics),
    stopReason,
    warnings: publicWarnings(inference?.warnings),
  };
}

// Public snapshots are deliberately allowlisted. They never serialize the
// client key, run seed, request metadata, internal hosts/ports, or raw errors.
function publicSnapshot(record) {
  const progress = record.progress ?? emptyCapturedProgress();
  const inference = record.status === "complete" ? reportInference(record) : null;
  const snapshot = {
    histograms: cloneHistograms(progress.histograms),
    progress: cloneProgress(progress),
    runId: record.runId,
    status: record.status,
    verdict: inference?.verdict ?? null,
  };
  if (record.status === "complete") {
    snapshot.evidence = publicEvidence(record);
    snapshot.inference = inference;
    snapshot.reportUrl = `/api/scans/${encodeURIComponent(record.runId)}/report`;
  } else if (record.status === "failed") {
    snapshot.failureCode = record.failureCode;
  }
  return snapshot;
}

function startedEvent(record) {
  return {
    noisePresetId: record.noisePresetId,
    runId: record.runId,
    targetId: record.targetId,
  };
}

function progressEvent(record) {
  const progress = record.progress ?? emptyCapturedProgress();
  const publicProgress = cloneProgress(progress);
  return {
    accepted: publicProgress.accepted,
    attempts: publicProgress.attempts,
    discarded: publicProgress.discarded,
    errors: publicProgress.errors,
    histograms: cloneHistograms(progress.histograms),
    lookIndex: progress.lookIndex,
    runId: record.runId,
    status: record.status,
  };
}

function terminalEvent(record) {
  if (record.status === "complete") {
    const inference = reportInference(record);
    return {
      event: "scan:complete",
      payload: {
        evidence: publicEvidence(record),
        reportUrl: `/api/scans/${encodeURIComponent(record.runId)}/report`,
        runId: record.runId,
        sensitivityMs: inference.sensitivityMs,
        status: "complete",
        stopReason: inference.stopReason,
        verdict: inference.verdict,
      },
    };
  }
  return {
    event: "scan:error",
    payload: {
      code: record.failureCode ?? RUN_FAILURE_CODE.INTERNAL_FAILED,
      message: failureMessage(record.failureCode),
      runId: record.runId,
      status: "failed",
    },
  };
}

export function createRunManager({
  activePerClient = DEFAULT_ACTIVE_PER_CLIENT,
  activeRuns,
  agentFactory = () => undefined,
  buildInfo = WEB_BUILD_INFO,
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
  sseDisconnectGraceMs = DEFAULT_SSE_DISCONNECT_GRACE_MS,
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
  if (!buildInfo || typeof buildInfo !== "object"
    || typeof buildInfo.buildVersion !== "string"
    || typeof buildInfo.detectorVersion !== "string") {
    throw new TypeError("buildInfo must contain buildVersion and detectorVersion strings");
  }
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
  const resolvedSseDisconnectGraceMs = validateNonNegativeDuration(
    sseDisconnectGraceMs,
    "sseDisconnectGraceMs",
  );
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
  const expired = new Map();
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
  let warmPromise;

  function currentTime() {
    const value = now();
    if (!Number.isFinite(value)) {
      throw new TypeError("now must return a finite number");
    }
    return value;
  }

  function warm() {
    if (!warmPromise) {
      warmPromise = Promise.all([
        import("../detector/index.js"),
        import("../report/index.js"),
        typeof transport.warm === "function" ? transport.warm() : undefined,
      ]).then(() => undefined).catch((error) => {
        warmPromise = undefined;
        throw error;
      });
    }
    return warmPromise;
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

  function clearSubscriberTimer(record) {
    if (record.subscriberTimer !== undefined) {
      scheduler.clearTimeout(record.subscriberTimer);
      record.subscriberTimer = undefined;
    }
  }

  function notify(record, event, payload) {
    for (const subscriber of [...record.subscribers]) {
      try {
        subscriber.listener(event, payload);
      } catch {
        // A disconnected or test double response must not break another
        // subscriber or the run's cleanup path.
        removeSubscriber(record, subscriber);
      }
    }
  }

  function notifyTerminal(record) {
    if (record.terminalEvent) {
      return;
    }
    const terminal = terminalEvent(record);
    record.terminalEvent = terminal.event;
    record.terminalPayload = terminal.payload;
    clearSubscriberTimer(record);
    const subscribers = [...record.subscribers];
    record.subscribers.clear();
    for (const subscriber of subscribers) {
      subscriber.active = false;
      try {
        subscriber.listener(terminal.event, terminal.payload);
      } catch {
        // The response owns its own close/error handling.
      }
    }
  }

  function markExpired(record) {
    if (record.expired) {
      return;
    }
    record.expired = true;
    clearSubscriberTimer(record);
    if (record.retentionTimer !== undefined) {
      scheduler.clearTimeout(record.retentionTimer);
      record.retentionTimer = undefined;
    }
    if (record.terminalEvent) {
      // Terminal streams already closed; the expired marker supports a later
      // SSE attachment without retaining the report or its raw observations.
      expired.set(record.runId, true);
    } else {
      record.terminalEvent = "scan:expired";
      record.terminalPayload = { runId: record.runId, status: "expired" };
      const subscribers = [...record.subscribers];
      record.subscribers.clear();
      for (const subscriber of subscribers) {
        subscriber.active = false;
        try {
          subscriber.listener(record.terminalEvent, record.terminalPayload);
        } catch {
          // The response owns its own close/error handling.
        }
      }
      expired.set(record.runId, true);
    }
    while (expired.size > resolvedMaxRetainedRuns) {
      expired.delete(expired.keys().next().value);
    }
  }

  function scheduleExpiry(record) {
    if (retained.size >= resolvedMaxRetainedRuns && !retained.has(record.runId)) {
      const oldestRunId = retained.keys().next().value;
      const oldest = retained.get(oldestRunId);
      if (oldest) {
        markExpired(oldest);
        retained.delete(oldestRunId);
      }
    }
    record.expiresAt = currentTime() + resolvedRetentionMs;
    record.retentionTimer = scheduler.setTimeout(() => {
      if (retained.get(record.runId) === record) {
        retained.delete(record.runId);
      }
      markExpired(record);
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
    notifyTerminal(record);
  }

  function releaseActive(record) {
    if (record.activeReleased) {
      return;
    }
    record.activeReleased = true;
    clearSubscriberTimer(record);
    if (runs.get(record.runId) === record) {
      runs.delete(record.runId);
    }
    decrementClient(record.clientKey);
  }

  function abortUnobserved(record) {
    if (record.discardOnFinish || record.status !== "running") {
      return;
    }
    record.discardOnFinish = true;
    clearRunTimer(record);
    clearSubscriberTimer(record);
    record.controller.abort();
    record.requests = undefined;
    releaseActive(record);
  }

  function scheduleUnobservedAbort(record) {
    if (record.subscribers.size !== 0 || record.status !== "running") {
      return;
    }
    clearSubscriberTimer(record);
    record.subscriberTimer = scheduler.setTimeout(() => {
      record.subscriberTimer = undefined;
      if (record.subscribers.size === 0) {
        abortUnobserved(record);
      }
    }, resolvedSseDisconnectGraceMs);
  }

  function clearRunTimer(record) {
    if (record.runTimer !== undefined) {
      scheduler.clearTimeout(record.runTimer);
      record.runTimer = undefined;
    }
  }

  async function execute(record) {
    try {
      // The web entrypoint starts this same promise after listen. Awaiting it
      // here closes the race where the first scan arrives before background
      // module/dispatcher warming has finished.
      await warm();
      let detectorResult;
      try {
        detectorResult = await detectorRunner({
          config: { ...WEB_DETECTOR_CONFIG, seed: record.seed },
          onProgress: (progress) => {
            record.progress = captureProgress(progress);
            notify(record, "scan:progress", progressEvent(record));
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
          buildVersion: buildInfo.buildVersion,
          detectorConfig: { ...WEB_DETECTOR_CONFIG, seed: record.seed },
          detectorResult,
          detectorVersion: buildInfo.detectorVersion,
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
      notifyTerminal(record);
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
        markExpired(record);
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
      progress: emptyCapturedProgress(),
      report: null,
      requests,
      retentionTimer: undefined,
      runId,
      runTimer: undefined,
      seed,
      startedAt: timestampFrom(() => time),
      status: "running",
      subscriberTimer: undefined,
      subscribers: new Set(),
      terminalEvent: null,
      terminalPayload: null,
      targetId,
    };
    runs.set(runId, record);
    incrementClient(normalizedClientKey);
    try {
      record.runTimer = scheduler.setTimeout(() => {
        record.timedOut = true;
        record.discardOnFinish = true;
        clearSubscriberTimer(record);
        record.controller.abort();
        record.status = "failed";
        record.failureCode = RUN_FAILURE_CODE.RUN_TIMEOUT;
        record.report = null;
        record.requests = undefined;
        scheduleExpiry(record);
        notifyTerminal(record);
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

  function getReport(runId) {
    sweep();
    const record = runs.get(runId) ?? retained.get(runId);
    if (!record || record.status !== "complete" || !record.report) {
      return null;
    }
    return structuredClone(record.report);
  }

  function getSnapshot(runId) {
    sweep();
    const record = runs.get(runId) ?? retained.get(runId);
    if (record) {
      return publicSnapshot(record);
    }
    if (expired.has(runId)) {
      return {
        histograms: { a: [], b: [] },
        progress: cloneProgress({ counts: emptyPublicCounts() }),
        runId,
        status: "expired",
        verdict: null,
      };
    }
    return null;
  }

  function removeSubscriber(record, subscriber) {
    if (!subscriber.active) {
      return false;
    }
    subscriber.active = false;
    record.subscribers.delete(subscriber);
    if (!record.terminalEvent) {
      scheduleUnobservedAbort(record);
    }
    return true;
  }

  function subscribe(runId, listener) {
    assertFunction(listener, "listener");
    sweep();
    const record = runs.get(runId) ?? retained.get(runId);
    if (!record) {
      if (expired.has(runId)) {
        listener("scan:expired", { runId, status: "expired" });
        return { unsubscribe: () => false };
      }
      return null;
    }

    clearSubscriberTimer(record);
    if (record.status !== "running") {
      listener("scan:started", startedEvent(record));
      if (record.progress) {
        listener("scan:progress", progressEvent(record));
      }
      if (record.terminalEvent && record.terminalPayload) {
        listener(record.terminalEvent, { ...record.terminalPayload });
      }
      return { unsubscribe: () => false };
    }

    const subscriber = { active: true, listener };
    record.subscribers.add(subscriber);
    listener("scan:started", startedEvent(record));
    if (record.progress) {
      listener("scan:progress", progressEvent(record));
    }
    return {
      unsubscribe: () => removeSubscriber(record, subscriber),
    };
  }

  function subscriberCount(runId) {
    const record = runs.get(runId);
    return record?.subscribers.size ?? 0;
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
    clearSubscriberTimer(record);
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
      clearSubscriberTimer(record);
      record.controller.abort();
      record.terminalEvent = "scan:expired";
      record.terminalPayload = { runId: record.runId, status: "expired" };
      const subscribers = [...record.subscribers];
      record.subscribers.clear();
      for (const subscriber of subscribers) {
        subscriber.active = false;
        try {
          subscriber.listener(record.terminalEvent, record.terminalPayload);
        } catch {
          // Shutdown continues even if a response is already disconnected.
        }
      }
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
    expired.clear();
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
    getReport,
    getSnapshot,
    histogramBinLimit: HISTOGRAM_BIN_LIMIT,
    limiterKeyCount: () => rateLimiter.keyCount(),
    maxActiveRuns: resolvedActiveRuns,
    maxRetainedRuns: resolvedMaxRetainedRuns,
    maxRunDurationMs: resolvedMaxRunDurationMs,
    requestTimeoutMs: resolvedRequestTimeoutMs,
    sseDisconnectGraceMs: resolvedSseDisconnectGraceMs,
    subscribe,
    subscriberCount,
    shutdown,
    start,
    sweep,
    warm,
    waitFor,
  };
}

export { createDemoRequests, parseBoundedInteger };
