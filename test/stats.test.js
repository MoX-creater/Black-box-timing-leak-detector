import test from "node:test";
import assert from "node:assert/strict";

import {
  analyzeSamples,
  erfc,
  mannWhitneyU,
  percentile,
} from "../src/stats/index.js";

/*
 * Independent reference calculation run in Colab with scipy==1.16.3 and
 * numpy==2.1.3. Expected values below were pasted from this script's output;
 * the implementation under test did not generate them.
 *
 * from scipy.stats import mannwhitneyu
 * import json
 * import numpy
 * import scipy
 * print(f"scipy={scipy.__version__}")
 * print(f"numpy={numpy.__version__}")
 * def type7(values, probability):
 *     values = sorted(values)
 *     h = (len(values) - 1) * probability
 *     lower = int(h)
 *     upper = min(lower + 1, len(values) - 1)
 *     fraction = h - lower
 *     return (1 - fraction) * values[lower] + fraction * values[upper]
 * cases = {
 *     "ties_and_type7": {
 *         "a": [10.0, 20.0, 20.0, 40.0],
 *         "b": [15.0, 20.0, 35.0, 50.0],
 *     },
 *     "hand_checkable": {"a": [1.0, 2.0], "b": [3.0, 4.0]},
 *     "tail_all_separated_20v20": {
 *         "a": [0.0] * 20, "b": [1.0] * 20,
 *     },
 *     "larger_with_ties": {
 *         "a": [10.0, 12.0, 12.0, 14.0, 15.0, 17.0, 18.0, 20.0, 21.0, 22.0, 24.0, 25.0],
 *         "b": [11.0, 13.0, 13.0, 15.0, 16.0, 18.0, 19.0, 21.0, 22.0, 23.0, 25.0, 26.0, 27.0, 28.0, 30.0],
 *     },
 * }
 * for name, case in cases.items():
 *     a, b = case["a"], case["b"]
 *     pa, pb = type7(a, 0.10), type7(b, 0.10)
 *     result = mannwhitneyu(a, b, alternative="two-sided", method="asymptotic", use_continuity=True)
 *     print(json.dumps({"name": name, "uA": float(result.statistic), "pValue": float(result.pvalue), "percentileA": pa, "percentileB": pb, "signedDelta": pa - pb, "absoluteDelta": abs(pa - pb)}, sort_keys=True))
 *
 * scipy=1.16.3
 * numpy=2.1.3
 * {"absoluteDelta": 3.5, "name": "ties_and_type7", "pValue": 0.65725516871927, "percentileA": 13.0, "percentileB": 16.5, "signedDelta": -3.5, "uA": 6.0}
 * {"absoluteDelta": 2.0, "name": "hand_checkable", "pValue": 0.2452781168067728, "percentileA": 1.1, "percentileB": 3.1, "signedDelta": -2.0, "uA": 0.0}
 * {"absoluteDelta": 1.0, "name": "tail_all_separated_20v20", "pValue": 4.682682358742056e-10, "percentileA": 0.0, "percentileB": 1.0, "signedDelta": -1.0, "uA": 0.0}
 * {"absoluteDelta": 1.0, "name": "larger_with_ties", "pValue": 0.1872109365849386, "percentileA": 12.0, "percentileB": 13.0, "signedDelta": -1.0, "uA": 62.5}
 */

function assertRelative(actual, expected, relativeTolerance = 1e-12) {
  const scale = Math.max(Math.abs(actual), Math.abs(expected));
  assert.ok(
    Math.abs(actual - expected) <= scale * relativeTolerance,
    `expected ${actual} to be within ${relativeTolerance} relative of ${expected}`,
  );
}

test("uses Type 7 percentile edges and does not mutate input", () => {
  const values = [4, 1, 3, 2];
  assert.equal(percentile([9], 0), 9);
  assert.equal(percentile([9], 1), 9);
  assert.equal(percentile(values, 0), 1);
  assert.equal(percentile(values, 1), 4);
  assert.equal(percentile(values, 0.5), 2.5);
  assert.deepEqual(values, [4, 1, 3, 2]);
});

