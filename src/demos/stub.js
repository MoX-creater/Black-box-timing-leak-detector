import path from "node:path";
import { fileURLToPath } from "node:url";

import express from "express";

export function createStubApp(serviceName = process.env.SERVICE_NAME ?? "demo") {
  const app = express();
  app.disable("x-powered-by");

  app.get("/healthz", (_request, response) => {
    response.json({ service: serviceName, status: "ok" });
  });

  return app;
}

export function startStubServer({
  host = process.env.HOST ?? "0.0.0.0",
  port = Number(process.env.PORT ?? 3001),
  serviceName = process.env.SERVICE_NAME ?? "demo",
} = {}) {
  return createStubApp(serviceName).listen(port, host);
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
        console.error("Failed to close stub server", error);
        process.exitCode = 1;
      }
    });
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
