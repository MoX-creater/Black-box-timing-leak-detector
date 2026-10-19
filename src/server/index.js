import path from "node:path";
import { fileURLToPath } from "node:url";

import { createWebApp } from "./app.js";

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
}
