import test from "node:test";
import assert from "node:assert/strict";

import { buildRequests } from "../src/http/request.js";

function baseConfig(overrides = {}) {
  return {
    method: "post",
    headers: {
      Accept: "application/json",
      "X-Trace": "same",
    },
    cookies: {
      session: "secret-cookie",
    },
    a: {
      url: "https://authorized.example.test/login",
      body: {
        type: "json",
        value: { username: "known", password: "short" },
      },
    },
    b: {
      url: "https://authorized.example.test/login",
      body: {
        type: "json",
        value: { username: "missing", password: "short" },
      },
    },
    ...overrides,
  };
}

test("builds distinct A/B JSON requests with normalized headers and hostname", () => {
  const result = buildRequests(baseConfig());

  assert.equal(result.a.method, "POST");
  assert.equal(result.a.hostname, "authorized.example.test");
  assert.equal(result.a.path, "/login");
  assert.equal(result.a.headers.accept, "application/json");
  assert.equal(result.a.headers["x-trace"], "same");
  assert.equal(result.a.headers["content-type"], "application/json");
  assert.equal(result.a.headers.cookie, "session=secret-cookie");
  assert.notEqual(result.a.body, result.b.body);
  assert.deepEqual(result.warnings, []);
});

test("serializes form bodies and auto-sets content type", () => {
  const config = baseConfig({
    headers: { Accept: "application/json" },
    a: {
      url: "https://authorized.example.test/login",
      body: { type: "form", value: { username: "known", password: "short" } },
    },
    b: {
      url: "https://authorized.example.test/login",
      body: { type: "form", value: { username: "missing", password: "short" } },
    },
  });
  const result = buildRequests(config);

  assert.equal(result.a.body, "username=known&password=short");
  assert.equal(result.b.body, "username=missing&password=short");
  assert.equal(result.a.headers["content-type"], "application/x-www-form-urlencoded");
});

test("explicit content type overrides the automatic content type", () => {
  const result = buildRequests(baseConfig({
    headers: { "Content-Type": "application/custom" },
  }));
  assert.equal(result.a.headers["content-type"], "application/custom");
});

test("applies method, repeatable header, and cookie overrides", () => {
  const result = buildRequests(baseConfig(), {
    method: "POST",
    headers: ["X-Run: one", "X-Other: two"],
    cookies: ["run=one"],
  });

  assert.equal(result.a.method, "POST");
  assert.equal(result.a.headers["x-run"], "one");
  assert.equal(result.a.headers["x-other"], "two");
  assert.equal(result.a.headers.cookie, "session=secret-cookie; run=one");
});

test("rejects A/B differences in method, body type, headers, and URL path", () => {
  const cases = [
    ["method", baseConfig({ a: { ...baseConfig().a, method: "GET" } })],
    ["body type", baseConfig({
      b: { ...baseConfig().b, body: { type: "form", value: { username: "missing", password: "short" } } },
    })],
    ["headers", baseConfig({
      a: { ...baseConfig().a, headers: { "X-Only-A": "1" } },
      b: { ...baseConfig().b, headers: { "X-Only-B": "1" } },
    })],
    ["URL path", baseConfig({
      b: { ...baseConfig().b, url: "https://authorized.example.test/reset" },
    })],
    ["body fields", baseConfig({
      b: { ...baseConfig().b, body: { type: "json", value: { username: "missing", token: "short" } } },
    })],
  ];

  for (const [label, config] of cases) {
    assert.throws(() => buildRequests(config), /A and B/, label);
  }
});

test("returns a warning instead of throwing for a body length difference over 8 bytes", () => {
  const result = buildRequests(baseConfig({
    a: {
      ...baseConfig().a,
      body: { type: "json", value: { username: "known-user-with-a-long-name", password: "short" } },
    },
    b: {
      ...baseConfig().b,
      body: { type: "json", value: { username: "x", password: "short" } },
    },
  }));

  assert.equal(result.warnings.length, 1);
  assert.equal(result.warnings[0].code, "BODY_LENGTH_DIFFERENCE");
  assert.match(result.warnings[0].message, /more than 8 bytes/);
});

test("rejects normalized duplicate headers and CR/LF header input", () => {
  assert.throws(
    () => buildRequests(baseConfig({ headers: { Trace: "one", trace: "two" } })),
    /duplicate header name/,
  );
  assert.throws(
    () => buildRequests(baseConfig({ headers: { "X-Bad\nName": "value" } })),
    /header name is invalid/,
  );
  assert.throws(
    () => buildRequests(baseConfig({ headers: { "X-Bad": "value\r\nnext" } })),
    /header value is invalid/,
  );
});

test("does not include cookie or body values in validation errors", () => {
  const cookieSecret = "cookie-secret-do-not-leak";
  const bodySecret = "body-secret-do-not-leak";
  assert.throws(
    () => buildRequests(baseConfig({
      cookies: { session: `${cookieSecret}\ninvalid` },
      a: {
        ...baseConfig().a,
        body: { type: "json", value: { username: bodySecret, password: "short" } },
      },
    })),
    (error) => !error.message.includes(cookieSecret) && !error.message.includes(bodySecret),
  );
  assert.throws(
    () => buildRequests(baseConfig({
      a: { ...baseConfig().a, body: { type: "unsupported", value: { secret: bodySecret } } },
    })),
    (error) => !error.message.includes(bodySecret),
  );
});
