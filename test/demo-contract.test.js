import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  createDemoAuthenticator,
  createDemoUserStore,
  hashPassword,
  LOGIN_INVALID_BODY,
  LOGIN_INVALID_STATUS,
  LOGIN_SUCCESS_STATUS,
  SCRYPT_PARAMS,
} from "../src/demos/auth.js";

let userStore;

test.before(async () => {
  userStore = await createDemoUserStore();
});

function countingScrypt() {
  const calls = [];
  const scryptFn = (password, salt, keylen, options, callback) => {
    calls.push({ keylen, options, password, salt: Buffer.from(salt) });
    callback(null, Buffer.alloc(keylen, 0x5a));
  };
  return { calls, scryptFn };
}

test("existing and nonexistent users return the same successful serialized body", async () => {
  const authenticate = createDemoAuthenticator({ userStore });
  const existingMatch = await authenticate({ password: "demo-password", username: "known-user" });
  const existingMismatch = await authenticate({ password: "wrong-password", username: "known-user" });
  const missing = await authenticate({ password: "any-password", username: "missing-user" });

  assert.equal(existingMatch.statusCode, LOGIN_SUCCESS_STATUS);
  assert.equal(existingMismatch.statusCode, LOGIN_SUCCESS_STATUS);
  assert.equal(missing.statusCode, LOGIN_SUCCESS_STATUS);
  assert.deepEqual(existingMatch.body, existingMismatch.body);
  assert.deepEqual(existingMatch.body, missing.body);
  assert.deepEqual(JSON.parse(existingMatch.body), JSON.parse(missing.body));
});

test("hashPassword uses async injectable scrypt with the pinned parameters", async () => {
  const fake = countingScrypt();
  const result = await hashPassword("password", { salt: "test-salt", scryptFn: fake.scryptFn });

  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].password, "password");
  assert.equal(fake.calls[0].keylen, SCRYPT_PARAMS.keylen);
  assert.deepEqual(fake.calls[0].options, {
    N: SCRYPT_PARAMS.N,
    maxmem: SCRYPT_PARAMS.maxmem,
    p: SCRYPT_PARAMS.p,
    r: SCRYPT_PARAMS.r,
  });
  assert.equal(result.length, SCRYPT_PARAMS.keylen);
});

test("stored and dummy hashes are precomputed once at store creation", async () => {
  let hashCalls = 0;
  const store = await createDemoUserStore({
    hashPasswordFn: async () => {
      hashCalls += 1;
      return Buffer.alloc(SCRYPT_PARAMS.keylen, 0x5a);
    },
  });

  assert.equal(hashCalls, 2);
  assert.ok(store.findUser("known-user").passwordHash instanceof Buffer);
  assert.ok(store.dummyHash instanceof Buffer);
});

test("fixed policy performs exactly one scrypt call for existing and missing users", async () => {
  const fake = countingScrypt();
  const authenticate = createDemoAuthenticator({
    scryptFn: fake.scryptFn,
    userStore,
  });

  await authenticate({ password: "wrong-password", username: "known-user" });
  assert.equal(fake.calls.length, 1);
  await authenticate({ password: "wrong-password", username: "missing-user" });
  assert.equal(fake.calls.length, 2);
});

test("vulnerable policy hashes existing users but skips missing users", async () => {
  const fake = countingScrypt();
  const authenticate = createDemoAuthenticator({
    skipMissingUserHash: true,
    scryptFn: fake.scryptFn,
    userStore,
  });

  await authenticate({ password: "wrong-password", username: "known-user" });
  assert.equal(fake.calls.length, 1);
  await authenticate({ password: "wrong-password", username: "missing-user" });
  assert.equal(fake.calls.length, 1);
});

test("hash comparison result is not reflected in the success response", async () => {
  let compareCalls = 0;
  const fake = countingScrypt();
  const authenticate = createDemoAuthenticator({
    scryptFn: fake.scryptFn,
    timingSafeEqualFn: () => {
      compareCalls += 1;
      return false;
    },
    userStore,
  });

  const response = await authenticate({ password: "wrong-password", username: "known-user" });

  assert.equal(compareCalls, 1);
  assert.equal(response.statusCode, LOGIN_SUCCESS_STATUS);
});

test("invalid input returns one fixed 400 body without echoing input", async () => {
  const fake = countingScrypt();
  const authenticate = createDemoAuthenticator({
    scryptFn: fake.scryptFn,
    userStore,
  });
  const invalidInputs = [
    null,
    {},
    { password: "password", username: "known-user", extra: "secret-to-hide" },
    { password: "", username: "known-user" },
    { password: "password", username: "" },
  ];

  for (const input of invalidInputs) {
    const response = await authenticate(input);
    assert.deepEqual(response, { body: LOGIN_INVALID_BODY, statusCode: LOGIN_INVALID_STATUS });
    assert.doesNotMatch(response.body, /secret-to-hide|known-user|password/);
  }
  assert.equal(fake.calls.length, 0);
});

test("auth helper contains no synchronous scrypt, sleep, or unseeded random work", async () => {
  const source = await readFile(new URL("../src/demos/auth.js", import.meta.url), "utf8");

  assert.match(source, /promisify\(scrypt\)/);
  assert.match(source, /timingSafeEqual/);
  assert.doesNotMatch(source, /scryptSync|sleep\(|Math\.random/);
});
