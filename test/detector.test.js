import test from "node:test";
import assert from "node:assert/strict";

import {
  DetectorConfigurationError,
  runDetector,
} from "../src/detector/index.js";
import { formatVerdict, VERDICT } from "../src/inference/verdict.js";

const TEST_CONFIG = {
  alphaTotal: 0.05,
  bootstrapReplicates: 100,
  lookBatchPerGroup: 2,
  materialDiscardRateDifference: 0.2,
  maxAttempts: 20,
  maxConsecutiveFailures: 3,
  maxDiscardRate: 0.5,
  maxValidPerGroup: 4,
  minAttemptsForDiscardRate: 2,
  minValidPerGroup: 2,
  quantile: 0.1,
  seed: "detector-test-seed",
  targetPower: 0.8,
};

const REQUESTS = { a: { id: "a" }, b: { id: "b" } };

function senderFor({ a = [], b = [] }, calls = []) {
  const queues = { a: [...a], b: [...b] };
  return async (request, options) => {
    calls.push({ id: request.id, options });
    const result = queues[request.id].shift();
    if (!result) {
      throw new Error(`missing fixture result for ${request.id}`);
    }
    return result;
  };
}

function accepted(durationMs, statusCode = 200) {
  return { durationMs, kind: "accepted", statusCode };
}

function discarded(reason = "error", errorCode = "ECONNRESET") {
  return { errorCode, kind: "discarded", reason };
}

function balancedFixtures(aValues, bValues) {
  return {
    a: [accepted(999), ...aValues.map((value) => accepted(value))],
    b: [accepted(998), ...bValues.map((value) => accepted(value))],
  };
}

async function runFixture(fixtures, options = {}) {
  return runDetector({
    config: { ...TEST_CONFIG, ...options.config },
    onProgress: options.onProgress,
    requests: REQUESTS,
    send: senderFor(fixtures, options.calls),
    signal: options.signal,
  });
}

test("takes one warmup pair, establishes baseline status without expectedStatus, and excludes it", async () => {
  const calls = [];
  const result = await runFixture(
    balancedFixtures([10, 11, 12, 13], [10.2, 11.1, 12.2, 13.1]),
    { calls },
  );

  assert.equal(calls[0].options.expectedStatus, undefined);
  assert.equal(calls[1].options.expectedStatus, undefined);
  assert.ok(calls.slice(2).every(({ options }) => options.expectedStatus === 200));
  assert.deepEqual(result.warmupRecords.map(({ result: item }) => item.durationMs).sort(), [998, 999]);
  assert.deepEqual(result.samples, {
    a: [10, 11, 12, 13],
    b: [10.2, 11.1, 12.2, 13.1],
  });
});

