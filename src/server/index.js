import path from "node:path";
import { fileURLToPath } from "node:url";

import { createWebApp } from "./app.js";

const LAUNCHER_STARTUP_GATE = "1";
const LAUNCHER_DEMO_HEALTH_URLS = Object.freeze([
  "http://127.0.0.1:3001/healthz",
  "http://127.0.0.1:3002/healthz",
]);
const LAUNCHER_STARTUP_TIMEOUT_MS = 30_000;
const LAUNCHER_HEALTH_REQUEST_TIMEOUT_MS = 1_000;
const LAUNCHER_HEALTH_POLL_MS = 50;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function healthIsReady(url, fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LAUNCHER_HEALTH_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, { signal: controller.signal });
    if (!response.ok) {
      return false;
    }
    await response.arrayBuffer();
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export async function waitForLauncherDemos({
  fetchImpl = globalThis.fetch,
  timeoutMs = LAUNCHER_STARTUP_TIMEOUT_MS,
  pollMs = LAUNCHER_HEALTH_POLL_MS,
} = {}) {
  if (typeof fetchImpl !== "function") {
    throw new TypeError("launcher startup health checks require fetch");
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ready = await Promise.all(LAUNCHER_DEMO_HEALTH_URLS.map((url) => healthIsReady(url, fetchImpl)));
    if (ready.every(Boolean)) {
      return;
    }
    await wait(pollMs);
  }
  throw new Error("launcher demo health checks timed out");
}

export function startWebServer({
  environment = process.env,
  host = process.env.HOST ?? "0.0.0.0",
  managerOptions = {},
  port = Number(process.env.PORT ?? 3000),
} = {}) {
  const app = createWebApp({ environment, managerOptions });
  const server = app.listen(port, host);
  server.once("listening", () => {
    void app.locals.runManager.warm().catch(() => {
      // A failed background warmup is retried by the first scan. The scan
      // lifecycle still owns the user-visible failure classification.
      console.error("Web runtime warmup failed; first scan will retry");
    });
  });
  const closeServer = server.close.bind(server);
  server.close = (callback) => {
    void app.locals.runManager.shutdown().then(
      () => closeServer(callback),
      () => closeServer(callback),
    );
    return server;
  };
  return server;
}

function isDirectRun() {
  return process.argv[1] !== undefined
    && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isDirectRun()) {
  const startDirectServer = async () => {
    if (process.env.LAUNCHER_STARTUP_GATE === LAUNCHER_STARTUP_GATE) {
      await waitForLauncherDemos();
    }
    const server = startWebServer();
    const shutdown = () => {
      server.close((error) => {
        if (error) {
          console.error("Failed to close web server", error);
          process.exitCode = 1;
        }
      });
    };

    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  };

  startDirectServer().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
