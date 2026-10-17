import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { buildStackSpecs } from "../src/launcher.js";

function serviceBlock(compose, service) {
  const match = compose.match(new RegExp(`\\n  ${service}:\\n([\\s\\S]*?)(?=\\n  [a-z]|$)`));
  assert.ok(match, `missing ${service} service`);
  return match[1];
}

function environmentValue(block, name) {
  const match = block.match(new RegExp(`^      ${name}: ?(?:"([^"]*)"|([^\\n]+))$`, "m"));
  assert.ok(match, `missing ${name}`);
  return match[1] ?? match[2];
}

test("compose and launcher produce the same demo noise and target configuration", async () => {
  const compose = await readFile(new URL("../compose.yaml", import.meta.url), "utf8");
  const vulnerableBlock = serviceBlock(compose, "vulnerable");
  const fixedBlock = serviceBlock(compose, "fixed");
  const webBlock = serviceBlock(compose, "web");
  const specs = buildStackSpecs({ PORT: "3100" });
  const vulnerable = specs.find(({ name }) => name === "vulnerable");
  const fixed = specs.find(({ name }) => name === "fixed");
  const web = specs.find(({ name }) => name === "web");

  assert.deepEqual({
    DEMO_NOISE_PRESET: environmentValue(vulnerableBlock, "DEMO_NOISE_PRESET"),
    DEMO_NOISE_SEED: environmentValue(vulnerableBlock, "DEMO_NOISE_SEED"),
  }, {
    DEMO_NOISE_PRESET: vulnerable.environment.DEMO_NOISE_PRESET,
    DEMO_NOISE_SEED: vulnerable.environment.DEMO_NOISE_SEED,
  });
  assert.equal(environmentValue(fixedBlock, "DEMO_NOISE_PRESET"), fixed.environment.DEMO_NOISE_PRESET);
  assert.equal(environmentValue(fixedBlock, "DEMO_NOISE_SEED"), fixed.environment.DEMO_NOISE_SEED);
  assert.equal(vulnerable.environment.HOST, "127.0.0.1");
  assert.equal(fixed.environment.HOST, "127.0.0.1");
  assert.equal(environmentValue(webBlock, "DEMO_VULNERABLE_HOST"), "vulnerable");
  assert.equal(environmentValue(webBlock, "DEMO_VULNERABLE_PORT"), "3001");
  assert.equal(environmentValue(webBlock, "DEMO_FIXED_HOST"), "fixed");
  assert.equal(environmentValue(webBlock, "DEMO_FIXED_PORT"), "3002");
  assert.equal(web.environment.DEMO_VULNERABLE_HOST, "127.0.0.1");
  assert.equal(web.environment.DEMO_VULNERABLE_PORT, "3001");
  assert.equal(web.environment.DEMO_FIXED_HOST, "127.0.0.1");
  assert.equal(web.environment.DEMO_FIXED_PORT, "3002");
  assert.deepEqual(
    Object.keys(web.environment).filter((key) => key.startsWith("DEMO_NOISE_")),
    [],
  );
});

test("compose publishes only the web port and keeps demo ports internal", async () => {
  const compose = await readFile(new URL("../compose.yaml", import.meta.url), "utf8");
  const webBlock = serviceBlock(compose, "web");
  const vulnerableBlock = serviceBlock(compose, "vulnerable");
  const fixedBlock = serviceBlock(compose, "fixed");

  assert.match(webBlock, /      - "3000:3000"/);
  assert.doesNotMatch(vulnerableBlock, /^    ports:/m);
  assert.doesNotMatch(fixedBlock, /^    ports:/m);
  assert.match(vulnerableBlock, /^      - "3001"/m);
  assert.match(fixedBlock, /^      - "3002"/m);
});
