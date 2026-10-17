import { request as undiciRequest } from "undici";

const LOOPBACK_IPV4_PATTERN = /^(?:127\.)\d{1,3}\.\d{1,3}\.\d{1,3}$/;
const AUTHORIZATION_WARNING = "WARNING: external target requests require your authorization.";

export class AuthorizationError extends Error {
  constructor(message) {
    super(message);
    this.name = "AuthorizationError";
    this.code = "AUTHORIZATION_REQUIRED";
  }
}

function parseTargetUrl(request, label) {
  if (!request || typeof request.url !== "string") {
    throw new TypeError(`${label} request URL is required`);
  }
  try {
    return new URL(request.url);
  } catch {
    throw new TypeError(`${label} request URL is invalid`);
  }
}

function isLoopbackIpv4(hostname) {
  if (!LOOPBACK_IPV4_PATTERN.test(hostname)) {
    return false;
  }
  return hostname.split(".").every((part) => Number(part) >= 0 && Number(part) <= 255);
}

export function isLocalTargetHostname(hostname) {
  const unbracketedHostname = hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
  return unbracketedHostname === "localhost"
    || unbracketedHostname === "::1"
    || isLoopbackIpv4(unbracketedHostname);
}

function targetInfo(request, label) {
  const url = parseTargetUrl(request, label);
  return { external: !isLocalTargetHostname(url.hostname), url };
}

export function authorizeRequestPair(pair, {
  iAmAuthorized = false,
  warn = (message) => console.error(message),
} = {}) {
  if (!pair || !pair.a || !pair.b) {
    throw new TypeError("A and B requests are required");
  }
  if (typeof warn !== "function") {
    throw new TypeError("warn must be a function");
  }

  const targets = [
    targetInfo(pair.a, "A"),
    targetInfo(pair.b, "B"),
  ];
  const hasExternalTarget = targets.some((target) => target.external);
  if (hasExternalTarget && !iAmAuthorized) {
    throw new AuthorizationError("non-localhost targets require --i-am-authorized");
  }
  if (hasExternalTarget) {
    warn(AUTHORIZATION_WARNING);
  }
  return targets;
}

async function defaultTransport(request, options) {
  const response = await undiciRequest(request.url, {
    body: request.body,
    headers: request.headers,
    maxRedirections: 0,
    method: request.method,
    ...options,
  });
  return { body: response.body, headers: response.headers, statusCode: response.statusCode };
}

async function consumeBody(response) {
  if (!response?.body) {
    return;
  }
  if (typeof response.body.dump === "function") {
    await response.body.dump();
    return;
  }
  if (typeof response.body[Symbol.asyncIterator] === "function") {
    for await (const _chunk of response.body) {
      // Consume the body so the connection can be reused or closed cleanly.
    }
  }
}

function responseStatus(response) {
  const statusCode = response?.statusCode ?? response?.status;
  if (!Number.isInteger(statusCode)) {
    throw new TypeError("transport response status is invalid");
  }
  return statusCode;
}

/**
 * Authorize both requests, then send them sequentially without following
 * redirects. A 3xx response is returned as a discarded sample.
 */
export async function runAuthorizedRequests(pair, options = {}) {
  const targets = authorizeRequestPair(pair, options);
  const transport = options.transport ?? defaultTransport;
  if (typeof transport !== "function") {
    throw new TypeError("transport must be a function");
  }

  const requests = [pair.a, pair.b];
  const results = [];
  for (const [index, request] of requests.entries()) {
    const response = await transport(request, { maxRedirections: 0 });
    const statusCode = responseStatus(response);
    await consumeBody(response);
    results.push({
      discarded: statusCode >= 300 && statusCode < 400,
      discardReason: statusCode >= 300 && statusCode < 400 ? "redirect" : undefined,
      label: index === 0 ? "A" : "B",
      statusCode,
    });
  }

  return {
    externalTargets: targets.filter((target) => target.external).length,
    results,
    warnings: targets.some((target) => target.external) ? [AUTHORIZATION_WARNING] : [],
  };
}
