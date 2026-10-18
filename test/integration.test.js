import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";

import { Agent } from "undici";

import { runCli } from "../src/cli/index.js";
import { createNoiseConfig } from "../src/demos/noise.js";
import { startStubServer } from "../src/demos/stub.js";
import { createHttpTransport } from "../src/http/transport.js";
import { validateRunReport } from "../src/report/index.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI_PATH = path.join(ROOT, "src", "cli", "index.js");
const HEADER_SENTINEL = "t27-header-sentinel";
const COOKIE_SENTINEL = "t27-cookie-sentinel";
const DETECTOR_SEED = "t27-integration-seed";
const NOISE_SEED = "t27-none-noise-seed";

const DEMO_DETECTOR = Object.freeze({
  alphaTotal: 0.05,
  bootstrapReplicates: 8,
  lookBatchPerGroup: 4,
  materialDiscardRateDifference: 0.2,
  maxAttempts: 20,
  maxConsecutiveFailures: 2,
  maxDiscardRate: 0.5,
  maxValidPerGroup: 8,
  minAttemptsForDiscardRate: 2,
  minValidPerGroup: 4,
  quantile: 0.1,
  targetPower: 0.8,
});

const SMALL_DETECTOR = Object.freeze({
  alphaTotal: 0.05,
  bootstrapReplicates: 8,
  lookBatchPerGroup: 2,
  materialDiscardRateDifference: 0.2,
  maxAttempts: 6,
  maxConsecutiveFailures: 2,
  maxDiscardRate: 0.5,
  maxValidPerGroup: 2,
  minAttemptsForDiscardRate: 2,
  minValidPerGroup: 2,
  quantile: 0.1,
  targetPower: 0.8,
});

const NONE_NOISE = Object.freeze({
  benchmarkStatus: "TBD",
  jitter: 0,
  presetId: "none",
  seed: NOISE_SEED,
  spikeMultiplier: 0,
  spikeProbability: 0,
});

function captureStream() {
  let output = "";
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      output += chunk.toString();
      callback();
    },
  });
  stream.text = () => output;
  return stream;
}

function makeConfig({ aUrl, bUrl = aUrl, detector, targetId = "t27-local", noise = NONE_NOISE }) {
  return {
    defaultsStatus: "TBD",
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-t27-header": "$T27_HEADER_SECRET",
    },
    cookies: {
      "t27-cookie": "$T27_COOKIE_SECRET",
    },
    a: {
      url: aUrl,
      body: {
        type: "json",
        value: { password: "t27-password", username: "known-user" },
      },
    },
    b: {
      url: bUrl,
      body: {
        type: "json",
        value: { password: "t27-password", username: "missing-user" },
      },
    },
    seed: DETECTOR_SEED,
    detector,
    noise,
    requestTemplateIds: { a: "known-user", b: "missing-user" },
    target: { id: targetId, kind: "integration" },
  };
}

function environment() {
  return {
    ...process.env,
    T27_HEADER_SECRET: HEADER_SENTINEL,
    T27_COOKIE_SECRET: COOKIE_SENTINEL,
  };
}

function assertNoSecrets(result, report) {
  const output = `${result.stdout}\n${result.stderr}\n${JSON.stringify(report)}`;
  assert.equal(output.includes(HEADER_SENTINEL), false);
  assert.equal(output.includes(COOKIE_SENTINEL), false);
}

function assertObservedSecrets(observed) {
  assert.ok(observed.headerValues.length > 0);
  assert.ok(observed.cookieValues.length > 0);
  assert.ok(observed.headerValues.every((value) => value === HEADER_SENTINEL));
  assert.ok(observed.cookieValues.every((value) => value.includes(COOKIE_SENTINEL)));
}

function parseReport(result) {
  assert.notEqual(result.stdout.trim(), "");
  const report = JSON.parse(result.stdout);
  validateRunReport(report);
  return report;
}

async function writeConfig(directory, config, name = "config.json") {
  const configPath = path.join(directory, name);
  await writeFile(configPath, JSON.stringify(config), "utf8");
  return configPath;
}

