import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createServer as createNetServer } from "node:net";

import { startStack } from "../src/launcher.js";

async function findFreePort() {
  const server = createNetServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}

async function waitForHealth(url, { deadlineMs = 30_000, intervalMs = 50 } = {}) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        await response.arrayBuffer();
        return;
      }
    } catch {
      // The child processes may still be starting.
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function waitForSnapshot(baseUrl, runId) {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const response = await fetch(`${baseUrl}/api/scans/${runId}`);
    const snapshot = await response.json();
    if (snapshot.status !== "running") {
      return snapshot;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("launcher scan did not reach a terminal state");
}

test("launcher starts all processes and forwards termination", async () => {
  const webPort = await findFreePort();
  const stack = startStack({
    environment: { ...process.env, HOST: "127.0.0.1", PORT: String(webPort) },
    stdio: "ignore",
  });

  try {
    await waitForHealth(`http://127.0.0.1:${webPort}/healthz`);
    const baseUrl = `http://127.0.0.1:${webPort}`;
    for (const targetId of ["vulnerable", "fixed"]) {
      const startResponse = await fetch(`${baseUrl}/api/scans`, {
        body: JSON.stringify({ noisePresetId: "none", targetId }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      assert.equal(startResponse.status, 202);
      const run = await startResponse.json();
      const snapshot = await waitForSnapshot(baseUrl, run.runId);
      assert.notEqual(snapshot.status, "failed", JSON.stringify(snapshot));
      assert.notEqual(snapshot.inference?.stopReason, "warmup-failed", JSON.stringify(snapshot));
      if (targetId === "vulnerable") {
        assert.equal(snapshot.verdict, "LEAK", JSON.stringify(snapshot));
      } else {
        assert.notEqual(snapshot.verdict, "LEAK", JSON.stringify(snapshot));
      }
    }
    stack.shutdown(0);
    assert.equal(await stack.done, 0);
  } finally {
    stack.shutdown(1);
    await stack.done;
  }
});

test("launcher stops the stack when a child exits unexpectedly", async () => {
  const children = [];
  const spawnProcess = () => {
    const child = new EventEmitter();
    child.finished = false;
    child.kill = () => {
      child.killed = true;
      if (!child.finished) {
        queueMicrotask(() => child.emit("exit", null, "SIGTERM"));
      }
    };
    children.push(child);
    return child;
  };
  const stack = startStack({
    environment: { PORT: "3200" },
    spawnProcess,
    stdio: "ignore",
  });

  children[0].emit("exit", 1, null);
  assert.equal(await stack.done, 1);
  assert.equal(children.filter((child) => child.killed).length, 2);
});
