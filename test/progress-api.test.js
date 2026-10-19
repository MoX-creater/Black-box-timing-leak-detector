import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";

import { request } from "undici";

import {
  createRunManager,
  RUN_FAILURE_CODE,
} from "../src/server/run-manager.js";
import { startWebServer } from "../src/server/index.js";
import { writeSseComment, writeSseEvent } from "../src/server/app.js";

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

function detectorFixture(seed, samples = { a: [], b: [] }) {
  return {
    counts: {
      a: {
        accepted: samples.a.length,
        attempts: samples.a.length,
        discarded: 0,
        discardReasons: {},
      },
      b: {
        accepted: samples.b.length,
        attempts: samples.b.length,
        discarded: 0,
        discardReasons: {},
      },
    },
    expectedStatus: 200,
    lookHistory: [],
    samples,
    seed,
    sensitivityMs: 1,
    stopReason: "max-samples-no-leak",
    verdict: "NO_LEAK_DETECTED",
    warmupRecords: [],
    warnings: [],
  };
}

function publicReport(verdict = "NO_LEAK_DETECTED") {
  return {
    inference: {
      sensitivityMs: 1.25,
      stopReason: "not-used-in-inference",
      verdict,
    },
    observation: {
      stopReason: "max-samples-no-leak",
    },
  };
}

function createManager(overrides = {}) {
  const clock = overrides.clock ?? createFakeClock();
  const manager = createRunManager({
    agentFactory: () => undefined,
    detectorRunner: async ({ config }) => detectorFixture(config.seed),
    environment: {},
    now: clock.now,
    reportBuilder: async () => publicReport(),
    reportValidator: () => {},
    scheduler: clock.scheduler,
    targetMap: TARGET_MAP,
    transportFactory: () => ({
      send: async () => ({ durationMs: 1, kind: "accepted", statusCode: 200 }),
    }),
    ...overrides,
  });
  return { clock, manager };
}

function sumBins(bins) {
  return bins.reduce((total, bin) => total + bin.count, 0);
}

