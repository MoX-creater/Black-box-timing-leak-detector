import { access, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { Agent } from "undici";

import { authorizeRequestPair, AuthorizationError } from "./authorization.js";
import { createNoiseConfig, validateNoiseConfig } from "../demos/noise.js";
import { buildRequests } from "../http/request.js";
import { createHttpTransport } from "../http/transport.js";
import { runDetector, validateDetectorConfig } from "../detector/index.js";
import { createRunReport, validateRunReport } from "../report/index.js";

const DETECTOR_FIELDS = [
  "alphaTotal",
  "bootstrapReplicates",
  "lookBatchPerGroup",
  "materialDiscardRateDifference",
  "maxAttempts",
  "maxConsecutiveFailures",
  "maxDiscardRate",
  "maxValidPerGroup",
  "minAttemptsForDiscardRate",
  "minValidPerGroup",
  "quantile",
  "targetPower",
];

const CONFIG_FIELDS = [
  "a",
  "b",
  "cookies",
  "defaultsStatus",
  "detector",
  "headers",
  "method",
  "noise",
  "requestTemplateIds",
  "seed",
  "target",
];

const HELP_TEXT = `Usage: npm run detect -- --config <file> [options]

Options:
  --config <file>          JSON config containing request templates A and B (required)
  --method <METHOD>        Override the common request method
  --header <name: value>   Repeatable common header override
  --cookie <name=value>    Repeatable common cookie override
  --cookie-file <file>     Read common cookie entries from a file
  --seed <seed>            Override the required detector seed
  --i-am-authorized        Confirm authorization for non-localhost targets
  --out <file>             Write the report instead of stdout
  --force                  Allow replacing an existing --out file
  --help                   Show this help

Bodies come only from the A/B templates in --config; --body is not supported.
Values supplied on the command line can end up in shell history. Prefer config
references such as $ENV_NAME for header/cookie values or --cookie-file.

Detector constants must be supplied explicitly in the config. Use
defaultsStatus: "TBD" to mark unbenchmarked rule values.
`;

class CliInputError extends Error {
  constructor() {
    super("input error");
    this.name = "CliInputError";
  }
}

function inputError() {
  throw new CliInputError();
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function write(stream, text) {
  stream.write(text);
}

function parseArguments(argv) {
  try {
    return parseArgs({
      args: argv,
      allowPositionals: false,
      options: {
        config: { type: "string" },
        cookie: { type: "string", multiple: true },
        "cookie-file": { type: "string", multiple: true },
        force: { type: "boolean" },
        header: { type: "string", multiple: true },
        help: { type: "boolean", short: "h" },
        "i-am-authorized": { type: "boolean" },
        method: { type: "string" },
        out: { type: "string" },
        seed: { type: "string" },
      },
      strict: true,
    }).values;
  } catch {
    inputError();
  }
}

async function loadJsonConfig(filePath) {
  let text;
  try {
    text = await readFile(filePath, "utf8");
  } catch {
    inputError();
  }
  try {
    return JSON.parse(text);
  } catch {
    inputError();
  }
}

function requireExactKeys(value, allowed) {
  if (!isPlainObject(value)) {
    inputError();
  }
  const allowedKeys = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    inputError();
  }
}

function resolveEnvironmentReference(value, environment) {
  if (typeof value !== "string" || !/^\$[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    return value;
  }
  const name = value.slice(1);
  if (typeof environment[name] !== "string") {
    inputError();
  }
  return environment[name];
}

function resolveHeaderCollection(value, environment) {
  if (value === undefined || value === null) {
    return value;
  }
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([name, headerValue]) => [
      name,
      resolveEnvironmentReference(headerValue, environment),
    ]));
  }
  if (!Array.isArray(value)) {
    return value;
  }
  return value.map((entry) => {
    if (typeof entry === "string") {
      const separator = entry.indexOf(":");
      if (separator > 0) {
        return `${entry.slice(0, separator)}: ${resolveEnvironmentReference(
          entry.slice(separator + 1).trim(),
          environment,
        )}`;
      }
      return entry;
    }
    if (Array.isArray(entry) && entry.length === 2) {
      return [entry[0], resolveEnvironmentReference(entry[1], environment)];
    }
    if (isPlainObject(entry) && "value" in entry) {
      return { ...entry, value: resolveEnvironmentReference(entry.value, environment) };
    }
    return entry;
  });
}

