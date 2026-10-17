import test from "node:test";
import assert from "node:assert/strict";

import {
  minimumDetectableDifference,
  normalQuantile,
} from "../src/inference/bootstrap.js";

const TEST_BOOTSTRAP_OPTIONS = {
  alphaAtLook: 0.025,
  bootstrapReplicates: 100,
  minValidPerGroup: 4,
  probability: 0.1,
  runSeed: "inference-test-seed",
  targetPower: 0.8,
};

test("normalQuantile matches Wichura AS 241 reference values", () => {
  assert.ok(Math.abs(normalQuantile(0.975) - 1.959963984540054) < 1e-15);
  assert.ok(Math.abs(normalQuantile(0.8) - 0.8416212335729143) < 1e-15);
  assert.ok(Math.abs(normalQuantile(0.995) - 2.5758293035489004) < 1e-15);
});

test("bootstrap MDE is deterministic and uses a positive standard error", () => {
  const a = [10, 11, 12, 13, 14, 15];
  const b = [20, 21, 22, 23, 24, 25];
  const first = minimumDetectableDifference(a, b, TEST_BOOTSTRAP_OPTIONS);
  const second = minimumDetectableDifference(a, b, TEST_BOOTSTRAP_OPTIONS);

  assert.deepEqual(first, second);
  assert.equal(first.available, true);
  assert.ok(first.standardError > 0);
  assert.ok(first.sensitivityMs > 0);
  assert.equal(first.bootstrapSeedDomain, "bootstrap");
});

test("bootstrap reports unavailable sensitivity for insufficient or degenerate data", () => {
  assert.deepEqual(
    minimumDetectableDifference([1, 2], [3, 4], TEST_BOOTSTRAP_OPTIONS),
    { available: false, reason: "insufficient-samples" },
  );
  assert.deepEqual(
    minimumDetectableDifference([5, 5, 5, 5], [5, 5, 5, 5], TEST_BOOTSTRAP_OPTIONS),
    { available: false, reason: "degenerate-bootstrap" },
  );
  assert.deepEqual(
    minimumDetectableDifference([1, 2, 3, 4], [5, 6, 7, 8], {
      ...TEST_BOOTSTRAP_OPTIONS,
      bootstrapReplicates: 1,
    }),
    { available: false, reason: "too-few-replicates" },
  );
});
