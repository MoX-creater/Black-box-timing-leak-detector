const BODY_LENGTH_WARNING_THRESHOLD = 8;
const FORM_BODY_TYPES = new Set(["string", "number", "boolean"]);
const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const METHOD_PATTERN = /^[A-Z]+$/;

function requestError(message) {
  return new TypeError(message);
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function normalizeMethod(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw requestError(`${label} method is required`);
  }
  const method = value.toUpperCase();
  if (!METHOD_PATTERN.test(method)) {
    throw requestError(`${label} method is invalid`);
  }
  return method;
}

function normalizeUrl(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw requestError(`${label} URL is required`);
  }
  try {
    const url = new URL(value);
    if (!url.hostname) {
      throw new Error("hostname missing");
    }
    return url;
  } catch {
    throw requestError(`${label} URL is invalid`);
  }
}

function normalizeHeaderName(name, label) {
  if (typeof name !== "string" || name.length === 0) {
    throw requestError(`${label} header name is invalid`);
  }
  if (/\r|\n/.test(name) || !HEADER_NAME_PATTERN.test(name)) {
    throw requestError(`${label} header name is invalid`);
  }
  return name.toLowerCase();
}

function normalizeHeaderValue(value, label) {
  if (typeof value !== "string") {
    throw requestError(`${label} header value is invalid`);
  }
  if (/\r|\n/.test(value)) {
    throw requestError(`${label} header value is invalid`);
  }
  return value;
}

function parseHeaderString(value, label) {
  if (typeof value !== "string") {
    throw requestError(`${label} header entry is invalid`);
  }
  const separator = value.indexOf(":");
  if (separator <= 0) {
    throw requestError(`${label} header entry is invalid`);
  }
  return {
    name: value.slice(0, separator).trim(),
    value: value.slice(separator + 1).trim(),
  };
}

function headerEntries(value, label) {
  if (value === undefined || value === null) {
    return [];
  }
  if (isPlainObject(value)) {
    return Object.entries(value).map(([name, headerValue]) => ({ name, value: headerValue }));
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) => {
      if (typeof entry === "string") {
        return parseHeaderString(entry, `${label}[${index}]`);
      }
      if (Array.isArray(entry) && entry.length === 2) {
        return { name: entry[0], value: entry[1] };
      }
      if (isPlainObject(entry) && "name" in entry && "value" in entry) {
        return { name: entry.name, value: entry.value };
      }
      throw requestError(`${label}[${index}] header entry is invalid`);
    });
  }
  throw requestError(`${label} headers are invalid`);
}

function normalizeHeaders(value, label) {
  const headers = new Map();
  for (const [index, entry] of headerEntries(value, label).entries()) {
    const name = normalizeHeaderName(entry.name, `${label}[${index}]`);
    if (headers.has(name)) {
      throw requestError(`${label} contains duplicate header name: ${name}`);
    }
    headers.set(name, normalizeHeaderValue(entry.value, `${label}[${index}]`));
  }
  return headers;
}

function mergeHeaders(...sets) {
  const merged = new Map();
  for (const set of sets) {
    for (const [name, value] of set) {
      merged.set(name, value);
    }
  }
  return merged;
}

function headersMatch(left, right) {
  if (left.size !== right.size) {
    return false;
  }
  for (const [name, value] of left) {
    if (right.get(name) !== value) {
      return false;
    }
  }
  return true;
}

function headersObject(headers) {
  return Object.fromEntries(headers);
}

function cookieEntries(value, label) {
  if (value === undefined || value === null) {
    return [];
  }
  if (isPlainObject(value)) {
    return Object.entries(value).map(([name, cookieValue]) => ({ name, value: cookieValue }));
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) => {
      if (typeof entry !== "string") {
        throw requestError(`${label}[${index}] cookie entry is invalid`);
      }
      const separator = entry.indexOf("=");
      if (separator <= 0) {
        throw requestError(`${label}[${index}] cookie entry is invalid`);
      }
      return {
        name: entry.slice(0, separator).trim(),
        value: entry.slice(separator + 1),
      };
    });
  }
  throw requestError(`${label} cookies are invalid`);
}

function normalizeCookies(value, label) {
  const cookies = new Map();
  for (const [index, entry] of cookieEntries(value, label).entries()) {
    if (typeof entry.name !== "string" || entry.name.length === 0 || /[=;\r\n]/.test(entry.name)) {
      throw requestError(`${label}[${index}] cookie name is invalid`);
    }
    if (typeof entry.value !== "string" || /[;\r\n]/.test(entry.value)) {
      throw requestError(`${label}[${index}] cookie value is invalid`);
    }
    if (cookies.has(entry.name)) {
      throw requestError(`${label} contains duplicate cookie name: ${entry.name}`);
    }
    cookies.set(entry.name, entry.value);
  }
  return cookies;
}

function formatCookies(cookies) {
  if (cookies.size === 0) {
    return undefined;
  }
  return [...cookies].map(([name, value]) => `${name}=${value}`).join("; ");
}

function sameBodyShape(left, right) {
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false;
    }
    return left.every((value, index) => sameBodyShape(value, right[index]));
  }
  if (isPlainObject(left) || isPlainObject(right)) {
    if (!isPlainObject(left) || !isPlainObject(right)) {
      return false;
    }
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return leftKeys.length === rightKeys.length
      && leftKeys.every((key, index) => key === rightKeys[index]
        && sameBodyShape(left[key], right[key]));
  }
  return true;
}