function resolveCookieCollection(value, environment) {
  if (value === undefined || value === null) {
    return value;
  }
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([name, cookieValue]) => [
      name,
      resolveEnvironmentReference(cookieValue, environment),
    ]));
  }
  if (!Array.isArray(value)) {
    return value;
  }
  return value.map((entry) => {
    if (typeof entry !== "string") {
      return entry;
    }
    const separator = entry.indexOf("=");
    if (separator > 0) {
      return `${entry.slice(0, separator)}=${resolveEnvironmentReference(
        entry.slice(separator + 1),
        environment,
      )}`;
    }
    return entry;
  });
}

function resolveConfigSecrets(config, environment) {
  const resolved = {
    ...config,
    a: { ...config.a },
    b: { ...config.b },
    cookies: resolveCookieCollection(config.cookies, environment),
    headers: resolveHeaderCollection(config.headers, environment),
  };
  resolved.a.headers = resolveHeaderCollection(config.a?.headers, environment);
  resolved.b.headers = resolveHeaderCollection(config.b?.headers, environment);
  return resolved;
}

async function readCookieFiles(paths, environment) {
  const entries = [];
  for (const filePath of paths) {
    let contents;
    try {
      contents = await readFile(filePath, "utf8");
    } catch {
      inputError();
    }
    for (const line of contents.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed.length === 0 || trimmed.startsWith("#")) {
        continue;
      }
      entries.push(resolveCookieCollection([trimmed], environment)[0]);
    }
  }
  return entries;
}

function validateSeed(seed) {
  if (!((typeof seed === "string" && seed.length > 0) || Number.isSafeInteger(seed))) {
    inputError();
  }
  return seed;
}

function prepareConfiguration(rawConfig, values, environment, cookieFileEntries) {
  requireExactKeys(rawConfig, CONFIG_FIELDS);
  if (rawConfig.defaultsStatus !== "TBD") {
    inputError();
  }
  if (!isPlainObject(rawConfig.detector)) {
    inputError();
  }
  requireExactKeys(rawConfig.detector, DETECTOR_FIELDS);
  const resolvedConfig = resolveConfigSecrets(rawConfig, environment);
  const seed = validateSeed(values.seed ?? resolvedConfig.seed);
  const detectorConfig = { ...resolvedConfig.detector, seed };
  try {
    validateDetectorConfig(detectorConfig);
  } catch {
    inputError();
  }

  const noise = resolvedConfig.noise === undefined
    ? createNoiseConfig({ presetId: "none", seed: "cli-noise-disabled" })
    : resolvedConfig.noise;
  try {
    validateNoiseConfig(noise);
  } catch {
    inputError();
  }
  const requestTemplateIds = resolvedConfig.requestTemplateIds ?? { a: "a", b: "b" };
  if (!isPlainObject(requestTemplateIds)
    || typeof requestTemplateIds.a !== "string"
    || typeof requestTemplateIds.b !== "string") {
    inputError();
  }
  const target = resolvedConfig.target ?? { id: "cli-target", kind: "http" };
  if (!isPlainObject(target) || typeof target.id !== "string" || typeof target.kind !== "string") {
    inputError();
  }

  const overrides = {
    cookies: [
      ...(values.cookie ?? []),
      ...cookieFileEntries,
    ],
    headers: values.header ?? [],
    method: values.method,
  };
  let requests;
  try {
    requests = buildRequests(resolvedConfig, overrides);
  } catch {
    inputError();
  }
  return {
    detectorConfig,
    noise,
    requestTemplateIds,
    requests,
    target,
  };
}

async function createProductionTransport() {
  const dispatcher = new Agent({ connections: 1 });
  const transport = createHttpTransport({ dispatcher });
  return {
    close: () => dispatcher.close(),
    send: transport.send,
  };
}

