import { STOP_REASON } from "../detector/index.js";
import { formatVerdict, VERDICT } from "../inference/verdict.js";
import { redactRequestMetadata } from "./redact.js";

export const REPORT_SCHEMA_VERSION = "1.0";

export const REPORT_WARNING_CODE = Object.freeze({
  BODY_LENGTH_DIFFERENCE: "BODY_LENGTH_DIFFERENCE",
  DISCARD_RATE_DIFFERENCE: "DISCARD_RATE_DIFFERENCE",
});

export class ReportValidationError extends TypeError {
  constructor(message) {
    super(message);
    this.name = "ReportValidationError";
    this.code = "REPORT_INVALID";
  }
}

const DETECTOR_CONFIG_FIELDS = [
  "alphaTotal",
  "bootstrapReplicates",
  "lookBatchPerGroup",
  "materialDiscardRateDifference",
  "maxAttempts",
  "maxConsecutiveFailures",
  "maxDiscardRate",
  "maxValidPerGroup",
  "minAttemptsForDiscardRate",
  "minValidPerGroup",
  "quantile",
  "seed",
  "targetPower",
];

const NOISE_FIELDS = [
  "benchmarkStatus",
  "jitter",
  "presetId",
  "seed",
  "spikeMultiplier",
  "spikeProbability",
];
const VERDICTS = new Set(Object.values(VERDICT));
const STOP_REASONS = new Set(Object.values(STOP_REASON));
const SENSITIVITY_REASONS = new Set([
  "degenerate-bootstrap",
  "insufficient-samples",
  "too-few-replicates",
]);
const SENSITIVE_KEYS = new Set([
  "authorization",
  "authorizationheader",
  "body",
  "bodyvalue",
  "cookie",
  "cookies",
  "requestbody",
  "requestcookie",
  "requestcookies",
  "requesturl",
  "targeturl",
  "url",
]);

function isObject(value) {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function invalid(path, message) {
  throw new ReportValidationError(`${path} ${message}`);
}

function requireObject(value, path) {
  if (!isObject(value)) {
    invalid(path, "must be an object");
  }
  return value;
}

function requireExactKeys(value, keys, path) {
  requireObject(value, path);
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      invalid(`${path}.${key}`, "is not allowed");
    }
  }
}

function requireString(value, path) {
  if (typeof value !== "string" || value.length === 0) {
    invalid(path, "must be a non-empty string");
  }
}

function requireBoolean(value, path) {
  if (typeof value !== "boolean") {
    invalid(path, "must be a boolean");
  }
}

function requireFiniteNumber(value, path, minimum = -Infinity, maximum = Infinity) {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    invalid(path, "must be a finite number in the allowed range");
  }
}

function requireNonNegativeNumber(value, path) {
  requireFiniteNumber(value, path, 0);
}

function requireNonNegativeInteger(value, path) {
  if (!Number.isSafeInteger(value) || value < 0) {
    invalid(path, "must be a non-negative safe integer");
  }
}

function requireSeed(value, path) {
  if (!(typeof value === "string" || Number.isSafeInteger(value))) {
    invalid(path, "must be a string or safe integer");
  }
}

function requireStatus(value, path, allowNull = true) {
  if (allowNull && value === null) {
    return;
  }
  if (!Number.isSafeInteger(value) || value < 100 || value > 599) {
    invalid(path, "must be an HTTP status code or null");
  }
}

function requireArray(value, path) {
  if (!Array.isArray(value)) {
    invalid(path, "must be an array");
  }
}

function requireIsoTimestamp(value, path) {
  requireString(value, path);
  if (!Number.isFinite(Date.parse(value))) {
    invalid(path, "must be an ISO timestamp");
  }
}

function normalizedKey(key) {
  return key.toLowerCase().replaceAll(/[-_]/g, "");
}

function rejectSensitiveKeys(value, path = "report") {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => rejectSensitiveKeys(entry, `${path}[${index}]`));
    return;
  }
  if (!isObject(value)) {
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (SENSITIVE_KEYS.has(normalizedKey(key))) {
      invalid(`${path}.${key}`, "contains a prohibited sensitive field");
    }
    rejectSensitiveKeys(child, `${path}.${key}`);
  }
}

