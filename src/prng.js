const UINT32_RANGE = 0x1_0000_0000;
const UINT32_MASK = 0xffff_ffff;
const SPLITMIX_INCREMENT = 0x9e37_79b9;

function splitmix32(value) {
  let mixed = (value + SPLITMIX_INCREMENT) >>> 0;
  mixed = Math.imul(mixed ^ (mixed >>> 16), 0x21f0_aad);
  mixed = Math.imul(mixed ^ (mixed >>> 15), 0x735a_2d97);
  return (mixed ^ (mixed >>> 15)) >>> 0;
}

function hashString(value) {
  let hash = 0x811c_9dc5;
  for (const character of value) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 0x0100_0193);
  }
  return hash >>> 0;
}

function expandSeed(seed) {
  if (typeof seed === "number") {
    if (!Number.isSafeInteger(seed)) {
      throw new TypeError("numeric seeds must be safe integers");
    }
    return splitmix32(seed >>> 0);
  }

  if (typeof seed === "string") {
    return splitmix32(hashString(seed));
  }

  throw new TypeError("seed must be a number or string");
}

function assertIntegerBounds(minInclusive, maxExclusive) {
  if (!Number.isSafeInteger(minInclusive) || !Number.isSafeInteger(maxExclusive)) {
    throw new TypeError("integer bounds must be safe integers");
  }
  if (minInclusive >= maxExclusive) {
    throw new RangeError("minInclusive must be less than maxExclusive");
  }
  if (maxExclusive - minInclusive > UINT32_RANGE) {
    throw new RangeError("integer range must not exceed 2^32 values");
  }
}

/**
 * Create a deterministic PRNG using Mulberry32 with splitmix-style seed
 * expansion. `nextInt(minInclusive, maxExclusive)` uses an inclusive lower
 * bound and exclusive upper bound.
 */
export function createSeededPrng(seed) {
  let state = expandSeed(seed);

  function nextUint32() {
    state = (state + 0x6d2b_79f5) & UINT32_MASK;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return (value ^ (value >>> 14)) >>> 0;
  }

  function nextFloat() {
    return nextUint32() / UINT32_RANGE;
  }

  function nextInt(minInclusive, maxExclusive) {
    assertIntegerBounds(minInclusive, maxExclusive);
    const range = maxExclusive - minInclusive;
    const acceptedLimit = UINT32_RANGE - (UINT32_RANGE % range);
    let value;
    do {
      value = nextUint32();
    } while (value >= acceptedLimit);
    return minInclusive + (value % range);
  }

  return { nextFloat, nextInt, nextUint32 };
}
