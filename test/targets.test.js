import test from "node:test";
import assert from "node:assert/strict";

import { createWebApp } from "../src/server/app.js";
import {
  createTargetMap,
  createTargetMapFromEnvironment,
  validateTargetMap,
} from "../src/server/targets.js";

test("builds exactly the two environment-derived internal targets", () => {
  const targets = createTargetMapFromEnvironment({
    DEMO_FIXED_HOST: "fixed",
    DEMO_FIXED_PORT: "3002",
    DEMO_VULNERABLE_HOST: "vulnerable",
    DEMO_VULNERABLE_PORT: "3001",
  });

  assert.deepEqual(targets, {
    fixed: { host: "fixed", port: 3002 },
    vulnerable: { host: "vulnerable", port: 3001 },
  });
  assert.deepEqual(Object.keys(targets).sort(), ["fixed", "vulnerable"]);
});

test("web app validates its target map at startup", () => {
  const app = createWebApp({
    environment: {
      DEMO_FIXED_HOST: "127.0.0.1",
      DEMO_FIXED_PORT: "3002",
      DEMO_VULNERABLE_HOST: "127.0.0.1",
      DEMO_VULNERABLE_PORT: "3001",
    },
  });

  assert.deepEqual(app.locals.demoTargets, {
    fixed: { host: "127.0.0.1", port: 3002 },
    vulnerable: { host: "127.0.0.1", port: 3001 },
  });
  assert.throws(
    () => createWebApp({
      environment: {
        DEMO_FIXED_HOST: "http://fixed",
        DEMO_FIXED_PORT: "3002",
        DEMO_VULNERABLE_HOST: "vulnerable",
        DEMO_VULNERABLE_PORT: "3001",
      },
    }),
    /host must be a hostname/,
  );
});

test("rejects target maps with unknown IDs, unsafe hosts, or invalid ports", () => {
  assert.throws(
    () => validateTargetMap({
      fixed: { host: "fixed", port: 3002 },
      other: { host: "other", port: 3003 },
      vulnerable: { host: "vulnerable", port: 3001 },
    }),
    /exactly fixed and vulnerable/,
  );
  assert.throws(
    () => createTargetMap({
      fixedHost: "fixed_service",
      fixedPort: 3002,
    }),
    /host must be a hostname/,
  );
  assert.throws(
    () => createTargetMap({ fixedPort: 65536 }),
    /port must be an integer between 1 and 65535/,
  );
  assert.throws(
    () => createTargetMap({ vulnerablePort: "0" }),
    /port must be an integer between 1 and 65535/,
  );
});