function normalizeWarning(warning, path) {
  requireObject(warning, path);
  if (warning.code === REPORT_WARNING_CODE.BODY_LENGTH_DIFFERENCE) {
    const differenceBytes = warning.differenceBytes;
    requireNonNegativeNumber(differenceBytes, `${path}.differenceBytes`);
    return { code: warning.code, differenceBytes };
  }
  if (warning.code === REPORT_WARNING_CODE.DISCARD_RATE_DIFFERENCE) {
    const rateA = warning.rateA ?? warning.rates?.a;
    const rateB = warning.rateB ?? warning.rates?.b;
    requireFiniteNumber(rateA, `${path}.rateA`, 0, 1);
    requireFiniteNumber(rateB, `${path}.rateB`, 0, 1);
    return { code: warning.code, rateA, rateB };
  }
  invalid(`${path}.code`, "is not an allowed warning code");
}

function normalizeWarnings(warnings, path) {
  requireArray(warnings, path);
  return warnings.map((warning, index) => normalizeWarning(warning, `${path}[${index}]`));
}

function validateWarnings(warnings, path) {
  requireArray(warnings, path);
  warnings.forEach((warning, index) => {
    const warningPath = `${path}[${index}]`;
    requireObject(warning, warningPath);
    if (warning.code === REPORT_WARNING_CODE.BODY_LENGTH_DIFFERENCE) {
      requireExactKeys(warning, ["code", "differenceBytes"], warningPath);
      requireNonNegativeNumber(warning.differenceBytes, `${warningPath}.differenceBytes`);
      return;
    }
    if (warning.code === REPORT_WARNING_CODE.DISCARD_RATE_DIFFERENCE) {
      requireExactKeys(warning, ["code", "rateA", "rateB"], warningPath);
      requireFiniteNumber(warning.rateA, `${warningPath}.rateA`, 0, 1);
      requireFiniteNumber(warning.rateB, `${warningPath}.rateB`, 0, 1);
      return;
    }
    invalid(`${warningPath}.code`, "is not an allowed warning code");
  });
}

function validateRequestMetadata(metadata, path) {
  requireObject(metadata, path);
  requireExactKeys(metadata, ["bodyBytes", "headerNames", "hostname", "method", "path"], path);
  if ("bodyBytes" in metadata) {
    requireNonNegativeInteger(metadata.bodyBytes, `${path}.bodyBytes`);
  }
  if ("headerNames" in metadata) {
    requireArray(metadata.headerNames, `${path}.headerNames`);
    metadata.headerNames.forEach((name, index) => requireString(name, `${path}.headerNames[${index}]`));
  }
  for (const field of ["hostname", "method", "path"]) {
    if (field in metadata) {
      requireString(metadata[field], `${path}.${field}`);
    }
  }
}

function validateCounts(counts, path) {
  requireExactKeys(counts, ["accepted", "attempts", "discarded", "discardReasons"], path);
  requireNonNegativeInteger(counts.accepted, `${path}.accepted`);
  requireNonNegativeInteger(counts.attempts, `${path}.attempts`);
  requireNonNegativeInteger(counts.discarded, `${path}.discarded`);
  requireObject(counts.discardReasons, `${path}.discardReasons`);
  let reasonTotal = 0;
  for (const [reason, count] of Object.entries(counts.discardReasons)) {
    requireNonNegativeInteger(count, `${path}.discardReasons.${reason}`);
    reasonTotal += count;
  }
  if (counts.accepted + counts.discarded !== counts.attempts) {
    invalid(path, "accepted plus discarded must equal attempts");
  }
  if (reasonTotal !== counts.discarded) {
    invalid(path, "discard reason counts must sum to discarded");
  }
}

function validateSamples(samples, counts, maxValidPerGroup, path) {
  requireArray(samples, path);
  if (samples.length > maxValidPerGroup) {
    invalid(path, "exceeds maxValidPerGroup");
  }
  samples.forEach((duration, index) => requireNonNegativeNumber(duration, `${path}[${index}]`));
  if (counts.accepted !== samples.length) {
    invalid(path, "length must equal accepted count");
  }
}

