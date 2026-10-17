import { minimumDetectableDifference } from "./bootstrap.js";
import { analyzeSamples } from "../stats/index.js";

export const VERDICT = Object.freeze({
  INCONCLUSIVE: "INCONCLUSIVE",
  LEAK: "LEAK",
  NO_LEAK_DETECTED: "NO_LEAK_DETECTED",
});

export function maxLooks(config) {
  return config.maxValidPerGroup / config.lookBatchPerGroup;
}

export function alphaAtLook(config, lookIndex) {
  return config.alphaTotal / maxLooks(config);
}

function discardRate(count) {
  return count.attempts === 0 ? 0 : count.discarded / count.attempts;
}

export function qualitySnapshot(counts, config) {
  const rates = {
    a: discardRate(counts.a),
    b: discardRate(counts.b),
  };
  const warnings = [];
  if (counts.a.attempts >= config.minAttemptsForDiscardRate
    && counts.b.attempts >= config.minAttemptsForDiscardRate) {
    if (Math.abs(rates.a - rates.b) > config.materialDiscardRateDifference) {
      warnings.push({
        code: "DISCARD_RATE_DIFFERENCE",
        message: "A and B discard rates differ materially",
        rates,
      });
    }
  }
  const gateReady = counts.a.attempts >= config.minAttemptsForDiscardRate
    && counts.b.attempts >= config.minAttemptsForDiscardRate;
  const passes = !gateReady || (
    rates.a <= config.maxDiscardRate && rates.b <= config.maxDiscardRate
  );
  return { discardRates: rates, passes, warnings };
}

export function formatVerdict({ sensitivityMs, verdict }) {
  if (verdict === VERDICT.LEAK) {
    return "LEAK";
  }
  if (verdict === VERDICT.NO_LEAK_DETECTED) {
    return `NO LEAK DETECTED (sensitivity >= ${sensitivityMs} ms)`;
  }
  return "INCONCLUSIVE";
}

export function inferLook({
  aSamples,
  bSamples,
  config,
  counts,
  lookIndex,
  runSeed,
  forceSensitivity = false,
}) {
  const quality = qualitySnapshot(counts, config);
  const maxLook = maxLooks(config);
  const alpha = alphaAtLook(config, lookIndex);
  const statistics = analyzeSamples(aSamples, bSamples, config.quantile);
  const shouldComputeSensitivity = forceSensitivity
    || statistics.mannWhitney.pValue <= alpha;
  const sensitivity = shouldComputeSensitivity
    ? minimumDetectableDifference(aSamples, bSamples, {
      alphaAtLook: alpha,
      bootstrapReplicates: config.bootstrapReplicates,
      minValidPerGroup: config.minValidPerGroup,
      probability: config.quantile,
      runSeed,
      targetPower: config.targetPower,
    })
    : null;
  const availableSensitivity = sensitivity?.available === true;
  let verdict = null;
  if (quality.passes && availableSensitivity) {
    const significant = statistics.mannWhitney.pValue <= alpha;
    const practicallyLarge = statistics.lowPercentile.absoluteDelta >= sensitivity.sensitivityMs;
    if (significant && practicallyLarge) {
      verdict = VERDICT.LEAK;
    } else if (lookIndex === maxLook
      && !significant
      && statistics.lowPercentile.absoluteDelta < sensitivity.sensitivityMs) {
      verdict = VERDICT.NO_LEAK_DETECTED;
    }
  }
  return {
    alphaAtLook: alpha,
    lookIndex,
    maxLooks: maxLook,
    quality,
    sensitivity,
    sensitivityMs: availableSensitivity ? sensitivity.sensitivityMs : null,
    statistics,
    verdict,
  };
}
