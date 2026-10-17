import test from "node:test";
import assert from "node:assert/strict";

import { createMonotonicClock } from "../src/clock.js";

test("converts monotonic nanoseconds to milliseconds", () => {
  const clock = createMonotonicClock({ now: () => 2_500_000n });
  assert.equal(clock.elapsedNanoseconds(1_000_000n, 2_500_000n), 1_500_000n);
  assert.equal(clock.elapsedMilliseconds(1_000_000n, 2_500_000n), 1.5);
});

test("uses an independent fake clock per instance", () => {
  let firstReading = 10_000_000n;
  let secondReading = 20_000_000n;
  const first = createMonotonicClock({ now: () => firstReading });
  const second = createMonotonicClock({ now: () => secondReading });

  assert.equal(first.now(), 10_000_000n);
  assert.equal(second.now(), 20_000_000n);
  firstReading = 11_000_000n;
  secondReading = 23_000_000n;
  assert.equal(first.elapsedMilliseconds(10_000_000n), 1);
  assert.equal(second.elapsedMilliseconds(20_000_000n), 3);
});

test("rejects a clock that moves backwards", () => {
  const clock = createMonotonicClock({ now: () => 1n });
  assert.throws(() => clock.elapsedNanoseconds(2n), RangeError);
});