async function closeServer(server) {
  if (!server.listening) {
    return;
  }
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function startApiServer({ environment = {}, managerOptions = {} } = {}) {
  const server = startWebServer({
    environment,
    host: "127.0.0.1",
    managerOptions,
    port: 0,
  });
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return { server, url: `http://127.0.0.1:${address.port}` };
}

function parseSse(text) {
  return text
    .split("\n\n")
    .filter((frame) => frame.startsWith("event: "))
    .map((frame) => {
      const lines = frame.split("\n");
      return {
        data: JSON.parse(lines.find((line) => line.startsWith("data: ")).slice(6)),
        event: lines.find((line) => line.startsWith("event: ")).slice(7),
      };
    });
}

test("run snapshots and events expose bounded, sanitized histogram progress", async () => {
  const { manager } = createManager({
    detectorRunner: async ({ config, onProgress }) => {
      onProgress({
        counts: {
          a: { accepted: 2, attempts: 3, discarded: 1, discardReasons: { error: 1 } },
          b: { accepted: 2, attempts: 2, discarded: 0, discardReasons: {} },
        },
        lookHistory: 2,
        samples: { a: [1, 2, Number.NaN], b: [3, 4] },
      });
      return detectorFixture(config.seed, { a: [1, 2], b: [3, 4] });
    },
    reportBuilder: async () => publicReport("LEAK"),
  });
  const run = manager.start({ clientKey: "private-client-key", noisePresetId: "none", targetId: "vulnerable" });
  await manager.waitFor(run.runId);

  const snapshot = manager.getSnapshot(run.runId);
  assert.equal(snapshot.status, "complete");
  assert.deepEqual(snapshot.progress.attempts, { a: 3, b: 2 });
  assert.deepEqual(snapshot.progress.accepted, { a: 2, b: 2 });
  assert.deepEqual(snapshot.progress.discarded, { a: 1, b: 0 });
  assert.deepEqual(snapshot.progress.errors, { a: 1, b: 0 });
  assert.equal(sumBins(snapshot.histograms.a), 2);
  assert.equal(sumBins(snapshot.histograms.b), 2);
  assert.ok(snapshot.histograms.a.length <= 64);
  assert.ok(snapshot.histograms.b.length <= 64);
  assert.equal(snapshot.verdict, "LEAK");
  assert.equal(snapshot.inference.sensitivityMs, 1.25);
  assert.equal(snapshot.reportUrl, `/api/scans/${run.runId}/report`);

  const events = [];
  manager.subscribe(run.runId, (event, payload) => events.push({ event, payload }));
  assert.deepEqual(events.map(({ event }) => event), [
    "scan:started",
    "scan:progress",
    "scan:complete",
  ]);
  assert.equal(events.at(-1).payload.verdict, "LEAK");

  const serialized = JSON.stringify(snapshot);
  for (const forbidden of ["private-client-key", "web-scan-run", "127.0.0.1", "3001", "secret"]) {
    assert.equal(serialized.includes(forbidden), false, `found ${forbidden}`);
  }
  await manager.shutdown();
});

test("zero-range samples use one shared histogram bin", async () => {
  const { manager } = createManager({
    detectorRunner: async ({ config, onProgress }) => {
      onProgress({
        counts: {
          a: { accepted: 2, attempts: 2, discarded: 0, discardReasons: {} },
          b: { accepted: 2, attempts: 2, discarded: 0, discardReasons: {} },
        },
        samples: { a: [5, 5], b: [5, 5] },
      });
      return detectorFixture(config.seed, { a: [5, 5], b: [5, 5] });
    },
  });
  const run = manager.start({ clientKey: "zero-range", noisePresetId: "none", targetId: "fixed" });
  await manager.waitFor(run.runId);
  const snapshot = manager.getSnapshot(run.runId);
  assert.equal(snapshot.histograms.a.length, 1);
  assert.equal(snapshot.histograms.b.length, 1);
  assert.deepEqual(snapshot.histograms.a[0], snapshot.histograms.b[0]);
  assert.equal(snapshot.histograms.a[0].count, 2);
  await manager.shutdown();
});

test("histograms cap bin count without dropping finite accepted samples", async () => {
  const samples = {
    a: Array.from({ length: 100 }, (_, index) => index + 1),
    b: Array.from({ length: 100 }, (_, index) => index + 101),
  };
  const { manager } = createManager({
    detectorRunner: async ({ config, onProgress }) => {
      onProgress({
        counts: {
          a: { accepted: 100, attempts: 100, discarded: 0, discardReasons: {} },
          b: { accepted: 100, attempts: 100, discarded: 0, discardReasons: {} },
        },
        samples,
      });
      return detectorFixture(config.seed, samples);
    },
  });
  const run = manager.start({ clientKey: "histogram-cap", noisePresetId: "none", targetId: "fixed" });
  await manager.waitFor(run.runId);
  const snapshot = manager.getSnapshot(run.runId);
  assert.ok(snapshot.histograms.a.length <= 64);
  assert.ok(snapshot.histograms.b.length <= 64);
  assert.equal(sumBins(snapshot.histograms.a), 100);
  assert.equal(sumBins(snapshot.histograms.b), 100);
  assert.deepEqual(snapshot.histograms.a.map(({ startMs, endMs }) => [startMs, endMs]),
    snapshot.histograms.b.map(({ startMs, endMs }) => [startMs, endMs]));
  await manager.shutdown();
});

test("only the last SSE subscriber starts the injected grace-period abort", async () => {
  const clock = createFakeClock();
  const { manager } = createManager({
    clock,
    sseDisconnectGraceMs: 50,
    detectorRunner: ({ signal }) => new Promise((resolve) => {
      if (signal.aborted) {
        resolve(detectorFixture("aborted"));
        return;
      }
      signal.addEventListener("abort", () => resolve(detectorFixture("aborted")), { once: true });
    }),
  });
  const run = manager.start({ clientKey: "subscribers", noisePresetId: "none", targetId: "vulnerable" });
  await flushMicrotasks();
  const first = manager.subscribe(run.runId, () => {});
  const second = manager.subscribe(run.runId, () => {});
  assert.equal(manager.subscriberCount(run.runId), 2);

  first.unsubscribe();
  assert.equal(manager.subscriberCount(run.runId), 1);
  clock.advance(50);
  assert.equal(manager.activeCount(), 1);

  second.unsubscribe();
  clock.advance(49);
  assert.equal(manager.activeCount(), 1);
  clock.advance(1);
  await manager.waitFor(run.runId);
  assert.equal(manager.activeCount(), 0);
  assert.equal(manager.get(run.runId), null);
  await manager.shutdown();
});

test("a reconnect during the grace period cancels the pending abort", async () => {
  const clock = createFakeClock();
  const { manager } = createManager({
    clock,
    sseDisconnectGraceMs: 50,
    detectorRunner: ({ signal }) => new Promise((resolve) => {
      signal.addEventListener("abort", () => resolve(detectorFixture("aborted")), { once: true });
    }),
  });
  const run = manager.start({ clientKey: "reconnect", noisePresetId: "none", targetId: "fixed" });
  await flushMicrotasks();
  const first = manager.subscribe(run.runId, () => {});
  first.unsubscribe();
  clock.advance(25);
  const reconnected = manager.subscribe(run.runId, () => {});
  clock.advance(50);
  assert.equal(manager.activeCount(), 1);
  reconnected.unsubscribe();
  clock.advance(50);
  await manager.waitFor(run.runId);
  await manager.shutdown();
});

test("retention expiry emits an expired event and drops the snapshot", async () => {
  const clock = createFakeClock();
  const { manager } = createManager({ clock, reportRetentionMs: 10 });
  const run = manager.start({ clientKey: "expiry", noisePresetId: "none", targetId: "vulnerable" });
  await manager.waitFor(run.runId);
  clock.advance(10);
  assert.equal(manager.get(run.runId), null);
  assert.equal(manager.getSnapshot(run.runId).status, "expired");
  const events = [];
  manager.subscribe(run.runId, (event, payload) => events.push({ event, payload }));
  assert.deepEqual(events, [{ event: "scan:expired", payload: { runId: run.runId, status: "expired" } }]);
  assert.equal(clock.pending(), 0);
  await manager.shutdown();
});

test("SSE write helpers guard ended responses and report backpressure", () => {
  let writes = 0;
  const backpressured = {
    destroyed: false,
    writableEnded: false,
    write() {
      writes += 1;
      return false;
    },
  };
  assert.equal(writeSseEvent(backpressured, "scan:progress", { runId: "run-0001" }), false);
  assert.equal(writeSseComment(backpressured), false);
  assert.equal(writes, 2);
  assert.equal(writeSseEvent({ destroyed: false, writableEnded: true, write: () => true }, "x", {}), false);
});

test("polling and late SSE attachment expose the approved public event contract", async () => {
  const { server, url } = await startApiServer({
    managerOptions: {
      detectorRunner: async ({ config, onProgress }) => {
        onProgress({
          counts: {
            a: { accepted: 2, attempts: 2, discarded: 0, discardReasons: {} },
            b: { accepted: 2, attempts: 2, discarded: 0, discardReasons: {} },
          },
          lookHistory: 1,
          samples: { a: [1, 2], b: [3, 4] },
        });
        return detectorFixture(config.seed, { a: [1, 2], b: [3, 4] });
      },
      reportBuilder: async () => publicReport("LEAK"),
      reportValidator: () => {},
    },
  });
  try {
    const start = await request(`${url}/api/scans`, {
      body: JSON.stringify({ noisePresetId: "none", targetId: "vulnerable" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    assert.equal(start.statusCode, 202);
    const run = await start.body.json();

    const snapshotResponse = await request(`${url}/api/scans/${run.runId}`);
    assert.equal(snapshotResponse.statusCode, 200);
    assert.equal(snapshotResponse.headers["cache-control"], "no-store");
    const snapshot = await snapshotResponse.body.json();
    assert.equal(snapshot.status, "complete");
    assert.equal(snapshot.verdict, "LEAK");
    assert.equal(sumBins(snapshot.histograms.a), 2);
    assert.equal(sumBins(snapshot.histograms.b), 2);
    const reportResponse = await request(`${url}/api/scans/${run.runId}/report`);
    assert.equal(reportResponse.statusCode, 200);
    assert.equal(reportResponse.headers["cache-control"], "no-store");
    assert.match(reportResponse.headers["content-type"], /^application\/json; charset=utf-8/);
    assert.match(
      reportResponse.headers["content-disposition"],
      /attachment; filename="?timing-leak-report\.json"?/,
    );
    assert.deepEqual(await reportResponse.body.json(), publicReport("LEAK"));

    const missingReport = await request(`${url}/api/scans/run-9999/report`);
    assert.equal(missingReport.statusCode, 404);
    assert.deepEqual(await missingReport.body.json(), {
      error: { code: "run-not-found", message: "Scan run was not found" },
    });
    const invalidReport = await request(`${url}/api/scans/not-a-run/report`);
    assert.equal(invalidReport.statusCode, 404);
    assert.deepEqual(await invalidReport.body.json(), {
      error: { code: "run-not-found", message: "Scan run was not found" },
    });
    const serialized = JSON.stringify(snapshot);
    for (const forbidden of ["web-scan-run", "127.0.0.1", "3001", "demo-password"]) {
      assert.equal(serialized.includes(forbidden), false, `found ${forbidden}`);
    }

    const eventsResponse = await request(`${url}/api/scans/${run.runId}/events`);
    assert.equal(eventsResponse.statusCode, 200);
    assert.match(eventsResponse.headers["content-type"], /^text\/event-stream; charset=utf-8/);
    assert.equal(eventsResponse.headers["cache-control"], "no-cache, no-store, no-transform");
    assert.equal(eventsResponse.headers["x-accel-buffering"], "no");
    const events = parseSse(await eventsResponse.body.text());
    assert.deepEqual(events.map(({ event }) => event), [
      "scan:started",
      "scan:progress",
      "scan:complete",
    ]);
    assert.equal(events[1].data.lookIndex, 1);
    assert.equal(events[2].data.verdict, "LEAK");

    const invalidId = await request(`${url}/api/scans/not-a-run`);
    assert.equal(invalidId.statusCode, 400);
    assert.deepEqual(await invalidId.body.json(), {
      error: { code: "invalid-run-id", message: "Scan ID is invalid" },
    });
    const missing = await request(`${url}/api/scans/run-9999`);
    assert.equal(missing.statusCode, 404);
    assert.deepEqual(await missing.body.json(), {
      error: { code: "run-not-found", message: "Scan run was not found" },
    });
  } finally {
    await closeServer(server);
  }
});

test("report downloads return a fixed 410 envelope after retention expiry", async () => {
  const clock = createFakeClock();
  const { server, url } = await startApiServer({
    managerOptions: {
      detectorRunner: async ({ config }) => detectorFixture(config.seed),
      now: clock.now,
      reportRetentionMs: 10,
      reportBuilder: async () => publicReport(),
      reportValidator: () => {},
      scheduler: clock.scheduler,
      transportFactory: () => ({
        send: async () => ({ durationMs: 1, kind: "accepted", statusCode: 200 }),
      }),
    },
  });
  try {
    const start = await request(`${url}/api/scans`, {
      body: JSON.stringify({ noisePresetId: "none", targetId: "vulnerable" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const run = await start.body.json();
    let snapshot;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const snapshotResponse = await request(`${url}/api/scans/${run.runId}`);
      snapshot = await snapshotResponse.body.json();
      if (snapshot.status === "complete") {
        break;
      }
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(snapshot.status, "complete");
    clock.advance(10);

    const expired = await request(`${url}/api/scans/${run.runId}/report`);
    assert.equal(expired.statusCode, 410);
    assert.deepEqual(await expired.body.json(), {
      error: { code: "report-expired", message: "Scan report has expired" },
    });
  } finally {
    await closeServer(server);
  }
});

test("failed snapshots and SSE errors expose only fixed failure details", async () => {
  const { server, url } = await startApiServer({
    managerOptions: {
      detectorRunner: async () => {
        throw new Error("private detector stack and target URL");
      },
    },
  });
  try {
    const start = await request(`${url}/api/scans`, {
      body: JSON.stringify({ noisePresetId: "none", targetId: "vulnerable" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const run = await start.body.json();
    let snapshot;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const response = await request(`${url}/api/scans/${run.runId}`);
      snapshot = await response.body.json();
      if (snapshot.status === "failed") {
        break;
      }
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(snapshot.status, "failed");
    assert.equal(snapshot.failureCode, RUN_FAILURE_CODE.DETECTOR_FAILED);
    assert.equal(JSON.stringify(snapshot).includes("private detector stack"), false);

    const eventsResponse = await request(`${url}/api/scans/${run.runId}/events`);
    const events = parseSse(await eventsResponse.body.text());
    assert.deepEqual(events.map(({ event }) => event), [
      "scan:started",
      "scan:progress",
      "scan:error",
    ]);
    assert.equal(events[2].data.code, RUN_FAILURE_CODE.DETECTOR_FAILED);
    assert.equal(events[2].data.message.includes("private detector stack"), false);
  } finally {
    await closeServer(server);
  }
});

test("SSE connections are capped with a fixed 429 response", async () => {
  const { server, url } = await startApiServer({
    managerOptions: {
      detectorRunner: ({ signal }) => new Promise((resolve) => {
        if (signal.aborted) {
          resolve(detectorFixture("aborted"));
          return;
        }
        signal.addEventListener("abort", () => resolve(detectorFixture("aborted")), { once: true });
      }),
    },
  });
  try {
    const start = await request(`${url}/api/scans`, {
      body: JSON.stringify({ noisePresetId: "none", targetId: "fixed" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const run = await start.body.json();
    const streams = await Promise.all(
      Array.from({ length: 8 }, () => request(`${url}/api/scans/${run.runId}/events`)),
    );
    assert.deepEqual(streams.map(({ statusCode }) => statusCode), Array(8).fill(200));

    const rejected = await request(`${url}/api/scans/${run.runId}/events`);
    assert.equal(rejected.statusCode, 429);
    assert.deepEqual(await rejected.body.json(), {
      error: {
        code: "sse-connection-limit",
        message: "Too many live scan connections",
      },
    });
  } finally {
    await closeServer(server);
  }
});

test("SSE keepalives use the injected scheduler", async () => {
  const clock = createFakeClock();
  const { server, url } = await startApiServer({
    managerOptions: {
      clock,
      detectorRunner: ({ signal }) => new Promise((resolve) => {
        if (signal.aborted) {
          resolve(detectorFixture("aborted"));
          return;
        }
        signal.addEventListener("abort", () => resolve(detectorFixture("aborted")), { once: true });
      }),
      now: clock.now,
      scheduler: clock.scheduler,
    },
  });
  try {
    const start = await request(`${url}/api/scans`, {
      body: JSON.stringify({ noisePresetId: "none", targetId: "fixed" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const run = await start.body.json();
    const stream = await request(`${url}/api/scans/${run.runId}/events`);
    let body = "";
    stream.body.on("data", (chunk) => {
      body += chunk.toString();
    });
    clock.advance(15_000);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.match(body, /: keepalive/);
  } finally {
    await closeServer(server);
  }
});