test("interleaves measured A/B requests and reports a final no-leak verdict", async () => {
  const order = [];
  const result = await runFixture(
    balancedFixtures([10, 11, 12, 13], [10.2, 11.1, 12.2, 13.1]),
    { onProgress: () => order.push("progress") },
  );

  assert.equal(result.verdict, VERDICT.NO_LEAK_DETECTED);
  assert.equal(result.stopReason, "max-samples-no-leak");
  assert.equal(result.lookHistory.at(-1).lookIndex, 2);
  assert.equal(result.lookHistory.at(-1).maxLooks, 2);
  assert.equal(result.lookHistory[0].sensitivityMs, null);
  assert.equal(result.sensitivityMs > 0, true);
  assert.equal(result.warmupRecords.length, 2);
  assert.equal(result.samples.a.length, TEST_CONFIG.maxValidPerGroup);
  assert.equal(result.samples.b.length, TEST_CONFIG.maxValidPerGroup);
  assert.match(formatVerdict(result), /^NO LEAK DETECTED \(sensitivity >= /);
  assert.ok(order.length > 0);
});

test("stops early with LEAK when significance and practical effect both pass", async () => {
  const result = await runFixture(
    balancedFixtures([10, 11, 12, 13, 14, 15], [30, 31, 32, 33, 34, 35]),
    { config: { alphaTotal: 0.1, maxAttempts: 20, maxValidPerGroup: 6, targetPower: 0.51 } },
  );

  assert.equal(result.verdict, VERDICT.LEAK);
  assert.equal(result.stopReason, "leak-detected");
  assert.equal(result.lookHistory.length, 2);
  assert.equal(result.sensitivityMs > 0, true);
});

test("returns max-samples-inconclusive when significance is practical but delta is below MDE", async () => {
  const a = [0, 1, ...Array(18).fill(100)];
  const b = Array.from({ length: 20 }, (_value, index) => index);
  const result = await runFixture(
    balancedFixtures(a, b),
    {
      config: {
        bootstrapReplicates: 100,
        lookBatchPerGroup: 10,
        maxAttempts: 60,
        maxValidPerGroup: 20,
        minValidPerGroup: 10,
      },
    },
  );

  assert.equal(result.verdict, VERDICT.INCONCLUSIVE);
  assert.equal(result.stopReason, "max-samples-inconclusive");
  assert.equal(result.lookHistory.at(-1).statistics.mannWhitney.pValue <= 0.025, true);
  assert.equal(result.lookHistory.at(-1).statistics.lowPercentile.absoluteDelta
    < result.sensitivityMs, true);
});

test("returns max-samples-inconclusive when delta is large but p-value is not significant", async () => {
  const result = await runFixture(
    balancedFixtures([0, 1, 2, 3], [50, 51, 52, 53]),
    { config: { targetPower: 0.5001, bootstrapReplicates: 500 } },
  );

  assert.equal(result.verdict, VERDICT.INCONCLUSIVE);
  assert.equal(result.stopReason, "max-samples-inconclusive");
  assert.equal(result.lookHistory.at(-1).statistics.mannWhitney.pValue > 0.025, true);
  assert.equal(result.lookHistory.at(-1).statistics.lowPercentile.absoluteDelta
    >= result.sensitivityMs, true);
});

test("stops on warmup failure and baseline mismatch", async () => {
  const failed = await runFixture({
    a: [discarded("unexpected-status")],
    b: [accepted(998)],
  });
  assert.equal(failed.stopReason, "warmup-failed");

  const mismatch = await runFixture({
    a: [accepted(999, 200)],
    b: [accepted(998, 201)],
  });
  assert.equal(mismatch.stopReason, "baseline-status-mismatch");
});

test("tracks per-group discard reasons and warns on materially different rates", async () => {
  const result = await runFixture({
    a: [accepted(999), discarded("error"), discarded("error"), accepted(10), accepted(11)],
    b: [accepted(998), accepted(10), accepted(11), accepted(12), accepted(13)],
  }, {
    config: {
      maxDiscardRate: 0.4,
      maxAttempts: 14,
      minAttemptsForDiscardRate: 4,
    },
  });

  assert.equal(result.stopReason, "data-quality-failure");
  assert.equal(result.counts.a.discardReasons.error, 2);
  assert.ok(result.warnings.some(({ code }) => code === "DISCARD_RATE_DIFFERENCE"));
});

test("stops after configurable consecutive transport failures", async () => {
  const result = await runFixture({
    a: [accepted(999), discarded(), discarded()],
    b: [accepted(998), discarded(), discarded()],
  }, {
    config: { maxConsecutiveFailures: 2, maxAttempts: 10 },
  });
  assert.equal(result.stopReason, "fatal-transport-error");
});

test("accepts AbortSignal and stops with aborted while invoking progress", async () => {
  const controller = new AbortController();
  let progressCalls = 0;
  const result = await runFixture(
    balancedFixtures([10, 11, 12, 13], [10.2, 11.1, 12.2, 13.1]),
    {
      onProgress: () => {
        progressCalls += 1;
        controller.abort();
      },
      signal: controller.signal,
    },
  );
  assert.equal(result.stopReason, "aborted");
  assert.ok(progressCalls >= 1);
});

test("configuration-invalid throws before any request", async () => {
  const invalidConfigs = [
    ["seed", { seed: {} }],
    ["warmupPairs", { warmupPairs: 2 }],
    ["quantile", { quantile: 0 }],
    ["alphaTotal", { alphaTotal: 1 }],
    ["targetPower", { targetPower: 0.5 }],
    ["bootstrapReplicates", { bootstrapReplicates: 1 }],
    ["minValidPerGroup", { minValidPerGroup: 0 }],
    ["lookBatchPerGroup", { lookBatchPerGroup: 0 }],
    ["maxValidPerGroup", { maxValidPerGroup: 1 }],
    ["divisibility", { maxValidPerGroup: 3 }],
    ["minAttemptsForDiscardRate", { minAttemptsForDiscardRate: 0 }],
    ["maxAttempts", { maxAttempts: 2 }],
    ["maxDiscardRate", { maxDiscardRate: 2 }],
    ["materialDiscardRateDifference", { materialDiscardRateDifference: -1 }],
    ["maxConsecutiveFailures", { maxConsecutiveFailures: 0 }],
  ];

  for (const [label, change] of invalidConfigs) {
    let calls = 0;
    await assert.rejects(
      runDetector({
        config: { ...TEST_CONFIG, ...change },
        requests: REQUESTS,
        send: async () => {
          calls += 1;
          return accepted(1);
        },
      }),
      (error) => error instanceof DetectorConfigurationError && error.code === "CONFIGURATION_INVALID",
      label,
    );
    assert.equal(calls, 0, label);
  }
});
