import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";

import { request } from "undici";

import { startWebServer } from "../src/server/index.js";

async function startApiServer({ environment = {}, managerOptions = {} } = {}) {
  const server = startWebServer({
    environment,
    host: "127.0.0.1",
    managerOptions,
    port: 0,
  });
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    server,
    url: `http://127.0.0.1:${address.port}`,
  };
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

async function readJson(response) {
  return response.body.json();
}

function assertApiError(body, code, message) {
  assert.deepEqual(body, {
    error: { code, message },
  });
}

test("GET /api/targets exposes only static public target and noise metadata", async () => {
  const { server, url } = await startApiServer({
    environment: {
      DEMO_NOISE_JITTER: "999999",
      DEMO_NOISE_PRESET: "low",
      DEMO_NOISE_SEED: "private-seed",
    },
  });
  try {
    const response = await request(`${url}/api/targets?url=http://127.0.0.1:3001`);
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers["cache-control"], "no-store");
    assert.equal(response.headers["access-control-allow-origin"], undefined);
    const body = await readJson(response);
    assert.deepEqual(body, {
      noisePresets: [{ id: "low", label: "Low noise" }],
      targets: [
        { id: "fixed", label: "Fixed demo" },
        { id: "vulnerable", label: "Vulnerable demo" },
      ],
    });
    const serialized = JSON.stringify(body).toLowerCase();
    for (const forbidden of ["host", "port", "http", "127.0.0.1", "jitter", "seed"]) {
      assert.equal(serialized.includes(forbidden), false, `found ${forbidden}`);
    }
  } finally {
    await closeServer(server);
  }
});

test("healthz ignores query strings and remains a static readiness response", async () => {
  const { server, url } = await startApiServer();
  try {
    const response = await request(`${url}/healthz?targetId=http%3A%2F%2Farbitrary.example`);
    assert.equal(response.statusCode, 200);
    assert.deepEqual(await readJson(response), { status: "ok" });
  } finally {
    await closeServer(server);
  }
});

test("POST /api/scans returns the PLAN response for an admitted start", async () => {
  const { server, url } = await startApiServer({
    managerOptions: {
      activePerClient: 2,
      detectorRunner: async () => {
        throw new Error("test detector failure");
      },
    },
  });
  try {
    const response = await request(`${url}/api/scans`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ targetId: "vulnerable", noisePresetId: "none" }),
    });
    assert.equal(response.statusCode, 202);
    assert.equal(response.headers["cache-control"], "no-store");
    assert.match(response.headers["content-type"], /^application\/json/);
    const body = await readJson(response);
    assert.deepEqual(body, {
      noisePresetId: "none",
      runId: "run-0001",
      status: "running",
      targetId: "vulnerable",
    });

    const secondResponse = await request(`${url}/api/scans`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ targetId: "fixed", noisePresetId: "none" }),
    });
    assert.equal(secondResponse.statusCode, 202);
    assert.equal((await readJson(secondResponse)).runId, "run-0002");
  } finally {
    await closeServer(server);
  }
});

test("POST /api/scans rejects missing or non-JSON content types and arrays", async () => {
  const { server, url } = await startApiServer();
  try {
    const cases = [
      { body: JSON.stringify({ targetId: "vulnerable", noisePresetId: "none" }), headers: {} },
      {
        body: JSON.stringify({ targetId: "vulnerable", noisePresetId: "none" }),
        headers: { "content-type": "text/plain" },
      },
      {
        body: JSON.stringify([{ targetId: "vulnerable", noisePresetId: "none" }]),
        headers: { "content-type": "application/json" },
      },
    ];
    for (const input of cases) {
      const response = await request(`${url}/api/scans`, {
        method: "POST",
        headers: input.headers,
        body: input.body,
      });
      assert.equal(response.statusCode, 400);
      assert.equal(response.headers["cache-control"], "no-store");
      assertApiError(
        await readJson(response),
        "invalid-scan-request",
        "Scan request is invalid",
      );
    }
  } finally {
    await closeServer(server);
  }
});

test("POST /api/scans rejects malformed JSON and oversized bodies with fixed errors", async () => {
  const { server, url } = await startApiServer();
  try {
    const malformed = await request(`${url}/api/scans`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    assert.equal(malformed.statusCode, 400);
    assertApiError(await readJson(malformed), "invalid-json", "Request body must contain valid JSON");

    const oversized = await request(`${url}/api/scans`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        targetId: "vulnerable",
        noisePresetId: "none",
        padding: "x".repeat(2_000),
      }),
    });
    assert.equal(oversized.statusCode, 413);
    assertApiError(await readJson(oversized), "body-too-large", "Request body is too large");
  } finally {
    await closeServer(server);
  }
});

test("POST /api/scans rejects unknown IDs, fields, unsafe keys, and wrong types", async () => {
  const { server, url } = await startApiServer();
  try {
    const bodies = [
      JSON.stringify({ targetId: "other", noisePresetId: "none" }),
      JSON.stringify({ targetId: "__proto__", noisePresetId: "none" }),
      JSON.stringify({ targetId: "constructor", noisePresetId: "none" }),
      JSON.stringify({ targetId: "prototype", noisePresetId: "none" }),
      JSON.stringify({ targetId: "vulnerable", noisePresetId: "high" }),
      JSON.stringify({ targetId: "vulnerable", noisePresetId: "none", url: "http://arbitrary.example" }),
      '{"targetId":"vulnerable","noisePresetId":"none","__proto__":"blocked"}',
      '{"targetId":"vulnerable","noisePresetId":"none","constructor":"blocked"}',
      '{"targetId":"vulnerable","noisePresetId":"none","prototype":"blocked"}',
      JSON.stringify({ targetId: 123, noisePresetId: "none" }),
      JSON.stringify({ targetId: "vulnerable", noisePresetId: null }),
    ];
    for (const serialized of bodies) {
      const response = await request(`${url}/api/scans`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: serialized,
      });
      assert.equal(response.statusCode, 400);
      assertApiError(
        await readJson(response),
        "invalid-scan-request",
        "Scan request is invalid",
      );
    }
  } finally {
    await closeServer(server);
  }
});

test("API failures use JSON instead of the default HTML error page", async () => {
  const { server, url } = await startApiServer();
  try {
    const response = await request(`${url}/api/not-a-route`);
    assert.equal(response.statusCode, 404);
    assert.equal(response.headers["cache-control"], "no-store");
    assertApiError(await readJson(response), "invalid-scan-request", "Scan request is invalid");
  } finally {
    await closeServer(server);
  }
});

test("scan admission limits return the fixed 429 error envelope", async () => {
  const { server, url } = await startApiServer({
    managerOptions: {
      detectorRunner: ({ signal }) => new Promise((resolve) => {
        if (signal.aborted) {
          resolve({});
          return;
        }
        signal.addEventListener("abort", () => resolve({}), { once: true });
      }),
    },
  });
  try {
    const body = JSON.stringify({ targetId: "vulnerable", noisePresetId: "none" });
    const first = await request(`${url}/api/scans`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    assert.equal(first.statusCode, 202);

    const second = await request(`${url}/api/scans`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    assert.equal(second.statusCode, 429);
    assert.equal(second.headers["cache-control"], "no-store");
    assertApiError(
      await readJson(second),
      "active-run-limit",
      "Too many scans are running",
    );
  } finally {
    await closeServer(server);
  }
});
