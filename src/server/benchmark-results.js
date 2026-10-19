// Schema 1.0 mirrors bench/run.js without importing its process/HTTP dependencies.
const TARGETS = ["vulnerable", "fixed"];
const PRESETS = ["none", "low", "high"];
const STOP_REASONS = [
  "aborted", "baseline-status-mismatch", "data-quality-failure", "fatal-transport-error",
  "leak-detected", "max-attempts-inconclusive", "max-samples-inconclusive",
  "max-samples-no-leak", "sensitivity-unavailable", "warmup-failed",
];

function requireValue(condition, path) {
  if (!condition) {
    throw new TypeError(`benchmark artifact ${path} is invalid`);
  }
}

function object(value, path) {
  requireValue(value !== null && typeof value === "object" && !Array.isArray(value), path);
}

function string(value, path, allowEmpty = false) {
  requireValue(typeof value === "string" && (allowEmpty || value.length > 0), path);
}

function count(value, path, minimum = 0) {
  requireValue(Number.isSafeInteger(value) && value >= minimum, path);
}

function number(value, path, maximum = Infinity) {
  requireValue(Number.isFinite(value) && value >= 0 && value <= maximum, path);
}

function nullableNumber(value, path) {
  if (value !== null) number(value, path);
}

function uniqueStrings(value, path, allowed) {
  requireValue(Array.isArray(value) && value.length > 0, path);
  for (const entry of value) {
    string(entry, path);
    if (allowed) requireValue(allowed.includes(entry), path);
  }
  requireValue(new Set(value).size === value.length, path);
}

function validateDetector(config) {
  const path = "provenance.detectorConfig";
  object(config, path);
  for (const key of ["alphaTotal", "quantile", "targetPower"]) {
    number(config[key], `${path}.${key}`, 1);
    requireValue(config[key] > (key === "targetPower" ? 0.5 : 0) && config[key] < 1, `${path}.${key}`);
  }
  for (const key of ["materialDiscardRateDifference", "maxDiscardRate"]) {
    number(config[key], `${path}.${key}`, 1);
  }
  for (const key of [
    "bootstrapReplicates", "lookBatchPerGroup", "maxAttempts", "maxConsecutiveFailures",
    "maxValidPerGroup", "minAttemptsForDiscardRate", "minValidPerGroup",
  ]) count(config[key], `${path}.${key}`, key === "bootstrapReplicates" ? 2 : 1);
  requireValue(config.maxValidPerGroup >= config.minValidPerGroup
    && config.maxValidPerGroup % config.lookBatchPerGroup === 0
    && config.maxAttempts >= 2 + (2 * config.maxValidPerGroup), path);
  requireValue(!("warmupPairs" in config), path);
  if ("seed" in config) {
    requireValue(typeof config.seed === "string" || Number.isSafeInteger(config.seed), `${path}.seed`);
  }
}

