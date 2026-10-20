import { execFileSync, spawn } from "node:child_process";
import { access, open, readFile, rename, unlink } from "node:fs/promises";
import { availableParallelism, cpus, arch, platform, release } from "node:os";
import { performance } from "node:perf_hooks";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createServer } from "node:net";

import { Agent } from "undici";

import { createSeededPrng } from "../src/prng.js";
import { NOISE_PRESETS } from "../src/demos/noise.js";
import { buildRequests } from "../src/http/request.js";
import { createHttpTransport } from "../src/http/transport.js";
import { runDetector } from "../src/detector/index.js";

export const BENCHMARK_SCHEMA_VERSION = "1.0";
export const BENCHMARK_TARGETS = Object.freeze(["vulnerable", "fixed"]);
export const BENCHMARK_PRESETS = Object.freeze(["none", "low", "high"]);
export const FULL_BENCHMARK_STATUS = "Real full run completed; default calibration remains TBD";
export const INCOMPLETE_BENCHMARK_STATUS = "Real full run incomplete; default calibration remains TBD";
export const SMOKE_BENCHMARK_STATUS = "Smoke run; not benchmark evidence";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_TRIAL_SEEDS = Object.freeze(["t4.1-master-v1"]);
const DEFAULT_DETECTOR_CONFIG = Object.freeze({
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

const DEFAULT_MATRIX_CONFIG = Object.freeze({
  baseline: Object.freeze({
    note: "Unavailable until a benchmark threshold is explicitly configured.",
    thresholdMs: null,
  }),
  detector: DEFAULT_DETECTOR_CONFIG,
  estimateRequestMs: 50,
  notes: "8 vs 8 budget (matches public web scan); alpha, bootstrap count, quantile and discard limits are TBD pending T4.2 calibration; no thresholds tuned.",
  noisePresets: BENCHMARK_PRESETS,
  seeds: DEFAULT_TRIAL_SEEDS,
  targets: BENCHMARK_TARGETS,
  trialsPerSeed: 30,
  trialTimeoutMs: 30_000,
});

const SMOKE_CONFIG = Object.freeze({
  baseline: Object.freeze({
    note: "Smoke run has no configured baseline threshold.",
    thresholdMs: null,
  }),
  detector: Object.freeze({
    ...DEFAULT_DETECTOR_CONFIG,
    bootstrapReplicates: 10,
    lookBatchPerGroup: 2,
    maxAttempts: 6,
    maxValidPerGroup: 2,
    minValidPerGroup: 2,
  }),
  estimateRequestMs: 50,
  notes: "Tiny smoke matrix; not a benchmark result.",
  noisePresets: ["none"],
  seeds: ["smoke-seed-01"],
  targets: BENCHMARK_TARGETS,
  trialsPerSeed: 1,
  trialTimeoutMs: 10_000,
});

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function invalid(message) {
  throw new TypeError(`benchmark configuration ${message}`);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireFiniteNumber(value, name, minimum = -Infinity) {
  if (!Number.isFinite(value) || value < minimum) {
    invalid(`${name} must be a finite number >= ${minimum}`);
  }
}

function requirePositiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) {
    invalid(`${name} must be a positive safe integer`);
  }
}

function deriveSeed(baseSeed, domain, ...parts) {
  const prng = createSeededPrng(JSON.stringify([
    "black-box-timing-leak-detector",
    "benchmark",
    domain,
    baseSeed,
    ...parts,
  ]));
  return `${domain}-${baseSeed}-${prng.nextUint32().toString(16).padStart(8, "0")}`;
}

export function benchmarkStatusFor({ complete = true, smoke = false } = {}) {
  if (smoke) return SMOKE_BENCHMARK_STATUS;
  return complete ? FULL_BENCHMARK_STATUS : INCOMPLETE_BENCHMARK_STATUS;
}

function cellDefinitions(config) {
  return config.targets.flatMap((targetId) => config.noisePresets.map((noisePresetId) => ({
    noisePresetId,
    targetId,
  })));
}

export function createBenchmarkConfig(overrides = {}) {
  const base = overrides.smoke ? SMOKE_CONFIG : DEFAULT_MATRIX_CONFIG;
  const config = {
    ...base,
    ...overrides,
    baseline: { ...base.baseline, ...(overrides.baseline ?? {}) },
    detector: { ...base.detector, ...(overrides.detector ?? {}) },
    noisePresets: [...(overrides.noisePresets ?? base.noisePresets)],
    seeds: [...(overrides.seeds ?? base.seeds)],
    targets: [...(overrides.targets ?? base.targets)],
  };
  validateBenchmarkConfig(config);
  return config;
}

export function validateBenchmarkConfig(config) {
  if (!isObject(config)) {
    invalid("must be an object");
  }
  if (!Array.isArray(config.targets) || config.targets.length === 0
    || config.targets.some((target) => !BENCHMARK_TARGETS.includes(target))) {
    invalid("targets must contain only vulnerable and fixed");
  }
  if (!Array.isArray(config.noisePresets) || config.noisePresets.length === 0
    || config.noisePresets.some((preset) => !BENCHMARK_PRESETS.includes(preset))) {
    invalid("noisePresets must contain only none, low, and high");
  }
  if (!Array.isArray(config.seeds) || config.seeds.length === 0
    || config.seeds.some((seed) => typeof seed !== "string" || seed.length === 0)) {
    invalid("seeds must contain non-empty strings");
  }
  requirePositiveInteger(config.trialsPerSeed, "trialsPerSeed");
  requirePositiveInteger(config.trialTimeoutMs, "trialTimeoutMs");
  requireFiniteNumber(config.estimateRequestMs, "estimateRequestMs", 0);
  if (typeof config.notes !== "string") {
    invalid("notes must be a string");
  }
  if (!isObject(config.baseline)) {
    invalid("baseline must be an object");
  }
  if (config.baseline.thresholdMs !== null) {
    requireFiniteNumber(config.baseline.thresholdMs, "baseline.thresholdMs", 0);
    if (typeof config.baseline.note !== "string" || config.baseline.note.length === 0) {
      invalid("baseline.note is required when thresholdMs is configured");
    }
  }
  if (typeof config.baseline.note !== "string") {
    invalid("baseline.note must be a string");
  }
  if (!isObject(config.detector)) {
    invalid("detector must be an object");
  }
  return config;
}

export function estimateBenchmark(config) {
  validateBenchmarkConfig(config);
  const cells = cellDefinitions(config).length;
  const trials = cells * config.seeds.length * config.trialsPerSeed;
  const requestsPerTrial = 2 + config.detector.maxAttempts;
  const baselineRequests = config.baseline.thresholdMs === null ? 0 : 40 * cells;
  const estimatedRequests = trials * requestsPerTrial + baselineRequests;
  return {
    cells,
    estimatedRequests,
    estimatedSeconds: (estimatedRequests * config.estimateRequestMs) / 1000,
    requestsPerTrial,
    trials,
  };
}

function wilsonInterval(successes, trials, z = 1.96) {
  if (!Number.isSafeInteger(successes) || !Number.isSafeInteger(trials)
    || successes < 0 || trials < 0 || successes > trials) {
    throw new RangeError("Wilson successes/trials are invalid");
  }
  if (trials === 0) {
    return { lower: null, upper: null };
  }
  const proportion = successes / trials;
  const denominator = 1 + ((z ** 2) / trials);
  const center = (proportion + ((z ** 2) / (2 * trials))) / denominator;
  const margin = (z / denominator) * Math.sqrt(
    (proportion * (1 - proportion) / trials) + ((z ** 2) / (4 * trials ** 2)),
  );
  return { lower: Math.max(0, center - margin), upper: Math.min(1, center + margin) };
}

export { wilsonInterval };

function gitCommit() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "unavailable";
  }
}

