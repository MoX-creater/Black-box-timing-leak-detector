import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

test("Dockerfile healthcheck contains valid Node healthcheck code", async () => {
  const dockerfile = await readFile(new URL("../Dockerfile", import.meta.url), "utf8");
  const line = dockerfile.split(/\r?\n/).find((entry) => entry.startsWith("HEALTHCHECK "));
  assert.ok(line, "Dockerfile must define a HEALTHCHECK");

  const match = line.match(/CMD (\[.*\])$/);
  assert.ok(match, "HEALTHCHECK must use JSON-array CMD syntax");
  const command = JSON.parse(match[1]);
  assert.deepEqual(command.slice(0, 2), ["node", "-e"]);
  assert.equal(typeof command[2], "string");
  assert.doesNotThrow(() => new vm.Script(command[2]));
  assert.match(command[2], /127\.0\.0\.1/);
  assert.match(command[2], /process\.env\.PORT \|\| 3000/);
  assert.match(command[2], /\/healthz/);
});
