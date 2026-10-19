import { readFileSync } from "node:fs";

function packageVersion() {
  try {
    const packageJson = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
    return typeof packageJson.version === "string" && packageJson.version.length > 0
      ? packageJson.version
      : "unavailable";
  } catch {
    return "unavailable";
  }
}

const version = packageVersion();
// Accept full SHA-1 or SHA-256 object IDs, never refs or guessed abbreviations.
const COMMIT_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;

export function createWebBuildInfo(environment = process.env) {
  const suppliedCommit = environment.GIT_COMMIT;
  const commit = typeof suppliedCommit === "string"
    && COMMIT_PATTERN.exec(suppliedCommit)?.[0] === suppliedCommit
    ? suppliedCommit
    : "unavailable";
  // The schema has no commit field, so the build string always states its
  // supplied commit or explicitly records that it is unavailable.
  return Object.freeze({
    buildVersion: `web-${version}+git.${commit}`,
    detectorVersion: `detector-${version}`,
    gitCommit: commit,
    packageVersion: version,
  });
}

export const WEB_BUILD_INFO = createWebBuildInfo();