async function packageMetadata() {
  try {
    const packageJson = JSON.parse(await readFile(path.join(ROOT, "package.json"), "utf8"));
    return {
      express: packageJson.dependencies?.express ?? "unavailable",
      packageVersion: packageJson.version ?? "unavailable",
      undici: packageJson.dependencies?.undici ?? "unavailable",
    };
  } catch {
    return { express: "unavailable", packageVersion: "unavailable", undici: "unavailable" };
  }
}

async function createProvenance(config, { smoke, command }) {
  const packages = await packageMetadata();
  const cpuList = cpus();
  return {
    benchmarkStatus: benchmarkStatusFor({ smoke }),
    baselineConfig: clone(config.baseline),
    codeCommit: gitCommit(),
    cpu: cpuList[0]?.model ?? "unavailable",
    cpuCount: typeof availableParallelism === "function" ? availableParallelism() : cpuList.length,
    detectorConfig: clone(config.detector),
    dependencies: { express: packages.express, undici: packages.undici },
    freshDemoProcessPerCell: true,
    noiseSequenceStartsAtRequest: 1,
    noiseConfigs: Object.fromEntries(config.noisePresets.map((presetId) => [
      presetId,
      clone(NOISE_PRESETS[presetId]),
    ])),
    nodeVersion: process.version,
    notes: config.notes,
    os: { arch: arch(), platform: platform(), release: release() },
    packageVersion: packages.packageVersion,
    runnerCommand: command,
    smoke,
    trialTimeoutMs: config.trialTimeoutMs,
    trialSeeds: [...config.seeds],
  };
}

