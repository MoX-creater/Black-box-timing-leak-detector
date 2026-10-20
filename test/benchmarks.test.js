import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  validateBenchmarkResults,
  wilsonInterval,
} from "../bench/run.js";
import { createBenchmarksPage } from "../public/benchmarks.js";
import { validateBenchmarkArtifact } from "../src/server/benchmark-results.js";

// Synthetic test-only data is never loaded from, or written to, bench/results.json.
const completeFixture = JSON.parse(await readFile(new URL("./fixtures/benchmark-complete.json", import.meta.url), "utf8"));
const committedArtifact = JSON.parse(await readFile(new URL("../bench/results.json", import.meta.url), "utf8"));

function fixture() {
  return structuredClone(completeFixture);
}

class FakeElement {
  constructor(tagName) {
    this.children = [];
    this.className = "";
    this.hidden = false;
    this.textContent = "";
    this.tagName = tagName;
  }

  append(...children) {
    this.children.push(...children);
  }

  replaceChildren(...children) {
    this.text = "";
    this.children = children;
  }

  set textContent(value) {
    this.text = String(value);
    this.children = [];
  }

  get textContent() {
    return this.text;
  }

  set innerHTML(_value) {
    throw new Error("HTML injection sink used");
  }
}

class FakeDocument {
  constructor() {
    this.elements = new Map();
    for (const id of [
      "benchmark-aggregates",
      "benchmark-baseline",
      "benchmark-provenance",
      "benchmark-reason",
      "benchmark-results",
      "benchmark-results-note",
      "benchmark-status",
      "benchmark-unavailable",
    ]) {
      this.elements.set(id, new FakeElement("div"));
    }
  }

  createElement(tagName) {
    return new FakeElement(tagName);
  }

  getElementById(id) {
    return this.elements.get(id) ?? null;
  }
}

function response(body, { ok = true, status = 200 } = {}) {
  return {
    json: async () => body,
    ok,
    status,
  };
}

function truncatedResponse() {
  return {
    json: async () => {
      throw new SyntaxError("Unexpected end of JSON input");
    },
    ok: true,
    status: 200,
  };
}

function descendants(node) {
  return [node, ...node.children.flatMap((child) => descendants(child))];
}

function textOf(node) {
  return descendants(node).map((entry) => entry.textContent).join(" ");
}

function valuesOf(container, label) {
  return descendants(container)
    .filter((node) => node.children[0]?.tagName === "dt" && node.children[0].textContent === label)
    .map((node) => node.children[1].textContent);
}

function unavailableFixture() {
  return {
    aggregates: [], baseline: [], provenance: null, reason: "Full run was not requested.",
    schemaVersion: "1.0", status: "unavailable", trials: [],
  };
}

function incompleteFixture() {
  const results = fixture();
  const failed = results.trials[5];
  results.trials = results.trials.map((trial) => trial.targetId === "fixed"
    ? { ...structuredClone(failed), seed: trial.seed, trialIndex: trial.trialIndex }
    : trial);
  const aggregate = results.aggregates[1];
  aggregate.completedCount = 0;
  aggregate.failedCount = 3;
  aggregate.inconclusiveRate = structuredClone(aggregate.falsePositiveRate);
  results.status = "incomplete";
  results.reason = "One or more matrix cells have no completed trial.";
  return results;
}

function unavailableBaseline(results) {
  results.provenance.baselineConfig.thresholdMs = null;
  results.baseline = results.baseline.map((entry) => ({
    absoluteDifferenceMs: null, flagged: null, meanA: null, meanB: null,
    noisePresetId: entry.noisePresetId, note: entry.note, samplesPerGroup: 20,
    seed: null, status: "unavailable", targetId: entry.targetId, thresholdMs: null,
  }));
  return results;
}

function fieldAt(results, path) {
  const parts = path.split(".");
  const key = parts.pop();
  return [parts.reduce((parent, part) => parent[part], results), key];
}

function setField(results, path, value) {
  const [parent, key] = fieldAt(results, path);
  parent[key] = value;
}

async function render(body) {
  const documentRef = new FakeDocument();
  const page = createBenchmarksPage({
    document: documentRef,
    fetchImpl: async () => response(body),
  });
  await page.ready;
  return { documentRef, page };
}

function assertUnavailable(documentRef) {
  assert.equal(documentRef.getElementById("benchmark-status").textContent, "benchmark data not yet available");
  assert.equal(documentRef.getElementById("benchmark-unavailable").hidden, false);
  assert.equal(documentRef.getElementById("benchmark-results").hidden, true);
  for (const id of ["benchmark-provenance", "benchmark-aggregates", "benchmark-baseline"]) {
    assert.deepEqual(documentRef.getElementById(id).children, []);
  }
}

