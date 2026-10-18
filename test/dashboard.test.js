import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { once } from "node:events";

import { request } from "undici";

import { createDashboard } from "../public/app.js";
import { startWebServer } from "../src/server/index.js";

const PUBLIC_DIR = new URL("../public/", import.meta.url);

async function readPublicFile(name) {
  return readFile(new URL(name, PUBLIC_DIR), "utf8");
}

async function startApiServer() {
  const server = startWebServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return { server, url: `http://127.0.0.1:${address.port}` };
}

async function closeServer(server) {
  if (!server.listening) {
    return;
  }
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function flushMicrotasks() {
  for (let index = 0; index < 12; index += 1) {
    await Promise.resolve();
  }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function response(body, { ok = true, status = 200 } = {}) {
  return {
    json: async () => body,
    ok,
    status,
  };
}

class FakeElement {
  constructor(tagName, id = "") {
    this.children = [];
    this.className = "";
    this.disabled = false;
    this.hidden = false;
    this.id = id;
    this.listeners = new Map();
    this.attributes = new Map();
    this.namespaceURI = null;
    this.tagName = tagName;
    this.textContent = "";
    this.value = "";
  }

  set innerHTML(_value) {
    throw new Error("innerHTML is forbidden in dashboard rendering");
  }

  addEventListener(name, listener) {
    const listeners = this.listeners.get(name) ?? [];
    listeners.push(listener);
    this.listeners.set(name, listeners);
  }

  append(...children) {
    this.children.push(...children);
  }

  dispatchEvent(event) {
    for (const listener of this.listeners.get(event.type) ?? []) {
      listener(event);
    }
  }

  replaceChildren(...children) {
    this.children = children;
  }

  setAttribute(name, value) {
    this.attributes.set(name, value);
  }
}

class FakeDocument {
  constructor() {
    this.elements = new Map();
    for (const id of [
      "dashboard",
      "evidence-delta",
      "evidence-discarded-a",
      "evidence-discarded-b",
      "evidence-errors-a",
      "evidence-errors-b",
      "error-message",
      "evidence-summary",
      "evidence-p-value",
      "evidence-percentile-a",
      "evidence-percentile-b",
      "evidence-sensitivity",
      "evidence-stop-reason",
      "evidence-u-a",
      "evidence-u-b",
      "histogram-legend",
      "histogram-output",
      "histogram-status",
      "load-status",
      "noise-select",
      "progress-message",
      "run-button",
      "scan-form",
      "scan-status",
      "side-channel-note",
      "target-select",
      "verdict-badge",
      "warning-list",
    ]) {
      const tagName = id.endsWith("select") ? "select" : id === "scan-form" ? "form" : "div";
      this.elements.set(id, new FakeElement(tagName, id));
    }
    for (const prefix of ["attempts", "accepted", "discarded", "errors"]) {
      for (const group of ["a", "b"]) {
        const id = `${prefix}-${group}`;
        this.elements.set(id, new FakeElement("span", id));
      }
    }
  }

  createElement(tagName) {
    return new FakeElement(tagName);
  }

  createElementNS(namespaceURI, tagName) {
    const element = new FakeElement(tagName);
    element.namespaceURI = namespaceURI;
    return element;
  }

  getElementById(id) {
    return this.elements.get(id) ?? null;
  }
}

class FakeTimers {
  constructor() {
    this.current = 0;
    this.nextId = 1;
    this.timers = new Map();
  }

  clearTimeout = (id) => {
    this.timers.delete(id);
  };

  setTimeout = (callback, delay) => {
    const id = this.nextId;
    this.nextId += 1;
    this.timers.set(id, { callback, due: this.current + delay });
    return id;
  };

  async advance(milliseconds) {
    this.current += milliseconds;
    let next;
    do {
      next = [...this.timers.entries()]
        .filter(([, timer]) => timer.due <= this.current)
        .sort((left, right) => left[1].due - right[1].due)[0];
      if (next) {
        this.timers.delete(next[0]);
        next[1].callback();
        await flushMicrotasks();
      }
    } while (next);
  }

  pending() {
    return this.timers.size;
  }
}

class FakeEventSource {
  static instances = [];

  constructor(url) {
    this.closed = false;
    this.listeners = new Map();
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(name, listener) {
    const listeners = this.listeners.get(name) ?? [];
    listeners.push(listener);
    this.listeners.set(name, listeners);
  }

  close() {
    this.closed = true;
  }

  emit(name, payload) {
    const event = { data: JSON.stringify(payload) };
    for (const listener of this.listeners.get(name) ?? []) {
      listener(event);
    }
  }

  fail() {
    this.onerror?.(new Error("stream disconnected"));
  }
}

function createDashboardHarness(fetchImpl) {
  FakeEventSource.instances = [];
  const documentRef = new FakeDocument();
  const timers = new FakeTimers();
  const dashboard = createDashboard({
    EventSourceImpl: FakeEventSource,
    document: documentRef,
    fetchImpl,
    timers,
  });
  return { dashboard, documentRef, timers };
}

test("static dashboard assets have CSP, safe headers, and explicit route isolation", async () => {
  const { server, url } = await startApiServer();
  const csp = "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
  try {
    const page = await request(`${url}/`);
    assert.equal(page.statusCode, 200);
    assert.equal(page.headers["content-type"].startsWith("text/html"), true);
    assert.equal(page.headers["content-security-policy"], csp);
    assert.equal(page.headers["x-content-type-options"], "nosniff");
    const html = await page.body.text();
    assert.match(html, /<script type="module" src="\/app\.js"><\/script>/);
    assert.match(html, /<link rel="stylesheet" href="\/styles\.css">/);
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/i);
    assert.doesNotMatch(html, /\sstyle\s*=/i);
    assert.doesNotMatch(html, /(?:url|header|body)\s*=/i);

    for (const asset of ["/styles.css", "/app.js"]) {
      const assetResponse = await request(`${url}${asset}`);
      assert.equal(assetResponse.statusCode, 200);
      assert.equal(assetResponse.headers["content-security-policy"], csp);
      assert.equal(assetResponse.headers["x-content-type-options"], "nosniff");
      await assetResponse.body.text();
    }

    const health = await request(`${url}/healthz`);
    assert.equal(health.statusCode, 200);
    assert.deepEqual(await health.body.json(), { status: "ok" });
    const api404 = await request(`${url}/api/not-a-route`);
    assert.equal(api404.statusCode, 404);
    assert.deepEqual((await api404.body.json()).error.code, "invalid-scan-request");

    for (const path of ["/.env", "/%2e%2e/package.json", "/public/"]) {
      const missing = await request(`${url}${path}`);
      assert.equal(missing.statusCode, 404, path);
      await missing.body.text();
    }
  } finally {
    await closeServer(server);
  }
});

test("static dashboard source contract scan names the grep-style safety checks honestly", async () => {
  const [html, source] = await Promise.all([
    readPublicFile("index.html"),
    readPublicFile("app.js"),
  ]);
  assert.match(source, /\/api\/targets/);
  assert.match(source, /\/api\/scans/);
  assert.match(source, /EventSourceImpl/);
  assert.match(source, /pollOnce/);
  assert.doesNotMatch(source, /innerHTML|outerHTML|document\.write/);
  const sourceWithoutSvgNamespace = source.replaceAll("http://www.w3.org/2000/svg", "");
  assert.doesNotMatch(sourceWithoutSvgNamespace, /https?:\/\//i);
  assert.doesNotMatch(html, /<input[^>]+(?:url|header|body)/i);
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /role="alert"/);
});

const METADATA = {
  noisePresets: [{ id: "none", label: "No noise" }],
  targets: [
    { id: "vulnerable", label: "Vulnerable demo" },
    { id: "fixed", label: "Fixed demo" },
  ],
};

test("dashboard behavior sends only selected IDs and filters stale run events", async () => {
  const calls = [];
  const post = deferred();
  const fetchImpl = (url, options = {}) => {
    calls.push({ options, url });
    if (url === "/api/targets") {
      return Promise.resolve(response(METADATA));
    }
    if (url === "/api/scans" && options.method === "POST") {
      return post.promise;
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  const { dashboard, documentRef, timers } = createDashboardHarness(fetchImpl);
  await flushMicrotasks();

  const targetSelect = documentRef.getElementById("target-select");
  const noiseSelect = documentRef.getElementById("noise-select");
  assert.deepEqual(targetSelect.children.map((option) => option.value), ["vulnerable", "fixed"]);
  assert.deepEqual(noiseSelect.children.map((option) => option.value), ["none"]);

  const form = documentRef.getElementById("scan-form");
  const runButton = documentRef.getElementById("run-button");
  const submit = { preventDefault() {}, type: "submit" };
  form.dispatchEvent(submit);
  assert.equal(runButton.disabled, true, "Run must disable synchronously before POST resolves");
  form.dispatchEvent(submit);
  const postCalls = calls.filter(({ url, options }) => url === "/api/scans" && options.method === "POST");
  assert.equal(postCalls.length, 1);
  assert.deepEqual(Object.keys(JSON.parse(postCalls[0].options.body)).sort(), ["noisePresetId", "targetId"]);
  assert.deepEqual(JSON.parse(postCalls[0].options.body), {
    noisePresetId: "none",
    targetId: "vulnerable",
  });

  post.resolve(response({ runId: "run-0001", status: "running" }, { status: 202 }));
  await flushMicrotasks();
  const source = FakeEventSource.instances[0];
  assert.ok(source);
  assert.equal(dashboard.state.phase, "running");

  source.emit("scan:progress", {
    accepted: { a: 99, b: 99 },
    attempts: { a: 99, b: 99 },
    discarded: { a: 0, b: 0 },
    errors: { a: 0, b: 0 },
    histograms: { a: [], b: [] },
    lookIndex: 99,
    runId: "run-old",
    status: "running",
  });
  assert.equal(dashboard.state.progress.accepted.a, 0);

  source.emit("scan:progress", {
    accepted: { a: 2, b: 3 },
    attempts: { a: 4, b: 5 },
    discarded: { a: 2, b: 2 },
    errors: { a: 1, b: 1 },
    histograms: {
      a: [{ count: 2, endMs: 2, startMs: 1 }],
      b: [{ count: 3, endMs: 4, startMs: 3 }],
    },
    lookIndex: 1,
    runId: "run-0001",
    status: "running",
  });
  assert.equal(dashboard.state.progress.accepted.a, 2);
  assert.equal(dashboard.state.histograms.a[0].count, 2);
  assert.equal(documentRef.getElementById("accepted-a").textContent, "2");

  source.fail();
  assert.equal(timers.pending(), 1);
  source.emit("scan:complete", {
    reportUrl: "/api/scans/run-old/report",
    runId: "run-old",
    sensitivityMs: 4,
    status: "complete",
    stopReason: "stale",
    verdict: "LEAK",
  });
  assert.equal(dashboard.state.phase, "running");
  assert.equal(source.closed, false);

  source.emit("scan:complete", {
    reportUrl: "/api/scans/run-0001/report",
    runId: "run-0001",
    sensitivityMs: 1.2345,
    status: "complete",
    stopReason: "max-samples-no-leak",
    verdict: "NO_LEAK_DETECTED",
  });
  assert.equal(dashboard.state.phase, "done");
  assert.equal(source.closed, true);
  assert.equal(timers.pending(), 0);
  assert.equal(
    documentRef.getElementById("verdict-badge").textContent,
    "NO LEAK DETECTED (sensitivity >= 1.23 ms)",
  );
  assert.match(
    documentRef.getElementById("side-channel-note").textContent,
    /does not prove universal absence of timing side channels/i,
  );
  dashboard.destroy();
});

test("429 start errors use the API message and apply a fixed cooldown", async () => {
  const fetchImpl = (url, options = {}) => {
    if (url === "/api/targets") {
      return Promise.resolve(response(METADATA));
    }
    if (url === "/api/scans" && options.method === "POST") {
      return Promise.resolve(response(
        { error: { code: "rate-limit-exceeded", message: "Scan start rate limit exceeded" } },
        { ok: false, status: 429 },
      ));
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  const { dashboard, documentRef, timers } = createDashboardHarness(fetchImpl);
  await flushMicrotasks();
  documentRef.getElementById("scan-form").dispatchEvent({ preventDefault() {}, type: "submit" });
  assert.equal(documentRef.getElementById("run-button").disabled, true);
  await flushMicrotasks();
  assert.equal(dashboard.state.phase, "failed");
  assert.equal(dashboard.state.cooldownActive, true);
  assert.equal(documentRef.getElementById("error-message").textContent, "Scan start rate limit exceeded");
  await timers.advance(999);
  assert.equal(documentRef.getElementById("run-button").disabled, true);
  await timers.advance(1);
  assert.equal(dashboard.state.cooldownActive, false);
  assert.equal(documentRef.getElementById("run-button").disabled, false);
  dashboard.destroy();
});

test("polling fallback stops visibly after five consecutive failures", async () => {
  const pollCalls = [];
  const fetchImpl = (url, options = {}) => {
    if (url === "/api/targets") {
      return Promise.resolve(response(METADATA));
    }
    if (url === "/api/scans" && options.method === "POST") {
      return Promise.resolve(response({ runId: "run-0002", status: "running" }, { status: 202 }));
    }
    if (url === "/api/scans/run-0002") {
      pollCalls.push(url);
      return Promise.resolve(response(
        { error: { code: "internal-error", message: "Internal server error" } },
        { ok: false, status: 500 },
      ));
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  const { dashboard, documentRef, timers } = createDashboardHarness(fetchImpl);
  await flushMicrotasks();
  documentRef.getElementById("scan-form").dispatchEvent({ preventDefault() {}, type: "submit" });
  await flushMicrotasks();
  const source = FakeEventSource.instances[0];
  source.fail();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await timers.advance(1_000);
  }
  assert.equal(pollCalls.length, 5);
  assert.equal(dashboard.state.phase, "failed");
  assert.match(documentRef.getElementById("error-message").textContent, /stopped after five consecutive failures/i);
  assert.equal(source.closed, true);
  assert.equal(timers.pending(), 0);
  const callsAfterStop = pollCalls.length;
  await timers.advance(5_000);
  assert.equal(pollCalls.length, callsAfterStop);
  dashboard.destroy();
});

function descendants(node) {
  return [node, ...node.children.flatMap((child) => descendants(child))];
}

test("dashboard renders SVG bars from progress and a completed snapshot without innerHTML", async () => {
  const post = deferred();
  const completed = deferred();
  const fetchImpl = (url, options = {}) => {
    if (url === "/api/targets") {
      return Promise.resolve(response(METADATA));
    }
    if (url === "/api/scans" && options.method === "POST") {
      return post.promise;
    }
    if (url === "/api/scans/run-0003") {
      return completed.promise;
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  const { dashboard, documentRef, timers } = createDashboardHarness(fetchImpl);
  await flushMicrotasks();
  documentRef.getElementById("scan-form").dispatchEvent({ preventDefault() {}, type: "submit" });
  post.resolve(response({ runId: "run-0003", status: "running" }, { status: 202 }));
  await flushMicrotasks();
  const source = FakeEventSource.instances[0];
  source.emit("scan:progress", {
    accepted: { a: 2, b: 1 },
    attempts: { a: 2, b: 1 },
    discarded: { a: 0, b: 0 },
    errors: { a: 0, b: 0 },
    histograms: {
      a: [
        { count: 1, endMs: 2, startMs: 1 },
        { count: 1, endMs: 3, startMs: 2 },
      ],
      b: [{ count: 1, endMs: 3, startMs: 1 }],
    },
    lookIndex: 1,
    runId: "run-0003",
    status: "running",
  });
  const progressNodes = descendants(documentRef.getElementById("histogram-output"));
  assert.equal(progressNodes.filter((node) => node.attributes.get("class")?.includes("histogram-bar-a")).length, 2);
  assert.equal(progressNodes.filter((node) => node.attributes.get("class")?.includes("histogram-bar-b")).length, 1);
  assert.equal(progressNodes.filter((node) => node.tagName === "defs").length, 1);
  assert.equal(progressNodes.filter((node) => node.attributes.get("id") === "histogram-pattern-b").length, 1);

  source.emit("scan:progress", {
    accepted: { a: 1, b: 0 },
    attempts: { a: 1, b: 0 },
    discarded: { a: 0, b: 0 },
    errors: { a: 0, b: 0 },
    histograms: {
      a: [{ count: 1, endMs: 5, startMs: 5 }],
      b: [],
    },
    lookIndex: 1,
    runId: "run-0003",
    status: "running",
  });
  const zeroRangeRect = descendants(documentRef.getElementById("histogram-output"))
    .find((node) => node.attributes.get("class")?.includes("histogram-bar-a"));
  assert.ok(Number(zeroRangeRect.attributes.get("width")) > 0);
  assert.ok(descendants(documentRef.getElementById("histogram-output"))
    .some((node) => node.attributes.get("class") === "histogram-series-b"));

  source.fail();
  await timers.advance(1_000);
  completed.resolve(response({
    evidence: {
      sensitivityMs: 3.5,
      statistics: null,
      stopReason: "max-samples-inconclusive",
      warnings: [],
    },
    histograms: {
      a: [{ count: 1, endMs: 2, startMs: 1 }],
      b: [{ count: 1, endMs: 2, startMs: 1 }],
    },
    inference: { sensitivityMs: 3.5, stopReason: "max-samples-inconclusive", verdict: "INCONCLUSIVE" },
    progress: {
      accepted: { a: 1, b: 1 },
      attempts: { a: 1, b: 1 },
      discarded: { a: 0, b: 0 },
      errors: { a: 0, b: 0 },
    },
    reportUrl: "/api/scans/run-0003/report",
    runId: "run-0003",
    status: "complete",
    verdict: "INCONCLUSIVE",
  }));
  await flushMicrotasks();
  assert.equal(dashboard.state.phase, "done");
  assert.equal(documentRef.getElementById("verdict-badge").textContent, "INCONCLUSIVE");
  assert.equal(documentRef.getElementById("histogram-output").children[0].tagName, "svg");
  assert.equal(descendants(documentRef.getElementById("histogram-output")).filter(
    (node) => node.attributes.get("class")?.includes("histogram-bar-a"),
  ).length, 1);
  assert.equal(descendants(documentRef.getElementById("histogram-output")).filter(
    (node) => node.attributes.get("class")?.includes("histogram-bar-b"),
  ).length, 1);
  assert.equal(documentRef.getElementById("evidence-sensitivity").textContent, "3.50 ms");

  dashboard.destroy();
  const noSamplesPost = deferred();
  const noSamplesCompleted = deferred();
  const noSamplesFetch = (url, options = {}) => {
    if (url === "/api/targets") {
      return Promise.resolve(response(METADATA));
    }
    if (url === "/api/scans" && options.method === "POST") {
      return noSamplesPost.promise;
    }
    if (url === "/api/scans/run-0004") {
      return noSamplesCompleted.promise;
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  const noSamples = createDashboardHarness(noSamplesFetch);
  await flushMicrotasks();
  noSamples.documentRef.getElementById("scan-form").dispatchEvent({ preventDefault() {}, type: "submit" });
  noSamplesPost.resolve(response({ runId: "run-0004", status: "running" }, { status: 202 }));
  await flushMicrotasks();
  const noSamplesSource = FakeEventSource.instances[0];
  noSamplesSource.fail();
  await noSamples.timers.advance(1_000);
  noSamplesCompleted.resolve(response({
    evidence: { sensitivityMs: null, statistics: null, stopReason: "data-quality-failure", warnings: [] },
    histograms: { a: [], b: [] },
    inference: { sensitivityMs: null, stopReason: "data-quality-failure", verdict: "INCONCLUSIVE" },
    progress: {
      accepted: { a: 0, b: 0 },
      attempts: { a: 2, b: 2 },
      discarded: { a: 2, b: 2 },
      errors: { a: 1, b: 1 },
    },
    runId: "run-0004",
    status: "complete",
    verdict: "INCONCLUSIVE",
  }));
  await flushMicrotasks();
  assert.match(
    descendants(noSamples.documentRef.getElementById("histogram-output"))
      .map((node) => node.textContent)
      .join(" "),
    /INCONCLUSIVE — no accepted samples to plot/,
  );
  assert.equal(noSamples.documentRef.getElementById("evidence-sensitivity").textContent, "unavailable");
  noSamples.dashboard.destroy();
});
