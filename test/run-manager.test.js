import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";

import { mannWhitneyU } from "../src/stats/index.js";
import { createRunReport, validateRunReport } from "../src/report/index.js";
import {
  createRunManager,
  DEFAULT_ACTIVE_RUNS_WITH_SHARED_CLIENT_IP,
  DEFAULT_MAX_RUN_DURATION_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  RUN_FAILURE_CODE,
  WEB_DETECTOR_CONFIG,
  WEB_DETECTOR_CONFIG_STATUS,
} from "../src/server/run-manager.js";
import { createWebApp } from "../src/server/app.js";
import { WEB_BUILD_INFO } from "../src/server/build-info.js";

const TARGET_MAP = Object.freeze({
  fixed: Object.freeze({ host: "127.0.0.1", port: 3002 }),
  vulnerable: Object.freeze({ host: "127.0.0.1", port: 3001 }),
});

function createFakeClock(start = 1_000) {
  let current = start;
  let nextTimerId = 1;
  const timers = new Map();
  const scheduler = {
    clearTimeout(timerId) {
      timers.delete(timerId);
    },
    setTimeout(callback, delay) {
      const timerId = nextTimerId;
      nextTimerId += 1;
      timers.set(timerId, { callback, due: current + delay });
      return timerId;
    },
  };
  return {
    advance(milliseconds) {
      current += milliseconds;
      let next;
      do {
        next = [...timers.entries()]
          .filter(([, timer]) => timer.due <= current)
          .sort((left, right) => left[1].due - right[1].due)[0];
        if (next) {
          timers.delete(next[0]);
          next[1].callback();
        }
      } while (next);
    },
    now: () => current,
    pending: () => timers.size,
    scheduler,
  };
}

async function flushMicrotasks() {
  for (let index = 0; index < 12; index += 1) {
    await Promise.resolve();
  }
}

function detectorFixture(seed) {
  return {
    counts: {
      a: { accepted: 0, attempts: 0, discarded: 0, discardReasons: {} },
      b: { accepted: 0, attempts: 0, discarded: 0, discardReasons: {} },
    },
    expectedStatus: null,
    lookHistory: [],
    samples: { a: [], b: [] },
    seed,
    sensitivityMs: null,
    stopReason: "aborted",
    verdict: "INCONCLUSIVE",
    warmupRecords: [],
    warnings: [],
  };
}

function createManager(overrides = {}) {
  const clock = overrides.clock ?? createFakeClock();
  let dispatcherCloseCount = 0;
  const manager = createRunManager({
    agentFactory: () => ({
      close: async () => {
        dispatcherCloseCount += 1;
      },
    }),
    detectorRunner: async ({ config }) => detectorFixture(config.seed),
    environment: {},
    now: clock.now,
    reportBuilder: async ({ runSeed }) => ({ reportSeed: runSeed }),
    reportValidator: () => {},
    scheduler: clock.scheduler,
    targetMap: TARGET_MAP,
    transportFactory: () => ({
      send: async () => ({ durationMs: 1, kind: "accepted", statusCode: 200 }),
    }),
    ...overrides,
  });
  return {
    clock,
    dispatcherCloseCount: () => dispatcherCloseCount,
    manager,
  };
}

