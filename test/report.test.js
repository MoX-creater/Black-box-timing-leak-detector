import test from "node:test";
import assert from "node:assert/strict";

import {
  createRunReport,
  REPORT_WARNING_CODE,
  ReportValidationError,
  validateRunReport,
} from "../src/report/index.js";
import { runDetector, STOP_REASON } from "../src/detector/index.js";
import { VERDICT, formatVerdict } from "../src/inference/verdict.js";

const DETECTOR_CONFIG = {
  alphaTotal: 0.05,
  bootstrapReplicates: 100,
  lookBatchPerGroup: 2,
  materialDiscardRateDifference: 0.2,
  maxAttempts: 20,
  maxConsecutiveFailures: 3,
  maxDiscardRate: 0.5,
  maxValidPerGroup: 4,
  minAttemptsForDiscardRate: 2,
  minValidPerGroup: 2,
  quantile: 0.1,
  seed: "report-test-seed",
  targetPower: 0.8,
};

function accepted(durationMs, statusCode = 200) {
  return { durationMs, kind: "accepted", statusCode };
}

function senderFor({ a = [], b = [] }) {
  const queues = { a: [...a], b: [...b] };
  return async (request) => {
    const result = queues[request.id].shift();
    if (!result) {
      throw new Error(`missing fixture result for ${request.id}`);
    }
    return result;
  };
}

async function detectorFixture() {
  return runDetector({
    config: DETECTOR_CONFIG,
    requests: { a: { id: "a" }, b: { id: "b" } },
    send: senderFor({
      a: [accepted(999), accepted(10), accepted(11), accepted(12), accepted(13)],
      b: [accepted(998), accepted(10.2), accepted(11.1), accepted(12.2), accepted(13.1)],
    }),
  });
}

function requestMetadata() {
  return {
    a: {
      body: '{"username":"known","password":"body-secret"}',
      headers: {
        authorization: "Bearer authorization-secret",
        cookie: "session=cookie-secret",
        "content-type": "application/json",
      },
      method: "POST",
      url: "https://authorized.example.test/login?token=url-secret",
    },
    b: {
      body: '{"username":"missing","password":"body-secret"}',
      headers: {
        authorization: "Bearer authorization-secret",
        cookie: "session=cookie-secret",
        "content-type": "application/json",
      },
      method: "POST",
      url: "https://authorized.example.test/login?token=url-secret",
    },
  };
}

function reportInput(detectorResult, overrides = {}) {
  return {
    buildVersion: "test-build-1",
    detectorConfig: DETECTOR_CONFIG,
    detectorResult,
    detectorVersion: "test-detector-1",
    endedAt: "2026-10-17T00:00:01.000Z",
    noise: { jitter: 0.25, presetId: "none", seed: "noise-seed" },
    requestMetadata: requestMetadata(),
    requestTemplateIds: { a: "known-existing", b: "nonexistent" },
    startedAt: "2026-10-17T00:00:00.000Z",
    target: { id: "vulnerable", kind: "demo" },
    ...overrides,
  };
}

async function validReport(overrides = {}) {
  return createRunReport(reportInput(await detectorFixture(), overrides));
}

function assertInvalid(report, message) {
  assert.throws(
    () => validateRunReport(report),
    (error) => error instanceof ReportValidationError
      && error.code === "REPORT_INVALID"
      && (message === undefined || error.message.includes(message)),
  );
}

test("creates a split, redacted report and round-trips JSON", async () => {
  const report = await validReport({
    requestWarnings: [{
      code: REPORT_WARNING_CODE.BODY_LENGTH_DIFFERENCE,
      differenceBytes: 12,
      message: "free text must not survive",
    }],
    warnings: [{
      code: REPORT_WARNING_CODE.DISCARD_RATE_DIFFERENCE,
      message: "free text must not survive",
      rates: { a: 0.5, b: 0.1 },
    }],
  });

  assert.equal(report.configuration.provenance, "configuration");
  assert.equal(report.observation.provenance, "observation");
  assert.equal(report.inference.provenance, "inference");
  assert.equal(report.configuration.noise.presetId, "none");
  assert.deepEqual(report.inference.warnings, [
    { code: "BODY_LENGTH_DIFFERENCE", differenceBytes: 12 },
    { code: "DISCARD_RATE_DIFFERENCE", rateA: 0.5, rateB: 0.1 },
  ]);
  const serialized = JSON.stringify(report);
  assert.doesNotMatch(serialized, /body-secret|cookie-secret|authorization-secret|url-secret/);
  assert.deepEqual(validateRunReport(JSON.parse(serialized)), JSON.parse(serialized));
});

test("requires accepted to equal each sample array length", async () => {
  const report = await validReport();
  report.observation.samples.a.pop();
  assertInvalid(report, "length must equal accepted count");
});

test("requires accepted plus discarded to equal attempts", async () => {
  const report = await validReport();
  report.observation.counts.a.attempts += 1;
  assertInvalid(report, "accepted plus discarded must equal attempts");
});

test("requires discard reason counts to sum to discarded", async () => {
  const report = await validReport();
  report.observation.counts.a.discardReasons.synthetic = 1;
  assertInvalid(report, "discard reason counts must sum to discarded");
});

test("requires sensitivity for NO_LEAK_DETECTED", async () => {
  const report = await validReport();
  report.inference.sensitivityMs = null;
  report.inference.displayVerdict = formatVerdict({
    sensitivityMs: null,
    verdict: VERDICT.NO_LEAK_DETECTED,
  });
  assertInvalid(report, "required for NO_LEAK_DETECTED");
});

test("requires stop reason and verdict compatibility", async () => {
  const report = await validReport();
  report.observation.stopReason = STOP_REASON.LEAK_DETECTED;
  assertInvalid(report, "incompatible with the verdict");

  const inconclusiveReport = await validReport();
  inconclusiveReport.observation.stopReason = STOP_REASON.ABORTED;
  assertInvalid(inconclusiveReport, "incompatible with the verdict");
});

test("requires displayVerdict to match formatVerdict", async () => {
  const report = await validReport();
  report.inference.displayVerdict = "NO LEAK DETECTED";
  assertInvalid(report, "does not match formatVerdict output");
});

test("requires endedAt to be at or after startedAt", async () => {
  const report = await validReport();
  report.observation.endedAt = "2026-10-16T23:59:59.000Z";
  assertInvalid(report, "greater than or equal to startedAt");
});

test("bounds every accepted sample array by maxValidPerGroup", async () => {
  const report = await validReport();
  report.observation.samples.a.push(14);
  report.observation.counts.a.accepted += 1;
  report.observation.counts.a.attempts += 1;
  assertInvalid(report, "exceeds maxValidPerGroup");
});

test("allows only the fixed structured warning records", async () => {
  const report = await validReport();
  report.inference.warnings = [{
    code: REPORT_WARNING_CODE.BODY_LENGTH_DIFFERENCE,
    differenceBytes: 12,
    message: "not allowed",
  }];
  assertInvalid(report, "is not allowed");
});

test("rejects injected cookie, authorization, body, and url fields anywhere", async () => {
  for (const field of ["cookie", "authorization", "body", "url"]) {
    const report = await validReport();
    report.inference.lookHistory[0].quality[field] = "secret-value";
    assertInvalid(report, "prohibited sensitive field");
  }
});

test("noise accepts only presetId, optional jitter, and optional seed", async () => {
  const report = await validReport();
  report.configuration.noise.extra = "not-allowed";
  assertInvalid(report, "is not allowed");
});
