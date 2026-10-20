import assert from "node:assert/strict";
import { once } from "node:events";
import net from "node:net";
import test from "node:test";

import { createWebApp } from "../src/server/app.js";

async function startTestServer() {
  const app = createWebApp();
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return { app, port: address.port, server };
}

async function closeTestServer({ app, server }) {
  await app.locals.runManager.shutdown();
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function postScan(port, body, headers) {
  const response = await fetch(`http://127.0.0.1:${port}/api/scans`, {
    body,
    headers,
    method: "POST",
  });
  return { body: await response.text(), status: response.status };
}

function rawRequest(port, requestText) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port }, () => {
      socket.write(Buffer.from(requestText, "ascii"));
    });
    let responseText = "";
    socket.on("data", (chunk) => {
      responseText += chunk.toString();
    });
    socket.on("end", () => resolve(responseText));
    socket.on("error", reject);
  });
}

function parseRawResponse(responseText) {
  const separator = responseText.indexOf("\r\n\r\n");
  assert.notEqual(separator, -1);
  const headerText = responseText.slice(0, separator);
  const body = responseText.slice(separator + 4);
  const status = Number(headerText.match(/^HTTP\/1\.1 (\d+)/)?.[1]);
  return { body, status };
}

test("malformed, oversized, wrong-type, and malformed-path errors are fixed and sanitized", async () => {
  const server = await startTestServer();
  try {
    const cases = [
      {
        expected: {
          body: JSON.stringify({
            error: { code: "invalid-json", message: "Request body must contain valid JSON" },
          }),
          status: 400,
        },
        name: "malformed JSON",
        result: await postScan(server.port, "{", { "content-type": "application/json" }),
      },
      {
        expected: {
          body: JSON.stringify({
            error: { code: "body-too-large", message: "Request body is too large" },
          }),
          status: 413,
        },
        name: "oversized body",
        result: await postScan(
          server.port,
          JSON.stringify({ filler: "x".repeat(2_000) }),
          { "content-type": "application/json" },
        ),
      },
      {
        expected: {
          body: JSON.stringify({
            error: { code: "invalid-scan-request", message: "Scan request is invalid" },
          }),
          status: 400,
        },
        name: "wrong content type",
        result: await postScan(server.port, "{}", { "content-type": "text/plain" }),
      },
    ];

    for (const { expected, name, result } of cases) {
      assert.deepEqual(result, expected, name);
      assert.doesNotMatch(result.body, /(?:Error|Error:|at |[A-Z]:\\|\/Users\/|\/home\/)/, name);
    }
  } finally {
    await closeTestServer(server);
  }
});

test("malformed percent paths return a fixed sanitized response", async () => {
  const server = await startTestServer();
  try {
    const result = parseRawResponse(await rawRequest(
      server.port,
      "GET /% HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
    ));
    assert.deepEqual(result, {
      body: JSON.stringify({ error: { code: "not-found", message: "Not found" } }),
      status: 404,
    });
    assert.doesNotMatch(result.body, /(?:Error|Error:|at |[A-Z]:\\|\/Users\/|\/home\/)/);
  } finally {
    await closeTestServer(server);
  }
});
