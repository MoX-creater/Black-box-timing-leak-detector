import path from "node:path";
import { fileURLToPath } from "node:url";

import { createWebApp } from "./app.js";

export function startWebServer({
  environment = process.env,
  host = process.env.HOST ?? "0.0.0.0",
  port = Number(process.env.PORT ?? 3000),
} = {}) {
  return createWebApp({ environment }).listen(port, host);
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
