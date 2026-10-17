import { createSeededPrng } from "../prng.js";
import {
  inferLook,
  maxLooks,
  qualitySnapshot,
  VERDICT,
} from "../inference/verdict.js";

const SAMPLING_SEED_DOMAIN = "sampling";

export const STOP_REASON = Object.freeze({
  ABORTED: "aborted",
  BASELINE_STATUS_MISMATCH: "baseline-status-mismatch",
  DATA_QUALITY_FAILURE: "data-quality-failure",
  FATAL_TRANSPORT_ERROR: "fatal-transport-error",
  LEAK_DETECTED: "leak-detected",
  MAX_ATTEMPTS_INCONCLUSIVE: "max-attempts-inconclusive",
  MAX_SAMPLES_INCONCLUSIVE: "max-samples-inconclusive",
  MAX_SAMPLES_NO_LEAK: "max-samples-no-leak",
  SENSITIVITY_UNAVAILABLE: "sensitivity-unavailable",
  WARMUP_FAILED: "warmup-failed",
});

export class DetectorConfigurationError extends TypeError {
  constructor(message) {
    super(message);
    this.name = "DetectorConfigurationError";
    this.code = "CONFIGURATION_INVALID";
  }
}

function invalid(message) {
  throw new DetectorConfigurationError(message);
}

function integer(config, name, minimum) {
  if (!Number.isSafeInteger(config[name]) || config[name] < minimum) {
    invalid(`${name} must be an integer >= ${minimum}`);
  }
}

export function validateDetectorConfig(config) {
  if (!config || typeof config !== "object") {
    invalid("config is required");
  }
  if ("warmupPairs" in config) {
    invalid("warmup is fixed at exactly one pair; warmupPairs is not configurable");
  }
  if (!(typeof config.seed === "string" || Number.isSafeInteger(config.seed))) {
    invalid("seed must be a string or safe integer");
  }
  if (!Number.isFinite(config.quantile) || config.quantile <= 0 || config.quantile >= 1) {
    invalid("quantile must be between 0 and 1 exclusive");
  }
  if (!Number.isFinite(config.alphaTotal) || config.alphaTotal <= 0 || config.alphaTotal >= 1) {
    invalid("alphaTotal must be between 0 and 1 exclusive");
  }
  if (!Number.isFinite(config.targetPower) || config.targetPower <= 0.5 || config.targetPower >= 1) {
    invalid("targetPower must be between 0.5 and 1 exclusive");
  }
  integer(config, "bootstrapReplicates", 2);
  integer(config, "minValidPerGroup", 1);
  integer(config, "lookBatchPerGroup", 1);
  integer(config, "maxValidPerGroup", config.minValidPerGroup);
  if (config.maxValidPerGroup % config.lookBatchPerGroup !== 0) {
    invalid("maxValidPerGroup must be divisible by lookBatchPerGroup");
  }
  integer(config, "minAttemptsForDiscardRate", 1);
  integer(config, "maxAttempts", 1);
  if (config.maxAttempts < 2 + (2 * config.maxValidPerGroup)) {
    invalid("maxAttempts must cover warmup and the maximum valid sample budget");
  }
  if (!Number.isFinite(config.maxDiscardRate) || config.maxDiscardRate < 0 || config.maxDiscardRate > 1) {
    invalid("maxDiscardRate must be between 0 and 1");
  }
  if (!Number.isFinite(config.materialDiscardRateDifference)
    || config.materialDiscardRateDifference < 0
    || config.materialDiscardRateDifference > 1) {
    invalid("materialDiscardRateDifference must be between 0 and 1");
  }
  integer(config, "maxConsecutiveFailures", 1);
  return config;
}

function deriveSamplingSeed(seed) {
  return JSON.stringify(["black-box-timing-leak-detector", SAMPLING_SEED_DOMAIN, seed]);
}

function emptyGroupCounts() {
  return { accepted: 0, attempts: 0, discarded: 0, discardReasons: {} };
}

function createCounts() {
  return { a: emptyGroupCounts(), b: emptyGroupCounts() };
}

