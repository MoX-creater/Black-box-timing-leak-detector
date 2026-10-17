const SQRT_TWO = Math.SQRT2;
const ERX = 0.845062911510467529297;
const TWO_OVER_SQRT_PI = 1.12837916709551257390;

// FDLIBM/Cody-style rational approximations for erfc, adapted from Sun's
// freely distributable s_erf.c/t_erf.h coefficients. The direct tail branches
// avoid calculating a normal CDF and subtracting it from one.
const PA = [
  -0.00236211856075265944077,
  0.414856118683748331666,
  -0.372207876035701323847,
  0.318346619901161753674,
  -0.110894694282396677476,
  0.0354783043256182359371,
  -0.00216637559486879084300,
];
const QA = [
  0.106420880400844228286,
  0.540397917702171048937,
  0.0718286544141962662868,
  0.126171219808761642112,
  0.0136370839120290507362,
  0.0119844998467991074170,
];
const RA = [
  -0.00986494403484714822705,
  -0.693858572707181764372,
  -10.5586262253232909814,
  -62.3753324503260060396,
  -162.396669462573470355,
  -184.605092906711035994,
  -81.2874355063065934246,
  -9.81432934416914548592,
];
const SA = [
  19.6512716674392571292,
  137.657754143519042600,
  434.565877475229228821,
  645.387271733267880336,
  429.008140027567833386,
  108.635005541779435134,
  6.57024977031928170135,
  -0.0604244152148580987438,
];
const RB = [
  -0.00986494292470009928597,
  -0.799283237680523006574,
  -17.7579549177547519889,
  -160.636384855821916062,
  -637.566443368389627722,
  -1025.09513161107724954,
  -483.519191608651397019,
];
const SB = [
  30.3380607434824582924,
  325.792512996573918826,
  1536.72958608443695994,
  3199.85821950859553908,
  2553.05040643316442583,
  474.528541206955367215,
  -22.4409524465858183362,
];

function polynomial(coefficients, value) {
  let result = coefficients.at(-1);
  for (let index = coefficients.length - 2; index >= 0; index -= 1) {
    result = result * value + coefficients[index];
  }
  return result;
}

function centralErfcSeries(x) {
  let term = x;
  let sum = term;
  let compensation = 0;
  for (let index = 0; index < 100; index += 1) {
    const next = term * (-x * x) * (2 * index + 1)
      / ((index + 1) * (2 * index + 3));
    const adjusted = next - compensation;
    const candidate = sum + adjusted;
    compensation = (candidate - sum) - adjusted;
    sum = candidate;
    term = next;
    if (Math.abs(term) <= Number.EPSILON * Math.abs(sum)) {
      break;
    }
  }
  return 1 - TWO_OVER_SQRT_PI * sum;
}

function positiveErfc(x) {
  if (x < 0.84375) {
    return centralErfcSeries(x);
  }

  if (x < 1.25) {
    const s = x - 1;
    const ratio = polynomial(PA, s) / polynomial([1, ...QA], s);
    return 1 - ERX - ratio;
  }

  if (x >= 28) {
    return 0;
  }

  const inverseSquare = 1 / (x * x);
  const numerator = x < 2.857142857142857
    ? polynomial(RA, inverseSquare)
    : polynomial(RB, inverseSquare);
  const denominator = x < 2.857142857142857
    ? polynomial([1, ...SA], inverseSquare)
    : polynomial([1, ...SB], inverseSquare);
  const correction = numerator / denominator;
  return Math.exp(-x * x - 0.5625 + correction) / x;
}

/** Return complementary error function using direct Cody-style tail branches. */
export function erfc(value) {
  if (Number.isNaN(value)) {
    return Number.NaN;
  }
  if (value === Infinity) {
    return 0;
  }
  if (value === -Infinity) {
    return 2;
  }
  if (value < 0) {
    return 2 - positiveErfc(-value);
  }
  return positiveErfc(value);
}

function assertProbability(probability) {
  if (!Number.isFinite(probability) || probability < 0 || probability > 1) {
    throw new RangeError("probability must be between 0 and 1");
  }
}

function copyDurations(values, label) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new TypeError(`${label} durations must be a non-empty array`);
  }
  const copy = [...values];
  for (const value of copy) {
    if (!Number.isFinite(value) || value < 0) {
      throw new RangeError(`${label} durations must be finite and non-negative`);
    }
  }
  return copy;
}

/**
 * Compute a Hyndman-Fan Type 7 (linear) sample percentile. At p=0 and p=1
 * this returns the minimum and maximum. p=0.10 with fewer than ~10 samples
 * collapses toward the minimum; minimum sample sizes are enforced in T1.11.
 */
export function percentile(values, probability) {
  assertProbability(probability);
  const sorted = copyDurations(values, "sample").sort((left, right) => left - right);
  if (sorted.length === 1) {
    return sorted[0];
  }
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.min(lower + 1, sorted.length - 1);
  const fraction = position - lower;
  return sorted[lower] + fraction * (sorted[upper] - sorted[lower]);
}

function rankSums(a, b) {
  const combined = [
    ...a.map((value) => ({ group: "a", value })),
    ...b.map((value) => ({ group: "b", value })),
  ].sort((left, right) => left.value - right.value);
  const sums = { a: 0, b: 0 };
  const tieGroups = [];
  let index = 0;
  while (index < combined.length) {
    let end = index + 1;
    while (end < combined.length && combined[end].value === combined[index].value) {
      end += 1;
    }
    const midrank = (index + 1 + end) / 2;
    for (let rankIndex = index; rankIndex < end; rankIndex += 1) {
      sums[combined[rankIndex].group] += midrank;
    }
    if (end - index > 1) {
      tieGroups.push(end - index);
    }
    index = end;
  }
  return { sums, tieGroups };
}

function clampUnit(value) {
  return Math.min(1, Math.max(0, value));
}

/** Compute tie-corrected, continuity-corrected two-sided Mann-Whitney U. */
export function mannWhitneyU(aValues, bValues) {
  const a = copyDurations(aValues, "A");
  const b = copyDurations(bValues, "B");
  const nA = a.length;
  const nB = b.length;
  const n = nA + nB;
  const { sums, tieGroups } = rankSums(a, b);
  const uA = sums.a - (nA * (nA + 1)) / 2;
  const uB = nA * nB - uA;
  const mean = (nA * nB) / 2;
  const tieTerm = tieGroups.reduce((sum, size) => sum + (size ** 3 - size), 0);
  const variance = (nA * nB / 12) * (
    n + 1 - tieTerm / (n * (n - 1))
  );
  if (variance === 0) {
    return {
      degenerate: true,
      pValue: 1,
      tieGroups,
      uA,
      uB,
      variance: 0,
      z: 0,
    };
  }
  const sigma = Math.sqrt(variance);
  const z = Math.max(Math.abs(uA - mean) - 0.5, 0) / sigma;
  const pValue = clampUnit(erfc(z / SQRT_TWO));
  return { degenerate: false, pValue, tieGroups, uA, uB, variance, z };
}

export function analyzeSamples(aValues, bValues, probability = 0.10) {
  const a = copyDurations(aValues, "A");
  const b = copyDurations(bValues, "B");
  const percentileA = percentile(a, probability);
  const percentileB = percentile(b, probability);
  const signedDelta = percentileA - percentileB;
  return {
    lowPercentile: {
      absoluteDelta: Math.abs(signedDelta),
      a: percentileA,
      b: percentileB,
      method: "linear-type-7",
      probability,
      signedDelta,
    },
    mannWhitney: mannWhitneyU(a, b),
  };
}
