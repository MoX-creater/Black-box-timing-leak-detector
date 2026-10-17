import express from "express";

import { createTargetMapFromEnvironment } from "./targets.js";

export function createWebApp({ environment = process.env } = {}) {
  const targetMap = createTargetMapFromEnvironment(environment);
  const app = express();
  app.disable("x-powered-by");
  app.locals.demoTargets = targetMap;

  app.get("/healthz", (_request, response) => {
    response.json({ status: "ok" });
  });

  return app;
}