function recordResult(count, result, samples) {
  count.attempts += 1;
  if (result?.kind === "accepted" && Number.isFinite(result.durationMs)) {
    count.accepted += 1;
    samples.push(result.durationMs);
    return;
  }
  count.discarded += 1;
  const reason = result?.reason ?? "error";
  count.discardReasons[reason] = (count.discardReasons[reason] ?? 0) + 1;
}

function cloneCounts(counts) {
  return JSON.parse(JSON.stringify(counts));
}

function emptyResult(seed, stopReason, counts, warmupRecords, samples, lookHistory, warnings = []) {
  return {
    counts,
    expectedStatus: null,
    lookHistory,
    samples,
    seed,
    sensitivityMs: null,
    stopReason,
    verdict: VERDICT.INCONCLUSIVE,
    warmupRecords,
    warnings,
  };
}

function isTransportFailure(result) {
  return result?.kind === "discarded"
    && (result.reason === "error" || result.reason === "timeout");
}

function assertPair(requests) {
  if (!requests || typeof requests !== "object" || !requests.a || !requests.b) {
    invalid("requests must contain A and B");
  }
}

function assertSend(send) {
  if (typeof send !== "function") {
    invalid("send must be a function");
  }
}

function assertAbortSignal(signal) {
  if (signal !== undefined && (!signal || typeof signal.aborted !== "boolean")) {
    invalid("signal must be an AbortSignal");
  }
}

function assertProgress(onProgress) {
  if (typeof onProgress !== "function") {
    invalid("onProgress must be a function");
  }
}

function statusOf(result) {
  return Number.isInteger(result?.statusCode) ? result.statusCode : null;
}

async function yieldToEventLoop() {
  await new Promise((resolve) => setImmediate(resolve));
}

function progressSnapshot({ counts, lookHistory, samples, warmupRecords }) {
  return {
    accepted: { a: samples.a.length, b: samples.b.length },
    counts: cloneCounts(counts),
    lookHistory: lookHistory.length,
    warmupRecords: warmupRecords.length,
  };
}

