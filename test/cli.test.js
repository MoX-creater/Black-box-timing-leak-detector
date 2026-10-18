import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";

import { createDemoApp } from "../src/demos/stub.js";
import { runCli } from "../src/cli/index.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const LOCAL_FIXTURE = path.join(ROOT, "test", "fixtures", "local.json");
const EXTERNAL_FIXTURE = path.join(ROOT, "test", "fixtures", "non-localhost.json");

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

async function startDemo() {
  const server = createDemoApp({ mode: "fixed" }).listen(0, "127.0.0.1");
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

async function makeConfig(directory, fixturePath, port) {
  const config = JSON.parse(await readFile(fixturePath, "utf8"));
  if (port !== undefined) {
    config.a.url = `http://127.0.0.1:${port}/login`;
    config.b.url = `http://127.0.0.1:${port}/login`;
  }
  const filePath = path.join(directory, `${path.basename(fixturePath, ".json")}.json`);
  await writeFile(filePath, JSON.stringify(config), "utf8");
  return filePath;
}

function runNodeDetect(args, environment = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["src/cli/index.js", ...args], {
      cwd: ROOT,
      env: { ...process.env, ...environment },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal, stderr, stdout }));
  });
}

function fixtureSecrets(text) {
  return [
    "fixture-password-secret",
    "header-command-secret",
    "cookie-file-secret",
    "header-config-secret",
    "cookie-config-secret",
  ]
    .filter((secret) => text.includes(secret));
}

test("local fixture runs against a test-started demo and emits only a redacted JSON report", async () => {
  const { port, server } = await startDemo();
  const directory = await mkdtemp(path.join(os.tmpdir(), "timing-cli-local-"));
  const cookieFile = path.join(directory, "cookies.txt");
  try {
    const configPath = await makeConfig(directory, LOCAL_FIXTURE, port);
    await writeFile(cookieFile, "fixture=cookie-file-secret\n", "utf8");
    const result = await runNodeDetect([
      "--config", configPath,
      "--cookie-file", cookieFile,
      "--header", "x-command-secret: header-command-secret",
      "--method", "POST",
      "--seed", "cli-local-seed",
    ], {
      CLI_TEST_HEADER: "header-config-secret",
      CLI_TEST_COOKIE: "cookie-config-secret",
    });

    assert.ok([0, 2].includes(result.code));
    const report = JSON.parse(result.stdout);
    assert.equal(report.configuration.seed, "cli-local-seed");
    assert.deepEqual(fixtureSecrets(`${result.stdout}\n${result.stderr}`), []);
    assert.deepEqual(report.configuration.target.redactedMetadata.a.headerNames, [
      "content-type",
      "cookie",
      "x-command-secret",
      "x-fixture-secret",
    ]);
    assert.deepEqual(report.configuration.target.redactedMetadata.b.headerNames, [
      "content-type",
      "cookie",
      "x-command-secret",
      "x-fixture-secret",
    ]);
  } finally {
    await closeServer(server);
    await rm(directory, { force: true, recursive: true });
  }
});

test("--out keeps stdout empty, writes atomically, refuses overwrite, and --force replaces", async () => {
  const { port, server } = await startDemo();
  const directory = await mkdtemp(path.join(os.tmpdir(), "timing-cli-out-"));
  try {
    const configPath = await makeConfig(directory, LOCAL_FIXTURE, port);
    const reportPath = path.join(directory, "report.json");
    const first = await runNodeDetect(["--config", configPath, "--out", reportPath], {
      CLI_TEST_COOKIE: "cookie-config-secret",
      CLI_TEST_HEADER: "header-config-secret",
    });
    assert.ok([0, 2].includes(first.code));
    assert.equal(first.stdout, "");
    assert.equal(first.stderr.split("\n").filter(Boolean).length, 1);
    const reportText = await readFile(reportPath, "utf8");
    assert.equal(JSON.parse(reportText).schemaVersion, "1.0");

    const refused = await runNodeDetect(["--config", configPath, "--out", reportPath], {
      CLI_TEST_COOKIE: "cookie-config-secret",
      CLI_TEST_HEADER: "header-config-secret",
    });
    assert.equal(refused.code, 1);
    assert.equal(refused.stdout, "");
    assert.equal(refused.stderr.trim(), "Input error");

    const forced = await runNodeDetect(["--config", configPath, "--out", reportPath, "--force"], {
      CLI_TEST_COOKIE: "cookie-config-secret",
      CLI_TEST_HEADER: "header-config-secret",
    });
    assert.ok([0, 2].includes(forced.code));
    assert.equal(forced.stdout, "");
    assert.equal(forced.stderr.split("\n").filter(Boolean).length, 1);
  } finally {
    await closeServer(server);
    await rm(directory, { force: true, recursive: true });
  }
});

