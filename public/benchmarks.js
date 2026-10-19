const BENCHMARK_UNAVAILABLE_MESSAGE = "benchmark data not yet available";

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function displayValue(value) {
  if (value === null || value === undefined || value === "") {
    return "unavailable";
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : "unavailable";
  }
  if (typeof value === "boolean") {
    return value ? "yes" : "no";
  }
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return "unavailable";
  }
}

function formatList(value) {
  return Array.isArray(value) && value.length > 0
    ? value.map((entry) => displayValue(entry)).join(", ")
    : "unavailable";
}

function formatMetric(metric) {
  if (!isObject(metric)) {
    return "unavailable";
  }
  const rate = Number.isFinite(metric.rate) ? `${(metric.rate * 100).toFixed(1)}%` : "unavailable";
  const successes = Number.isSafeInteger(metric.successes) ? metric.successes : "unavailable";
  const trials = Number.isSafeInteger(metric.trials) ? metric.trials : "unavailable";
  const interval = metric.wilson95;
  const intervalText = isObject(interval)
    && Number.isFinite(interval.lower)
    && Number.isFinite(interval.upper)
    ? `; 95% Wilson CI ${(interval.lower * 100).toFixed(1)}%–${(interval.upper * 100).toFixed(1)}%`
    : "; 95% Wilson CI unavailable";
  return `${rate} (${successes}/${trials})${intervalText}`;
}

function milliseconds(value) {
  return Number.isFinite(value) ? `${value} ms` : "unavailable";
}

function appendDefinitions(documentRef, container, entries) {
  const list = documentRef.createElement("dl");
  list.className = "evidence-list";
  for (const [label, value] of entries) {
    const item = documentRef.createElement("div");
    const term = documentRef.createElement("dt");
    const description = documentRef.createElement("dd");
    term.textContent = label;
    description.textContent = displayValue(value);
    item.append(term, description);
    list.append(item);
  }
  container.append(list);
}

function renderProvenance(documentRef, container, provenance, schemaVersion, trials) {
  const matrix = isObject(provenance.matrix) ? provenance.matrix : {};
  const operatingSystem = isObject(provenance.os) ? provenance.os : {};
  appendDefinitions(documentRef, container, [
    ["Benchmark status", provenance.benchmarkStatus],
    ["Schema version", schemaVersion],
    ["Git commit", provenance.codeCommit],
    ["Package version", provenance.packageVersion],
    ["Node version", provenance.nodeVersion],
    ["Express version", provenance.dependencies.express],
    ["Undici version", provenance.dependencies.undici],
    ["Runner command", provenance.runnerCommand],
    ["CPU", provenance.cpu],
    ["CPU count", provenance.cpuCount],
    ["Operating system", `${displayValue(operatingSystem.platform)} ${displayValue(operatingSystem.release)} (${displayValue(operatingSystem.arch)})`],
    ["Smoke run", provenance.smoke],
    ["Notes", provenance.notes],
    ["Trial seeds", formatList(provenance.trialSeeds)],
    ["Matrix seeds", formatList(matrix.seeds)],
    ["Run seeds", formatList(trials.map((trial) => trial.seed))],
    ["Targets", formatList(matrix.targets)],
    ["Noise presets", formatList(matrix.noisePresets)],
    ["Trials per seed", matrix.trialsPerSeed],
    ["Trial timeout", milliseconds(provenance.trialTimeoutMs)],
    ["Fresh demo process per cell", provenance.freshDemoProcessPerCell],
    ["Noise sequence starts at request", provenance.noiseSequenceStartsAtRequest],
    ["Detector configuration", provenance.detectorConfig],
    ["Baseline configuration", provenance.baselineConfig],
    ["Noise configuration", provenance.noiseConfigs],
  ]);
}

