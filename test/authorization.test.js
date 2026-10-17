import test from "node:test";
import assert from "node:assert/strict";

import {
  AuthorizationError,
  isLocalTargetHostname,
  runAuthorizedRequests,
} from "../src/cli/authorization.js";
import { redactRequestMetadata } from "../src/report/redact.js";

function requestPair(aUrl = "http://localhost:3000/login", bUrl = aUrl) {
  return {
    a: { body: "a-body-secret", headers: { cookie: "a-cookie-secret" }, method: "POST", url: aUrl },
    b: { body: "b-body-secret", headers: { cookie: "b-cookie-secret" }, method: "POST", url: bUrl },
  };
}

test("recognizes only exact localhost, 127/8, and ::1 hostnames as local", () => {
  assert.equal(isLocalTargetHostname("localhost"), true);
  assert.equal(isLocalTargetHostname("127.0.0.1"), true);
  assert.equal(isLocalTargetHostname("127.255.255.255"), true);
  assert.equal(isLocalTargetHostname("::1"), true);
  assert.equal(isLocalTargetHostname("localhost.evil.com"), false);
  assert.equal(isLocalTargetHostname("127.0.0.1.evil.com"), false);
  assert.equal(isLocalTargetHostname("evil.com"), false);
  assert.equal(isLocalTargetHostname("0.0.0.0"), false);
});

test("parses URLs so userinfo and hostname suffixes remain external", async () => {
  const calls = [];
  const transport = async (request) => {
    calls.push(request);
    return { statusCode: 200 };
  };
  for (const url of [
    "http://localhost.evil.com/login",
    "http://127.0.0.1.evil.com/login",
    "http://localhost@evil.com/login",
    "http://0.0.0.0/login",
  ]) {
    await assert.rejects(
      runAuthorizedRequests(requestPair(url), { transport }),
      AuthorizationError,
    );
  }
  assert.equal(calls.length, 0);
});

test("gates both A and B URLs when only B is external", async () => {
  const calls = [];
  const transport = async (request) => {
    calls.push(request.url);
    return { statusCode: 200 };
  };

  await assert.rejects(
    runAuthorizedRequests(requestPair("http://localhost:3000/login", "https://evil.example/login"), { transport }),
    AuthorizationError,
  );
  assert.equal(calls.length, 0);
});

test("emits exactly one warning before the first authorized request", async () => {
  const events = [];
  const result = await runAuthorizedRequests(
    requestPair("http://localhost:3000/login", "https://authorized.example/login"),
    {
      iAmAuthorized: true,
      transport: async (request, options) => {
        events.push(["request", request.url, options.maxRedirections]);
        return { statusCode: 200 };
      },
      warn: (message) => events.push(["warning", message]),
    },
  );

  assert.equal(events.filter(([type]) => type === "warning").length, 1);
  assert.equal(events[0][0], "warning");
  assert.deepEqual(events.filter(([type]) => type === "request").map((event) => event[2]), [0, 0]);
  assert.equal(result.warnings.length, 1);
});

test("does not warn or require authorization for local pairs", async () => {
  let warningCount = 0;
  let requestCount = 0;
  const result = await runAuthorizedRequests(requestPair("http://127.0.0.1:3000/login"), {
    transport: async () => {
      requestCount += 1;
      return { statusCode: 200 };
    },
    warn: () => {
      warningCount += 1;
    },
  });

  assert.equal(requestCount, 2);
  assert.equal(warningCount, 0);
  assert.deepEqual(result.warnings, []);
});

test("does not follow redirects and marks 3xx responses discarded", async () => {
  const calls = [];
  const result = await runAuthorizedRequests(requestPair(), {
    transport: async (request, options) => {
      calls.push({ request, options });
      return {
        headers: { location: "https://external.example/secret" },
        statusCode: 302,
      };
    },
  });

  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map(({ options }) => options.maxRedirections), [0, 0]);
  assert.equal(result.results[0].discarded, true);
  assert.equal(result.results[0].discardReason, "redirect");
  assert.equal(result.results[1].discarded, true);
});

test("redaction uses only safe fields and strips query and URL credentials", () => {
  const metadata = redactRequestMetadata({
    body: "body-secret",
    extra: "drop-me",
    headers: { Cookie: "cookie-secret", "X-Test": "header-secret" },
    method: "POST",
    url: "https://user:password@authorized.example/login?secret=query",
  });
  assert.deepEqual(metadata, {
    bodyBytes: 11,
    headerNames: ["cookie", "x-test"],
    hostname: "authorized.example",
    method: "POST",
    path: "/login",
  });
  const serialized = JSON.stringify(metadata);
  for (const secret of ["body-secret", "cookie-secret", "header-secret", "password", "secret=query", "?secret"]) {
    assert.equal(serialized.includes(secret), false);
  }
  assert.deepEqual(Object.keys(metadata).sort(), ["bodyBytes", "headerNames", "hostname", "method", "path"]);
});

test("redaction errors do not include URL query or credential values", () => {
  assert.throws(
    () => redactRequestMetadata({ url: "not a URL?body-secret" }),
    (error) => !error.message.includes("body-secret"),
  );
  assert.throws(
    () => redactRequestMetadata({ url: "https://user:cookie-secret@" }),
    (error) => !error.message.includes("cookie-secret"),
  );
});