function validateStatistics(statistics, path) {
  if (statistics === null) {
    return;
  }
  requireExactKeys(statistics, ["lowPercentile", "mannWhitney"], path);
  requireExactKeys(statistics.lowPercentile, [
    "absoluteDelta",
    "a",
    "b",
    "method",
    "probability",
    "signedDelta",
  ], `${path}.lowPercentile`);
  for (const field of ["absoluteDelta", "a", "b", "signedDelta"]) {
    requireNonNegativeNumber(
      field === "signedDelta"
        ? Math.abs(statistics.lowPercentile[field])
        : statistics.lowPercentile[field],
      `${path}.lowPercentile.${field}`,
    );
  }
  requireString(statistics.lowPercentile.method, `${path}.lowPercentile.method`);
  requireFiniteNumber(statistics.lowPercentile.probability, `${path}.lowPercentile.probability`, 0, 1);

  const mannWhitney = statistics.mannWhitney;
  requireExactKeys(mannWhitney, [
    "degenerate",
    "pValue",
    "tieGroups",
    "uA",
    "uB",
    "variance",
    "z",
  ], `${path}.mannWhitney`);
  requireBoolean(mannWhitney.degenerate, `${path}.mannWhitney.degenerate`);
  requireFiniteNumber(mannWhitney.pValue, `${path}.mannWhitney.pValue`, 0, 1);
  requireArray(mannWhitney.tieGroups, `${path}.mannWhitney.tieGroups`);
  mannWhitney.tieGroups.forEach((size, index) => {
    requireNonNegativeInteger(size, `${path}.mannWhitney.tieGroups[${index}]`);
  });
  for (const field of ["uA", "uB", "variance"]) {
    requireNonNegativeNumber(mannWhitney[field], `${path}.mannWhitney.${field}`);
  }
  requireFiniteNumber(mannWhitney.z, `${path}.mannWhitney.z`, 0);
}

function validateSensitivity(sensitivity, path) {
  if (sensitivity === null) {
    return;
  }
  requireObject(sensitivity, path);
  if (sensitivity.available === true) {
    requireExactKeys(sensitivity, [
      "alphaQuantile",
      "available",
      "bootstrapReplicates",
      "bootstrapSeedDomain",
      "powerQuantile",
      "sensitivityMs",
      "standardError",
    ], path);
    requireFiniteNumber(sensitivity.alphaQuantile, `${path}.alphaQuantile`, 0);
    requireBoolean(sensitivity.available, `${path}.available`);
    requireNonNegativeInteger(sensitivity.bootstrapReplicates, `${path}.bootstrapReplicates`);
    requireString(sensitivity.bootstrapSeedDomain, `${path}.bootstrapSeedDomain`);
    requireFiniteNumber(sensitivity.powerQuantile, `${path}.powerQuantile`, 0);
    requireNonNegativeNumber(sensitivity.sensitivityMs, `${path}.sensitivityMs`);
    requireNonNegativeNumber(sensitivity.standardError, `${path}.standardError`);
    return;
  }
  requireExactKeys(sensitivity, ["available", "reason"], path);
  requireBoolean(sensitivity.available, `${path}.available`);
  if (!SENSITIVITY_REASONS.has(sensitivity.reason)) {
    invalid(`${path}.reason`, "is not an allowed sensitivity reason");
  }
}

function validateLook(look, path) {
  requireExactKeys(look, [
    "alphaAtLook",
    "counts",
    "lookIndex",
    "maxLooks",
    "quality",
    "sensitivity",
    "sensitivityMs",
    "statistics",
    "verdict",
  ], path);
  requireFiniteNumber(look.alphaAtLook, `${path}.alphaAtLook`, 0, 1);
  requireNonNegativeInteger(look.lookIndex, `${path}.lookIndex`);
  requireNonNegativeInteger(look.maxLooks, `${path}.maxLooks`);
  requireExactKeys(look.counts, ["a", "b"], `${path}.counts`);
  requireExactKeys(look.quality, ["discardRates", "passes", "warnings"], `${path}.quality`);
  requireExactKeys(look.quality.discardRates, ["a", "b"], `${path}.quality.discardRates`);
  requireFiniteNumber(look.quality.discardRates.a, `${path}.quality.discardRates.a`, 0, 1);
  requireFiniteNumber(look.quality.discardRates.b, `${path}.quality.discardRates.b`, 0, 1);
  requireBoolean(look.quality.passes, `${path}.quality.passes`);
  validateWarnings(look.quality.warnings, `${path}.quality.warnings`);
  validateSensitivity(look.sensitivity, `${path}.sensitivity`);
  if (look.sensitivityMs !== null) {
    requireNonNegativeNumber(look.sensitivityMs, `${path}.sensitivityMs`);
  }
  if (look.verdict !== null && !VERDICTS.has(look.verdict)) {
    invalid(`${path}.verdict`, "is not a known verdict");
  }
  validateStatistics(look.statistics, `${path}.statistics`);
  validateCounts(look.counts.a, `${path}.counts.a`);
  validateCounts(look.counts.b, `${path}.counts.b`);
}

