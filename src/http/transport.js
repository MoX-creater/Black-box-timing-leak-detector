import { request as undiciRequest } from "undici";

import { createMonotonicClock } from "../clock.js";

const SAFE_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ENOTFOUND",
]);

function safeErrorCode(error) {
  const code = typeof error?.code === "string" ? error.code : "";
  if (code.startsWith("UND_ERR_") || SAFE_ERROR_CODES.has(code)) {
    return code;
  }
  return "UNKNOWN";
}

function validateTimeout(timeoutMs) {
  if (timeoutMs === undefined) {
    return;
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("timeoutMs must be a positive safe integer");
  }
}

function validateExpectedStatus(expectedStatus) {
  if (expectedStatus === undefined) {
    return;
  }
  if (!Number.isInteger(expectedStatus) || expectedStatus < 100 || expectedStatus > 599) {
    throw new TypeError("expectedStatus must be an HTTP status code");
  }
}

function validateRequest(request) {
  if (!request || typeof request !== "object" || typeof request.url !== "string") {
    throw new TypeError("request with a URL is required");
  }
}

async function consumeBody(body) {
  if (!body) {
    return;
  }
  if (typeof body.dump === "function") {
    await body.dump();
    return;
  }
  if (typeof body[Symbol.asyncIterator] === "function") {
    for await (const _chunk of body) {
      // Fully consume the body before taking the end timestamp.
    }
  }
}

function statusResult(statusCode, expectedStatus, durationMs) {
  if (statusCode >= 300 && statusCode < 400) {
    return { kind: "discarded", reason: "unexpected-status", statusCode };
  }
  if (expectedStatus !== undefined && statusCode !== expectedStatus) {
    return { kind: "discarded", reason: "status-mismatch", statusCode };
  }
  if (statusCode < 200 || statusCode >= 300) {
    return { kind: "discarded", reason: "unexpected-status", statusCode };
  }
  return { durationMs, kind: "accepted", statusCode };
}

function errorResult(error) {
  const reason = typeof error?.code === "string" && error.code.startsWith("UND_ERR_")
    && error.code.includes("TIMEOUT")
    ? "timeout"
    : error?.name === "TimeoutError"
      ? "timeout"
      : "error";
  return { errorCode: safeErrorCode(error), kind: "discarded", reason };
}

function requestOptions(request, dispatcher, timeoutMs) {
  const options = {
    body: request.body,
    headers: request.headers,
    method: request.method,
  };
  if (dispatcher !== undefined) {
    options.dispatcher = dispatcher;
  }
  if (timeoutMs !== undefined) {
    options.bodyTimeout = timeoutMs;
    options.headersTimeout = timeoutMs;
  }
  return options;
}

/**
 * Send one request with undici.request. Direct undici.request does not follow
 * redirects; 3xx responses are classified as discarded unexpected statuses.
 */
export async function sendHttpRequest(request, {
  clock = createMonotonicClock(),
  dispatcher,
  expectedStatus,
  requestFn = undiciRequest,
  timeoutMs,
} = {}) {
  validateRequest(request);
  validateExpectedStatus(expectedStatus);
  validateTimeout(timeoutMs);
  if (typeof requestFn !== "function") {
    throw new TypeError("requestFn must be a function");
  }
  if (!clock || typeof clock.now !== "function" || typeof clock.elapsedMilliseconds !== "function") {
    throw new TypeError("clock must provide now and elapsedMilliseconds");
  }

  const start = clock.now();
  try {
    const response = await requestFn(request.url, requestOptions(request, dispatcher, timeoutMs));
    await consumeBody(response.body);
    const end = clock.now();
    return statusResult(response.statusCode, expectedStatus, clock.elapsedMilliseconds(start, end));
  } catch (error) {
    return errorResult(error);
  }
}

/** Create a reusable transport that shares one injected dispatcher across calls. */
export function createHttpTransport({
  clock = createMonotonicClock(),
  dispatcher,
  requestFn = undiciRequest,
  timeoutMs,
} = {}) {
  validateTimeout(timeoutMs);
  return {
    send: (request, options = {}) => sendHttpRequest(request, {
      clock,
      dispatcher: options.dispatcher ?? dispatcher,
      expectedStatus: options.expectedStatus,
      requestFn,
      timeoutMs: options.timeoutMs ?? timeoutMs,
    }),
  };
}