function validateProvenance(provenance) {
  object(provenance, "provenance");
  for (const key of [
    "benchmarkStatus", "codeCommit", "cpu", "nodeVersion", "packageVersion", "runnerCommand", "notes",
  ]) string(provenance[key], `provenance.${key}`, key === "notes");
  count(provenance.cpuCount, "provenance.cpuCount");
  count(provenance.trialTimeoutMs, "provenance.trialTimeoutMs", 1);
  requireValue(typeof provenance.smoke === "boolean", "provenance.smoke");
  requireValue(provenance.freshDemoProcessPerCell === true, "provenance.freshDemoProcessPerCell");
  requireValue(provenance.noiseSequenceStartsAtRequest === 1, "provenance.noiseSequenceStartsAtRequest");
  object(provenance.dependencies, "provenance.dependencies");
  for (const key of ["express", "undici"]) string(provenance.dependencies[key], `provenance.dependencies.${key}`);
  object(provenance.os, "provenance.os");
  for (const key of ["arch", "platform", "release"]) string(provenance.os[key], `provenance.os.${key}`);
  validateDetector(provenance.detectorConfig);
  object(provenance.baselineConfig, "provenance.baselineConfig");
  nullableNumber(provenance.baselineConfig.thresholdMs, "provenance.baselineConfig.thresholdMs");
  string(provenance.baselineConfig.note, "provenance.baselineConfig.note",
    provenance.baselineConfig.thresholdMs === null);

  const matrix = provenance.matrix;
  object(matrix, "provenance.matrix");
  uniqueStrings(matrix.targets, "provenance.matrix.targets", TARGETS);
  uniqueStrings(matrix.noisePresets, "provenance.matrix.noisePresets", PRESETS);
  uniqueStrings(matrix.seeds, "provenance.matrix.seeds");
  uniqueStrings(provenance.trialSeeds, "provenance.trialSeeds");
  requireValue(matrix.seeds.length === provenance.trialSeeds.length
    && matrix.seeds.every((seed, index) => seed === provenance.trialSeeds[index]), "provenance.trialSeeds");
  count(matrix.trialsPerSeed, "provenance.matrix.trialsPerSeed", 1);
  object(provenance.noiseConfigs, "provenance.noiseConfigs");
  requireValue(Object.keys(provenance.noiseConfigs).length === matrix.noisePresets.length,
    "provenance.noiseConfigs");
  for (const presetId of matrix.noisePresets) {
    const config = provenance.noiseConfigs[presetId];
    const path = `provenance.noiseConfigs.${presetId}`;
    object(config, path);
    requireValue(config.presetId === presetId && config.benchmarkStatus === "TBD", path);
    count(config.jitter, `${path}.jitter`);
    count(config.spikeMultiplier, `${path}.spikeMultiplier`);
    number(config.spikeProbability, `${path}.spikeProbability`, 1);
    requireValue(config.jitter <= 50_000 && config.spikeMultiplier <= 8
      && config.jitter * config.spikeMultiplier <= 200_000, path);
    if (presetId === "none") {
      requireValue(config.jitter === 0 && config.spikeMultiplier === 0 && config.spikeProbability === 0, path);
    }
  }
  return matrix;
}

function cellKey(entry) {
  return `${entry.targetId}/${entry.noisePresetId}`;
}

function validateCounts(counts, path) {
  object(counts, path);
  let discarded = 0;
  let errors = 0;
  let attempts = 0;
  for (const label of ["a", "b"]) {
    const group = counts[label];
    object(group, `${path}.${label}`);
    for (const key of ["accepted", "attempts", "discarded"]) count(group[key], `${path}.${label}.${key}`);
    requireValue(group.accepted + group.discarded === group.attempts, `${path}.${label}`);
    object(group.discardReasons, `${path}.${label}.discardReasons`);
    let reasons = 0;
    for (const [reason, total] of Object.entries(group.discardReasons)) {
      requireValue(["error", "timeout", "unexpected-status", "status-mismatch"].includes(reason), `${path}.${label}.discardReasons`);
      count(total, `${path}.${label}.discardReasons.${reason}`, 1);
      reasons += total;
    }
    requireValue(reasons === group.discarded, `${path}.${label}.discardReasons`);
    discarded += group.discarded;
    errors += (group.discardReasons.error ?? 0) + (group.discardReasons.timeout ?? 0);
    attempts += group.attempts;
  }
  count(attempts, `${path}.totalAttempts`);
  return { attempts, discarded, errors };
}

