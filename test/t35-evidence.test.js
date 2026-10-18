import test from "node:test";
import assert from "node:assert/strict";

import { createRunManager } from "../src/server/run-manager.js";

const TARGET_MAP = Object.freeze({
  fixed: Object.freeze({ host: "127.0.0.1", port: 3002 }),
  vulnerable: Object.freeze({ host: "127.0.0.1", port: 3001 }),
});

function detectorFixture(seed) {
  return {
    counts: {
      a: { accepted: 0, attempts: 0, discarded: 0, discardReasons: {} },
      b: { accepted: 0, attempts: 0, discarded: 0, discardReasons: {} },
    },
    expectedStatus: 200,
    lookHistory: [],
    samples: { a: [1.5], b: [2.5] },
    seed,
    sensitivityMs: 1.75,
    stopReason: "leak-detected",
    verdict: "LEAK",
    warmupRecords: [],
    warnings: [],
  };
}

function reportFixture(runSeed) {
  return {
    configuration: {
      detector: { seed: "private-seed" },
      target: {
        redactedMetadata: {
          a: { hostname: "private-host", port: 3001 },
          b: { hostname: "private-host", port: 3001 },
        },
      },
    },
    inference: {
      statistics: {
        lowPercentile: {
          a: 1.25,
          absoluteDelta: 2.5,
          b: 3.75,
          method: "linear-type-7",
          probability: 0.1,
          signedDelta: -2.5,
        },
        mannWhitney: {
          degenerate: false,
          pValue: 0.0125,
          uA: 3,
          uB: 5,
          z: -2.1,
        },
      },
      sensitivityMs: 4.5,
      verdict: "LEAK",
      warnings: [
        {
          code: "BODY_LENGTH_DIFFERENCE",
          differenceBytes: 12,
          message: "private warning message",
        },
        {
          code: "DISCARD_RATE_DIFFERENCE",
          message: "private discard message",
          rateA: 0.1,
          rateB: 0.2,
          rates: { a: 0.1, b: 0.2 },
        },
      ],
    },
    observation: {
      requestMetadata: {
        body: "private body",
        clientKey: "private-client-key",
        url: "http://private-host:3001/login",
      },
      samples: { a: [1.5], b: [2.5] },
      seed: "private-seed",
      stopReason: "leak-detected",
    },
    runSeed,
  };
}

function createManager(overrides = {}) {
  return createRunManager({
    detectorRunner: async ({ config }) => detectorFixture(config.seed),
    environment: {},
    reportBuilder: async ({ runSeed }) => reportFixture(runSeed),
    reportValidator: () => {},
    targetMap: TARGET_MAP,
    transportFactory: () => ({
      send: async () => ({ durationMs: 1, kind: "accepted", statusCode: 200 }),
    }),
    ...overrides,
  });
}

test("completed public evidence is an additive sanitized named-field projection", async () => {
  const manager = createManager();
  const run = manager.start({ clientKey: "private-client-key", noisePresetId: "none", targetId: "fixed" });
  await manager.waitFor(run.runId);

  const snapshot = manager.getSnapshot(run.runId);
  assert.deepEqual(snapshot.evidence, {
    sensitivityMs: 4.5,
    statistics: {
      lowPercentile: {
        a: 1.25,
        absoluteDelta: 2.5,
        b: 3.75,
        method: "linear-type-7",
        probability: 0.1,
        signedDelta: -2.5,
      },
      mannWhitney: {
        degenerate: false,
        pValue: 0.0125,
        uA: 3,
        uB: 5,
        z: -2.1,
      },
    },
    stopReason: "leak-detected",
    warnings: [
      { code: "BODY_LENGTH_DIFFERENCE", differenceBytes: 12 },
      { code: "DISCARD_RATE_DIFFERENCE", rateA: 0.1, rateB: 0.2 },
    ],
  });

  const serialized = JSON.stringify(snapshot);
  for (const forbidden of [
    "private-seed",
    "private-host",
    "3001",
    "private-client-key",
    "private body",
    "requestMetadata",
    "\"samples\"",
    "private warning message",
  ]) {
    assert.equal(serialized.includes(forbidden), false, `found ${forbidden}`);
  }

  const events = [];
  manager.subscribe(run.runId, (event, payload) => events.push({ event, payload }));
  const complete = events.find(({ event }) => event === "scan:complete");
  assert.deepEqual(complete.payload.evidence, snapshot.evidence);
  await manager.shutdown();
});

test("unavailable report statistics and sensitivity remain null in public evidence", async () => {
  const manager = createManager({
    reportBuilder: async () => ({
      inference: { statistics: null, sensitivityMs: null, verdict: "INCONCLUSIVE", warnings: [] },
      observation: { stopReason: "sensitivity-unavailable" },
    }),
  });
  const run = manager.start({ clientKey: "unavailable", noisePresetId: "none", targetId: "fixed" });
  await manager.waitFor(run.runId);
  assert.deepEqual(manager.getSnapshot(run.runId).evidence, {
    sensitivityMs: null,
    statistics: null,
    stopReason: "sensitivity-unavailable",
    warnings: [],
  });
  await manager.shutdown();
});
