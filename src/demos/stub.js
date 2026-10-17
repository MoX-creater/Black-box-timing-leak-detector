import path from "node:path";
import { fileURLToPath } from "node:url";

import express from "express";

import {
  createDemoAuthenticator,
  createDemoUserStore,
  LOGIN_INVALID_BODY,
  LOGIN_INVALID_STATUS,
  LOGIN_SUCCESS_BODY,
  LOGIN_SUCCESS_STATUS,
} from "./auth.js";
import {
  createNoiseMiddleware,
  resolveNoiseConfigFromEnvironment,
} from "./noise.js";

export const DEMO_MODE = Object.freeze({
  FIXED: "fixed",
  VULNERABLE: "vulnerable",
});

const JSON_BODY_LIMIT = "8kb";
const SERVER_ERROR_STATUS = 500;
const SERVER_ERROR_BODY = JSON.stringify({
  error: {
    code: "INTERNAL_SERVER_ERROR",
    message: "Internal server error",
  },
});
const defaultUserStore = createDemoUserStore();

function validateMode(mode) {
  if (mode !== DEMO_MODE.FIXED && mode !== DEMO_MODE.VULNERABLE) {
    throw new TypeError("mode must be vulnerable or fixed");
  }
  return mode;
}

function sendSerialized(response, statusCode, body) {
  response
    .status(statusCode)
    .set("Content-Type", "application/json; charset=utf-8")
    .set("Content-Length", String(Buffer.byteLength(body, "utf8")))
    .end(body);
}

function isBodyParsingError(error) {
  return error?.type === "entity.parse.failed" || error?.type === "entity.too.large";
}

function errorHandler(error, _request, response, _next) {
  if (response.headersSent) {
    response.end();
    return;
  }
  if (isBodyParsingError(error)) {
    sendSerialized(response, LOGIN_INVALID_STATUS, LOGIN_INVALID_BODY);
    return;
  }
  sendSerialized(response, SERVER_ERROR_STATUS, SERVER_ERROR_BODY);
}

function resolveMode(mode, serviceName) {
  return validateMode(mode ?? process.env.DEMO_MODE ?? process.env.SERVICE_NAME ?? serviceName);
}

export function createDemoApp({
  hashPasswordFn,
  mode,
  noiseConfig = resolveNoiseConfigFromEnvironment(),
  noiseWorkFn,
  serviceName = process.env.SERVICE_NAME ?? mode ?? "demo",
  scryptFn,
  timingSafeEqualFn,
  userStore = defaultUserStore,
} = {}) {
  const resolvedMode = resolveMode(mode, serviceName);
  const noiseMiddleware = createNoiseMiddleware(noiseConfig, { work: noiseWorkFn });
  const authenticate = Promise.resolve(userStore).then((store) => createDemoAuthenticator({
    hashPasswordFn,
    skipMissingUserHash: resolvedMode === DEMO_MODE.VULNERABLE,
    scryptFn,
    timingSafeEqualFn,
    userStore: store,
  }));
  const app = express();
  app.locals.noiseConfig = noiseMiddleware.noiseConfig;
  app.disable("x-powered-by");
  app.set("etag", false);
  app.use(express.json({ limit: JSON_BODY_LIMIT, strict: true }));

  app.get("/healthz", (_request, response) => {
    sendSerialized(response, 200, JSON.stringify({ service: serviceName, status: "ok" }));
  });

  app.post("/login", noiseMiddleware, async (request, response, next) => {
    try {
      const result = await (await authenticate)(request.body);
      sendSerialized(response, result.statusCode, result.body);
    } catch (error) {
      next(error);
    }
  });

  app.use(errorHandler);
  return app;
}

export function createStubApp(serviceName = process.env.SERVICE_NAME ?? "demo", options = {}) {
  return createDemoApp({ ...options, serviceName });
}

export function startStubServer({
  hashPasswordFn,
  host = process.env.HOST ?? "0.0.0.0",
  mode,
  noiseConfig,
  noiseWorkFn,
  port = Number(process.env.PORT ?? 3001),
  serviceName = process.env.SERVICE_NAME ?? mode ?? "demo",
  scryptFn,
  timingSafeEqualFn,
  userStore,
} = {}) {
  const app = createDemoApp({
    hashPasswordFn,
    mode,
    noiseConfig,
    noiseWorkFn,
    serviceName,
    scryptFn,
    timingSafeEqualFn,
    userStore,
  });
  return app.listen(port, host);
}

function isDirectRun() {
  return process.argv[1] !== undefined
    && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isDirectRun()) {
  const server = startStubServer();
  const shutdown = () => {
    server.close((error) => {
      if (error) {
        process.exitCode = 1;
      }
    });
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

export {
  JSON_BODY_LIMIT,
  SERVER_ERROR_BODY,
  SERVER_ERROR_STATUS,
  sendSerialized,
};
