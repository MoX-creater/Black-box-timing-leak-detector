import test from "node:test";
import assert from "node:assert/strict";

import { createSeededPrng } from "../src/prng.js";

test("Mulberry32 has stable known values for numeric seed 42", () => {
  const prng = createSeededPrng(42);
  assert.deepEqual(
    Array.from({ length: 5 }, () => prng.nextUint32()),
    [
      770_829_557,
      402_751_009,
      1_145_720_951,
      3_571_107_294,
      4_271_639_225,
    ],
  );
});

test("number and string seeds are accepted and deterministic", () => {
  const numeric = createSeededPrng(42);
  const numericAgain = createSeededPrng(42);
  const stringSeed = createSeededPrng("42");
  const stringAgain = createSeededPrng("42");

  assert.deepEqual(
    Array.from({ length: 5 }, () => numericAgain.nextUint32()),
    Array.from({ length: 5 }, () => numeric.nextUint32()),
  );
  assert.deepEqual(
    Array.from({ length: 5 }, () => stringAgain.nextUint32()),
    Array.from({ length: 5 }, () => stringSeed.nextUint32()),
  );
});

test("nextInt uses inclusive lower and exclusive upper bounds", () => {
  const prng = createSeededPrng("bounds");
  for (let index = 0; index < 10_000; index += 1) {
    const value = prng.nextInt(3, 7);
    assert.ok(value >= 3 && value < 7);
  }
  assert.equal(createSeededPrng(42).nextInt(9, 10), 9);
  assert.throws(() => createSeededPrng(42).nextInt(7, 7), RangeError);
});

test("nextFloat returns values in the half-open unit interval", () => {
  const prng = createSeededPrng("floats");
  for (let index = 0; index < 10_000; index += 1) {
    const value = prng.nextFloat();
    assert.ok(value >= 0 && value < 1);
  }
});