test("help documents body omission and shell-history risk without echoing values", async () => {
  const result = await runNodeDetect(["--help"]);

  assert.equal(result.code, 0);
  assert.match(result.stdout, /--body is not supported/);
  assert.match(result.stdout, /shell history/);
  assert.equal(result.stderr, "");
  assert.deepEqual(fixtureSecrets(`${result.stdout}\n${result.stderr}`), []);
});

test("--body is rejected as an input error and its value is not echoed", async () => {
  const result = await runNodeDetect(["--body", "body-command-secret"]);

  assert.equal(result.code, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr.trim(), "Input error");
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /body-command-secret/);
});

test("non-localhost input fails before any connection without authorization", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "timing-cli-external-"));
  const stderr = captureStream();
  const stdout = captureStream();
  let connectionAttempts = 0;
  try {
    const configPath = await makeConfig(directory, EXTERNAL_FIXTURE);
    const code = await runCli(["--config", configPath], {
      environment: {
        ...process.env,
        CLI_TEST_COOKIE: "cookie-config-secret",
        CLI_TEST_HEADER: "header-config-secret",
      },
      stderr,
      stdout,
      transportFactory: async () => {
        connectionAttempts += 1;
        return { send: async () => ({}) };
      },
    });
    assert.equal(code, 1);
    assert.equal(connectionAttempts, 0);
    assert.equal(stderr.text(), "Input error\n");
    assert.equal(stdout.text(), "");
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("authorized non-localhost execution uses only the injected transport and warns safely", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "timing-cli-authorized-"));
  const stderr = captureStream();
  const stdout = captureStream();
  let connectionAttempts = 0;
  try {
    const configPath = await makeConfig(directory, EXTERNAL_FIXTURE);
    const code = await runCli(["--config", configPath, "--i-am-authorized"], {
      environment: {
        ...process.env,
        CLI_TEST_COOKIE: "cookie-config-secret",
        CLI_TEST_HEADER: "header-config-secret",
      },
      stderr,
      stdout,
      transportFactory: async () => ({
        close: async () => {},
        send: async () => {
          connectionAttempts += 1;
          return { durationMs: 10, kind: "accepted", statusCode: 200 };
        },
      }),
    });
    assert.ok([0, 2].includes(code));
    assert.equal(connectionAttempts > 0, true);
    assert.match(stderr.text(), /WARNING: external target requests require your authorization/);
    assert.deepEqual(fixtureSecrets(`${stdout.text()}\n${stderr.text()}`), []);
    assert.equal(JSON.parse(stdout.text()).configuration.target.id, "external-fixture");
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("missing seed is an input error and does not open transport", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "timing-cli-seed-"));
  const stderr = captureStream();
  const stdout = captureStream();
  let connectionAttempts = 0;
  try {
    const config = JSON.parse(await readFile(LOCAL_FIXTURE, "utf8"));
    delete config.seed;
    const configPath = path.join(directory, "missing-seed.json");
    await writeFile(configPath, JSON.stringify(config), "utf8");
    const code = await runCli(["--config", configPath], {
      stderr,
      stdout,
      transportFactory: async () => {
        connectionAttempts += 1;
        return { send: async () => ({}) };
      },
    });
    assert.equal(code, 1);
    assert.equal(connectionAttempts, 0);
    assert.equal(stderr.text(), "Input error\n");
    assert.equal(stdout.text(), "");
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("SIGINT aborts the detector, reports the aborted stop reason, and closes transport", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "timing-cli-sigint-"));
  const stderr = captureStream();
  const stdout = captureStream();
  const processObject = new EventEmitter();
  let closeCalls = 0;
  try {
    const configPath = await makeConfig(directory, LOCAL_FIXTURE, 1);
    const code = await runCli(["--config", configPath], {
      detectorRunner: ({ signal }) => new Promise((resolve) => {
        signal.addEventListener("abort", () => resolve({
          counts: {
            a: { accepted: 0, attempts: 0, discarded: 0, discardReasons: {} },
            b: { accepted: 0, attempts: 0, discarded: 0, discardReasons: {} },
          },
          expectedStatus: null,
          lookHistory: [],
          samples: { a: [], b: [] },
          seed: "local-fixture-seed",
          sensitivityMs: null,
          stopReason: "aborted",
          verdict: "INCONCLUSIVE",
          warmupRecords: [],
          warnings: [],
        }));
        setImmediate(() => processObject.emit("SIGINT"));
      }),
      processObject,
      environment: {
        ...process.env,
        CLI_TEST_COOKIE: "cookie-config-secret",
        CLI_TEST_HEADER: "header-config-secret",
      },
      stderr,
      stdout,
      transportFactory: async () => ({
        close: async () => { closeCalls += 1; },
        send: async () => ({ durationMs: 1, kind: "accepted", statusCode: 200 }),
      }),
    });
    assert.equal(code, 2);
    assert.equal(closeCalls, 1);
    assert.equal(JSON.parse(stdout.text()).observation.stopReason, "aborted");
    assert.equal(stderr.text(), "INCONCLUSIVE: aborted\n");
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