async function writeReportAtomically(filePath, text, force) {
  try {
    await access(filePath);
    if (!force) {
      inputError();
    }
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
  let temporaryPath = `${filePath}.tmp-${process.pid}`;
  let handle;
  for (let index = 0; index < 100; index += 1) {
    try {
      handle = await open(temporaryPath, "wx");
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
      temporaryPath = `${filePath}.tmp-${process.pid}-${index + 1}`;
    }
  }
  if (!handle) {
    throw new Error("temporary report path unavailable");
  }
  try {
    await handle.writeFile(text, "utf8");
  } finally {
    await handle.close();
  }
  try {
    await rename(temporaryPath, filePath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }
}

function reportSummary(report) {
  return `${report.inference.verdict} (${report.observation.stopReason})`;
}

export async function runCli(argv = process.argv.slice(2), {
  detectorRunner = runDetector,
  environment = process.env,
  now = () => new Date().toISOString(),
  processObject = process,
  stderr = process.stderr,
  stdout = process.stdout,
  transportFactory = createProductionTransport,
} = {}) {
  let values;
  try {
    values = parseArguments(argv);
  } catch {
    write(stderr, "Input error\n");
    return 1;
  }
  if (values.help) {
    write(stdout, HELP_TEXT);
    return 0;
  }
  if (values.force && values.out === undefined) {
    write(stderr, "Input error\n");
    return 1;
  }
  if (typeof values.config !== "string" || values.config.length === 0) {
    write(stderr, "Input error\n");
    return 1;
  }

  let transportHandle;
  let signalHandler;
  const abortController = new AbortController();
  try {
    const rawConfig = await loadJsonConfig(values.config);
    const cookieFileEntries = await readCookieFiles(values["cookie-file"] ?? [], environment);
    const prepared = prepareConfiguration(rawConfig, values, environment, cookieFileEntries);
    authorizeRequestPair(prepared.requests, {
      iAmAuthorized: values["i-am-authorized"] === true,
      warn: (message) => write(stderr, `${message}\n`),
    });
    signalHandler = () => abortController.abort();
    processObject.once("SIGINT", signalHandler);
    transportHandle = await transportFactory({ requests: prepared.requests });
    if (!transportHandle || typeof transportHandle.send !== "function") {
      throw new Error("transport unavailable");
    }
    const startedAt = now();
    let detectorResult;
    let endedAt;
    try {
      detectorResult = await detectorRunner({
        config: prepared.detectorConfig,
        onProgress: () => {},
        requests: prepared.requests,
        send: transportHandle.send,
        signal: abortController.signal,
      });
      endedAt = now();
    } finally {
      if (typeof transportHandle.close === "function") {
        await transportHandle.close();
      }
      transportHandle = undefined;
    }

    const report = createRunReport({
      buildVersion: "cli-0.1.0",
      detectorConfig: prepared.detectorConfig,
      detectorResult,
      detectorVersion: "detector-0.1.0",
      endedAt,
      noise: prepared.noise,
      requestMetadata: prepared.requests,
      requestTemplateIds: prepared.requestTemplateIds,
      runSeed: prepared.detectorConfig.seed,
      startedAt,
      target: prepared.target,
      requestWarnings: prepared.requests.warnings,
    });
    try {
      validateRunReport(report);
    } catch {
      throw new Error("report validation failed");
    }
    const reportText = `${JSON.stringify(report, null, 2)}\n`;
    const exitCode = report.inference.verdict === "INCONCLUSIVE" ? 2 : 0;
    if (values.out !== undefined) {
      await writeReportAtomically(values.out, reportText, values.force === true);
      write(stderr, `Report written: ${reportSummary(report)}\n`);
      return exitCode;
    }
    write(stdout, reportText);
    if (exitCode === 2) {
      write(stderr, `INCONCLUSIVE: ${report.observation.stopReason}\n`);
    }
    return exitCode;
  } catch (error) {
    if (error instanceof AuthorizationError || error instanceof CliInputError) {
      write(stderr, "Input error\n");
    } else {
      write(stderr, "Runtime error\n");
    }
    return 1;
  } finally {
    if (transportHandle && typeof transportHandle.close === "function") {
      await transportHandle.close().catch(() => {});
    }
    if (signalHandler && typeof processObject.removeListener === "function") {
      processObject.removeListener("SIGINT", signalHandler);
    }
  }
}

function isDirectRun() {
  return process.argv[1] !== undefined
    && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isDirectRun()) {
  runCli().then((code) => {
    process.exitCode = code;
  });
}