function renderAggregates(documentRef, container, aggregates) {
  const cells = Array.isArray(aggregates) ? aggregates : [];
  const sections = cells.map((aggregate) => {
    const section = documentRef.createElement("section");
    const heading = documentRef.createElement("h4");
    heading.textContent = `${displayValue(aggregate?.targetId)} / ${displayValue(aggregate?.noisePresetId)}`;
    section.append(heading);
    appendDefinitions(documentRef, section, [
      ["Trial count", aggregate?.trialCount],
      ["Completed count", aggregate?.completedCount],
      ["Failed count", aggregate?.failedCount],
      ["Detection rate", formatMetric(aggregate?.detectionRate)],
      ["False-positive rate", formatMetric(aggregate?.falsePositiveRate)],
      ["Inconclusive rate", formatMetric(aggregate?.inconclusiveRate)],
    ]);
    return section;
  });
  container.replaceChildren(...sections);
}

function renderBaseline(documentRef, container, baseline) {
  const cells = Array.isArray(baseline) ? baseline : [];
  const sections = cells.map((entry) => {
    const section = documentRef.createElement("section");
    const heading = documentRef.createElement("h4");
    heading.textContent = `${displayValue(entry?.targetId)} / ${displayValue(entry?.noisePresetId)}`;
    section.append(heading);
    appendDefinitions(documentRef, section, [
      ["Status", entry?.status],
      ["Mean A", milliseconds(entry?.meanA)],
      ["Mean B", milliseconds(entry?.meanB)],
      ["Absolute difference", milliseconds(entry?.absoluteDifferenceMs)],
      ["Threshold", milliseconds(entry?.thresholdMs)],
      ["Flagged", entry?.flagged],
      ["Samples per group", entry?.samplesPerGroup],
      ["Failed requests", entry?.failedRequests],
      ["Duration", milliseconds(entry?.durationMs)],
      ["Seed", entry?.seed],
      ["Note", entry?.note],
    ]);
    return section;
  });
  container.replaceChildren(...sections);
}