export function unavailableResults(reason = "No real benchmark run has been requested.") {
  return {
    aggregates: [],
    baseline: [],
    provenance: null,
    reason,
    schemaVersion: BENCHMARK_SCHEMA_VERSION,
    status: "unavailable",
    trials: [],
  };
}

async function reservePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = address && typeof address === "object" ? address.port : null;
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  if (!port) {
    throw new Error("could not reserve demo port");
  }
  return port;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 5_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function waitForHealth(baseUrl, timeoutMs = 10_000) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    try {
      const response = await fetchWithTimeout(`${baseUrl}/healthz`, {}, 1_000);
      if (response.ok) {
        await response.arrayBuffer();
        return;
      }
    } catch {
      // The child can still be starting or binding its ephemeral port.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("demo healthcheck timed out");
}

async function startDemoProcess(targetId, presetId, noiseSeed) {
  const port = await reservePort();
  const child = spawn(process.execPath, [path.join(ROOT, "src", "demos", "stub.js")], {
    cwd: ROOT,
    env: {
      ...process.env,
      DEMO_NOISE_PRESET: presetId,
      DEMO_NOISE_SEED: noiseSeed,
      HOST: "127.0.0.1",
      PORT: String(port),
      SERVICE_NAME: targetId,
    },
    stdio: "ignore",
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await waitForHealth(baseUrl);
    return { baseUrl, child, port };
  } catch (error) {
    child.kill("SIGTERM");
    throw error;
  }
}

async function stopDemoProcess(processInfo) {
  if (!processInfo?.child || processInfo.child.exitCode !== null) {
    return;
  }
  processInfo.child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => processInfo.child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(() => {
      if (processInfo.child.exitCode === null) {
        processInfo.child.kill("SIGKILL");
      }
      resolve();
    }, 2_000)),
  ]);
}

function requestPair(baseUrl) {
  return buildRequests({
    a: {
      body: { type: "json", value: { password: "benchmark-password", username: "known-user" } },
      url: `${baseUrl}/login`,
    },
    b: {
      body: { type: "json", value: { password: "benchmark-password", username: "missing-user" } },
      url: `${baseUrl}/login`,
    },
    headers: { "content-type": "application/json" },
    method: "POST",
  });
}

function summarizeCounts(counts) {
  const groups = [counts?.a, counts?.b].filter(Boolean);
  const discarded = groups.reduce((sum, group) => sum + group.discarded, 0);
  const errors = groups.reduce((sum, group) => sum
    + (group.discardReasons.error ?? 0)
    + (group.discardReasons.timeout ?? 0), 0);
  return { discarded, errors };
}