async function closeHttpServer(server) {
  if (!server.listening) {
    return;
  }
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

test("web detector constants are TBD and the 8-vs-8 best p beats alphaAtLook", () => {
  assert.equal(WEB_DETECTOR_CONFIG_STATUS, "TBD");
  assert.equal(WEB_DETECTOR_CONFIG.maxValidPerGroup, 8);
  assert.equal(WEB_DETECTOR_CONFIG.lookBatchPerGroup, 4);
  assert.equal(WEB_DETECTOR_CONFIG.minValidPerGroup, 4);
  assert.equal(WEB_DETECTOR_CONFIG.maxAttempts, 20);

  const bestCase = mannWhitneyU(
    [1, 2, 3, 4, 5, 6, 7, 8],
    [9, 10, 11, 12, 13, 14, 15, 16],
  );
  const alphaAtLook = WEB_DETECTOR_CONFIG.alphaTotal
    / (WEB_DETECTOR_CONFIG.maxValidPerGroup / WEB_DETECTOR_CONFIG.lookBatchPerGroup);
  assert.equal(alphaAtLook, 0.025);
  assert.ok(Math.abs(bestCase.pValue - 0.0009391056991171899) < 1e-15);
  assert.ok(bestCase.pValue < alphaAtLook);
});

test("starts use the fixed web config, internal target paths, and a server seed stream", async () => {
  let captured;
  let configuredTimeout;
  const { manager } = createManager({
    detectorRunner: async (options) => {
      captured ??= options;
      return detectorFixture(options.config.seed);
    },
    transportFactory: ({ timeoutMs }) => {
      configuredTimeout = timeoutMs;
      return { send: async () => ({ durationMs: 1, kind: "accepted", statusCode: 200 }) };
    },
  });
  const first = manager.start({ clientKey: "client-a", noisePresetId: "none", targetId: "vulnerable" });
  const second = manager.start({ clientKey: "client-b", noisePresetId: "none", targetId: "fixed" });
  await manager.waitFor(first.runId);
  await manager.waitFor(second.runId);

  assert.equal(first.status, "running");
  assert.match(first.runId, /^run-0001$/);
  assert.match(second.runId, /^run-0002$/);
  assert.notEqual(manager.get(first.runId).seed, manager.get(second.runId).seed);
  assert.equal(captured.config.maxValidPerGroup, 8);
  assert.equal(captured.config.lookBatchPerGroup, 4);
  assert.equal(captured.config.minValidPerGroup, 4);
  assert.equal(captured.config.maxAttempts, 20);
  assert.equal(configuredTimeout, DEFAULT_REQUEST_TIMEOUT_MS);
  assert.equal(captured.requests.a.method, "POST");
  assert.equal(captured.requests.a.path, "/login");
  assert.equal(captured.requests.b.path, "/login");
  assert.deepEqual(JSON.parse(captured.requests.a.body), {
    password: "demo-password",
    username: "known-user",
  });
  assert.deepEqual(JSON.parse(captured.requests.b.body), {
    password: "demo-password",
    username: "missing-user",
  });
  assert.equal(captured.requests.a.url, "http://127.0.0.1:3001/login");
  assert.equal(captured.requests.b.url, "http://127.0.0.1:3001/login");
  await manager.shutdown();
});

test("shared client keys use a global active bound of three and a per-client bound of one", async () => {
  const signals = [];
  const { dispatcherCloseCount, manager } = createManager({
    detectorRunner: ({ signal }) => new Promise((resolve) => {
      signals.push(signal);
      if (signal.aborted) {
        resolve(detectorFixture("aborted"));
        return;
      }
      signal.addEventListener("abort", () => resolve(detectorFixture("aborted")), { once: true });
    }),
  });
  const first = manager.start({ clientKey: "client-a", noisePresetId: "none", targetId: "vulnerable" });
  await flushMicrotasks();
  assert.throws(
    () => manager.start({ clientKey: "client-a", noisePresetId: "none", targetId: "fixed" }),
    (error) => error.code === "active-run-limit" && error.statusCode === 429,
  );
  manager.start({ clientKey: "client-b", noisePresetId: "none", targetId: "fixed" });
  manager.start({ clientKey: "client-c", noisePresetId: "none", targetId: "fixed" });
  assert.equal(manager.maxActiveRuns, DEFAULT_ACTIVE_RUNS_WITH_SHARED_CLIENT_IP);
  assert.equal(manager.activeCount(), 3);
  assert.throws(
    () => manager.start({ clientKey: "client-d", noisePresetId: "none", targetId: "fixed" }),
    (error) => error.code === "active-run-limit" && error.statusCode === 429,
  );
  await manager.shutdown();
  await flushMicrotasks();
  assert.equal(signals.length, 3);
  assert.equal(manager.activeCount(), 0);
  assert.equal(dispatcherCloseCount(), 1);
});

test("hand-written start rate limiter rejects the fourth start and expires by injected time", async () => {
  const clock = createFakeClock();
  const { manager } = createManager({ clock, rateWindowMs: 100 });
  for (let index = 0; index < 3; index += 1) {
    const run = manager.start({
      clientKey: "same-client",
      noisePresetId: "none",
      targetId: "vulnerable",
    });
    await manager.waitFor(run.runId);
  }
  assert.throws(
    () => manager.start({ clientKey: "same-client", noisePresetId: "none", targetId: "vulnerable" }),
    (error) => error.code === "rate-limit-exceeded" && error.statusCode === 429,
  );
  clock.advance(101);
  const allowed = manager.start({
    clientKey: "same-client",
    noisePresetId: "none",
    targetId: "vulnerable",
  });
  await manager.waitFor(allowed.runId);
  await manager.shutdown();
});

test("detector failure and report failure retain only fixed failure codes", async () => {
  const detectorFailure = createManager({
    detectorRunner: async () => {
      throw new Error("secret detector detail");
    },
  });
  const detectorRun = detectorFailure.manager.start({
    clientKey: "detector-failure",
    noisePresetId: "none",
    targetId: "vulnerable",
  });
  await detectorFailure.manager.waitFor(detectorRun.runId);
  const failedDetector = detectorFailure.manager.get(detectorRun.runId);
  assert.deepEqual(failedDetector.failureCode, RUN_FAILURE_CODE.DETECTOR_FAILED);
  assert.equal(JSON.stringify(failedDetector).includes("secret detector detail"), false);
  await detectorFailure.manager.shutdown();

  const reportFailure = createManager({
    reportBuilder: async () => {
      throw new Error("secret report detail");
    },
  });
  const reportRun = reportFailure.manager.start({
    clientKey: "report-failure",
    noisePresetId: "none",
    targetId: "vulnerable",
  });
  await reportFailure.manager.waitFor(reportRun.runId);
  const failedReport = reportFailure.manager.get(reportRun.runId);
  assert.deepEqual(failedReport.failureCode, RUN_FAILURE_CODE.REPORT_BUILD_FAILED);
  assert.equal(JSON.stringify(failedReport).includes("secret report detail"), false);
  await reportFailure.manager.shutdown();
});

test("maximum run duration aborts through the injected scheduler and releases the slot", async () => {
  const clock = createFakeClock();
  let aborted = false;
  const { manager } = createManager({
    clock,
    maxRunDurationMs: 50,
    detectorRunner: ({ signal }) => new Promise((resolve) => {
      if (signal.aborted) {
        aborted = true;
        resolve(detectorFixture("timed-out"));
        return;
      }
      signal.addEventListener("abort", () => {
        aborted = true;
        resolve(detectorFixture("timed-out"));
      }, { once: true });
    }),
  });
  const run = manager.start({ clientKey: "timeout", noisePresetId: "none", targetId: "vulnerable" });
  await flushMicrotasks();
  clock.advance(50);
  await manager.waitFor(run.runId);
  assert.equal(aborted, true);
  assert.equal(manager.activeCount(), 0);
  assert.equal(manager.get(run.runId).status, "failed");
  assert.equal(manager.get(run.runId).failureCode, RUN_FAILURE_CODE.RUN_TIMEOUT);
  await manager.shutdown();
});

test("disconnect cleanup aborts and removes the active run without retaining history", async () => {
  const { manager } = createManager({
    detectorRunner: ({ signal }) => new Promise((resolve) => {
      if (signal.aborted) {
        resolve(detectorFixture("disconnected"));
        return;
      }
      signal.addEventListener("abort", () => resolve(detectorFixture("disconnected")), { once: true });
    }),
  });
  const run = manager.start({ clientKey: "disconnecting", noisePresetId: "none", targetId: "vulnerable" });
  await flushMicrotasks();
  assert.equal(manager.disconnect(run.runId, "disconnecting"), true);
  await manager.waitFor(run.runId);
  assert.equal(manager.activeCount(), 0);
  assert.equal(manager.get(run.runId), null);
  await manager.shutdown();
});

test("completed reports expire and are never persistent history", async () => {
  const clock = createFakeClock();
  const { manager } = createManager({ clock, reportRetentionMs: 10 });
  const run = manager.start({ clientKey: "retention", noisePresetId: "none", targetId: "vulnerable" });
  await manager.waitFor(run.runId);
  assert.equal(manager.get(run.runId).status, "complete");
  assert.deepEqual(manager.getReport(run.runId), manager.get(run.runId).report);
  clock.advance(10);
  assert.equal(manager.get(run.runId), null);
  assert.equal(manager.getReport(run.runId), null);
  assert.equal(manager.activeCount(), 0);
  await manager.shutdown();
});

test("retained report state has a count bound as well as a time bound", async () => {
  const { manager } = createManager({ maxRetainedRuns: 1 });
  const first = manager.start({ clientKey: "retained-a", noisePresetId: "none", targetId: "vulnerable" });
  await manager.waitFor(first.runId);
  const second = manager.start({ clientKey: "retained-b", noisePresetId: "none", targetId: "vulnerable" });
  await manager.waitFor(second.runId);
  assert.equal(manager.maxRetainedRuns, 1);
  assert.equal(manager.get(first.runId), null);
  assert.equal(manager.get(second.runId).status, "complete");
  await manager.shutdown();
});

test("duration environment values use planned defaults and bounded validation", async () => {
  const defaults = createManager();
  assert.equal(defaults.manager.maxRunDurationMs, DEFAULT_MAX_RUN_DURATION_MS);
  assert.equal(defaults.manager.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS);
  await defaults.manager.shutdown();

  assert.throws(
    () => createManager({ environment: { SCAN_MAX_DURATION_MS: "120001" } }),
    /SCAN_MAX_DURATION_MS/,
  );
  assert.throws(
    () => createManager({ environment: { SCAN_REQUEST_TIMEOUT_MS: "30001" } }),
    /SCAN_REQUEST_TIMEOUT_MS/,
  );
  const configured = createManager({
    environment: {
      SCAN_MAX_DURATION_MS: "100",
      SCAN_REQUEST_TIMEOUT_MS: "20",
    },
  });
  assert.equal(configured.manager.maxRunDurationMs, 100);
  assert.equal(configured.manager.requestTimeoutMs, 20);
  await configured.manager.shutdown();
});

test("trust proxy configuration is explicit and defaults to not trusting forwarded headers", async () => {
  const direct = createWebApp({
    environment: { TRUST_PROXY_HOPS: "0" },
    managerOptions: { detectorRunner: async () => detectorFixture("direct") },
  });
  assert.equal(direct.get("trust proxy"), false);
  await direct.locals.runManager.shutdown();

  const trusted = createWebApp({
    environment: { TRUST_PROXY_HOPS: "1" },
    managerOptions: { detectorRunner: async () => detectorFixture("trusted") },
  });
  assert.equal(trusted.get("trust proxy"), 1);
  assert.equal(trusted.locals.runManager.maxActiveRuns, 2);
  await trusted.locals.runManager.shutdown();
});

test("one real local scan uses the shared HTTP dispatcher and produces a valid report", async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const manager = createRunManager({
    reportBuilder: createRunReport,
    targetMap: {
      fixed: { host: "127.0.0.1", port: address.port },
      vulnerable: { host: "127.0.0.1", port: address.port },
    },
  });
  try {
    const run = manager.start({ clientKey: "real-local", noisePresetId: "none", targetId: "vulnerable" });
    await manager.waitFor(run.runId);
    const completed = manager.get(run.runId);
    assert.equal(completed.status, "complete");
    validateRunReport(completed.report);
    validateRunReport(manager.getReport(run.runId));
    assert.equal(completed.report.buildVersion, WEB_BUILD_INFO.buildVersion);
    assert.equal(completed.report.detectorVersion, WEB_BUILD_INFO.detectorVersion);
    assert.equal(completed.report.configuration.target.id, "vulnerable");
    assert.equal(completed.report.configuration.detector.maxValidPerGroup, 8);
  } finally {
    await manager.shutdown();
    await closeHttpServer(server);
  }
});