function normalizeBody(value, label) {
  if (value === undefined || value === null) {
    return { type: "none", value: undefined };
  }
  if (!isPlainObject(value) || !["json", "form"].includes(value.type)) {
    throw requestError(`${label} body type is invalid`);
  }
  if (!isPlainObject(value.value)) {
    throw requestError(`${label} body fields are invalid`);
  }
  if (value.type === "form") {
    for (const fieldValue of Object.values(value.value)) {
      if (!FORM_BODY_TYPES.has(typeof fieldValue)) {
        throw requestError(`${label} form body fields are invalid`);
      }
    }
  }
  return { type: value.type, value: value.value };
}

function serializeBody(body, label) {
  if (body.type === "none") {
    return { bytes: 0, content: undefined };
  }
  try {
    const content = body.type === "json"
      ? JSON.stringify(body.value)
      : new URLSearchParams(Object.entries(body.value)).toString();
    if (content === undefined) {
      throw new Error("body serialization returned no content");
    }
    return { bytes: Buffer.byteLength(content, "utf8"), content };
  } catch {
    throw requestError(`${label} body could not be serialized`);
  }
}

function bodyContentType(type) {
  if (type === "json") {
    return "application/json";
  }
  if (type === "form") {
    return "application/x-www-form-urlencoded";
  }
  return undefined;
}

function resolveBody(template, override, label) {
  return normalizeBody(override === undefined ? template.body : override, label);
}

function resolveMethod(config, overrides, a, b) {
  const common = overrides.method ?? config.method;
  const aMethod = normalizeMethod(a.method ?? common, "A");
  const bMethod = normalizeMethod(b.method ?? common, "B");
  if (aMethod !== bMethod) {
    throw requestError("A and B methods must match");
  }
  return aMethod;
}

function resolveTemplateHeaders(config, overrides, template, label) {
  return mergeHeaders(
    normalizeHeaders(config.headers, "common"),
    normalizeHeaders(template.headers, label),
    normalizeHeaders(overrides.headers, "overrides"),
  );
}

function buildRequest({ template, label, method, explicitHeaders, cookies, body, url, bodyData }) {
  const contentType = bodyContentType(body.type);
  const headers = new Map(explicitHeaders);
  if (contentType !== undefined && !headers.has("content-type")) {
    headers.set("content-type", contentType);
  }
  if (cookies.size > 0) {
    headers.set("cookie", formatCookies(cookies));
  }
  return {
    body: bodyData.content,
    headers: headersObject(headers),
    hostname: url.hostname,
    method,
    path: `${url.pathname}${url.search}`,
    url: url.toString(),
    template: label,
  };
}

/**
 * Build paired requests. A and B must share method, body shape/type, explicit
 * headers, and URL path; only body field values may differ.
 */
export function buildRequests(config, overrides = {}) {
  if (!isPlainObject(config) || !isPlainObject(config.a) || !isPlainObject(config.b)) {
    throw requestError("A and B request templates are required");
  }
  if (!isPlainObject(overrides)) {
    throw requestError("request overrides are invalid");
  }

  const a = config.a;
  const b = config.b;
  const method = resolveMethod(config, overrides, a, b);
  const aUrl = normalizeUrl(a.url, "A");
  const bUrl = normalizeUrl(b.url, "B");
  const aPath = `${aUrl.pathname}${aUrl.search}`;
  const bPath = `${bUrl.pathname}${bUrl.search}`;
  if (aPath !== bPath) {
    throw requestError("A and B URL paths must match");
  }

  const aBody = resolveBody(a, overrides.body, "A");
  const bBody = resolveBody(b, overrides.body, "B");
  if (aBody.type !== bBody.type || !sameBodyShape(aBody.value, bBody.value)) {
    throw requestError("A and B body type and fields must match");
  }

  const aHeaders = resolveTemplateHeaders(config, overrides, a, "A");
  const bHeaders = resolveTemplateHeaders(config, overrides, b, "B");
  if (!headersMatch(aHeaders, bHeaders)) {
    throw requestError("A and B headers must match");
  }

  const cookies = mergeHeaders(
    normalizeCookies(config.cookies, "common"),
    normalizeCookies(overrides.cookies, "overrides"),
  );
  const aBodyData = serializeBody(aBody, "A");
  const bBodyData = serializeBody(bBody, "B");
  const warnings = [];
  const bodyLengthDifference = Math.abs(aBodyData.bytes - bBodyData.bytes);
  if (bodyLengthDifference > BODY_LENGTH_WARNING_THRESHOLD) {
    warnings.push({
      code: "BODY_LENGTH_DIFFERENCE",
      differenceBytes: bodyLengthDifference,
      message: "A and B body byte lengths differ by more than 8 bytes",
    });
  }

  return {
    a: buildRequest({
      body: aBody,
      bodyData: aBodyData,
      cookies,
      explicitHeaders: aHeaders,
      label: "A",
      method,
      template: a,
      url: aUrl,
    }),
    b: buildRequest({
      body: bBody,
      bodyData: bBodyData,
      cookies,
      explicitHeaders: bHeaders,
      label: "B",
      method,
      template: b,
      url: bUrl,
    }),
    warnings,
  };
}
