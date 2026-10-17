import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";

import { request } from "undici";

import {
  createDemoUserStore,
  hashPassword,
  LOGIN_INVALID_BODY,
  LOGIN_INVALID_STATUS,
  LOGIN_SUCCESS_STATUS,
} from "../src/demos/auth.js";
import {
  createDemoApp,
  DEMO_MODE,
  startStubServer,
} from "../src/demos/stub.js";

async function startApp(app) {
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return { server, url: `http://127.0.0.1:${address.port}` };
}

async function closeServer(server) {
  if (!server.listening) {
    return;
  }
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function postLogin(url, body, headers = { "content-type": "application/json" }) {
  const response = await request(`${url}/login`, {
    body,
    headers,
    method: "POST",
  });
  const responseBody = await response.body.text();
  return { body: responseBody, headers: response.headers, statusCode: response.statusCode };
}

function comparableHeaders(headers) {
  return Object.fromEntries(
    Object.entries(headers)
      .filter(([name]) => name.toLowerCase() !== "date")
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function countingScrypt() {
  const calls = [];
  const scryptFn = (password, salt, keylen, options, callback) => {
    calls.push({ keylen, options, password, salt: Buffer.from(salt) });
    callback(null, Buffer.alloc(keylen, 0x5a));
  };
  return { calls, scryptFn };
}

async function countingApp(mode, fake) {
  const userStore = await createDemoUserStore({
    hashPasswordFn: async () => Buffer.alloc(32, 0x5a),
  });
  return createDemoApp({
    hashPasswordFn: hashPassword,
    mode,
    scryptFn: fake.scryptFn,
    userStore,
  });
}

test("vulnerable mode performs one hash for existing and zero for missing users", async () => {
  const fake = countingScrypt();
  const { server, url } = await startApp(await countingApp(DEMO_MODE.VULNERABLE, fake));
  try {
    const existing = await postLogin(url, JSON.stringify({
      password: "wrong-password",
      username: "known-user",
    }));
    assert.equal(existing.statusCode, LOGIN_SUCCESS_STATUS);
    assert.equal(fake.calls.length, 1);

    const missing = await postLogin(url, JSON.stringify({
      password: "wrong-password",
      username: "missing-user",
    }));
    assert.equal(missing.statusCode, LOGIN_SUCCESS_STATUS);
    assert.equal(fake.calls.length, 1);
    assert.deepEqual(existing.body, missing.body);
  } finally {
    await closeServer(server);
  }
});

test("fixed mode performs one hash for both existing and missing users", async () => {
  const fake = countingScrypt();
  const { server, url } = await startApp(await countingApp(DEMO_MODE.FIXED, fake));
  try {
    const existing = await postLogin(url, JSON.stringify({
      password: "wrong-password",
      username: "known-user",
    }));
    assert.equal(existing.statusCode, LOGIN_SUCCESS_STATUS);
    assert.equal(fake.calls.length, 1);

    const missing = await postLogin(url, JSON.stringify({
      password: "wrong-password",
      username: "missing-user",
    }));
    assert.equal(missing.statusCode, LOGIN_SUCCESS_STATUS);
    assert.equal(fake.calls.length, 2);
    assert.deepEqual(existing.body, missing.body);
  } finally {
    await closeServer(server);
  }
});

for (const mode of Object.values(DEMO_MODE)) {
  test(`${mode} returns identical success bodies and headers for existing and missing users`, async () => {
    const { server, url } = await startApp(await createDemoApp({ mode }));
    try {
      const existing = await postLogin(url, JSON.stringify({
        password: "wrong-password",
        username: "known-user",
      }));
      const missing = await postLogin(url, JSON.stringify({
        password: "wrong-password",
        username: "missing-user",
      }));

      assert.equal(existing.statusCode, LOGIN_SUCCESS_STATUS);
      assert.equal(missing.statusCode, LOGIN_SUCCESS_STATUS);
      assert.deepEqual(existing.body, missing.body);
      assert.deepEqual(comparableHeaders(existing.headers), comparableHeaders(missing.headers));
      assert.equal(existing.headers["content-type"], "application/json; charset=utf-8");
      assert.equal(existing.headers["content-length"], String(Buffer.byteLength(existing.body)));
      assert.equal(existing.headers.etag, undefined);
      assert.equal(existing.headers["x-powered-by"], undefined);
    } finally {
      await closeServer(server);
    }
  });
}

test("malformed, oversized, non-JSON, and missing-content-type requests share the fixed 400 response", async () => {
  const { server, url } = await startApp(await createDemoApp({ mode: DEMO_MODE.FIXED }));
  try {
    const malformed = await postLogin(url, "{", { "content-type": "application/json" });
    const oversized = await postLogin(url, JSON.stringify({ value: "x".repeat(9000) }), {
      "content-type": "application/json",
    });
    const nonJson = await postLogin(url, "not-json", { "content-type": "text/plain" });
    const missingContentType = await postLogin(url, JSON.stringify({
      password: "password",
      username: "known-user",
    }), {});

    for (const response of [malformed, oversized, nonJson, missingContentType]) {
      assert.equal(response.statusCode, LOGIN_INVALID_STATUS);
      assert.equal(response.body, LOGIN_INVALID_BODY);
      assert.equal(response.headers["content-type"], "application/json; charset=utf-8");
      assert.equal(response.headers["content-length"], String(Buffer.byteLength(LOGIN_INVALID_BODY)));
    }
    assert.deepEqual(comparableHeaders(malformed.headers), comparableHeaders(oversized.headers));
    assert.deepEqual(comparableHeaders(malformed.headers), comparableHeaders(nonJson.headers));
    assert.deepEqual(comparableHeaders(malformed.headers), comparableHeaders(missingContentType.headers));
  } finally {
    await closeServer(server);
  }
});

test("unexpected route errors return a fixed 500 without details", async () => {
  const app = createDemoApp({
    hashPasswordFn: async () => {
      throw new Error("private stack detail");
    },
    mode: DEMO_MODE.FIXED,
  });
  const { server, url } = await startApp(app);
  try {
    const response = await postLogin(url, JSON.stringify({
      password: "password",
      username: "known-user",
    }));
    const body = response.body;
    assert.equal(response.statusCode, 500);
    assert.equal(body, JSON.stringify({
      error: {
        code: "INTERNAL_SERVER_ERROR",
        message: "Internal server error",
      },
    }));
    assert.doesNotMatch(body, /private stack detail|Error/);
  } finally {
    await closeServer(server);
  }
});

test("unknown demo modes throw at startup", () => {
  assert.throws(() => createDemoApp({ mode: "stub" }), /mode must be vulnerable or fixed/);
});

for (const mode of Object.values(DEMO_MODE)) {
  test(`real ${mode} listener returns equivalent successful responses`, async () => {
    const server = startStubServer({ host: "127.0.0.1", mode, port: 0 });
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const url = `http://127.0.0.1:${address.port}`;
    try {
      const existing = await postLogin(url, JSON.stringify({
        password: "wrong-password",
        username: "known-user",
      }));
      const missing = await postLogin(url, JSON.stringify({
        password: "wrong-password",
        username: "missing-user",
      }));
      assert.equal(existing.statusCode, LOGIN_SUCCESS_STATUS);
      assert.equal(missing.statusCode, LOGIN_SUCCESS_STATUS);
      assert.deepEqual(existing.body, missing.body);
    } finally {
      await closeServer(server);
    }
  });
}