function validateWarmupRecords(records, path) {
  requireArray(records, path);
  records.forEach((record, index) => {
    const recordPath = `${path}[${index}]`;
    requireExactKeys(record, ["label", "result"], recordPath);
    if (!new Set(["a", "b"]).has(record.label)) {
      invalid(`${recordPath}.label`, "must be a or b");
    }
    requireObject(record.result, `${recordPath}.result`);
    requireExactKeys(record.result, ["durationMs", "errorCode", "kind", "reason", "statusCode"], `${recordPath}.result`);
    if (!new Set(["accepted", "aborted", "discarded"]).has(record.result.kind)) {
      invalid(`${recordPath}.result.kind`, "is not a known transport result kind");
    }
    if ("durationMs" in record.result) {
      requireNonNegativeNumber(record.result.durationMs, `${recordPath}.result.durationMs`);
    }
    if ("errorCode" in record.result) {
      requireString(record.result.errorCode, `${recordPath}.result.errorCode`);
    }
    if ("reason" in record.result) {
      requireString(record.result.reason, `${recordPath}.result.reason`);
    }
    if ("statusCode" in record.result) {
      requireStatus(record.result.statusCode, `${recordPath}.result.statusCode`, false);
    }
  });
}

function validateConfiguration(configuration) {
  requireExactKeys(configuration, [
    "detector",
    "noise",
    "provenance",
    "requestTemplateIds",
    "seed",
    "target",
  ], "report.configuration");
  if (configuration.provenance !== "configuration") {
    invalid("report.configuration.provenance", "must identify configuration provenance");
  }
  requireSeed(configuration.seed, "report.configuration.seed");
  requireExactKeys(configuration.target, ["id", "kind", "redactedMetadata"], "report.configuration.target");
  requireString(configuration.target.id, "report.configuration.target.id");
  requireString(configuration.target.kind, "report.configuration.target.kind");
  requireExactKeys(configuration.target.redactedMetadata, ["a", "b"], "report.configuration.target.redactedMetadata");
  validateRequestMetadata(configuration.target.redactedMetadata.a, "report.configuration.target.redactedMetadata.a");
  validateRequestMetadata(configuration.target.redactedMetadata.b, "report.configuration.target.redactedMetadata.b");

  requireExactKeys(configuration.requestTemplateIds, ["a", "b"], "report.configuration.requestTemplateIds");
  requireString(configuration.requestTemplateIds.a, "report.configuration.requestTemplateIds.a");
  requireString(configuration.requestTemplateIds.b, "report.configuration.requestTemplateIds.b");

  requireExactKeys(configuration.detector, DETECTOR_CONFIG_FIELDS, "report.configuration.detector");
  requireNonNegativeInteger(configuration.detector.maxValidPerGroup, "report.configuration.detector.maxValidPerGroup");
  DETECTOR_CONFIG_FIELDS.filter((field) => field !== "seed" && field !== "maxValidPerGroup")
    .forEach((field) => requireFiniteNumber(configuration.detector[field], `report.configuration.detector.${field}`));
  requireSeed(configuration.detector.seed, "report.configuration.detector.seed");

  requireExactKeys(configuration.noise, NOISE_FIELDS, "report.configuration.noise");
  requireString(configuration.noise.presetId, "report.configuration.noise.presetId");
  if ("jitter" in configuration.noise) {
    requireNonNegativeNumber(configuration.noise.jitter, "report.configuration.noise.jitter");
  }
  if ("seed" in configuration.noise) {
    requireSeed(configuration.noise.seed, "report.configuration.noise.seed");
  }
  if ("benchmarkStatus" in configuration.noise) {
    requireString(configuration.noise.benchmarkStatus, "report.configuration.noise.benchmarkStatus");
  }
  if ("spikeMultiplier" in configuration.noise) {
    requireNonNegativeInteger(
      configuration.noise.spikeMultiplier,
      "report.configuration.noise.spikeMultiplier",
    );
  }
  if ("spikeProbability" in configuration.noise) {
    requireFiniteNumber(
      configuration.noise.spikeProbability,
      "report.configuration.noise.spikeProbability",
      0,
      1,
    );
  }
}