async function runTrial(config, targetId, presetId, baseSeed, derivedSeed, trialIndex) {
  const started = performance.now();
  let processInfo;
  let agent;
  let timedOut = false;
  try {
    processInfo = await startDemoProcess(
      targetId,
      presetId,
      deriveSeed(derivedSeed, "noise", targetId, presetId, trialIndex),
    );
    const requests = requestPair(processInfo.baseUrl);
    agent = new Agent({ connections: 1 });
    const transport = createHttpTransport({ dispatcher: agent });
    const controller = new AbortController();
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, config.trialTimeoutMs);
    let detectorResult;
    try {
      detectorResult = await runDetector({
        config: { ...config.detector, seed: derivedSeed },
        onProgress: () => {},
        requests,
        send: transport.send,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    const counts = clone(detectorResult.counts);
    const summary = summarizeCounts(counts);
    return {
      counts,
      discarded: summary.discarded,
      durationMs: performance.now() - started,
      errors: summary.errors,
      noisePresetId: presetId,
      sensitivityMs: timedOut ? null : detectorResult.sensitivityMs,
      status: timedOut ? "failed" : "completed",
      stopReason: timedOut ? "timeout" : detectorResult.stopReason,
      targetId,
      trialIndex,
      verdict: timedOut ? null : detectorResult.verdict,
      seed: baseSeed,
      derivedSeed,
    };
  } catch (error) {
    return {
      counts: null,
      discarded: 0,
      durationMs: performance.now() - started,
      errors: 1,
      errorCode: error?.code ?? "BENCHMARK_TRIAL_FAILED",
      noisePresetId: presetId,
      sensitivityMs: null,
      status: "failed",
      stopReason: "trial-failed",
      targetId,
      trialIndex,
      verdict: null,
      seed: baseSeed,
      derivedSeed,
    };
  } finally {
    if (agent) {
      await agent.close().catch(() => {});
    }
    await stopDemoProcess(processInfo).catch(() => {});
  }
}

async function runBaseline(config, targetId, presetId, seed) {
  if (config.baseline.thresholdMs === null) {
    return {
      absoluteDifferenceMs: null,
      flagged: null,
      meanA: null,
      meanB: null,
      noisePresetId: presetId,
      note: config.baseline.note,
      samplesPerGroup: 20,
      seed: null,
      status: "unavailable",
      targetId,
      thresholdMs: null,
    };
  }

  const baselineSeed = deriveSeed(seed, "baseline", targetId, presetId);
  const started = performance.now();
  let processInfo;
  let agent;
  try {
    processInfo = await startDemoProcess(targetId, presetId, deriveSeed(baselineSeed, "noise"));
    const requests = requestPair(processInfo.baseUrl);
    agent = new Agent({ connections: 1 });
    const transport = createHttpTransport({ dispatcher: agent });
    const samples = { a: [], b: [] };
    let failedRequests = 0;
    for (const label of ["a", "b"]) {
      for (let index = 0; index < 20; index += 1) {
        const result = await transport.send(requests[label]);
        if (result.kind === "accepted") {
          samples[label].push(result.durationMs);
        } else {
          failedRequests += 1;
        }
      }
    }
    const mean = (values) => values.length === 0
      ? null
      : values.reduce((sum, value) => sum + value, 0) / values.length;
    const meanA = mean(samples.a);
    const meanB = mean(samples.b);
    const difference = meanA === null || meanB === null ? null : Math.abs(meanA - meanB);
    return {
      absoluteDifferenceMs: difference,
      durationMs: performance.now() - started,
      failedRequests,
      flagged: difference === null ? null : difference >= config.baseline.thresholdMs,
      meanA,
      meanB,
      noisePresetId: presetId,
      note: config.baseline.note,
      samplesPerGroup: 20,
      seed: baselineSeed,
      status: failedRequests === 0 ? "completed" : "failed",
      targetId,
      thresholdMs: config.baseline.thresholdMs,
    };
  } catch (error) {
    return {
      absoluteDifferenceMs: null,
      durationMs: performance.now() - started,
      failedRequests: 1,
      flagged: null,
      meanA: null,
      meanB: null,
      noisePresetId: presetId,
      note: config.baseline.note,
      samplesPerGroup: 20,
      seed: baselineSeed,
      status: "failed",
      targetId,
      thresholdMs: config.baseline.thresholdMs,
      errorCode: error?.code ?? "BENCHMARK_BASELINE_FAILED",
    };
  } finally {
    if (agent) {
      await agent.close().catch(() => {});
    }
    await stopDemoProcess(processInfo).catch(() => {});
  }
}

function rateMetric(trials, predicate) {
  const attempted = trials.length;
  const successes = trials.filter(predicate).length;
  return {
    rate: attempted === 0 ? null : successes / attempted,
    successes,
    trials: attempted,
    wilson95: wilsonInterval(successes, attempted),
  };
}

function cellDefinitionsFromTrials(trials) {
  const keys = new Map();
  for (const trial of trials) {
    const key = `${trial.targetId}\u0000${trial.noisePresetId}`;
    keys.set(key, { noisePresetId: trial.noisePresetId, targetId: trial.targetId });
  }
  return [...keys.values()];
}

function aggregateTrials(trials) {
  return cellDefinitionsFromTrials(trials).map(({ noisePresetId, targetId }) => {
    const cellTrials = trials.filter((trial) => trial.targetId === targetId
      && trial.noisePresetId === noisePresetId);
    const completed = cellTrials.filter((trial) => trial.status === "completed");
    const failed = cellTrials.filter((trial) => trial.status === "failed");
    return {
      completedCount: completed.length,
      detectionRate: targetId === "vulnerable"
        ? rateMetric(cellTrials, (trial) => trial.verdict === "LEAK")
        : null,
      failedCount: failed.length,
      falsePositiveRate: targetId === "fixed"
        ? rateMetric(cellTrials, (trial) => trial.verdict === "LEAK")
        : null,
      inconclusiveRate: rateMetric(cellTrials, (trial) => trial.verdict === "INCONCLUSIVE"),
      noisePresetId,
      targetId,
      trialCount: cellTrials.length,
    };
  });
}

function validateRateMetric(metric, pathName) {
  if (!isObject(metric)) {
    throw new TypeError(`${pathName} must be an object`);
  }
  if (!Number.isSafeInteger(metric.successes) || !Number.isSafeInteger(metric.trials)
    || metric.successes < 0 || metric.trials < 0 || metric.successes > metric.trials) {
    throw new TypeError(`${pathName} counts are invalid`);
  }
  const expected = wilsonInterval(metric.successes, metric.trials);
  if (metric.wilson95?.lower !== expected.lower || metric.wilson95?.upper !== expected.upper) {
    throw new TypeError(`${pathName} Wilson interval is invalid`);
  }
}

export function validateBenchmarkResults(results) {
  if (!isObject(results)) {
    throw new TypeError("benchmark results must be an object");
  }
  if (results.schemaVersion !== BENCHMARK_SCHEMA_VERSION) {
    throw new TypeError("benchmark results schemaVersion is invalid");
  }
  if (!new Set(["unavailable", "incomplete", "complete"]).has(results.status)) {
    throw new TypeError("benchmark results status is invalid");
  }
  if (!Array.isArray(results.trials) || !Array.isArray(results.aggregates)
    || !Array.isArray(results.baseline)) {
    throw new TypeError("benchmark result collections are invalid");
  }
  if (results.status === "unavailable") {
    if (results.trials.length !== 0 || results.aggregates.length !== 0) {
      throw new TypeError("unavailable results must be empty");
    }
    return results;
  }
  if (!isObject(results.provenance) || typeof results.provenance.notes !== "string") {
    throw new TypeError("benchmark provenance is invalid");
  }
  for (const [index, trial] of results.trials.entries()) {
    if (!isObject(trial) || !["completed", "failed"].includes(trial.status)) {
      throw new TypeError(`trial ${index} is invalid`);
    }
  }
  for (const [index, aggregate] of results.aggregates.entries()) {
    for (const name of ["inconclusiveRate", "detectionRate", "falsePositiveRate"]) {
      if (aggregate[name] !== null) {
        validateRateMetric(aggregate[name], `aggregate ${index}.${name}`);
      }
    }
  }
  if (results.status === "complete"
    && results.aggregates.some((aggregate) => aggregate.completedCount === 0)) {
    throw new TypeError("complete results require a completed trial in every cell");
  }
  return results;
}

export async function runBenchmark({
  command = "node bench/run.js",
  config: suppliedConfig,
  smoke = false,
} = {}) {
  const config = createBenchmarkConfig({ ...(suppliedConfig ?? {}), smoke });
  const provenance = await createProvenance(config, { command, smoke });
  const trials = [];
  const baseline = [];
  for (const { noisePresetId, targetId } of cellDefinitions(config)) {
    for (const [seedIndex, baseSeed] of config.seeds.entries()) {
      for (let trialIndex = 0; trialIndex < config.trialsPerSeed; trialIndex += 1) {
        const derivedSeed = deriveSeed(baseSeed, "trial", targetId, noisePresetId, seedIndex, trialIndex);
        trials.push(await runTrial(
          config,
          targetId,
          noisePresetId,
          baseSeed,
          derivedSeed,
          trialIndex,
        ));
      }
    }
    baseline.push(await runBaseline(
      config,
      targetId,
      noisePresetId,
      deriveSeed(config.seeds[0], "baseline-cell", targetId, noisePresetId),
    ));
  }
  const aggregates = aggregateTrials(trials);
  const expectedCells = cellDefinitions(config).length;
  const complete = aggregates.length === expectedCells
    && aggregates.every((aggregate) => aggregate.completedCount > 0);
  const benchmarkProvenance = {
    ...provenance,
    benchmarkStatus: benchmarkStatusFor({ complete, smoke }),
    matrix: {
      noisePresets: [...config.noisePresets],
      seeds: [...config.seeds],
      targets: [...config.targets],
      trialsPerSeed: config.trialsPerSeed,
    },
  };
  const results = {
    aggregates,
    baseline,
    provenance: benchmarkProvenance,
    reason: complete ? null : "One or more matrix cells have no completed trial.",
    schemaVersion: BENCHMARK_SCHEMA_VERSION,
    status: complete ? "complete" : "incomplete",
    trials,
  };
  validateBenchmarkResults(results);
  return results;
}

async function loadConfig(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    throw new Error("benchmark config could not be loaded");
  }
}

async function writeResultsAtomically(filePath, results, force = false) {
  try {
    await access(filePath);
    if (!force) {
      throw new Error("output exists; use --force to overwrite");
    }
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
  const temporaryPath = `${filePath}.tmp-${process.pid}`;
  const handle = await open(temporaryPath, "wx");
  try {
    await handle.writeFile(`${JSON.stringify(results, null, 2)}\n`, "utf8");
  } finally {
    await handle.close();
  }
  try {
    await rename(temporaryPath, filePath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }
}

function parseCommandLine(argv) {
  return parseArgs({
    args: argv,
    allowPositionals: false,
    options: {
      config: { type: "string" },
      force: { type: "boolean" },
      help: { type: "boolean", short: "h" },
      out: { type: "string" },
      smoke: { type: "boolean" },
      "yes-full-run": { type: "boolean" },
    },
    strict: true,
  }).values;
}

function benchmarkHelp() {
  return `Usage: npm run bench -- [options]

Options:
  --smoke           Run one tiny target/preset/seed matrix for validation
  --config <file>   Override benchmark matrix configuration
  --out <file>      Write results atomically to this file
  --force           Allow replacing an existing output file
  --yes-full-run    Required before starting the full matrix
  --help            Show this help

Without a real run, the runner reports an explicit unavailable state and does
not write bench/results.json. Full-run estimates are labelled estimates.
`;
}

export async function main(argv = process.argv.slice(2), streams = {
  stderr: process.stderr,
  stdout: process.stdout,
}) {
  let values;
  try {
    values = parseCommandLine(argv);
  } catch {
    streams.stderr.write("Input error\n");
    return 1;
  }
  if (values.help) {
    streams.stdout.write(benchmarkHelp());
    return 0;
  }
  try {
    const config = values.config === undefined ? undefined : await loadConfig(values.config);
    const smoke = values.smoke === true;
    const selectedConfig = createBenchmarkConfig({ ...(config ?? {}), smoke });
    if (!smoke && values["yes-full-run"] !== true) {
      const estimate = estimateBenchmark(selectedConfig);
      streams.stderr.write(
        `Estimated full run: ${estimate.estimatedRequests} requests, `
        + `roughly ${estimate.estimatedSeconds.toFixed(1)} seconds (estimate only). `
        + "Re-run with --yes-full-run to start.\n",
      );
      if (values.out === undefined) {
        streams.stdout.write(`${JSON.stringify(unavailableResults(
          "Full run not started; --yes-full-run was not supplied.",
        ), null, 2)}\n`);
        return 0;
      }
      return 1;
    }
    if (values.force && values.out === undefined) {
      throw new Error("--force requires --out");
    }
    if (values.out === "bench/results.json") {
      throw new Error("T2.6 does not write bench/results.json");
    }
    if (values.out !== undefined && values.force !== true) {
      try {
        await access(values.out);
        throw new Error("output exists; use --force to overwrite");
      } catch (error) {
        if (error?.code !== "ENOENT") {
          throw error;
        }
      }
    }
    const results = await runBenchmark({
      command: `node bench/run.js ${argv.join(" ")}`,
      config: selectedConfig,
      smoke,
    });
    validateBenchmarkResults(results);
    if (values.out !== undefined) {
      await writeResultsAtomically(values.out, results, values.force === true);
      streams.stderr.write(`Benchmark results written: ${results.status}\n`);
    } else {
      streams.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
    }
    return results.status === "complete" ? 0 : 1;
  } catch (error) {
    streams.stderr.write(error.message === "output exists; use --force to overwrite"
      ? `${error.message}\n`
      : "Benchmark unavailable or failed\n");
    return 1;
  }
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().then((code) => {
    process.exitCode = code;
  });
}