test("artifact validator accepts the synthetic complete fixture unchanged without mutation", () => {
  const results = fixture();
  assert.match(results.provenance.notes, /Synthetic test-only fixture; NOT measured benchmark evidence/);
  assert.equal(validateBenchmarkArtifact(results), results);
  assert.deepEqual(results, completeFixture);
  assert.equal(results.trials.filter((trial) => trial.status === "failed").length, 2);
  assert.equal(results.aggregates[0].detectionRate.trials, 3);
});

test("committed T4.1 artifact preserves validated matrix invariants and stored aggregates", () => {
  const results = structuredClone(committedArtifact);
  assert.equal(validateBenchmarkResults(results), results);
  assert.equal(validateBenchmarkArtifact(results), results);
  assert.equal(results.status, "complete");
  assert.equal(results.trials.length, 180);

  const matrix = results.provenance.matrix;
  const cellKey = (entry) => `${entry.targetId}/${entry.noisePresetId}`;
  const cells = new Map();
  for (const targetId of matrix.targets) {
    for (const noisePresetId of matrix.noisePresets) {
      cells.set(`${targetId}/${noisePresetId}`, []);
    }
  }
  for (const trial of results.trials) {
    assert.equal(trial.seed, matrix.seeds[0]);
    assert.equal(typeof trial.derivedSeed, "string");
    assert.ok(trial.derivedSeed.length > 0);
    cells.get(cellKey(trial)).push(trial);
  }
  assert.equal(cells.size, 6);
  assert.equal(new Set(results.trials.map((trial) => trial.derivedSeed)).size, 180);

  const metric = (trials, predicate) => {
    const successes = trials.filter(predicate).length;
    return {
      rate: successes / trials.length,
      successes,
      trials: trials.length,
      wilson95: wilsonInterval(successes, trials.length),
    };
  };
  for (const trials of cells.values()) {
    assert.equal(trials.length, 30);
    assert.ok(trials.every((trial) => trial.status === "completed"));
  }
  assert.equal(results.trials.filter((trial) => trial.status === "failed").length, 0);

  for (const aggregate of results.aggregates) {
    const trials = cells.get(cellKey(aggregate));
    assert.equal(aggregate.trialCount, trials.length);
    assert.equal(aggregate.completedCount, trials.filter((trial) => trial.status === "completed").length);
    assert.equal(aggregate.failedCount, trials.filter((trial) => trial.status === "failed").length);
    assert.deepEqual(aggregate.inconclusiveRate, metric(trials, (trial) => trial.verdict === "INCONCLUSIVE"));
    if (aggregate.targetId === "vulnerable") {
      assert.deepEqual(aggregate.detectionRate, metric(trials, (trial) => trial.verdict === "LEAK"));
      assert.equal(aggregate.falsePositiveRate, null);
    } else {
      assert.equal(aggregate.detectionRate, null);
      assert.deepEqual(aggregate.falsePositiveRate, metric(trials, (trial) => trial.verdict === "LEAK"));
    }
  }
  assert.ok(results.baseline.every((entry) => entry.status === "unavailable"));
});

test("artifact validator preserves honest unavailable/incomplete states and nullable measurements", () => {
  for (const results of [unavailableFixture(), incompleteFixture(), unavailableBaseline(fixture())]) {
    assert.equal(validateBenchmarkArtifact(results), results);
  }
  const baselineFailure = fixture();
  Object.assign(baselineFailure.baseline[1], {
    meanA: null, failedRequests: 1, errorCode: "BENCHMARK_BASELINE_FAILED",
  });
  assert.doesNotThrow(() => validateBenchmarkArtifact(baselineFailure));
});

