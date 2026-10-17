const SAFE_FIELDS = ["bodyBytes", "headerNames", "hostname", "method", "path"];

function parseUrl(value) {
  if (typeof value !== "string") {
    throw new TypeError("request URL is required");
  }
  try {
    return new URL(value);
  } catch {
    throw new TypeError("request URL is invalid");
  }
}

function headerNames(value) {
  if (value === undefined || value === null) {
    return [];
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) => {
      if (typeof entry === "string") {
        const separator = entry.indexOf(":");
        if (separator <= 0) {
          throw new TypeError(`request header entry ${index} is invalid`);
        }
        return entry.slice(0, separator).trim().toLowerCase();
      }
      if (Array.isArray(entry) && entry.length === 2) {
        return String(entry[0]).toLowerCase();
      }
      if (entry && typeof entry === "object" && "name" in entry) {
        return String(entry.name).toLowerCase();
      }
      throw new TypeError(`request header entry ${index} is invalid`);
    }).sort();
  }
  if (typeof value === "object") {
    return Object.keys(value).map((name) => name.toLowerCase()).sort();
  }
  throw new TypeError("request headers are invalid");
}

function bodyBytes(value) {
  if (value === undefined || value === null) {
    return 0;
  }
  if (typeof value !== "string") {
    throw new TypeError("request body is invalid");
  }
  return Buffer.byteLength(value, "utf8");
}

/** Return only safe report/log fields; all other request fields are dropped. */
export function redactRequestMetadata(request) {
  if (!request || typeof request !== "object") {
    throw new TypeError("request metadata is invalid");
  }
  const url = parseUrl(request.url);
  const redacted = {
    bodyBytes: bodyBytes(request.body),
    headerNames: headerNames(request.headers),
    hostname: url.hostname,
    method: typeof request.method === "string" ? request.method : undefined,
    path: url.pathname,
  };
  return Object.fromEntries(SAFE_FIELDS
    .filter((field) => redacted[field] !== undefined)
    .map((field) => [field, redacted[field]]));
}
