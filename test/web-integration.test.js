import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";

import { startStubServer } from "../src/demos/stub.js";
import { startWebServer } from "../src/server/index.js";

async function startDemo(mode) {
  const server = startStubServer({
    host: "127.0.0.1",
    mode,
    noiseConfig: undefined,
    port: 0,
    serviceName: mode,
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

async function waitForSnapshot(baseUrl, runId) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const response = await fetch(`${baseUrl}/api/scans/${runId}`);
    const snapshot = await response.json();
    if (snapshot.status !== "running") {
      return snapshot;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("web scan did not reach a terminal state");
}

test("the first web scan after startup uses real demos without warmup failure", async () => {
  const vulnerable = await startDemo("vulnerable");
  const fixed = await startDemo("fixed");
  const web = startWebServer({
    environment: {
      DEMO_FIXED_HOST: "127.0.0.1",
      DEMO_FIXED_PORT: String(fixed.port),
      DEMO_NOISE_PRESET: "none",
      DEMO_VULNERABLE_HOST: "127.0.0.1",
      DEMO_VULNERABLE_PORT: String(vulnerable.port),
    },
    host: "127.0.0.1",
    port: 0,
  });
  await once(web, "listening");
  const address = web.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    for (const targetId of ["vulnerable", "fixed"]) {
      const startResponse = await fetch(`${baseUrl}/api/scans`, {
        body: JSON.stringify({ noisePresetId: "none", targetId }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      assert.equal(startResponse.status, 202);
      const run = await startResponse.json();
      const snapshot = await waitForSnapshot(baseUrl, run.runId);

      assert.notEqual(snapshot.status, "failed");
      assert.notEqual(snapshot.inference?.stopReason, "warmup-failed");
      assert.equal(snapshot.progress.accepted.a, 8);
      assert.equal(snapshot.progress.accepted.b, 8);

      const reportResponse = await fetch(`${baseUrl}/api/scans/${run.runId}/report`);
      assert.equal(reportResponse.status, 200);
      const report = await reportResponse.json();
      assert.ok(report.observation.warmupRecords.every(({ result }) => (
        result.kind === "accepted" && result.statusCode === 200
      )));

    }
  } finally {
    await new Promise((resolve) => web.close(resolve));
    await closeServer(vulnerable.server);
    await closeServer(fixed.server);
  }
});