test("artifact validator rejects partial roots and truncated required fields", () => {
  for (const results of [null, [], {}, "complete"]) {
    assert.throws(() => validateBenchmarkArtifact(results), TypeError);
  }
  for (const path of [
    "schemaVersion", "status", "reason", "trials", "aggregates", "baseline", "provenance",
    "provenance.codeCommit", "provenance.dependencies.express", "provenance.dependencies.undici",
    "provenance.packageVersion", "provenance.nodeVersion", "provenance.benchmarkStatus",
    "provenance.cpu", "provenance.cpuCount", "provenance.os.arch", "provenance.os.platform",
    "provenance.os.release", "provenance.runnerCommand", "provenance.notes", "provenance.smoke",
    "provenance.freshDemoProcessPerCell", "provenance.noiseSequenceStartsAtRequest",
    "provenance.trialTimeoutMs", "provenance.trialSeeds", "provenance.matrix.seeds",
    "provenance.matrix.targets", "provenance.matrix.noisePresets", "provenance.matrix.trialsPerSeed",
    "provenance.detectorConfig.alphaTotal", "provenance.detectorConfig.maxAttempts",
    "provenance.detectorConfig.targetPower", "provenance.noiseConfigs.none.jitter",
    "provenance.noiseConfigs.none.spikeMultiplier", "provenance.noiseConfigs.none.spikeProbability",
    "provenance.baselineConfig.thresholdMs", "provenance.baselineConfig.note",
    "trials.0.counts", "trials.0.counts.a.accepted", "trials.0.counts.b.discardReasons",
    "trials.0.durationMs", "trials.0.sensitivityMs", "trials.0.discarded", "trials.0.errors",
    "trials.0.targetId", "trials.0.noisePresetId", "trials.0.seed", "trials.0.trialIndex",
    "trials.0.verdict", "trials.0.status", "trials.0.stopReason", "trials.2.errorCode",
    "aggregates.0.completedCount", "aggregates.0.failedCount", "aggregates.0.trialCount",
    "aggregates.0.detectionRate.rate", "aggregates.0.detectionRate.successes",
    "aggregates.0.detectionRate.trials", "aggregates.0.detectionRate.wilson95.lower",
    "aggregates.0.detectionRate.wilson95.upper", "aggregates.0.falsePositiveRate",
    "aggregates.0.inconclusiveRate", "baseline.0.meanA", "baseline.0.meanB",
    "baseline.0.thresholdMs", "baseline.0.absoluteDifferenceMs", "baseline.0.durationMs",
    "baseline.0.failedRequests", "baseline.0.flagged", "baseline.0.seed", "baseline.0.note",
    "baseline.0.samplesPerGroup", "baseline.0.status", "baseline.0.targetId", "baseline.0.noisePresetId",
  ]) {
    const results = fixture();
    const [parent, key] = fieldAt(results, path);
    delete parent[key];
    assert.throws(() => validateBenchmarkArtifact(results), TypeError, `missing ${path}`);
  }
});

test("artifact validator requires numeric safe-integer counts, never null or numeric strings", () => {
  for (const path of [
    "provenance.cpuCount", "provenance.matrix.trialsPerSeed", "provenance.trialTimeoutMs",
    "provenance.detectorConfig.bootstrapReplicates", "provenance.detectorConfig.lookBatchPerGroup",
    "provenance.detectorConfig.maxAttempts", "provenance.detectorConfig.maxConsecutiveFailures",
    "provenance.detectorConfig.maxValidPerGroup", "provenance.detectorConfig.minAttemptsForDiscardRate",
    "provenance.detectorConfig.minValidPerGroup", "provenance.noiseConfigs.none.jitter",
    "provenance.noiseConfigs.none.spikeMultiplier", "trials.0.trialIndex", "trials.0.errors",
    "trials.0.discarded", "trials.0.counts.a.accepted", "trials.0.counts.a.attempts",
    "trials.0.counts.a.discarded", "trials.0.counts.a.discardReasons.timeout",
    "aggregates.0.trialCount", "aggregates.0.completedCount", "aggregates.0.failedCount",
    "aggregates.0.detectionRate.successes", "aggregates.0.detectionRate.trials",
    "baseline.0.samplesPerGroup", "baseline.0.failedRequests",
  ]) {
    for (const value of [null, "2", true, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN]) {
      const results = fixture();
      setField(results, path, value);
      assert.throws(() => validateBenchmarkArtifact(results), TypeError, `${path}: ${String(value)}`);
    }
  }
});

