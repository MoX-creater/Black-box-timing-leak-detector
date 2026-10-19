import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";

import { request } from "undici";

import { createRunReport, validateRunReport } from "../src/report/index.js";
import { createWebApp } from "../src/server/app.js";
import { MAX_EXPIRED_RUN_IDS } from "../src/server/run-manager.js";

const NOT_FOUND = { error: { code: "run-not-found", message: "Scan run was not found" } };
const EXPIRED = { error: { code: "report-expired", message: "Scan report has expired" } };
const SERVER_SEED = "private-server-stream-seed-sentinel";
const CLIENT_KEY = "198.51.100.217";
const ENVIRONMENT = Object.freeze({
  DEMO_FIXED_HOST: "private-fixed-sentinel.example.test",
  DEMO_FIXED_PORT: "61091",
  DEMO_VULNERABLE_HOST: "private-vulnerable-sentinel.example.test",
  DEMO_VULNERABLE_PORT: "61093",
  GIT_COMMIT: "abcdef0123456789abcdef0123456789abcdef01",
  SCAN_SEED: SERVER_SEED,
  TRUST_PROXY_HOPS: "1",
});

function createFakeClock() {
  let current = 1_000;
  let nextId = 1;
  const timers = new Map();
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
    elapse: (milliseconds) => { current += milliseconds; },
    now: () => current,
    pending: () => timers.size,
    scheduler: {
      clearTimeout: (id) => timers.delete(id),
      setTimeout(callback, delay) {
        const id = nextId++;
        timers.set(id, { callback, due: current + delay });
        return id;
      },
    },
  };
}

function emptyDetectorResult(seed) {
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

async function startReportApi(t, overrides = {}) {
  const clock = createFakeClock();
  const app = createWebApp({
    environment: ENVIRONMENT,
    managerOptions: {
      detectorRunner: async ({ config }) => emptyDetectorResult(config.seed),
      now: clock.now,
      reportBuilder: createRunReport,
      reportValidator: validateRunReport,
      reportRetentionMs: 100,
      scheduler: clock.scheduler,
      transportFactory: () => ({ send: async () => assert.fail("unexpected outbound request") }),
      ...overrides,
    },
  });
  const manager = app.locals.runManager;
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    await manager.shutdown();
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });
  return { clock, manager, url: `http://127.0.0.1:${server.address().port}` };
}

async function assertReportError(url, runId, statusCode, body) {
  const response = await request(`${url}/api/scans/${runId}/report`);
  assert.equal(response.statusCode, statusCode);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(response.headers["content-disposition"], undefined);
  assert.deepEqual(await response.body.json(), body);
}

async function completeRun(manager, clientKey = CLIENT_KEY) {
  const run = manager.start({ clientKey, noisePresetId: "none", targetId: "fixed" });
  await manager.waitFor(run.runId);
  assert.equal(manager.getSnapshot(run.runId).status, "complete");
  return run;
}

test("report route downloads the same validated run with web-only metadata redaction", async (t) => {
  const { manager, url } = await startReportApi(t);
  const run = await completeRun(manager);
  const expected = manager.getReport(run.runId);
  validateRunReport(expected);
  const response = await request(`${url}/api/scans/${run.runId}/report`);

  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.match(response.headers["content-type"], /^application\/json; charset=utf-8/);
  assert.match(response.headers["content-disposition"], /attachment; filename="?timing-leak-report\.json"?/);
  const serialized = await response.body.text();
  const report = JSON.parse(serialized);
  validateRunReport(report);
  assert.deepEqual(report, expected);
  assert.equal(report.configuration.target.id, "fixed");
  assert.equal(report.configuration.detector.seed, manager.get(run.runId).seed);
  assert.deepEqual(report.observation.samples, { a: [], b: [] });
  assert.equal(report.inference.statistics, null);
  assert.deepEqual(report.configuration.target.redactedMetadata.a, {
    bodyBytes: 52,
    headerNames: ["content-type"],
    method: "POST",
    path: "/login",
  });
  assert.deepEqual(report.configuration.target.redactedMetadata.b, {
    bodyBytes: 54,
    headerNames: ["content-type"],
    method: "POST",
    path: "/login",
  });
  assert.deepEqual(report.configuration.noise, { presetId: "none" });
  for (const forbidden of [
    ENVIRONMENT.DEMO_FIXED_HOST,
    ENVIRONMENT.DEMO_FIXED_PORT,
    ENVIRONMENT.DEMO_VULNERABLE_HOST,
    ENVIRONMENT.DEMO_VULNERABLE_PORT,
    CLIENT_KEY,
    SERVER_SEED,
    "demo-password",
  ]) {
    assert.equal(serialized.includes(forbidden), false, `found ${forbidden}`);
  }
});

test("report route uses fixed 404 envelopes for malformed and unknown IDs", async (t) => {
  const { url } = await startReportApi(t);
  await assertReportError(url, "not-a-run", 404, NOT_FOUND);
  await assertReportError(url, "run-9999", 404, NOT_FOUND);
  await assertReportError(url, "run-0000", 404, NOT_FOUND);
});

test("report route uses a fixed 410 envelope only for a fresh expired ID", async (t) => {
  const { clock, manager, url } = await startReportApi(t);
  const run = await completeRun(manager);
  clock.advance(100);
  await assertReportError(url, run.runId, 410, EXPIRED);
});

test("expired run ID markers are bounded with oldest-first eviction", async (t) => {
  const { clock, manager, url } = await startReportApi(t);
  const runs = [];
  for (let index = 0; index < MAX_EXPIRED_RUN_IDS + 1; index += 1) {
    runs.push(await completeRun(manager, `client-${index}`));
  }
  clock.advance(100);
  await assertReportError(url, runs[0].runId, 404, NOT_FOUND);
  await assertReportError(url, runs.at(-1).runId, 410, EXPIRED);
  await assertReportError(url, "run-9999", 404, NOT_FOUND);
});
