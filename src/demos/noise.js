import { createHash } from "node:crypto";

import { createSeededPrng } from "../prng.js";

export const NOISE_SEED_DOMAIN = "demo-noise";
export const DEFAULT_NOISE_SEED = "demo-noise-seed";
export const NOISE_BENCHMARK_STATUS = "TBD";

// These are hard safety bounds, not performance claims. Preset tuning remains TBD until benchmarked.
export const MAX_NOISE_JITTER = 50_000;
export const MAX_NOISE_ROUNDS = 200_000;
export const MAX_NOISE_SPIKE_MULTIPLIER = 8;

// `jitter` is the maximum base SHA-256 round count for a preset.
export const NOISE_PRESETS = Object.freeze({
  none: Object.freeze({
    benchmarkStatus: NOISE_BENCHMARK_STATUS,
    jitter: 0,
    presetId: "none",
    spikeMultiplier: 0,
    spikeProbability: 0,
  }),
  low: Object.freeze({
    benchmarkStatus: NOISE_BENCHMARK_STATUS,
    jitter: 2_000,
    presetId: "low",
    spikeMultiplier: 4,
    spikeProbability: 0.02,
  }),
  high: Object.freeze({
    benchmarkStatus: NOISE_BENCHMARK_STATUS,
    jitter: 8_000,
    presetId: "high",
    spikeMultiplier: 8,
    spikeProbability: 0.05,
  }),
});

function invalid(message) {
  throw new TypeError(`noise configuration ${message}`);
}

function isSeed(value) {
  return typeof value === "string" || Number.isSafeInteger(value);
}

function validateProbability(value) {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    invalid("spikeProbability must be between 0 and 1");
  }
}

function validateJitter(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_NOISE_JITTER) {
    invalid(`jitter must be an integer between 0 and ${MAX_NOISE_JITTER}`);
  }
}

function validateMultiplier(value) {
  if (!Number.isSafeInteger(value)
    || value < 0
    || value > MAX_NOISE_SPIKE_MULTIPLIER) {
    invalid(`spikeMultiplier must be an integer between 0 and ${MAX_NOISE_SPIKE_MULTIPLIER}`);
  }
}

export function deriveNoiseSeed(seed) {
  if (!isSeed(seed)) {
    invalid("seed must be a string or safe integer");
  }
  return JSON.stringify([
    "black-box-timing-leak-detector",
    NOISE_SEED_DOMAIN,
    seed,
  ]);
}

export function validateNoiseConfig(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    invalid("must be an object");
  }
  const preset = NOISE_PRESETS[config.presetId];
  if (!preset) {
    invalid("presetId must name a built-in preset");
  }
  if (config.benchmarkStatus !== NOISE_BENCHMARK_STATUS) {
    invalid(`benchmarkStatus must be ${NOISE_BENCHMARK_STATUS}`);
  }
  if (!isSeed(config.seed)) {
    invalid("seed must be a string or safe integer");
  }
  validateJitter(config.jitter);
  validateProbability(config.spikeProbability);
  validateMultiplier(config.spikeMultiplier);
  if (config.presetId === "none"
    && (config.spikeProbability !== 0 || config.spikeMultiplier !== 0)) {
    invalid("none must have zero spikeProbability and spikeMultiplier");
  }
  if (config.jitter * config.spikeMultiplier > MAX_NOISE_ROUNDS) {
    invalid(`maximum rounds after spikeMultiplier must be <= ${MAX_NOISE_ROUNDS}`);
  }
  return config;
}

export function createNoiseConfig({
  jitter,
  presetId = "none",
  seed = DEFAULT_NOISE_SEED,
  spikeMultiplier,
  spikeProbability,
} = {}) {
  const preset = NOISE_PRESETS[presetId];
  if (!preset) {
    invalid("presetId must name a built-in preset");
  }
  const config = {
    benchmarkStatus: NOISE_BENCHMARK_STATUS,
    jitter: jitter ?? preset.jitter,
    presetId,
    seed,
    spikeMultiplier: spikeMultiplier ?? preset.spikeMultiplier,
    spikeProbability: spikeProbability ?? preset.spikeProbability,
  };
  return validateNoiseConfig(config);
}

function parseEnvironmentInteger(value, name) {
  if (!/^[0-9]+$/.test(value)) {
    invalid(`${name} must be a non-negative integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    invalid(`${name} must be a safe integer`);
  }
  return parsed;
}

export function resolveNoiseConfigFromEnvironment(environment = process.env) {
  const jitter = environment.DEMO_NOISE_JITTER === undefined
    ? undefined
    : parseEnvironmentInteger(environment.DEMO_NOISE_JITTER, "DEMO_NOISE_JITTER");
  return createNoiseConfig({
    jitter,
    presetId: environment.DEMO_NOISE_PRESET ?? "none",
    seed: environment.DEMO_NOISE_SEED ?? DEFAULT_NOISE_SEED,
  });
}

export function drawNoise(prng, config, requestNumber) {
  validateNoiseConfig(config);
  if (!prng || typeof prng.nextInt !== "function" || typeof prng.nextFloat !== "function") {
    invalid("prng must provide nextInt and nextFloat");
  }
  if (!Number.isSafeInteger(requestNumber) || requestNumber < 1) {
    invalid("requestNumber must be a positive safe integer");
  }
  const baseRounds = prng.nextInt(0, config.jitter + 1);
  const spikeRoll = prng.nextFloat();
  const spiked = spikeRoll < config.spikeProbability;
  const rounds = spiked ? baseRounds * config.spikeMultiplier : baseRounds;
  return {
    baseRounds,
    requestNumber,
    rounds,
    spikeRoll,
    spiked,
  };
}

export function performNoiseWork(rounds, { requestNumber, seed } = {}) {
  if (!Number.isSafeInteger(rounds) || rounds < 0 || rounds > MAX_NOISE_ROUNDS) {
    invalid(`rounds must be an integer between 0 and ${MAX_NOISE_ROUNDS}`);
  }
  let digest = Buffer.from(`${NOISE_SEED_DOMAIN}:${seed}:${requestNumber}`, "utf8");
  for (let index = 0; index < rounds; index += 1) {
    digest = createHash("sha256").update(digest).digest();
  }
  return digest;
}

export function createNoiseMiddleware(noiseConfig, { work = performNoiseWork } = {}) {
  const config = validateNoiseConfig(noiseConfig);
  if (typeof work !== "function") {
    invalid("work must be a function");
  }
  const prng = createSeededPrng(deriveNoiseSeed(config.seed));
  let drawCount = 0;

  // Same seed gives vulnerable and fixed processes the same noise sequence;
  // the sequence restarts at request 1 every time a process starts.
  const middleware = (_request, response, next) => {
    drawCount += 1;
    const requestNumber = drawCount;
    const draw = drawNoise(prng, config, requestNumber);
    try {
      work(draw.rounds, {
        ...draw,
        seed: config.seed,
      });
      if (response.locals) {
        response.locals.noiseDraw = draw;
      }
      next();
    } catch (error) {
      next(error);
    }
  };

  middleware.getDrawCount = () => drawCount;
  middleware.noiseConfig = config;
  return middleware;
}