function validateTrial(trial, index, provenance, cells) {
  const path = `trials[${index}]`;
  object(trial, path);
  requireValue(cells.has(cellKey(trial)), `${path}.cell`);
  requireValue(provenance.matrix.seeds.includes(trial.seed), `${path}.seed`);
  requireValue(["completed", "failed"].includes(trial.status), `${path}.status`);
  string(trial.seed, `${path}.seed`);
  count(trial.trialIndex, `${path}.trialIndex`);
  requireValue(trial.trialIndex < provenance.matrix.trialsPerSeed, `${path}.trialIndex`);
  number(trial.durationMs, `${path}.durationMs`);
  nullableNumber(trial.sensitivityMs, `${path}.sensitivityMs`);
  count(trial.discarded, `${path}.discarded`);
  count(trial.errors, `${path}.errors`);
  if ("errorCode" in trial) string(trial.errorCode, `${path}.errorCode`);
  if (trial.counts === null) {
    requireValue(trial.status === "failed" && trial.stopReason === "trial-failed"
      && trial.discarded === 0 && trial.errors === 1, path);
    string(trial.errorCode, `${path}.errorCode`);
  } else {
    const summary = validateCounts(trial.counts, `${path}.counts`);
    requireValue(trial.discarded === summary.discarded && trial.errors === summary.errors
      && summary.attempts <= provenance.detectorConfig.maxAttempts, `${path}.counts`);
  }
  if (trial.status === "failed") {
    requireValue(trial.verdict === null && trial.sensitivityMs === null
      && trial.stopReason === (trial.counts === null ? "trial-failed" : "timeout"), path);
  } else {
    requireValue(["LEAK", "NO_LEAK_DETECTED", "INCONCLUSIVE"].includes(trial.verdict), `${path}.verdict`);
    requireValue(STOP_REASONS.includes(trial.stopReason), `${path}.stopReason`);
    requireValue((trial.verdict === "LEAK") === (trial.stopReason === "leak-detected")
      && (trial.verdict === "NO_LEAK_DETECTED") === (trial.stopReason === "max-samples-no-leak"), path);
  }
}

function validateMetric(metric, trials, verdict, path) {
  object(metric, path);
  count(metric.successes, `${path}.successes`);
  count(metric.trials, `${path}.trials`);
  requireValue(metric.trials === trials.length
    && metric.successes === trials.filter((trial) => trial.verdict === verdict).length, path);
  // Validate stored bounds, without recalculating the runner's Wilson intervals.
  number(metric.rate, `${path}.rate`, 1);
  requireValue(metric.rate === metric.successes / metric.trials, `${path}.rate`);
  object(metric.wilson95, `${path}.wilson95`);
  number(metric.wilson95.lower, `${path}.wilson95.lower`, 1);
  number(metric.wilson95.upper, `${path}.wilson95.upper`, 1);
  requireValue(metric.wilson95.lower <= metric.rate && metric.rate <= metric.wilson95.upper,
    `${path}.wilson95`);
}

function validateAggregate(aggregate, index, trials) {
  const path = `aggregates[${index}]`;
  for (const key of ["trialCount", "completedCount", "failedCount"]) count(aggregate[key], `${path}.${key}`);
  requireValue(aggregate.trialCount === trials.length
    && aggregate.completedCount === trials.filter((trial) => trial.status === "completed").length
    && aggregate.failedCount === trials.filter((trial) => trial.status === "failed").length, path);
  validateMetric(aggregate.inconclusiveRate, trials, "INCONCLUSIVE", `${path}.inconclusiveRate`);
  const applicable = aggregate.targetId === "vulnerable" ? "detectionRate" : "falsePositiveRate";
  const inapplicable = aggregate.targetId === "vulnerable" ? "falsePositiveRate" : "detectionRate";
  validateMetric(aggregate[applicable], trials, "LEAK", `${path}.${applicable}`);
  requireValue(aggregate[inapplicable] === null, `${path}.${inapplicable}`);
}

function validateBaseline(entry, index, config) {
  const path = `baseline[${index}]`;
  requireValue(["unavailable", "completed", "failed"].includes(entry.status), `${path}.status`);
  string(entry.note, `${path}.note`, true);
  requireValue(entry.note === config.note && entry.thresholdMs === config.thresholdMs, `${path}.configuration`);
  requireValue(entry.samplesPerGroup === 20, `${path}.samplesPerGroup`);
  for (const key of ["absoluteDifferenceMs", "meanA", "meanB", "thresholdMs"]) nullableNumber(entry[key], `${path}.${key}`);
  requireValue(entry.flagged === null || typeof entry.flagged === "boolean", `${path}.flagged`);
  if (entry.status === "unavailable") {
    requireValue(config.thresholdMs === null && entry.seed === null
      && entry.meanA === null && entry.meanB === null && entry.absoluteDifferenceMs === null
      && entry.flagged === null, path);
    requireValue(!("durationMs" in entry) && !("failedRequests" in entry) && !("errorCode" in entry), path);
    return;
  }
  requireValue(config.thresholdMs !== null, `${path}.thresholdMs`);
  string(entry.seed, `${path}.seed`);
  number(entry.durationMs, `${path}.durationMs`);
  count(entry.failedRequests, `${path}.failedRequests`);
  requireValue(entry.failedRequests <= 40
    && (entry.status === "completed" ? entry.failedRequests === 0 : entry.failedRequests > 0), path);
  if ("errorCode" in entry) string(entry.errorCode, `${path}.errorCode`);
  if (entry.meanA === null || entry.meanB === null) {
    requireValue(entry.status === "failed" && entry.absoluteDifferenceMs === null && entry.flagged === null, path);
  } else {
    requireValue(entry.absoluteDifferenceMs === Math.abs(entry.meanA - entry.meanB)
      && entry.flagged === (entry.absoluteDifferenceMs >= entry.thresholdMs), path);
  }
}

