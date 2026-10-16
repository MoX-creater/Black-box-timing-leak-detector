import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";

import { request } from "undici";

import { startStubServer } from "../src/demos/stub.js";
import { startWebServer } from "../src/server/index.js";

async function startEphemeral(start) {
  const server = start({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return { server, url: `http://127.0.0.1:${address.port}/healthz` };
}

async function closeServer(server) {
  if (!server.listening) {
    return;
  }

  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function assertHealth(start, expectedBody) {
  const { server, url } = await startEphemeral(start);
  try {
    const response = await request(url);
    assert.equal(response.statusCode, 200);
    assert.deepEqual(await response.body.json(), expectedBody);
  } finally {
    await closeServer(server);
  }
}

test("web entrypoint serves a health response", async () => {
  await assertHealth(startWebServer, { status: "ok" });
});

test("stub entrypoint serves a named health response", async () => {
  await assertHealth(
    (options) => startStubServer({ ...options, serviceName: "stub" }),
    { service: "stub", status: "ok" },
  );
});
