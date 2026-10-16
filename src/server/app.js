import express from "express";

export function createWebApp() {
  const app = express();
  app.disable("x-powered-by");

  app.get("/healthz", (_request, response) => {
    response.json({ status: "ok" });
  });

  return app;
}