test("erfc has accurate central and tail values", () => {
  assert.equal(erfc(0), 1);
  assertRelative(erfc(1), 0.1572992070502851, 1e-15);
  assertRelative(erfc(5.0), 1.5374597944280351e-12, 1e-12);
});

test("matches independent SciPy reference values for ties and effect", () => {
  const result = analyzeSamples(
    [10, 20, 20, 40],
    [15, 20, 35, 50],
  );
  assert.equal(result.lowPercentile.method, "linear-type-7");
  assert.equal(result.lowPercentile.a, 13);
  assert.equal(result.lowPercentile.b, 16.5);
  assert.equal(result.lowPercentile.signedDelta, -3.5);
  assert.equal(result.lowPercentile.absoluteDelta, 3.5);
  assert.equal(result.mannWhitney.uA, 6);
  assert.equal(result.mannWhitney.uB, 10);
  assertRelative(result.mannWhitney.pValue, 0.65725516871927);
  assert.deepEqual(result.mannWhitney.tieGroups, [3]);
});

test("matches hand-checkable U and Type 7 case", () => {
  // A ranks 1,2 and B ranks 3,4: U_A=0, mu=2, sigma=sqrt(5/3),
  // continuity-corrected z=(|0-2|-0.5)/sqrt(5/3)=1.161895003862225.
  const result = analyzeSamples([1, 2], [3, 4]);
  assert.equal(result.lowPercentile.a, 1.1);
  assert.equal(result.lowPercentile.b, 3.1);
  assert.equal(result.mannWhitney.uA, 0);
  assert.equal(result.mannWhitney.uB, 4);
  assertRelative(result.mannWhitney.z, 1.161895003862225);
  assertRelative(result.mannWhitney.pValue, 0.2452781168067728);
});

test("matches larger tied reference and tail p-value", () => {
  const result = analyzeSamples(
    [10, 12, 12, 14, 15, 17, 18, 20, 21, 22, 24, 25],
    [11, 13, 13, 15, 16, 18, 19, 21, 22, 23, 25, 26, 27, 28, 30],
  );
  assert.equal(result.mannWhitney.uA, 62.5);
  assert.equal(result.mannWhitney.uB, 117.5);
  assert.equal(result.lowPercentile.signedDelta, -1);
  assertRelative(result.mannWhitney.pValue, 0.1872109365849386);

  const tail = mannWhitneyU([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]);
  assertRelative(tail.pValue, 4.682682358742056e-10);
});

test("returns symmetric U and effect results when A and B are swapped", () => {
  const a = [10, 20, 20, 40];
  const b = [15, 20, 35, 50];
  const originalA = [...a];
  const originalB = [...b];
  const original = analyzeSamples(a, b);
  const swapped = analyzeSamples(b, a);

  assert.equal(swapped.mannWhitney.uA, original.mannWhitney.uB);
  assert.equal(swapped.mannWhitney.uB, original.mannWhitney.uA);
  assert.equal(swapped.lowPercentile.signedDelta, -original.lowPercentile.signedDelta);
  assert.equal(swapped.lowPercentile.absoluteDelta, original.lowPercentile.absoluteDelta);
  assert.equal(swapped.mannWhitney.pValue, original.mannWhitney.pValue);
  assert.deepEqual(a, originalA);
  assert.deepEqual(b, originalB);
});

test("marks all-tied samples as degenerate with p-value one", () => {
  const result = mannWhitneyU([5, 5, 5], [5, 5]);
  assert.equal(result.degenerate, true);
  assert.equal(result.pValue, 1);
  assert.equal(result.z, 0);
  assert.equal(result.variance, 0);
});

test("rejects negative and invalid durations", () => {
  assert.throws(() => percentile([-1, 2], 0.5), /non-negative/);
  assert.throws(() => mannWhitneyU([1, Number.NaN], [2]), /finite/);
  assert.throws(() => percentile([1, 2], 1.1), /between 0 and 1/);
});