function validateObservation(observation, configuration) {
  requireExactKeys(observation, [
    "counts",
    "endedAt",
    "expectedStatus",
    "provenance",
    "samples",
    "startedAt",
    "stopReason",
    "warmupRecords",
  ], "report.observation");
  if (observation.provenance !== "observation") {
    invalid("report.observation.provenance", "must identify observation provenance");
  }
  requireIsoTimestamp(observation.startedAt, "report.observation.startedAt");
  requireIsoTimestamp(observation.endedAt, "report.observation.endedAt");
  if (Date.parse(observation.endedAt) < Date.parse(observation.startedAt)) {
    invalid("report.observation.endedAt", "must be greater than or equal to startedAt");
  }
  requireStatus(observation.expectedStatus, "report.observation.expectedStatus");
  if (!STOP_REASONS.has(observation.stopReason)) {
    invalid("report.observation.stopReason", "is not an allowed stop reason");
  }
  requireExactKeys(observation.samples, ["a", "b"], "report.observation.samples");
  requireExactKeys(observation.counts, ["a", "b"], "report.observation.counts");
  validateCounts(observation.counts.a, "report.observation.counts.a");
  validateCounts(observation.counts.b, "report.observation.counts.b");
  validateSamples(
    observation.samples.a,
    observation.counts.a,
    configuration.detector.maxValidPerGroup,
    "report.observation.samples.a",
  );
  validateSamples(
    observation.samples.b,
    observation.counts.b,
    configuration.detector.maxValidPerGroup,
    "report.observation.samples.b",
  );
  validateWarmupRecords(observation.warmupRecords, "report.observation.warmupRecords");
}

function validateInference(inference, observation) {
  requireExactKeys(inference, [
    "displayVerdict",
    "explanation",
    "lookHistory",
    "provenance",
    "sensitivityMs",
    "statistics",
    "verdict",
    "warnings",
  ], "report.inference");
  if (inference.provenance !== "inference") {
    invalid("report.inference.provenance", "must identify inference provenance");
  }
  if (!VERDICTS.has(inference.verdict)) {
    invalid("report.inference.verdict", "is not a known verdict");
  }
  if (inference.sensitivityMs !== null) {
    requireNonNegativeNumber(inference.sensitivityMs, "report.inference.sensitivityMs");
  }
  if (inference.verdict === VERDICT.NO_LEAK_DETECTED && inference.sensitivityMs === null) {
    invalid("report.inference.sensitivityMs", "is required for NO_LEAK_DETECTED");
  }
  const expectedDisplay = formatVerdict({
    sensitivityMs: inference.sensitivityMs,
    verdict: inference.verdict,
  });
  if (inference.displayVerdict !== expectedDisplay) {
    invalid("report.inference.displayVerdict", "does not match formatVerdict output");
  }
  requireString(inference.explanation, "report.inference.explanation");
  validateStatistics(inference.statistics, "report.inference.statistics");
  requireArray(inference.lookHistory, "report.inference.lookHistory");
  inference.lookHistory.forEach((look, index) => {
    validateLook(look, `report.inference.lookHistory[${index}]`);
  });
  validateWarnings(inference.warnings, "report.inference.warnings");

  if (observation.stopReason === STOP_REASON.LEAK_DETECTED
    && inference.verdict !== VERDICT.LEAK) {
    invalid("report.observation.stopReason", "is incompatible with the verdict");
  }
  if (observation.stopReason === STOP_REASON.MAX_SAMPLES_NO_LEAK
    && inference.verdict !== VERDICT.NO_LEAK_DETECTED) {
    invalid("report.observation.stopReason", "is incompatible with the verdict");
  }
  if (observation.stopReason !== STOP_REASON.LEAK_DETECTED
    && observation.stopReason !== STOP_REASON.MAX_SAMPLES_NO_LEAK
    && inference.verdict !== VERDICT.INCONCLUSIVE) {
    invalid("report.observation.stopReason", "is incompatible with the verdict");
  }
}