function isCompleteResults(results) {
  // The fixed server route validates the full artifact. These checks also keep
  // malformed/truncated responses from being presented as a complete browser run.
  if (!isObject(results) || results.schemaVersion !== "1.0" || results.status !== "complete"
    || results.reason !== null || !isObject(results.provenance)) return false;
  const provenance = results.provenance;
  const matrix = provenance.matrix;
  if (!isObject(matrix) || !isObject(provenance.dependencies) || !isObject(provenance.os)
    || !isObject(provenance.detectorConfig) || !isObject(provenance.baselineConfig)
    || !isObject(provenance.noiseConfigs)) return false;
  if (!["benchmarkStatus", "codeCommit", "cpu", "nodeVersion", "packageVersion", "runnerCommand", "notes"]
    .every((key) => typeof provenance[key] === "string")
    || !Number.isSafeInteger(provenance.cpuCount) || provenance.cpuCount < 0
    || !Number.isSafeInteger(provenance.trialTimeoutMs) || provenance.trialTimeoutMs < 1
    || typeof provenance.smoke !== "boolean"
    || provenance.freshDemoProcessPerCell !== true
    || provenance.noiseSequenceStartsAtRequest !== 1
    || typeof provenance.dependencies.express !== "string"
    || typeof provenance.dependencies.undici !== "string"
    || !["arch", "platform", "release"].every((key) => typeof provenance.os[key] === "string")) return false;
  const detector = provenance.detectorConfig;
  const detectorNumbers = [
    "alphaTotal", "materialDiscardRateDifference", "maxDiscardRate", "quantile", "targetPower",
  ];
  const detectorCounts = [
    "bootstrapReplicates", "lookBatchPerGroup", "maxAttempts", "maxConsecutiveFailures",
    "maxValidPerGroup", "minAttemptsForDiscardRate", "minValidPerGroup",
  ];
  if (!detectorNumbers.every((key) => Number.isFinite(detector[key]))
    || !detectorCounts.every((key) => Number.isSafeInteger(detector[key]) && detector[key] >= 1)) return false;
  const baselineConfig = provenance.baselineConfig;
  if (!((baselineConfig.thresholdMs === null || Number.isFinite(baselineConfig.thresholdMs))
    && typeof baselineConfig.note === "string")) return false;
  const strings = (values) => Array.isArray(values) && values.length > 0
    && values.every((value) => typeof value === "string" && value.length > 0)
    && new Set(values).size === values.length;
  if (!strings(matrix.targets) || !matrix.targets.every((target) => ["vulnerable", "fixed"].includes(target))
    || !strings(matrix.noisePresets) || !matrix.noisePresets.every((preset) => ["none", "low", "high"].includes(preset))
    || !strings(matrix.seeds) || !strings(provenance.trialSeeds)
    || matrix.seeds.length !== provenance.trialSeeds.length
    || !matrix.seeds.every((seed, index) => seed === provenance.trialSeeds[index])
    || !Number.isSafeInteger(matrix.trialsPerSeed) || matrix.trialsPerSeed < 1) return false;
  for (const key of ["trials", "aggregates", "baseline"]) {
    if (!Array.isArray(results[key]) || results[key].length === 0 || !results[key].every(isObject)) return false;
  }
  const keys = new Set(matrix.targets.flatMap((target) => matrix.noisePresets.map((preset) => `${target}/${preset}`)));
  const keyOf = (entry) => `${entry.targetId}/${entry.noisePresetId}`;
  const perCell = matrix.seeds.length * matrix.trialsPerSeed;
  if (!Number.isSafeInteger(perCell * keys.size) || results.trials.length !== perCell * keys.size
    || results.aggregates.length !== keys.size || results.baseline.length !== keys.size) return false;
  if (!results.trials.every((trial) => keys.has(keyOf(trial))
    && ["completed", "failed"].includes(trial.status)
    && (trial.status === "completed" ? ["LEAK", "NO_LEAK_DETECTED", "INCONCLUSIVE"].includes(trial.verdict) : trial.verdict === null)
    && typeof trial.seed === "string" && trial.seed.length > 0
    && Number.isSafeInteger(trial.trialIndex) && trial.trialIndex >= 0 && trial.trialIndex < matrix.trialsPerSeed)) return false;
  const optionalNumber = (value, maximum = Infinity) => value === null || value === undefined
    || (Number.isFinite(value) && value >= 0 && value <= maximum);
  const metricShape = (metric, total) => isObject(metric)
    && Number.isSafeInteger(metric.successes) && metric.successes >= 0 && metric.successes <= total
    && metric.trials === total && Number.isFinite(metric.rate) && metric.rate >= 0 && metric.rate <= 1
    && isObject(metric.wilson95)
    && Number.isFinite(metric.wilson95.lower) && metric.wilson95.lower >= 0 && metric.wilson95.lower <= 1
    && Number.isFinite(metric.wilson95.upper) && metric.wilson95.upper >= 0 && metric.wilson95.upper <= 1
    && metric.wilson95.lower <= metric.rate && metric.rate <= metric.wilson95.upper;
  for (const collection of [results.aggregates, results.baseline]) {
    if (new Set(collection.map(keyOf)).size !== keys.size || !collection.every((entry) => keys.has(keyOf(entry)))) return false;
  }
  for (const aggregate of results.aggregates) {
    const trials = results.trials.filter((trial) => keyOf(trial) === keyOf(aggregate));
    if (trials.length !== perCell || !Number.isSafeInteger(aggregate.trialCount) || aggregate.trialCount !== perCell
      || !Number.isSafeInteger(aggregate.completedCount) || aggregate.completedCount < 1
      || aggregate.completedCount !== trials.filter((trial) => trial.status === "completed").length
      || !Number.isSafeInteger(aggregate.failedCount)
      || aggregate.failedCount !== trials.filter((trial) => trial.status === "failed").length
      || !metricShape(aggregate.inconclusiveRate, perCell)) return false;
    const applicable = aggregate.targetId === "vulnerable" ? "detectionRate" : "falsePositiveRate";
    const inapplicable = aggregate.targetId === "vulnerable" ? "falsePositiveRate" : "detectionRate";
    if (!metricShape(aggregate[applicable], perCell) || aggregate[inapplicable] !== null) return false;
  }
  return results.baseline.every((entry) => {
    if (!isObject(entry) || !keys.has(keyOf(entry))
      || !["unavailable", "completed", "failed"].includes(entry.status)
      || entry.samplesPerGroup !== 20 || typeof entry.note !== "string") return false;
    if (entry.status === "unavailable") {
      return entry.seed === null && entry.meanA === null && entry.meanB === null
        && entry.absoluteDifferenceMs === null && entry.thresholdMs === null && entry.flagged === null;
    }
    return typeof entry.seed === "string"
      && ["meanA", "meanB", "absoluteDifferenceMs", "thresholdMs"].every(
        (key) => Number.isFinite(entry[key]) || entry[key] === null,
      )
      && Number.isFinite(entry.durationMs)
      && Number.isSafeInteger(entry.failedRequests)
      && entry.failedRequests >= 0
      && entry.failedRequests <= 40
      && (entry.flagged === null || typeof entry.flagged === "boolean");
  }) && results.baseline.every((entry) => {
    if (entry.status === "unavailable") return true;
    return true;
  });
}

