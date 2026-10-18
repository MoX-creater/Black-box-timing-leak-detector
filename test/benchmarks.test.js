import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createBenchmarksPage } from "../public/benchmarks.js";

class FakeElement {
  constructor(tagName) {
    this.children = [];
    this.className = "";
    this.hidden = false;
    this.textContent = "";
    this.tagName = tagName;
  }

  append(...children) {
    this.children.push(...children);
  }

  replaceChildren(...children) {
    this.children = children;
  }
}

class FakeDocument {
  constructor() {
    this.elements = new Map();
    for (const id of [
      "benchmark-aggregates",
      "benchmark-baseline",
      "benchmark-provenance",
      "benchmark-reason",
      "benchmark-results",
      "benchmark-results-note",
      "benchmark-status",
      "benchmark-unavailable",
    ]) {
      this.elements.set(id, new FakeElement("div"));
    }
  }

  createElement(tagName) {
    return new FakeElement(tagName);
  }

  getElementById(id) {
    return this.elements.get(id) ?? null;
  }
}

function response(body, { ok = true, status = 200 } = {}) {
  return {
    json: async () => body,
    ok,
    status,
  };
}

function descendants(node) {
  return [node, ...node.children.flatMap((child) => descendants(child))];
}

function textOf(node) {
  return descendants(node).map((entry) => entry.textContent).join(" ");
}

function completeResults() {
  return {
    aggregates: [{
      completedCount: 2,
      detectionRate: {
        rate: 0.5,
        successes: 1,
        trials: 2,
        wilson95: { lower: 0.0945, upper: 0.9055 },
      },
      failedCount: 0,
      falsePositiveRate: null,
      inconclusiveRate: {
        rate: 0.5,
        successes: 1,
        trials: 2,
        wilson95: { lower: 0.0945, upper: 0.9055 },
      },
      noisePresetId: "none",
      targetId: "vulnerable",
      trialCount: 2,
    }],
    baseline: [{
      absoluteDifferenceMs: 0.25,
      flagged: null,
      meanA: 10.25,
      meanB: 10.5,
      noisePresetId: "none",
      note: "Unavailable until a threshold is configured.",
      samplesPerGroup: 20,
      status: "unavailable",
      targetId: "vulnerable",
      thresholdMs: null,
    }],
    provenance: {
      baselineConfig: { thresholdMs: null },
      benchmarkStatus: "TBD until a real full run is completed",
      codeCommit: "abc123",
      cpu: "test CPU",
      cpuCount: 2,
      detectorConfig: { alphaTotal: 0.05 },
      matrix: {
        noisePresets: ["none"],
        targets: ["vulnerable"],
        trialsPerSeed: 2,
      },
      nodeVersion: "v22.23.3",
      noiseConfigs: { none: { presetId: "none" } },
      notes: "Measured fixture",
      os: { arch: "x64", platform: "linux", release: "test" },
      packageVersion: "0.1.0",
      runnerCommand: "node bench/run.js",
      smoke: false,
      trialSeeds: ["seed-01"],
    },
    reason: null,
    schemaVersion: "1.0",
    status: "complete",
    trials: [],
  };
}

test("benchmarks page renders the explicit unavailable state for a missing result file", async () => {
  const documentRef = new FakeDocument();
  const page = createBenchmarksPage({
    document: documentRef,
    fetchImpl: async () => response(null, { ok: false, status: 404 }),
  });
  await page.ready;

  assert.equal(documentRef.getElementById("benchmark-status").textContent, "Benchmark data not yet available.");
  assert.equal(documentRef.getElementById("benchmark-unavailable").hidden, false);
  assert.equal(documentRef.getElementById("benchmark-results").hidden, true);
});

test("benchmarks page renders the explicit unavailable state from unavailable results", async () => {
  const documentRef = new FakeDocument();
  const page = createBenchmarksPage({
    document: documentRef,
    fetchImpl: async () => response({
      aggregates: [],
      baseline: [],
      provenance: null,
      reason: "Full run was not requested.",
      schemaVersion: "1.0",
      status: "unavailable",
      trials: [],
    }),
  });
  await page.ready;

  assert.equal(documentRef.getElementById("benchmark-status").textContent, "Benchmark data not yet available.");
  assert.equal(documentRef.getElementById("benchmark-reason").textContent, "Full run was not requested.");
});

test("benchmarks page renders provenance, Wilson intervals, and baseline fields for complete results", async () => {
  const documentRef = new FakeDocument();
  const page = createBenchmarksPage({
    document: documentRef,
    fetchImpl: async () => response(completeResults()),
  });
  await page.ready;

  const pageText = [
    "benchmark-provenance",
    "benchmark-aggregates",
    "benchmark-baseline",
  ].map((id) => textOf(documentRef.getElementById(id))).join(" ");
  assert.equal(documentRef.getElementById("benchmark-results").hidden, false);
  assert.match(pageText, /abc123/);
  assert.match(pageText, /v22\.23\.3/);
  assert.match(pageText, /0\.1\.0/);
  assert.match(pageText, /50\.0% \(1\/2\)/);
  assert.match(pageText, /95% Wilson CI 9\.4%–90\.5%/);
  assert.match(pageText, /10\.25 ms/);
  assert.match(pageText, /Unavailable until a threshold is configured/);
});

test("benchmarks page source uses DOM text rendering rather than HTML injection", async () => {
  const source = await readFile(new URL("../public/benchmarks.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /innerHTML|outerHTML|document\.write/);
});
