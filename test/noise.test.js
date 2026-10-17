import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  createNoiseConfig,
  createNoiseMiddleware,
  deriveNoiseSeed,
  drawNoise,
  MAX_NOISE_JITTER,
  MAX_NOISE_ROUNDS,
  NOISE_BENCHMARK_STATUS,
  NOISE_PRESETS,
  performNoiseWork,
  resolveNoiseConfigFromEnvironment,
} from "../src/demos/noise.js";
import { createSeededPrng } from "../src/prng.js";

function collectDraws(config, count = 20) {
  const draws = [];
  const middleware = createNoiseMiddleware(config, {
    work: (rounds, draw) => draws.push({ ...draw, rounds }),
  });
  for (let index = 0; index < count; index += 1) {
    middleware({}, { locals: {} }, () => {});
  }
  return draws;
}

test("preset definitions are serializable and remain marked TBD", () => {
  const roundTrip = JSON.parse(JSON.stringify(NOISE_PRESETS));

  assert.deepEqual(roundTrip, NOISE_PRESETS);
  for (const preset of Object.values(NOISE_PRESETS)) {
    assert.equal(preset.benchmarkStatus, NOISE_BENCHMARK_STATUS);
  }
  assert.equal(NOISE_PRESETS.none.jitter, 0);
  assert.equal(NOISE_PRESETS.none.spikeProbability, 0);
  assert.equal(NOISE_PRESETS.none.spikeMultiplier, 0);
});

test("same seed and config produce the same heavy-tail noise sequence", () => {
  const config = createNoiseConfig({
    presetId: "high",
    seed: "same-seed",
    spikeProbability: 1,
  });
  const first = collectDraws(config, 100);
  const second = collectDraws(config, 100);

  assert.deepEqual(first, second);
  assert.ok(first.some(({ spiked }) => spiked));
  assert.ok(first.some(({ rounds }) => rounds > 8_000));
  assert.notEqual(deriveNoiseSeed("same-seed"), deriveNoiseSeed("other-seed"));
});

test("noise draws stay within base and post-spike bounds", () => {
  for (const preset of Object.values(NOISE_PRESETS)) {
    const config = createNoiseConfig({ presetId: preset.presetId, seed: "bounds-seed" });
    const draws = collectDraws(config, 100);
    for (const draw of draws) {
      assert.ok(draw.baseRounds >= 0 && draw.baseRounds <= config.jitter);
      assert.ok(draw.rounds >= 0);
      assert.ok(draw.rounds <= config.jitter * config.spikeMultiplier || draw.rounds <= config.jitter);
      assert.ok(draw.rounds <= MAX_NOISE_ROUNDS);
    }
  }

  const forcedSpike = createNoiseConfig({
    jitter: 100,
    presetId: "low",
    seed: "forced-spike",
    spikeMultiplier: 4,
    spikeProbability: 1,
  });
  const prng = createSeededPrng(deriveNoiseSeed(forcedSpike.seed));
  const draw = drawNoise(prng, forcedSpike, 1);
  assert.equal(draw.spiked, true);
  assert.ok(draw.rounds <= 400);
});

test("none performs no real hash rounds", () => {
  let calls = 0;
  const middleware = createNoiseMiddleware(createNoiseConfig({ presetId: "none" }), {
    work: (rounds) => {
      calls += rounds;
    },
  });
  middleware({}, { locals: {} }, () => {});
  middleware({}, { locals: {} }, () => {});

  assert.equal(calls, 0);
});

test("draw counter increments synchronously before work and restarts at one", () => {
  let middleware;
  const observedCounts = [];
  middleware = createNoiseMiddleware(createNoiseConfig({ seed: "counter-seed" }), {
    work: () => observedCounts.push(middleware.getDrawCount()),
  });

  middleware({}, { locals: {} }, () => {});
  middleware({}, { locals: {} }, () => {});

  assert.deepEqual(observedCounts, [1, 2]);
  const restarted = createNoiseMiddleware(createNoiseConfig({ seed: "counter-seed" }), {
    work: () => observedCounts.push(restarted.getDrawCount()),
  });
  restarted({}, { locals: {} }, () => {});
  assert.equal(observedCounts.at(-1), 1);
});

test("same noise stream is independent of user identity and auth policy", () => {
  const config = createNoiseConfig({ presetId: "high", seed: "policy-independent" });
  const first = [];
  const second = [];
  const firstMiddleware = createNoiseMiddleware(config, {
    work: (_rounds, draw) => first.push(draw),
  });
  const secondMiddleware = createNoiseMiddleware(config, {
    work: (_rounds, draw) => second.push(draw),
  });

  firstMiddleware({ body: { username: "known-user" }, mode: "vulnerable" }, { locals: {} }, () => {});
  firstMiddleware({ body: { username: "missing-user" }, mode: "vulnerable" }, { locals: {} }, () => {});
  secondMiddleware({ body: { username: "known-user" }, mode: "fixed" }, { locals: {} }, () => {});
  secondMiddleware({ body: { username: "missing-user" }, mode: "fixed" }, { locals: {} }, () => {});

  assert.deepEqual(first, second);
});

test("environment selects presets and never accepts an unbounded jitter", () => {
  const config = resolveNoiseConfigFromEnvironment({
    DEMO_NOISE_JITTER: "1234",
    DEMO_NOISE_PRESET: "low",
    DEMO_NOISE_SEED: "environment-seed",
  });
  assert.equal(config.presetId, "low");
  assert.equal(config.jitter, 1234);
  assert.equal(config.seed, "environment-seed");

  assert.throws(
    () => resolveNoiseConfigFromEnvironment({ DEMO_NOISE_JITTER: String(MAX_NOISE_JITTER + 1) }),
    /jitter must be an integer/,
  );
  assert.throws(
    () => createNoiseConfig({
      jitter: MAX_NOISE_JITTER,
      presetId: "high",
      spikeMultiplier: 8,
    }),
    /maximum rounds after spikeMultiplier/,
  );
});

test("real noise work uses bounded SHA-256 and no artificial delay or randomness", async () => {
  const source = await readFile(new URL("../src/demos/noise.js", import.meta.url), "utf8");
  const digest = performNoiseWork(2, { requestNumber: 1, seed: "source-test" });

  assert.equal(digest.length, 32);
  assert.match(source, /createHash\("sha256"\)/);
  assert.doesNotMatch(source, /sleep\(|Math\.random/);
});
