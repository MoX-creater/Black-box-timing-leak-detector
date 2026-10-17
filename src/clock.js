function assertNanoseconds(value, name) {
  if (typeof value !== "bigint") {
    throw new TypeError(`${name} must be a bigint`);
  }
}

/** Create an independent monotonic clock backed by process.hrtime.bigint(). */
export function createMonotonicClock({ now = () => process.hrtime.bigint() } = {}) {
  if (typeof now !== "function") {
    throw new TypeError("now must be a function");
  }

  const read = () => {
    const value = now();
    assertNanoseconds(value, "clock reading");
    return value;
  };

  function elapsedNanoseconds(start, end = read()) {
    assertNanoseconds(start, "start");
    assertNanoseconds(end, "end");
    if (end < start) {
      throw new RangeError("end must not precede start");
    }
    return end - start;
  }

  function elapsedMilliseconds(start, end = read()) {
    return Number(elapsedNanoseconds(start, end)) / 1_000_000;
  }

  return { elapsedMilliseconds, elapsedNanoseconds, now: read };
}
