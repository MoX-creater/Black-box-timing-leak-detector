import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

import { Agent } from "undici";

import { createMonotonicClock } from "../src/clock.js";
import { createHttpTransport, sendHttpRequest } from "../src/http/transport.js";

function requestFixture(url = "http://127.0.0.1:3000/login") {
  return {
    body: "request-body",
    headers: { "content-type": "text/plain" },
    method: "POST",
    url,
  };
}

function fakeClock(readings, events = []) {
  let index = 0;
  return createMonotonicClock({
    now: () => {
      events.push("clock");
      return readings[index++];
    },
  });
}

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}

async function close(server) {
  if (server.listening) {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test("uses a shared dispatcher, consumes the body, and measures monotonic duration", async () => {
  const events = [];
  const dispatcher = { name: "shared-agent" };
  const clock = fakeClock([10_000_000n, 12_500_000n], events);
  let receivedOptions;
  const result = await sendHttpRequest(requestFixture(), {
    clock,
    dispatcher,
    requestFn: async (_url, options) => {
      receivedOptions = options;
      return {
        statusCode: 200,
        body: {
          async *[Symbol.asyncIterator]() {
            events.push("body-start");
            yield Buffer.from("response");
            events.push("body-end");
          },
        },
      };
    },
  });

  assert.deepEqual(result, { durationMs: 2.5, kind: "accepted", statusCode: 200 });
  assert.equal(receivedOptions.dispatcher, dispatcher);
  assert.equal("maxRedirections" in receivedOptions, false);
  assert.deepEqual(events, ["clock", "body-start", "body-end", "clock"]);
});

test("passes a timeout configuration to the transport", async () => {
  let receivedOptions;
  const result = await sendHttpRequest(requestFixture(), {
    clock: fakeClock([1n, 2n]),
    requestFn: async (_url, options) => {
      receivedOptions = options;
      throw Object.assign(new Error("private timeout detail"), { code: "UND_ERR_HEADERS_TIMEOUT" });
    },
    timeoutMs: 25,
  });

  assert.deepEqual(result, {
    errorCode: "UND_ERR_HEADERS_TIMEOUT",
    kind: "discarded",
    reason: "timeout",
  });
  assert.equal(receivedOptions.headersTimeout, 25);
  assert.equal(receivedOptions.bodyTimeout, 25);
  assert.equal("durationMs" in result, false);
  assert.equal(JSON.stringify(result).includes("private timeout detail"), false);
});

test("classifies status outcomes with one consistent discarded result shape", async () => {
  const run = (statusCode, expectedStatus) => sendHttpRequest(requestFixture(), {
    clock: fakeClock([1n, 2n]),
    expectedStatus,
    requestFn: async () => ({ statusCode, body: undefined }),
  });

  const accepted = await run(200, 200);
  const mismatch = await run(401, 200);
  const unexpected = await run(500);

  assert.deepEqual(accepted, { durationMs: 0.000001, kind: "accepted", statusCode: 200 });
  assert.deepEqual(mismatch, { kind: "discarded", reason: "status-mismatch", statusCode: 401 });
  assert.deepEqual(unexpected, { kind: "discarded", reason: "unexpected-status", statusCode: 500 });
  for (const result of [mismatch, unexpected]) {
    assert.equal("durationMs" in result, false);
  }
});

test("whitelists error codes and omits error messages", async () => {
  const known = await sendHttpRequest(requestFixture(), {
    requestFn: async () => {
      throw Object.assign(new Error("sensitive known detail"), { code: "ECONNRESET" });
    },
  });
  const unknown = await sendHttpRequest(requestFixture(), {
    requestFn: async () => {
      throw Object.assign(new Error("sensitive unknown detail"), { code: "SECRET_CODE" });
    },
  });

  assert.deepEqual(known, { errorCode: "ECONNRESET", kind: "discarded", reason: "error" });
  assert.deepEqual(unknown, { errorCode: "UNKNOWN", kind: "discarded", reason: "error" });
  assert.equal(JSON.stringify(known).includes("sensitive known detail"), false);
  assert.equal(JSON.stringify(unknown).includes("sensitive unknown detail"), false);
  assert.equal("durationMs" in known, false);
  assert.equal("durationMs" in unknown, false);
});

test("returns a local 302 as unexpected-status without making a second request", async () => {
  let requestCount = 0;
  const server = createServer((_request, response) => {
    requestCount += 1;
    response.writeHead(302, { location: "https://external.example/redirect-target" });
    response.end("redirect");
  });
  const dispatcher = new Agent({ keepAliveTimeout: 1_000, keepAliveMaxTimeout: 1_000 });

  try {
    const origin = await listen(server);
    const transport = createHttpTransport({ dispatcher });
    const result = await transport.send(requestFixture(`${origin}/start`));

    assert.deepEqual(result, {
      kind: "discarded",
      reason: "unexpected-status",
      statusCode: 302,
    });
    assert.equal(requestCount, 1);
    assert.equal("durationMs" in result, false);
  } finally {
    await dispatcher.close();
    await close(server);
  }
});