test("artifact validator rejects inconsistent matrix, trials, rates, and baseline shapes", () => {
  const invalidFields = [
    ["status", "partial"], ["schemaVersion", "2.0"], ["reason", "partial run"],
    ["provenance.dependencies", []], ["provenance.os", "linux"], ["provenance.cpu", {}],
    ["provenance.detectorConfig", {}], ["provenance.detectorConfig.alphaTotal", null],
    ["provenance.detectorConfig.quantile", "0.1"], ["provenance.detectorConfig.targetPower", 1],
    ["provenance.detectorConfig.maxDiscardRate", 2], ["provenance.detectorConfig.maxValidPerGroup", 3],
    ["provenance.smoke", "false"], ["provenance.freshDemoProcessPerCell", false],
    ["provenance.noiseSequenceStartsAtRequest", 0], ["provenance.baselineConfig.thresholdMs", "5"],
    ["provenance.baselineConfig.note", null], ["provenance.noiseConfigs", {}],
    ["provenance.noiseConfigs.none.spikeProbability", "0"], ["provenance.noiseConfigs.none.presetId", "low"],
    ["provenance.matrix.seeds", ["different"]], ["provenance.matrix.targets", ["vulnerable", "vulnerable"]],
    ["provenance.matrix.noisePresets", ["custom"]], ["provenance.trialSeeds", []],
    ["trials", []], ["trials.0", null], ["trials.0.targetId", "other"], ["trials.0.noisePresetId", "high"],
    ["trials.0.seed", 42], ["trials.0.seed", "trial-synthetic-vulnerable-01"], ["trials.0.trialIndex", 1],
    ["trials.0.counts", null], ["trials.0.counts.a", []], ["trials.0.counts.a.attempts", 4],
    ["trials.0.counts.a.discardReasons", { timeout: 2 }], ["trials.0.errors", 0],
    ["trials.0.discarded", 0], ["trials.0.durationMs", null], ["trials.0.sensitivityMs", "0.2"],
    ["trials.0.status", "pending"], ["trials.0.stopReason", "invented"], ["trials.0.verdict", "SAFE"],
    ["trials.2.verdict", "LEAK"], ["trials.2.sensitivityMs", 1], ["trials.2.errorCode", {}],
    ["aggregates", []], ["aggregates.0", "cell"], ["aggregates.0.targetId", "fixed"],
    ["aggregates.0.completedCount", 3], ["aggregates.0.failedCount", 0], ["aggregates.0.trialCount", 2],
    ["aggregates.0.detectionRate", null], ["aggregates.0.detectionRate.trials", 2],
    ["aggregates.0.detectionRate.successes", 2], ["aggregates.0.detectionRate.rate", null],
    ["aggregates.0.detectionRate.rate", 0.5], ["aggregates.0.detectionRate.wilson95", []],
    ["aggregates.0.detectionRate.wilson95.lower", null], ["aggregates.0.detectionRate.wilson95.upper", "0.9"],
    ["aggregates.0.detectionRate.wilson95", { lower: 0.8, upper: 0.2 }],
    ["aggregates.0.falsePositiveRate", {}], ["aggregates.0.inconclusiveRate", "unavailable"],
    ["baseline", []], ["baseline.0", null], ["baseline.0.targetId", "fixed"],
    ["baseline.0.status", "unavailable"], ["baseline.0.note", 5], ["baseline.0.seed", null],
    ["baseline.0.meanA", "10.25"], ["baseline.0.meanA", -1], ["baseline.0.meanB", null],
    ["baseline.0.flagged", "true"], ["baseline.0.thresholdMs", 6], ["baseline.0.absoluteDifferenceMs", 0],
    ["baseline.0.failedRequests", 1], ["baseline.1.failedRequests", 0], ["baseline.1.failedRequests", 41],
    ["baseline.1.flagged", false], ["baseline.0.durationMs", null],
  ];
  for (const [path, value] of invalidFields) {
    const results = fixture();
    setField(results, path, value);
    assert.throws(() => validateBenchmarkArtifact(results), TypeError, path);
  }
  for (const collection of ["trials", "aggregates", "baseline"]) {
    const results = fixture();
    results[collection].pop();
    assert.throws(() => validateBenchmarkArtifact(results), TypeError, `truncated ${collection}`);
  }
  const falseComplete = incompleteFixture();
  falseComplete.status = "complete";
  falseComplete.reason = null;
  assert.throws(() => validateBenchmarkArtifact(falseComplete), TypeError);
  const falseUnavailable = unavailableFixture();
  falseUnavailable.baseline = [{}];
  assert.throws(() => validateBenchmarkArtifact(falseUnavailable), TypeError);
});

