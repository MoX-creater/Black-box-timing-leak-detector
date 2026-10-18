const BENCHMARK_UNAVAILABLE_MESSAGE = "Benchmark data not yet available.";

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
  if (!isObject(metric)
    || !Number.isFinite(metric.rate)
    || !Number.isSafeInteger(metric.successes)
    || !Number.isSafeInteger(metric.trials)) {
    return "unavailable";
  }
  const interval = metric.wilson95;
  const intervalText = isObject(interval)
    && Number.isFinite(interval.lower)
    && Number.isFinite(interval.upper)
    ? `; 95% Wilson CI ${(interval.lower * 100).toFixed(1)}%–${(interval.upper * 100).toFixed(1)}%`
    : "; 95% Wilson CI unavailable";
  return `${(metric.rate * 100).toFixed(1)}% (${metric.successes}/${metric.trials})${intervalText}`;
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

function renderProvenance(documentRef, container, provenance, schemaVersion) {
  const matrix = isObject(provenance.matrix) ? provenance.matrix : {};
  const operatingSystem = isObject(provenance.os) ? provenance.os : {};
  appendDefinitions(documentRef, container, [
    ["Benchmark status", provenance.benchmarkStatus],
    ["Schema version", schemaVersion],
    ["Git commit", provenance.codeCommit],
    ["Package version", provenance.packageVersion],
    ["Node version", provenance.nodeVersion],
    ["Runner command", provenance.runnerCommand],
    ["CPU", provenance.cpu],
    ["CPU count", provenance.cpuCount],
    ["Operating system", `${displayValue(operatingSystem.platform)} ${displayValue(operatingSystem.release)} (${displayValue(operatingSystem.arch)})`],
    ["Smoke run", provenance.smoke],
    ["Notes", provenance.notes],
    ["Trial seeds", formatList(provenance.trialSeeds)],
    ["Targets", formatList(matrix.targets)],
    ["Noise presets", formatList(matrix.noisePresets)],
    ["Trials per seed", matrix.trialsPerSeed],
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
      ["Mean A", entry?.meanA === null || entry?.meanA === undefined ? "unavailable" : `${displayValue(entry.meanA)} ms`],
      ["Mean B", entry?.meanB === null || entry?.meanB === undefined ? "unavailable" : `${displayValue(entry.meanB)} ms`],
      ["Absolute difference", entry?.absoluteDifferenceMs === null || entry?.absoluteDifferenceMs === undefined
        ? "unavailable"
        : `${displayValue(entry.absoluteDifferenceMs)} ms`],
      ["Threshold", entry?.thresholdMs === null || entry?.thresholdMs === undefined
        ? "unavailable"
        : `${displayValue(entry.thresholdMs)} ms`],
      ["Flagged", entry?.flagged],
      ["Samples per group", entry?.samplesPerGroup],
      ["Note", entry?.note],
    ]);
    return section;
  });
  container.replaceChildren(...sections);
}

function isCompleteResults(results) {
  return isObject(results)
    && results.status === "complete"
    && isObject(results.provenance)
    && Array.isArray(results.aggregates)
    && Array.isArray(results.baseline);
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
  }

  function renderComplete(results) {
    elements["benchmark-unavailable"].hidden = true;
    elements["benchmark-results"].hidden = false;
    elements["benchmark-results-note"].textContent = results.reason ?? "Measured benchmark results.";
    elements["benchmark-provenance"].replaceChildren();
    renderProvenance(
      documentRef,
      elements["benchmark-provenance"],
      results.provenance,
      results.schemaVersion,
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