export function createBenchmarksPage({
  document: documentRef = globalThis.document,
  fetchImpl = typeof globalThis.fetch === "function" ? globalThis.fetch.bind(globalThis) : null,
} = {}) {
  if (!documentRef || typeof fetchImpl !== "function") {
    throw new TypeError("Benchmarks page requires document and fetch implementations");
  }
  const ids = [
    "benchmark-aggregates",
    "benchmark-baseline",
    "benchmark-provenance",
    "benchmark-reason",
    "benchmark-results",
    "benchmark-results-note",
    "benchmark-status",
    "benchmark-unavailable",
  ];
  const elements = Object.fromEntries(ids.map((id) => [id, documentRef.getElementById(id)]));

  function renderUnavailable(reason = "") {
    elements["benchmark-unavailable"].hidden = false;
    elements["benchmark-results"].hidden = true;
    elements["benchmark-status"].textContent = BENCHMARK_UNAVAILABLE_MESSAGE;
    elements["benchmark-reason"].textContent = typeof reason === "string" ? reason : "";
    elements["benchmark-results-note"].textContent = "";
    for (const id of ["benchmark-provenance", "benchmark-aggregates", "benchmark-baseline"]) {
      elements[id].replaceChildren();
    }
  }

  function renderComplete(results) {
    elements["benchmark-unavailable"].hidden = true;
    elements["benchmark-results"].hidden = false;
    elements["benchmark-status"].textContent = "Complete benchmark run";
    elements["benchmark-reason"].textContent = "";
    elements["benchmark-results-note"].textContent = "Stored benchmark observations; threshold and default calibration remain TBD.";
    elements["benchmark-provenance"].replaceChildren();
    renderProvenance(
      documentRef,
      elements["benchmark-provenance"],
      results.provenance,
      results.schemaVersion,
      results.trials,
    );
    renderAggregates(documentRef, elements["benchmark-aggregates"], results.aggregates);
    renderBaseline(documentRef, elements["benchmark-baseline"], results.baseline);
  }

  async function load() {
    try {
      const response = await fetchImpl("/bench/results.json");
      if (!response.ok) {
        renderUnavailable();
        return;
      }
      const results = await response.json();
      if (!isCompleteResults(results)) {
        renderUnavailable(results?.reason ?? "A complete benchmark run is not available yet.");
        return;
      }
      renderComplete(results);
    } catch {
      renderUnavailable();
    }
  }

  const ready = load();
  return { elements, load, ready };
}

if (typeof document !== "undefined") {
  createBenchmarksPage();
}
