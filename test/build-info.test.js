import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { createWebBuildInfo, WEB_BUILD_INFO } from "../src/server/build-info.js";
import { createRunManager } from "../src/server/run-manager.js";
import { createWebApp } from "../src/server/app.js";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const COMMIT = "0123456789abcdef0123456789abcdef01234567";

test("web build metadata uses the package version and a supplied full hex commit", () => {
  for (const commit of [COMMIT, "ABCD".repeat(16)]) {
    assert.deepEqual(createWebBuildInfo({ GIT_COMMIT: commit }), {
      buildVersion: `web-${version}+git.${commit}`,
      detectorVersion: `detector-${version}`,
      gitCommit: commit,
      packageVersion: version,
    });
  }
  assert.ok(Object.isFrozen(createWebBuildInfo({})));
  assert.deepEqual(WEB_BUILD_INFO, createWebBuildInfo(process.env));
});

test("missing, empty, and invalid commit values explicitly remain unavailable", () => {
  for (const supplied of [
    undefined, null, "", " ", "HEAD", "deadbeef", "g".repeat(40),
    "a".repeat(39), "a".repeat(41), "a".repeat(63), "a".repeat(65),
    ` ${COMMIT}`, `${COMMIT}\n`, `${COMMIT}\r\n`, 123,
  ]) {
    const environment = supplied === undefined ? {} : { GIT_COMMIT: supplied };
    assert.deepEqual(createWebBuildInfo(environment), {
      buildVersion: `web-${version}+git.unavailable`,
      detectorVersion: `detector-${version}`,
      gitCommit: "unavailable",
      packageVersion: version,
    }, `unexpected build metadata for ${JSON.stringify(supplied)}`);
  }
  assert.equal(createWebBuildInfo({ COMMIT_SHA: COMMIT, GITHUB_SHA: COMMIT }).gitCommit,
    "unavailable");
});

function emptyDetectorResult(seed) {
  return {
    counts: {
      a: { accepted: 0, attempts: 0, discarded: 0, discardReasons: {} },
      b: { accepted: 0, attempts: 0, discarded: 0, discardReasons: {} },
    },
    expectedStatus: null,
    lookHistory: [],
    samples: { a: [], b: [] },
    seed,
    sensitivityMs: null,
    stopReason: "aborted",
    verdict: "INCONCLUSIVE",
    warmupRecords: [],
    warnings: [],
  };
}

for (const entrypoint of ["createRunManager", "createWebApp"]) {
  test(`${entrypoint} honors its injected build environment in validated reports`, async () => {
    for (const environment of [{ GIT_COMMIT: COMMIT }, {}, { GIT_COMMIT: "" }, { GIT_COMMIT: "invalid" }]) {
      const options = {
        detectorRunner: async ({ config }) => emptyDetectorResult(config.seed),
        transportFactory: () => ({ send: async () => assert.fail("unexpected outbound request") }),
      };
      const manager = entrypoint === "createRunManager"
        ? createRunManager({
          ...options,
          environment,
          targetMap: {
            fixed: { host: "fixed.example.test", port: 3002 },
            vulnerable: { host: "vulnerable.example.test", port: 3001 },
          },
        })
        : createWebApp({ environment, managerOptions: options }).locals.runManager;
      try {
        const run = manager.start({ clientKey: "build-test", noisePresetId: "none", targetId: "fixed" });
        await manager.waitFor(run.runId);
        assert.equal(manager.getSnapshot(run.runId).status, "complete");
        const report = manager.getReport(run.runId);
        const expectedCommit = environment.GIT_COMMIT === COMMIT ? COMMIT : "unavailable";
        assert.equal(report.buildVersion, `web-${version}+git.${expectedCommit}`);
        assert.equal(report.detectorVersion, `detector-${version}`);
      } finally {
        await manager.shutdown();
      }
    }
  });
}
