import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  benchmarkStatusFor,
  createBenchmarkConfig,
  estimateBenchmark,
  FULL_BENCHMARK_STATUS,
  INCOMPLETE_BENCHMARK_STATUS,
  main,
  runBenchmark,
  SMOKE_BENCHMARK_STATUS,
  unavailableResults,
  validateBenchmarkResults,
  wilsonInterval,
} from "../bench/run.js";
import { validateBenchmarkArtifact } from "../src/server/benchmark-results.js";

const committedArtifact = JSON.parse(
  await readFile(new URL("../bench/results.json", import.meta.url), "utf8"),
);

function streams() {
  let stdout = "";
  let stderr = "";
  return {
    stderr: { write: (text) => { stderr += text; } },
    stdout: { write: (text) => { stdout += text; } },
    text: () => ({ stderr, stdout }),
  };
}

test("Wilson interval matches the small-sample reference and edge cases", () => {
  const oneOfTwo = wilsonInterval(1, 2);
  assert.ok(Math.abs(oneOfTwo.lower - 0.0945) < 0.0002);
  assert.ok(Math.abs(oneOfTwo.upper - 0.9055) < 0.0002);
  assert.deepEqual(wilsonInterval(0, 0), { lower: null, upper: null });
  const zeroOfFive = wilsonInterval(0, 5);
  const fiveOfFive = wilsonInterval(5, 5);
  assert.equal(zeroOfFive.lower, 0);
  assert.equal(fiveOfFive.upper, 1);
  assert.ok(zeroOfFive.upper < 1);
  assert.ok(fiveOfFive.lower > 0);
});

test("full-run estimate is computed from the configured matrix", () => {
  const smoke = createBenchmarkConfig({ smoke: true });
  const config = createBenchmarkConfig({
    detector: { ...smoke.detector, maxAttempts: 6 },
    noisePresets: ["none", "low"],
    seeds: ["a", "b"],
    targets: ["vulnerable", "fixed"],
    trialsPerSeed: 2,
  });
  const estimate = estimateBenchmark(config);
  assert.equal(estimate.cells, 4);
  assert.equal(estimate.trials, 16);
  assert.equal(estimate.requestsPerTrial, 8);
  assert.equal(estimate.estimatedRequests, 128);
});

test("full-run defaults match the committed T4.1 provenance", () => {
  const config = createBenchmarkConfig();
  const provenance = committedArtifact.provenance;
  assert.deepEqual(config.targets, provenance.matrix.targets);
  assert.deepEqual(config.noisePresets, provenance.matrix.noisePresets);
  assert.deepEqual(config.seeds, provenance.matrix.seeds);
  assert.equal(config.trialsPerSeed, provenance.matrix.trialsPerSeed);
  assert.deepEqual(config.detector, provenance.detectorConfig);
  assert.equal(config.trialTimeoutMs, provenance.trialTimeoutMs);
  assert.equal(config.notes, provenance.notes);
  assert.deepEqual(config.baseline, provenance.baselineConfig);
});

test("future full and smoke provenance statuses are distinct and schema-compatible", () => {
  assert.equal(benchmarkStatusFor(), FULL_BENCHMARK_STATUS);
  assert.equal(benchmarkStatusFor({ complete: false }), INCOMPLETE_BENCHMARK_STATUS);
  assert.equal(benchmarkStatusFor({ smoke: true }), SMOKE_BENCHMARK_STATUS);
  assert.equal(typeof committedArtifact.provenance.benchmarkStatus, "string");
  assert.doesNotThrow(() => validateBenchmarkArtifact({
    ...structuredClone(committedArtifact),
    provenance: {
      ...structuredClone(committedArtifact.provenance),
      benchmarkStatus: FULL_BENCHMARK_STATUS,
    },
  }));
});

test("runner smoke output has completed trials and unavailable baseline", async () => {
  const results = await runBenchmark({ smoke: true });
  validateBenchmarkResults(results);
  validateBenchmarkArtifact(results);
  assert.equal(results.status, "complete");
  assert.equal(results.provenance.benchmarkStatus, SMOKE_BENCHMARK_STATUS);
  assert.equal(results.provenance.freshDemoProcessPerCell, true);
  assert.equal(results.provenance.noiseSequenceStartsAtRequest, 1);
  assert.equal(typeof results.provenance.cpuCount, "number");
  assert.equal(typeof results.provenance.notes, "string");
  assert.equal(results.trials.length, 2);
  assert.ok(results.trials.every((trial) => trial.status === "completed"));
  assert.ok(results.trials.every((trial) => results.provenance.matrix.seeds.includes(trial.seed)));
  assert.ok(results.trials.every((trial) => typeof trial.derivedSeed === "string"));
  assert.ok(results.baseline.every((entry) => entry.status === "unavailable"));
  assert.ok(results.aggregates.every((aggregate) => aggregate.inconclusiveRate !== null));
});

test("CLI benchmark smoke writes a temporary result", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "timing-bench-"));
  const outputPath = path.join(directory, "smoke-results.json");
  const io = streams();
  try {
    const code = await main(["--smoke", "--out", outputPath], io);
    assert.equal(code, 0);
    const saved = JSON.parse(await readFile(outputPath, "utf8"));
    validateBenchmarkResults(saved);
    assert.equal(saved.status, "complete");
    assert.equal(io.text().stdout, "");
    assert.match(io.text().stderr, /Benchmark results written: complete/);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("CLI benchmark refuses an existing output unless forced", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "timing-bench-existing-"));
  const outputPath = path.join(directory, "existing.json");
  const io = streams();
  try {
    await writeFile(outputPath, "existing", "utf8");
    const code = await main(["--smoke", "--out", outputPath], io);
    assert.equal(code, 1);
    assert.match(io.text().stderr, /output exists; use --force/);
    assert.equal(await readFile(outputPath, "utf8"), "existing");
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("without full-run confirmation the command emits unavailable state", async () => {
  const io = streams();
  const code = await main([], io);
  assert.equal(code, 0);
  assert.match(io.text().stderr, /estimate/);
  const result = JSON.parse(io.text().stdout);
  assert.deepEqual(result, unavailableResults("Full run not started; --yes-full-run was not supplied."));
});

test("failed trials remain attempted in aggregate denominators", () => {
  const metric = wilsonInterval(0, 1);
  const results = {
    aggregates: [{
      completedCount: 0,
      detectionRate: {
        rate: 0,
        successes: 0,
        trials: 1,
        wilson95: metric,
      },
      failedCount: 1,
      falsePositiveRate: null,
      inconclusiveRate: {
        rate: 0,
        successes: 0,
        trials: 1,
        wilson95: metric,
      },
      noisePresetId: "none",
      targetId: "vulnerable",
      trialCount: 1,
    }],
    baseline: [],
    provenance: { notes: "unit test" },
    reason: "One or more matrix cells have no completed trial.",
    schemaVersion: "1.0",
    status: "incomplete",
    trials: [{ status: "failed" }],
  };
  assert.doesNotThrow(() => validateBenchmarkResults(results));
  assert.equal(results.aggregates[0].detectionRate.trials, 1);
});
