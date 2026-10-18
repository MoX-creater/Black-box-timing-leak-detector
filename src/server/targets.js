const DEFAULT_TARGET_VALUES = Object.freeze({
  fixedHost: "fixed",
  fixedPort: 3002,
  vulnerableHost: "vulnerable",
  vulnerablePort: 3001,
});

const TARGET_ENVIRONMENT_FIELDS = Object.freeze({
  fixedHost: "DEMO_FIXED_HOST",
  fixedPort: "DEMO_FIXED_PORT",
  vulnerableHost: "DEMO_VULNERABLE_HOST",
  vulnerablePort: "DEMO_VULNERABLE_PORT",
});

const TARGET_IDS = Object.freeze(["fixed", "vulnerable"]);
const PUBLIC_TARGET_LABELS = Object.freeze({
  fixed: "Fixed demo",
  vulnerable: "Vulnerable demo",
});
const HOST_PATTERN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/i;

function invalid(message) {
  throw new TypeError(`demo target configuration ${message}`);
}

function validateHost(host, field) {
  if (typeof host !== "string" || !HOST_PATTERN.test(host)) {
    invalid(`${field} must be a hostname without a scheme, path, or port`);
  }
  const labels = host.split(".");
  if (labels.length === 4 && labels.every((label) => /^\d+$/.test(label))) {
    if (labels.some((label) => Number(label) > 255)) {
      invalid(`${field} must contain valid IPv4 octets`);
    }
  }
  return host;
}

function validatePort(port, field) {
  const value = typeof port === "number" ? String(port) : port;
  if (typeof value !== "string" || !/^[0-9]+$/.test(value)) {
    invalid(`${field} must be an integer between 1 and 65535`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65535) {
    invalid(`${field} must be an integer between 1 and 65535`);
  }
  return parsed;
}

function validateTargetEntry(entry, id) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    invalid(`${id} must be an object`);
  }
  const keys = Object.keys(entry).sort();
  if (keys.length !== 2 || keys[0] !== "host" || keys[1] !== "port") {
    invalid(`${id} must contain exactly host and port`);
  }
  return Object.freeze({
    host: validateHost(entry.host, `${id}.host`),
    port: validatePort(entry.port, `${id}.port`),
  });
}

export function validateTargetMap(targets) {
  if (!targets || typeof targets !== "object" || Array.isArray(targets)) {
    invalid("must be an object");
  }
  const ids = Object.keys(targets).sort();
  if (ids.length !== TARGET_IDS.length || !ids.every((id, index) => id === TARGET_IDS[index])) {
    invalid("must contain exactly fixed and vulnerable target IDs");
  }
  return Object.freeze({
    fixed: validateTargetEntry(targets.fixed, "fixed"),
    vulnerable: validateTargetEntry(targets.vulnerable, "vulnerable"),
  });
}

export function createTargetMap({
  fixedHost = DEFAULT_TARGET_VALUES.fixedHost,
  fixedPort = DEFAULT_TARGET_VALUES.fixedPort,
  vulnerableHost = DEFAULT_TARGET_VALUES.vulnerableHost,
  vulnerablePort = DEFAULT_TARGET_VALUES.vulnerablePort,
} = {}) {
  return validateTargetMap({
    fixed: { host: fixedHost, port: fixedPort },
    vulnerable: { host: vulnerableHost, port: vulnerablePort },
  });
}

export function createTargetMapFromEnvironment(environment = process.env) {
  return createTargetMap({
    fixedHost: environment[TARGET_ENVIRONMENT_FIELDS.fixedHost] ?? DEFAULT_TARGET_VALUES.fixedHost,
    fixedPort: environment[TARGET_ENVIRONMENT_FIELDS.fixedPort] ?? DEFAULT_TARGET_VALUES.fixedPort,
    vulnerableHost: environment[TARGET_ENVIRONMENT_FIELDS.vulnerableHost]
      ?? DEFAULT_TARGET_VALUES.vulnerableHost,
    vulnerablePort: environment[TARGET_ENVIRONMENT_FIELDS.vulnerablePort]
      ?? DEFAULT_TARGET_VALUES.vulnerablePort,
  });
}

export {
  DEFAULT_TARGET_VALUES,
  PUBLIC_TARGET_LABELS,
  TARGET_ENVIRONMENT_FIELDS,
  TARGET_IDS,
};