/** Run one seeded, sequentially interleaved detector comparison. */
export async function runDetector({
  config,
  onProgress = () => {},
  requests,
  send,
  signal,
} = {}) {
  validateDetectorConfig(config);
  assertPair(requests);
  assertSend(send);
  assertAbortSignal(signal);
  assertProgress(onProgress);

  const prng = createSeededPrng(deriveSamplingSeed(config.seed));
  const counts = createCounts();
  const samples = { a: [], b: [] };
  const warmupRecords = [];
  const lookHistory = [];
  const warnings = [];
  let expectedStatus = null;
  let consecutiveFailures = 0;
  let lastSensitivityMs = null;

  const final = (stopReason, verdict = VERDICT.INCONCLUSIVE, sensitivityMs = null) => ({
    counts,
    expectedStatus,
    lookHistory,
    samples,
    seed: config.seed,
    sensitivityMs,
    stopReason,
    verdict,
    warmupRecords,
    warnings,
  });

  const sendOne = async (label, request, expected) => {
    try {
      const result = await send(request, { expectedStatus: expected, signal });
      return result;
    } catch (error) {
      if (signal?.aborted) {
        return { kind: "aborted" };
      }
      throw error;
    }
  };

  if (signal?.aborted) {
    return final(STOP_REASON.ABORTED);
  }

  const warmupLabels = prng.nextInt(0, 2) === 0 ? ["a", "b"] : ["b", "a"];
  for (const label of warmupLabels) {
    if (signal?.aborted) {
      return final(STOP_REASON.ABORTED);
    }
    let result;
    try {
      result = await sendOne(label, requests[label], undefined);
    } catch {
      return final(STOP_REASON.FATAL_TRANSPORT_ERROR);
    }
    warmupRecords.push({ label, result });
    if (result?.kind === "aborted" || signal?.aborted) {
      return final(STOP_REASON.ABORTED);
    }
    if (result?.kind !== "accepted" || statusOf(result) === null) {
      if (isTransportFailure(result)) {
        consecutiveFailures += 1;
      }
      if (consecutiveFailures >= config.maxConsecutiveFailures) {
        return final(STOP_REASON.FATAL_TRANSPORT_ERROR);
      }
      return final(STOP_REASON.WARMUP_FAILED);
    }
    consecutiveFailures = 0;
  }

  const warmupStatuses = warmupRecords.map(({ result }) => statusOf(result));
  if (warmupStatuses[0] !== warmupStatuses[1]) {
    return final(STOP_REASON.BASELINE_STATUS_MISMATCH);
  }
  expectedStatus = warmupStatuses[0];

  onProgress(progressSnapshot({ counts, lookHistory, samples, warmupRecords }));

  while (samples.a.length < config.maxValidPerGroup
    || samples.b.length < config.maxValidPerGroup) {
    if (signal?.aborted) {
      return final(STOP_REASON.ABORTED);
    }
    if (counts.a.attempts + counts.b.attempts + 2 > config.maxAttempts) {
      return final(STOP_REASON.MAX_ATTEMPTS_INCONCLUSIVE);
    }

    const labels = prng.nextInt(0, 2) === 0 ? ["a", "b"] : ["b", "a"];
    for (const label of labels) {
      if (signal?.aborted) {
        return final(STOP_REASON.ABORTED);
      }
      let result;
      try {
        result = await sendOne(label, requests[label], expectedStatus);
      } catch {
        return final(STOP_REASON.FATAL_TRANSPORT_ERROR);
      }
      if (result?.kind === "aborted" || signal?.aborted) {
        return final(STOP_REASON.ABORTED);
      }
      recordResult(counts[label], result, samples[label]);
      if (isTransportFailure(result)) {
        consecutiveFailures += 1;
      } else {
        consecutiveFailures = 0;
      }
      if (consecutiveFailures >= config.maxConsecutiveFailures) {
        return final(STOP_REASON.FATAL_TRANSPORT_ERROR);
      }
    }

    await yieldToEventLoop();
    onProgress(progressSnapshot({ counts, lookHistory, samples, warmupRecords }));

    const roundQuality = qualitySnapshot(counts, config);
    for (const warning of roundQuality.warnings) {
      if (!warnings.some(({ code }) => code === warning.code)) {
        warnings.push(warning);
      }
    }
    if (!roundQuality.passes) {
      return final(STOP_REASON.DATA_QUALITY_FAILURE);
    }

    const validA = samples.a.length;
    const validB = samples.b.length;
    const lookReady = validA > 0
      && validB > 0
      && validA % config.lookBatchPerGroup === 0
      && validB % config.lookBatchPerGroup === 0;
    const finalLook = validA === config.maxValidPerGroup
      && validB === config.maxValidPerGroup;
    if (!lookReady && !finalLook) {
      continue;
    }

    const lookIndex = Math.min(
      maxLooks(config),
      Math.max(validA, validB) / config.lookBatchPerGroup,
    );
    const inference = inferLook({
      aSamples: samples.a,
      bSamples: samples.b,
      config,
      counts,
      forceSensitivity: finalLook,
      lookIndex,
      runSeed: config.seed,
    });
    warnings.push(...inference.quality.warnings);
    if (inference.sensitivity?.available) {
      lastSensitivityMs = inference.sensitivity.sensitivityMs;
    }
    lookHistory.push({
      ...inference,
      counts: cloneCounts(counts),
      sensitivity: inference.sensitivity,
    });

    if (!inference.quality.passes) {
      return final(STOP_REASON.DATA_QUALITY_FAILURE, VERDICT.INCONCLUSIVE, null);
    }
    if (inference.sensitivity?.available === false) {
      return final(STOP_REASON.SENSITIVITY_UNAVAILABLE, VERDICT.INCONCLUSIVE, null);
    }
    if (inference.verdict === VERDICT.LEAK) {
      return final(STOP_REASON.LEAK_DETECTED, VERDICT.LEAK, inference.sensitivityMs);
    }
    if (inference.verdict === VERDICT.NO_LEAK_DETECTED) {
      return final(STOP_REASON.MAX_SAMPLES_NO_LEAK, VERDICT.NO_LEAK_DETECTED, inference.sensitivityMs);
    }
  }

  return final(STOP_REASON.MAX_SAMPLES_INCONCLUSIVE, VERDICT.INCONCLUSIVE, lastSensitivityMs);
}
