import { createSeededPrng } from "../prng.js";
import { percentile } from "../stats/index.js";

const BOOTSTRAP_SEED_DOMAIN = "bootstrap";

function polynomial(coefficients, value) {
  let result = coefficients.at(-1);
  for (let index = coefficients.length - 2; index >= 0; index -= 1) {
    result = result * value + coefficients[index];
  }
  return result;
}

/**
 * Wichura's AS 241 normal quantile algorithm. Coefficients are from the
 * published Algorithm AS 241 rational approximations.
 */
export function normalQuantile(probability) {
  if (!Number.isFinite(probability) || probability <= 0 || probability >= 1) {
    throw new RangeError("normal quantile probability must be between 0 and 1");
  }

  const q = probability - 0.5;
  if (Math.abs(q) <= 0.425) {
    const r = 0.180625 - q * q;
    const numerator = polynomial([
      3.387132872796366608,
      133.14166789178437745,
      1971.5909503065514427,
      13731.693765509461125,
      45921.953931549871457,
      67265.770927008700853,
      33430.575583588128105,
      2509.0809287301226727,
    ], r);
    const denominator = polynomial([
      1,
      42.313330701600911252,
      687.1870074920579083,
      5394.1960214247511077,
      21213.794301586595867,
      39307.89580009271061,
      28729.085735721942674,
      5226.495278852854561,
    ], r);
    return q * numerator / denominator;
  }

  let r = Math.sqrt(-Math.log(Math.min(probability, 1 - probability)));
  let value;
  if (r <= 5) {
    r -= 1.6;
    value = polynomial([
      1.42343711074968357734,
      4.63033784615654529590,
      5.76949722146069140550,
      3.64784832476320460504,
      1.27045825245236838258,
      0.241780725177450611770,
      0.0227238449892691845833,
      0.000774545014278341407640,
    ], r) / polynomial([
      1,
      2.05319162663775882187,
      1.67638483018380384940,
      0.689767334985100004550,
      0.148103976427480074590,
      0.0151986665636164571966,
      0.000547593808499534494600,
      0.00000000105075007164441684324,
    ], r);
  } else if (r <= 27) {
    r -= 5;
    value = polynomial([
      6.65790464350110377720,
      5.46378491116411436990,
      1.78482653991729133580,
      0.296560571828504891230,
      0.0265321895265761230930,
      0.00124266094738807843860,
      0.0000271155556874348757815,
      0.000000201033439929228813265,
    ], r) / polynomial([
      1,
      0.599832206555887937690,
      0.136929880922735805310,
      0.0148753612908506148525,
      0.000786869131145613259100,
      0.0000184631831751005468180,
      0.000000142151175831644588870,
      0.00000000000204426310338993978564,
    ], r);
  } else {
    value = r * Math.SQRT2;
  }
  return probability < 0.5 ? -value : value;
}

function deriveBootstrapSeed(runSeed) {
  return JSON.stringify([
    "black-box-timing-leak-detector",
    BOOTSTRAP_SEED_DOMAIN,
    runSeed,
  ]);
}

function sampleWithReplacement(values, prng) {
  return Array.from(
    { length: values.length },
    () => values[prng.nextInt(0, values.length)],
  );
}

function sampleStandardDeviation(values) {
  if (values.length < 2) {
    return Number.NaN;
  }
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const squared = values.reduce((sum, value) => sum + ((value - mean) ** 2), 0);
  return Math.sqrt(squared / (values.length - 1));
}

export function minimumDetectableDifference(aValues, bValues, {
  alphaAtLook,
  bootstrapReplicates,
  minValidPerGroup,
  probability,
  runSeed,
  targetPower,
} = {}) {
  if (aValues.length < minValidPerGroup || bValues.length < minValidPerGroup) {
    return { available: false, reason: "insufficient-samples" };
  }
  if (!Number.isInteger(bootstrapReplicates) || bootstrapReplicates < 2) {
    return { available: false, reason: "too-few-replicates" };
  }

  const prng = createSeededPrng(deriveBootstrapSeed(runSeed));
  const differences = [];
  for (let index = 0; index < bootstrapReplicates; index += 1) {
    const sampleA = sampleWithReplacement(aValues, prng);
    const sampleB = sampleWithReplacement(bValues, prng);
    differences.push(
      percentile(sampleA, probability) - percentile(sampleB, probability),
    );
  }
  const standardError = sampleStandardDeviation(differences);
  if (!Number.isFinite(standardError) || standardError === 0) {
    return { available: false, reason: "degenerate-bootstrap" };
  }

  const alphaQuantile = normalQuantile(1 - alphaAtLook / 2);
  const powerQuantile = normalQuantile(targetPower);
  const sensitivityMs = (alphaQuantile + powerQuantile) * standardError;
  if (!Number.isFinite(sensitivityMs)) {
    return { available: false, reason: "degenerate-bootstrap" };
  }
  return {
    alphaQuantile,
    available: true,
    bootstrapReplicates,
    bootstrapSeedDomain: BOOTSTRAP_SEED_DOMAIN,
    powerQuantile,
    sensitivityMs,
    standardError,
  };
}
