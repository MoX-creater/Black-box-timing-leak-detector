import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = fileURLToPath(new URL("../../", import.meta.url));

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

function gitCommit() {
  try {
    const commit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: PROJECT_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return commit.length > 0 ? commit : "unavailable";
  } catch {
    return "unavailable";
  }
}

const version = packageVersion();
const commit = gitCommit();
const gitSuffix = commit === "unavailable" ? "" : `+git.${commit}`;

// The report schema has version strings but no separate commit field. Keep the
// package version authoritative and attach the observed commit only when git
// is available; never substitute a guessed build identifier.
export const WEB_BUILD_INFO = Object.freeze({
  buildVersion: `web-${version}${gitSuffix}`,
  detectorVersion: `detector-${version}`,
  gitCommit: commit,
  packageVersion: version,
});