test("benchmarks page renders provenance, counts, stored intervals, and baseline comparison", async () => {
  const { documentRef } = await render(fixture());

  const pageText = [
    "benchmark-provenance",
    "benchmark-aggregates",
    "benchmark-baseline",
  ].map((id) => textOf(documentRef.getElementById(id))).join(" ");
  assert.equal(documentRef.getElementById("benchmark-results").hidden, false);
  assert.equal(documentRef.getElementById("benchmark-unavailable").hidden, true);
  assert.match(pageText, /0000000000000000000000000000000000000000/);
  assert.match(pageText, /v22\.23\.3/);
  assert.match(pageText, /0\.1\.0/);
  assert.match(pageText, /5\.3\.0/);
  assert.match(pageText, /8\.12\.2/);
  assert.match(pageText, /33\.3% \(1\/3\); 95% Wilson CI 6\.1%–79\.2%/);
  assert.match(pageText, /0\.0% \(0\/3\); 95% Wilson CI 0\.0%–56\.2%/);
  assert.match(pageText, /10\.25 ms/);
  assert.match(pageText, /NOT measured benchmark evidence/);
  assert.match(pageText, /synthetic test-only CPU/);
  assert.match(pageText, /"alphaTotal":0\.05/);
  const provenance = documentRef.getElementById("benchmark-provenance");
  assert.deepEqual(valuesOf(provenance, "Benchmark status"), ["Real run recorded; default calibration TBD"]);
  assert.deepEqual(valuesOf(provenance, "Matrix seeds"), ["synthetic-seed-01"]);
  assert.deepEqual(valuesOf(provenance, "Trial seeds"), ["synthetic-seed-01"]);
  for (const trial of completeFixture.trials) assert.match(valuesOf(provenance, "Run seeds")[0], new RegExp(trial.seed));
  assert.deepEqual(valuesOf(provenance, "Trial timeout"), ["30000 ms"]);
  const aggregates = documentRef.getElementById("benchmark-aggregates");
  assert.deepEqual(valuesOf(aggregates, "Trial count"), ["3", "3"]);
  assert.deepEqual(valuesOf(aggregates, "Completed count"), ["2", "2"]);
  assert.deepEqual(valuesOf(aggregates, "Failed count"), ["1", "1"]);
  const baseline = documentRef.getElementById("benchmark-baseline");
  assert.deepEqual(valuesOf(baseline, "Status"), ["completed", "failed"]);
  assert.deepEqual(valuesOf(baseline, "Failed requests"), ["0", "20"]);
  assert.deepEqual(valuesOf(baseline, "Flagged"), ["yes", "unavailable"]);
  assert.match(pageText, /Mean B unavailable/);
  assert.match(documentRef.getElementById("benchmark-results-note").textContent, /Real run recorded; default calibration TBD/);
  assert.match(documentRef.getElementById("benchmark-results-note").textContent, /tested targets, presets, configuration, machine, and runtime/);
  assert.match(documentRef.getElementById("benchmark-results-note").textContent, /Detection varied in the tested cells/);
  assert.deepEqual(valuesOf(baseline, "Samples per group (nominal configured value)"), ["20", "20"]);
});

test("benchmarks page exposes committed runtime provenance without printing stored status text", async () => {
  const { documentRef } = await render(committedArtifact);
  const provenance = documentRef.getElementById("benchmark-provenance");
  const pageText = textOf(provenance);
  const operatingSystem = committedArtifact.provenance.os;
  assert.deepEqual(valuesOf(provenance, "Code commit"), [committedArtifact.provenance.codeCommit]);
  assert.deepEqual(valuesOf(provenance, "Node version"), [committedArtifact.provenance.nodeVersion]);
  assert.deepEqual(valuesOf(provenance, "CPU"), [committedArtifact.provenance.cpu]);
  assert.match(pageText, new RegExp(`${operatingSystem.platform} ${operatingSystem.release}`));
  assert.doesNotMatch(pageText, /TBD until a real full run is completed/);
  assert.match(documentRef.getElementById("benchmark-results-note").textContent, /Detection did not degrade under the tested presets/);
});

test("benchmarks page does not render smoke output as complete evidence", async () => {
  const smoke = structuredClone(committedArtifact);
  smoke.provenance.smoke = true;
  const { documentRef } = await render(smoke);
  assertUnavailable(documentRef);
});

test("benchmarks page renders unavailable for a truncated response", async () => {
  const documentRef = new FakeDocument();
  const page = createBenchmarksPage({
    document: documentRef,
    fetchImpl: async () => truncatedResponse(),
  });
  await page.ready;
  assertUnavailable(documentRef);
});

test("benchmarks page renders unavailable for a wrongly typed complete field", async () => {
  const results = fixture();
  results.provenance.cpuCount = "2";
  const { documentRef } = await render(results);
  assertUnavailable(documentRef);
});

test("benchmarks page source uses DOM text rendering rather than HTML injection", async () => {
  const source = await readFile(new URL("../public/benchmarks.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /innerHTML|outerHTML|document\.write/);
  assert.doesNotMatch(source, /wilsonInterval|wilson95\s*\(/);
});
