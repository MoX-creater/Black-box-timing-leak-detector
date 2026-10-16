import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import { startStack } from "../src/launcher.js";

async function waitForHealth(url) {
  const deadline = Date.now() + 5000;
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
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

test("launcher starts all processes and forwards termination", async () => {
  const stack = startStack({
    environment: { ...process.env, HOST: "127.0.0.1", PORT: "3100" },
    stdio: "ignore",
  });

  try {
    await waitForHealth("http://127.0.0.1:3100/healthz");
    await waitForHealth("http://127.0.0.1:3001/healthz");
    await waitForHealth("http://127.0.0.1:3002/healthz");
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