export function validateRunReport(report) {
  requireObject(report, "report");
  rejectSensitiveKeys(report);
  requireExactKeys(report, [
    "buildVersion",
    "configuration",
    "detectorVersion",
    "inference",
    "observation",
    "schemaVersion",
  ], "report");
  if (report.schemaVersion !== REPORT_SCHEMA_VERSION) {
    invalid("report.schemaVersion", `must equal ${REPORT_SCHEMA_VERSION}`);
  }
  requireString(report.detectorVersion, "report.detectorVersion");
  requireString(report.buildVersion, "report.buildVersion");
  validateConfiguration(report.configuration);
  validateObservation(report.observation, report.configuration);
  validateInference(report.inference, report.observation);
  return report;
}

function copyDetectorConfig(config) {
  requireObject(config, "detectorConfig");
  requireExactKeys(config, DETECTOR_CONFIG_FIELDS, "detectorConfig");
  return Object.fromEntries(DETECTOR_CONFIG_FIELDS.map((field) => [field, config[field]]));
}

function copyNoiseConfig(noise) {
  requireObject(noise, "noise");
  requireExactKeys(noise, NOISE_FIELDS, "noise");
  const output = { presetId: noise.presetId };
  if ("benchmarkStatus" in noise) {
    output.benchmarkStatus = noise.benchmarkStatus;
  }
  if ("jitter" in noise) {
    output.jitter = noise.jitter;
  }
  if ("seed" in noise) {
    output.seed = noise.seed;
  }
  if ("spikeMultiplier" in noise) {
    output.spikeMultiplier = noise.spikeMultiplier;
  }
  if ("spikeProbability" in noise) {
    output.spikeProbability = noise.spikeProbability;
  }
  return output;
}

function safeCounts(counts) {
  requireObject(counts, "detectorResult.counts");
  return {
    a: { ...counts.a, discardReasons: { ...counts.a.discardReasons } },
    b: { ...counts.b, discardReasons: { ...counts.b.discardReasons } },
  };
}

function safeTransportResult(result) {
  if (!isObject(result)) {
    return { kind: "discarded", reason: "error" };
  }
  const safe = { kind: result.kind };
  for (const field of ["durationMs", "errorCode", "reason", "statusCode"]) {
    if (field in result) {
      safe[field] = result[field];
    }
  }
  return safe;
}

function safeWarmupRecords(records) {
  requireArray(records, "detectorResult.warmupRecords");
  return records.map((record) => ({
    label: record.label,
    result: safeTransportResult(record.result),
  }));
}

function safeStatistics(statistics) {
  if (statistics === null || statistics === undefined) {
    return null;
  }
  return {
    lowPercentile: {
      absoluteDelta: statistics.lowPercentile.absoluteDelta,
      a: statistics.lowPercentile.a,
      b: statistics.lowPercentile.b,
      method: statistics.lowPercentile.method,
      probability: statistics.lowPercentile.probability,
      signedDelta: statistics.lowPercentile.signedDelta,
    },
    mannWhitney: {
      degenerate: statistics.mannWhitney.degenerate,
      pValue: statistics.mannWhitney.pValue,
      tieGroups: [...statistics.mannWhitney.tieGroups],
      uA: statistics.mannWhitney.uA,
      uB: statistics.mannWhitney.uB,
      variance: statistics.mannWhitney.variance,
      z: statistics.mannWhitney.z,
    },
  };
}

function safeSensitivity(sensitivity) {
  if (sensitivity === null || sensitivity === undefined) {
    return null;
  }
  if (sensitivity.available === false) {
    return { available: false, reason: sensitivity.reason };
  }
  return {
    alphaQuantile: sensitivity.alphaQuantile,
    available: true,
    bootstrapReplicates: sensitivity.bootstrapReplicates,
    bootstrapSeedDomain: sensitivity.bootstrapSeedDomain,
    powerQuantile: sensitivity.powerQuantile,
    sensitivityMs: sensitivity.sensitivityMs,
    standardError: sensitivity.standardError,
  };
}