/**
 * Validate a schema 1.0 runner artifact, returning it unchanged or throwing TypeError.
 * Unavailable artifacts must have null provenance and empty collections. Complete
 * and incomplete artifacts require a full, internally consistent recorded matrix;
 * only complete artifacts have a completed trial in every cell. No I/O or imports.
 */
export function validateBenchmarkArtifact(results) {
  object(results, "results");
  requireValue(results.schemaVersion === "1.0", "schemaVersion");
  requireValue(["unavailable", "incomplete", "complete"].includes(results.status), "status");
  for (const key of ["trials", "aggregates", "baseline"]) {
    requireValue(Array.isArray(results[key]), key);
  }
  if (results.status === "unavailable") {
    requireValue(results.provenance === null && results.trials.length === 0
      && results.aggregates.length === 0 && results.baseline.length === 0, "unavailable collections");
    string(results.reason, "reason");
    return results;
  }
  if (results.status === "complete") requireValue(results.reason === null, "reason");
  else string(results.reason, "reason");
  const matrix = validateProvenance(results.provenance);
  const expectedCells = matrix.targets.length * matrix.noisePresets.length;
  const trialsPerCell = matrix.seeds.length * matrix.trialsPerSeed;
  const totalTrials = expectedCells * trialsPerCell;
  count(totalTrials, "matrix trial count", 1);
  requireValue(results.trials.length === totalTrials && results.aggregates.length === expectedCells
    && results.baseline.length === expectedCells, "matrix coverage");
  const cells = new Map(matrix.targets.flatMap((targetId) => matrix.noisePresets.map((noisePresetId) => [
    cellKey({ targetId, noisePresetId }), [],
  ])));
  for (const [index, trial] of results.trials.entries()) {
    validateTrial(trial, index, results.provenance, cells);
    cells.get(cellKey(trial)).push(trial);
  }
  for (const trials of cells.values()) {
    requireValue(trials.length === trialsPerCell, "trial cell coverage");
    const combinations = new Set();
    for (const trial of trials) {
      combinations.add(`${trial.seed}\u0000${trial.trialIndex}`);
    }
    requireValue(combinations.size === trialsPerCell, "trial combination coverage");
    for (const seed of matrix.seeds) {
      for (let trialIndex = 0; trialIndex < matrix.trialsPerSeed; trialIndex += 1) {
        requireValue(combinations.has(`${seed}\u0000${trialIndex}`), "trial combination coverage");
      }
    }
  }
  for (const collection of ["aggregates", "baseline"]) {
    const seen = new Set();
    for (const [index, entry] of results[collection].entries()) {
      object(entry, `${collection}[${index}]`);
      const key = cellKey(entry);
      requireValue(cells.has(key) && !seen.has(key), `${collection} cell coverage`);
      seen.add(key);
      if (collection === "aggregates") validateAggregate(entry, index, cells.get(key));
      else validateBaseline(entry, index, results.provenance.baselineConfig);
    }
  }
  const complete = results.aggregates.every((aggregate) => aggregate.completedCount > 0);
  requireValue(complete === (results.status === "complete"), "status/completed cells");
  return results;
}