async function runNodeCli(args, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      cwd: ROOT,
      env: environment(),
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      child.kill();
      if (!settled) {
        settled = true;
        reject(new Error("CLI child process timed out"));
      }
    }, timeoutMs);
    const finish = (callback, value) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => finish(reject, error));
    child.once("exit", (code, signal) => finish(resolve, { code, signal, stderr, stdout }));
  });
}

async function startDemo(mode) {
  const server = startStubServer({
    host: "127.0.0.1",
    mode,
    noiseConfig: createNoiseConfig({ presetId: "none", seed: NOISE_SEED }),
    port: 0,
    serviceName: `t27-${mode}`,
  });
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return { port: address.port, server };
}

async function closeServer(server) {
  if (!server.listening) {
    return;
  }
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function startHttpServer(handler) {
  const sockets = new Set();
  const timers = new Set();
  const server = createServer((request, response) => {
    handler(request, response, { sockets, timers });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    close: async () => {
      for (const timer of timers) {
        clearTimeout(timer);
      }
      for (const socket of sockets) {
        socket.destroy();
      }
      await closeServer(server);
    },
    port: address.port,
    server,
  };
}

function observedHandler(observed, behavior) {
  return (request, response, context) => {
    observed.headerValues.push(request.headers["x-t27-header"]);
    observed.cookieValues.push(request.headers.cookie ?? "");
    observed.requests += 1;
    request.resume();
    behavior({
      context,
      request,
      requestNumber: observed.requests,
      response,
    });
  };
}

async function runInProcessCli(directory, config, options = {}) {
  const configPath = await writeConfig(directory, config, options.name ?? "config.json");
  const stdout = captureStream();
  const stderr = captureStream();
  const code = await runCli(["--config", configPath], {
    environment: environment(),
    now: options.now,
    processObject: new EventEmitter(),
    stderr,
    stdout,
    transportFactory: options.transportFactory,
  });
  const result = { code, stderr: stderr.text(), stdout: stdout.text() };
  return { ...result, report: parseReport(result) };
}

function assertDiscardedFromStatistics(report, reason) {
  for (const label of ["a", "b"]) {
    const counts = report.observation.counts[label];
    assert.equal(report.observation.samples[label].length, 0);
    assert.equal(counts.accepted, 0);
    assert.equal(counts.discarded, counts.attempts);
    assert.equal(counts.discardReasons[reason], counts.discarded);
  }
}

function assertErrorAccounting(report) {
  for (const label of ["a", "b"]) {
    const counts = report.observation.counts[label];
    assert.equal(counts.accepted, 0);
    assert.equal(counts.accepted + counts.discarded, counts.attempts);
    assert.equal(Object.values(counts.discardReasons).reduce((sum, count) => sum + count, 0), counts.discarded);
  }
}

test("CLI against the real vulnerable demo reports the verdict produced by the run", async () => {
  const { port, server } = await startDemo("vulnerable");
  const directory = await mkdtemp(path.join(os.tmpdir(), "timing-t27-vulnerable-"));
  try {
    const config = makeConfig({
      aUrl: `http://127.0.0.1:${port}/login`,
      detector: DEMO_DETECTOR,
      targetId: "t27-vulnerable",
    });
    const configPath = await writeConfig(directory, config);
    const result = await runNodeCli(["--config", configPath]);
    assert.ok([0, 2].includes(result.code));
    const report = parseReport(result);
    assert.equal(report.configuration.noise.presetId, "none");
    assert.deepEqual(report.configuration.detector, {
      ...DEMO_DETECTOR,
      seed: DETECTOR_SEED,
    });
    assert.equal(
      report.inference.verdict,
      "LEAK",
      `The real vulnerable demo did not produce LEAK. Report data:\n${JSON.stringify(report, null, 2)}`,
    );
    assertNoSecrets(result, report);
  } finally {
    await rm(directory, { force: true, recursive: true });
    await closeServer(server);
  }
});

test("CLI against the real fixed demo records a non-LEAK verdict", async (t) => {
  const { port, server } = await startDemo("fixed");
  const directory = await mkdtemp(path.join(os.tmpdir(), "timing-t27-fixed-"));
  try {
    const config = makeConfig({
      aUrl: `http://127.0.0.1:${port}/login`,
      detector: DEMO_DETECTOR,
      targetId: "t27-fixed",
    });
    const configPath = await writeConfig(directory, config);
    const result = await runNodeCli(["--config", configPath]);
    assert.ok([0, 2].includes(result.code));
    const report = parseReport(result);
    t.diagnostic(`fixed demo verdict=${report.inference.verdict}, stopReason=${report.observation.stopReason}`);
    assert.notEqual(
      report.inference.verdict,
      "LEAK",
      `The real fixed demo unexpectedly produced LEAK. Report data:\n${JSON.stringify(report, null, 2)}`,
    );
    assert.equal(report.configuration.noise.presetId, "none");
    assert.deepEqual(report.configuration.detector, {
      ...DEMO_DETECTOR,
      seed: DETECTOR_SEED,
    });
    assertNoSecrets(result, report);
  } finally {
    await rm(directory, { force: true, recursive: true });
    await closeServer(server);
  }
});

test("status mismatches are discarded and excluded from CLI statistics", async () => {
  const observed = { cookieValues: [], headerValues: [], requests: 0 };
  const server = await startHttpServer(observedHandler(observed, ({ requestNumber, response }) => {
    response.statusCode = requestNumber <= 2 ? 200 : 503;
    response.end("{}");
  }));
  const directory = await mkdtemp(path.join(os.tmpdir(), "timing-t27-status-"));
  try {
    const result = await runInProcessCli(directory, makeConfig({
      aUrl: `http://127.0.0.1:${server.port}/status-mismatch`,
      detector: SMALL_DETECTOR,
      targetId: "t27-status-mismatch",
    }));
    assert.equal(result.code, 2);
    assertObservedSecrets(observed);
    assertDiscardedFromStatistics(result.report, "status-mismatch");
    assertNoSecrets(result, result.report);
  } finally {
    await rm(directory, { force: true, recursive: true });
    await server.close();
  }
});

test("redirects are discarded without hitting the second local listener", async () => {
  let redirectHits = 0;
  const redirectTarget = await startHttpServer((_request, response) => {
    redirectHits += 1;
    response.end("redirect target");
  });
  const observed = { cookieValues: [], headerValues: [], requests: 0 };
  const server = await startHttpServer(observedHandler(observed, ({ requestNumber, response }) => {
    if (requestNumber <= 2) {
      response.statusCode = 200;
      response.end("{}");
      return;
    }
    response.statusCode = 302;
    response.setHeader("Location", `http://127.0.0.1:${redirectTarget.port}/must-not-follow`);
    response.end();
  }));
  const directory = await mkdtemp(path.join(os.tmpdir(), "timing-t27-redirect-"));
  try {
    const result = await runInProcessCli(directory, makeConfig({
      aUrl: `http://127.0.0.1:${server.port}/redirect`,
      detector: SMALL_DETECTOR,
      targetId: "t27-redirect",
    }));
    assert.equal(result.code, 2);
    assertObservedSecrets(observed);
    assert.equal(redirectHits, 0);
    assertDiscardedFromStatistics(result.report, "unexpected-status");
    assertNoSecrets(result, result.report);
  } finally {
    await rm(directory, { force: true, recursive: true });
    await server.close();
    await redirectTarget.close();
  }
});

test("connection resets are counted as fatal transport errors", async () => {
  const observed = { cookieValues: [], headerValues: [], requests: 0 };
  const server = await startHttpServer(observedHandler(observed, ({ request, requestNumber, response }) => {
    if (requestNumber <= 2) {
      response.statusCode = 200;
      response.end("{}");
      return;
    }
    request.socket.destroy();
  }));
  const directory = await mkdtemp(path.join(os.tmpdir(), "timing-t27-reset-"));
  try {
    const result = await runInProcessCli(directory, makeConfig({
      aUrl: `http://127.0.0.1:${server.port}/reset`,
      detector: SMALL_DETECTOR,
      targetId: "t27-reset",
    }));
    assert.equal(result.code, 2);
    assert.equal(result.report.observation.stopReason, "fatal-transport-error");
    assertObservedSecrets(observed);
    assertErrorAccounting(result.report);
    assertNoSecrets(result, result.report);
  } finally {
    await rm(directory, { force: true, recursive: true });
    await server.close();
  }
});

test("short transport timeouts stop after consecutive failures", async () => {
  const observed = { cookieValues: [], headerValues: [], requests: 0 };
  const server = await startHttpServer(observedHandler(observed, ({ context, requestNumber, response }) => {
    if (requestNumber <= 2) {
      response.statusCode = 200;
      response.end("{}");
      return;
    }
    const timer = setTimeout(() => response.end("late response"), 1_000);
    context.timers.add(timer);
    response.once("close", () => {
      clearTimeout(timer);
      context.timers.delete(timer);
    });
  }));
  const directory = await mkdtemp(path.join(os.tmpdir(), "timing-t27-timeout-"));
  try {
    const result = await runInProcessCli(directory, makeConfig({
      aUrl: `http://127.0.0.1:${server.port}/timeout`,
      detector: SMALL_DETECTOR,
      targetId: "t27-timeout",
    }), {
      transportFactory: async () => {
        const dispatcher = new Agent({ connections: 1 });
        const transport = createHttpTransport({ dispatcher, timeoutMs: 150 });
        return {
          close: () => dispatcher.close(),
          send: transport.send,
        };
      },
    });
    assert.equal(result.code, 2);
    assert.equal(result.report.observation.stopReason, "fatal-transport-error");
    assert.equal(result.report.configuration.detector.maxAttempts, 6);
    assert.equal(result.report.configuration.detector.maxConsecutiveFailures, 2);
    assertObservedSecrets(observed);
    assertErrorAccounting(result.report);
    assert.ok(Object.values(result.report.observation.counts)
      .some((counts) => counts.discardReasons.timeout > 0));
    assertNoSecrets(result, result.report);
  } finally {
    await rm(directory, { force: true, recursive: true });
    await server.close();
  }
});

function deterministicTransportFactory(calls) {
  return async () => {
    let responseNumber = 0;
    return {
      close: async () => {},
      send: async (request) => {
        responseNumber += 1;
        calls.push(request.body.includes("known-user") ? "a" : "b");
        return {
          durationMs: 10 + responseNumber,
          kind: "accepted",
          statusCode: 200,
        };
      },
    };
  };
}

test("same seed reproduces CLI sampling order and report counts with an injected transport", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "timing-t27-reproducible-"));
  const firstCalls = [];
  const secondCalls = [];
  const config = makeConfig({
    aUrl: "http://127.0.0.1:1/reproducible",
    detector: SMALL_DETECTOR,
    targetId: "t27-reproducible",
  });
  const fixedNow = () => "2026-01-01T00:00:00.000Z";
  try {
    const first = await runInProcessCli(directory, config, {
      name: "first.json",
      now: fixedNow,
      transportFactory: deterministicTransportFactory(firstCalls),
    });
    const second = await runInProcessCli(directory, config, {
      name: "second.json",
      now: fixedNow,
      transportFactory: deterministicTransportFactory(secondCalls),
    });
    assert.deepEqual(second.report, first.report);
    assert.deepEqual(second.report.observation.counts, first.report.observation.counts);
    assert.deepEqual(second.report.observation.samples, first.report.observation.samples);
    assert.deepEqual(second.report.observation.warmupRecords, first.report.observation.warmupRecords);
    assert.deepEqual(second.report.observation.counts, first.report.observation.counts);
    assert.deepEqual(second.report.configuration.seed, first.report.configuration.seed);
    assert.deepEqual(secondCalls, firstCalls);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