function safeQuality(quality) {
  return {
    discardRates: {
      a: quality.discardRates.a,
      b: quality.discardRates.b,
    },
    passes: quality.passes,
    warnings: normalizeWarnings(quality.warnings, "detectorResult.lookHistory.quality.warnings"),
  };
}

function safeLook(look) {
  return {
    alphaAtLook: look.alphaAtLook,
    counts: safeCounts(look.counts),
    lookIndex: look.lookIndex,
    maxLooks: look.maxLooks,
    quality: safeQuality(look.quality),
    sensitivity: safeSensitivity(look.sensitivity),
    sensitivityMs: look.sensitivityMs,
    statistics: safeStatistics(look.statistics),
    verdict: look.verdict,
  };
}

function safeLookHistory(lookHistory) {
  requireArray(lookHistory, "detectorResult.lookHistory");
  return lookHistory.map((look) => safeLook(look));
}

function explainVerdict(detectorResult) {
  if (detectorResult.verdict === VERDICT.LEAK) {
    return "The observed A/B timing difference met the statistical and practical effect criteria.";
  }
  if (detectorResult.verdict === VERDICT.NO_LEAK_DETECTED) {
    return `No leak was detected at or above the measured sensitivity of ${detectorResult.sensitivityMs} ms.`;
  }
  return `The run was inconclusive and stopped because of ${detectorResult.stopReason}.`;
}

export function createRunReport({
  buildVersion,
  detectorConfig,
  detectorResult,
  detectorVersion,
  endedAt,
  noise,
  requestMetadata,
  requestTemplateIds,
  runSeed,
  startedAt,
  target,
  requestWarnings = [],
  warnings = [],
} = {}) {
  requireObject(detectorResult, "detectorResult");
  requireObject(target, "target");
  requireObject(requestMetadata, "requestMetadata");
  requireObject(requestTemplateIds, "requestTemplateIds");
  const seed = runSeed === undefined ? detectorResult.seed : runSeed;
  const lookHistory = safeLookHistory(detectorResult.lookHistory);
  const finalLook = lookHistory.at(-1);
  const detectorWarnings = normalizeWarnings(detectorResult.warnings ?? [], "detectorResult.warnings");
  const suppliedRequestWarnings = normalizeWarnings(requestWarnings, "requestWarnings");
  const suppliedWarnings = normalizeWarnings(warnings, "warnings");
  const allWarnings = [...detectorWarnings, ...suppliedRequestWarnings, ...suppliedWarnings];
  const report = {
    buildVersion,
    configuration: {
      detector: copyDetectorConfig(detectorConfig),
      noise: copyNoiseConfig(noise),
      provenance: "configuration",
      requestTemplateIds: {
        a: requestTemplateIds.a,
        b: requestTemplateIds.b,
      },
      seed,
      target: {
        id: target.id,
        kind: target.kind,
        redactedMetadata: {
          a: redactRequestMetadata(requestMetadata.a),
          b: redactRequestMetadata(requestMetadata.b),
        },
      },
    },
    detectorVersion,
    inference: {
      displayVerdict: formatVerdict(detectorResult),
      explanation: explainVerdict(detectorResult),
      lookHistory,
      provenance: "inference",
      sensitivityMs: detectorResult.sensitivityMs,
      statistics: finalLook?.statistics ?? null,
      verdict: detectorResult.verdict,
      warnings: allWarnings,
    },
    observation: {
      counts: safeCounts(detectorResult.counts),
      endedAt,
      expectedStatus: detectorResult.expectedStatus,
      provenance: "observation",
      samples: {
        a: [...detectorResult.samples.a],
        b: [...detectorResult.samples.b],
      },
      startedAt,
      stopReason: detectorResult.stopReason,
      warmupRecords: safeWarmupRecords(detectorResult.warmupRecords),
    },
    schemaVersion: REPORT_SCHEMA_VERSION,
  };
  validateRunReport(report);
  return report;
}

export const buildRunReport = createRunReport;
