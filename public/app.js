const POLL_INTERVAL_MS = 1_000;
const MAX_POLL_FAILURES = 5;
const START_COOLDOWN_MS = 1_000;
const NO_LEAK_VERDICT = "NO_LEAK_DETECTED";
const SIDE_CHANNEL_NOTE = "A NO LEAK DETECTED result does not prove universal absence of timing side channels.";
const SVG_NS = "http://www.w3.org/2000/svg";
const WARNING_LABELS = Object.freeze({
  BODY_LENGTH_DIFFERENCE: "A/B request body lengths differed.",
  DISCARD_RATE_DIFFERENCE: "A/B discard rates differed materially.",
});

const EVENT_NAMES = Object.freeze([
  "scan:started",
  "scan:progress",
  "scan:complete",
  "scan:error",
  "scan:expired",
]);

function emptyCounts() {
  return {
    attempts: { a: 0, b: 0 },
    accepted: { a: 0, b: 0 },
    discarded: { a: 0, b: 0 },
    errors: { a: 0, b: 0 },
  };
}

function emptyEvidence() {
  return {
    sensitivityMs: null,
    statistics: null,
    stopReason: null,
    warnings: [],
  };
}

function emptyState() {
  return {
    cooldownActive: false,
    cooldownTimer: null,
    errorMessage: "",
    eventSource: null,
    evidence: emptyEvidence(),
    evidenceMessage: "The detector will report the evidence state from the current run.",
    generation: 0,
    histograms: { a: [], b: [] },
    lookIndex: 0,
    message: "Loading demo choices…",
    metadata: { noisePresets: [], targets: [] },
    metadataReady: false,
    phase: "idle",
    pollFailures: 0,
    pollInFlight: false,
    pollTimer: null,
    progress: emptyCounts(),
    reportUrl: null,
    runId: null,
    selectedNoisePresetId: "",
    selectedTargetId: "",
    sensitivityMs: null,
    sseMode: "unavailable",
    stopReason: null,
    verdict: null,
  };
}

function isActive(state) {
  return state.phase === "starting" || state.phase === "running";
}

function safeCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function safeNumber(value) {
  return Number.isFinite(value) ? value : null;
}

function copyPair(value) {
  return {
    a: safeCount(value?.a),
    b: safeCount(value?.b),
  };
}

function normalizeProgress(progress) {
  return {
    accepted: copyPair(progress?.accepted),
    attempts: copyPair(progress?.attempts),
    discarded: copyPair(progress?.discarded),
    errors: copyPair(progress?.errors),
  };
}

function normalizeHistograms(histograms) {
  const normalize = (bins) => (Array.isArray(bins) ? bins : [])
    .map((bin) => ({
      count: safeCount(bin?.count),
      endMs: safeNumber(bin?.endMs),
      startMs: safeNumber(bin?.startMs),
    }))
    .filter((bin) => bin.startMs !== null
      && bin.endMs !== null
      && bin.startMs <= bin.endMs)
    .slice(0, 64);
  return {
    a: normalize(histograms?.a),
    b: normalize(histograms?.b),
  };
}

function normalizeStatistics(statistics) {
  if (!statistics || typeof statistics !== "object") {
    return null;
  }
  const mannWhitney = statistics.mannWhitney;
  const lowPercentile = statistics.lowPercentile;
  if (!mannWhitney || !lowPercentile) {
    return null;
  }
  const normalized = {
    lowPercentile: {
      a: safeNumber(lowPercentile.a),
      absoluteDelta: safeNumber(lowPercentile.absoluteDelta),
      b: safeNumber(lowPercentile.b),
      method: lowPercentile.method === "linear-type-7" ? lowPercentile.method : null,
      probability: safeNumber(lowPercentile.probability),
      signedDelta: safeNumber(lowPercentile.signedDelta),
    },
    mannWhitney: {
      degenerate: typeof mannWhitney.degenerate === "boolean" ? mannWhitney.degenerate : null,
      pValue: safeNumber(mannWhitney.pValue),
      uA: safeNumber(mannWhitney.uA),
      uB: safeNumber(mannWhitney.uB),
      z: safeNumber(mannWhitney.z),
    },
  };
  if (Object.values(normalized.lowPercentile).some((value) => value === null)
    || Object.values(normalized.mannWhitney).some((value) => value === null)) {
    return null;
  }
  return normalized;
}

function normalizeWarnings(warnings) {
  if (!Array.isArray(warnings)) {
    return [];
  }
  return warnings.flatMap((warning) => {
    if (warning?.code === "BODY_LENGTH_DIFFERENCE" && Number.isFinite(warning.differenceBytes)) {
      return [{ code: warning.code, differenceBytes: warning.differenceBytes }];
    }
    if (warning?.code === "DISCARD_RATE_DIFFERENCE"
      && Number.isFinite(warning.rateA)
      && Number.isFinite(warning.rateB)) {
      return [{ code: warning.code, rateA: warning.rateA, rateB: warning.rateB }];
    }
    return [];
  });
}

function normalizeEvidence(evidence) {
  return {
    sensitivityMs: safeNumber(evidence?.sensitivityMs),
    statistics: normalizeStatistics(evidence?.statistics),
    stopReason: typeof evidence?.stopReason === "string" ? evidence.stopReason : null,
    warnings: normalizeWarnings(evidence?.warnings),
  };
}

function fixedNumber(value, digits = 2) {
  return Number.isFinite(value) ? value.toFixed(digits) : "unavailable";
}

function fixedMilliseconds(value, digits = 2) {
  return Number.isFinite(value) ? `${fixedNumber(value, digits)} ms` : "unavailable";
}

function formatSensitivity(value) {
  return Number.isFinite(value) ? value.toFixed(2) : null;
}

function formatVerdict(verdict, sensitivityMs) {
  if (verdict === "LEAK") {
    return "LEAK";
  }
  if (verdict === NO_LEAK_VERDICT) {
    const sensitivity = formatSensitivity(sensitivityMs);
    return sensitivity === null
      ? "NO LEAK DETECTED (sensitivity unavailable)"
      : `NO LEAK DETECTED (sensitivity >= ${sensitivity} ms)`;
  }
  if (verdict === "INCONCLUSIVE") {
    return "INCONCLUSIVE";
  }
  return "Waiting for a scan";
}

function statusLabel(phase) {
  if (phase === "starting") {
    return "Starting";
  }
  if (phase === "running") {
    return "Running";
  }
  if (phase === "done") {
    return "Complete";
  }
  if (phase === "failed") {
    return "Needs attention";
  }
  return "Idle";
}

function verdictClass(verdict, phase) {
  if (phase === "failed") {
    return "verdict verdict-failed";
  }
  if (phase === "running" || phase === "starting") {
    return "verdict verdict-running";
  }
  if (verdict === "LEAK") {
    return "verdict verdict-leak";
  }
  if (verdict === NO_LEAK_VERDICT) {
    return "verdict verdict-safe";
  }
  if (verdict === "INCONCLUSIVE") {
    return "verdict verdict-inconclusive";
  }
  return "verdict verdict-idle";
}

function metadataEntries(value, fields) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((entry) => typeof entry?.id === "string" && typeof entry?.label === "string")
    .map((entry) => ({ id: entry[fields.id], label: entry[fields.label] }));
}

class ApiRequestError extends Error {
  constructor(status, code, message) {
    super(message || "The request failed");
    this.name = "ApiRequestError";
    this.code = code;
    this.status = status;
  }
}

async function readJsonResponse(response) {
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok) {
    throw new ApiRequestError(
      response.status,
      body?.error?.code,
      body?.error?.message,
    );
  }
  return body;
}

export function createDashboard({
  document: documentRef = globalThis.document,
  EventSourceImpl = globalThis.EventSource,
  fetchImpl = typeof globalThis.fetch === "function" ? globalThis.fetch.bind(globalThis) : null,
  timers = { clearTimeout, setTimeout },
} = {}) {
  if (!documentRef || typeof fetchImpl !== "function") {
    throw new TypeError("Dashboard requires document and fetch implementations");
  }

  const ids = [
    "dashboard",
    "error-message",
    "evidence-summary",
    "evidence-delta",
    "evidence-discarded-a",
    "evidence-discarded-b",
    "evidence-errors-a",
    "evidence-errors-b",
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
  ];
  for (const prefix of ["attempts", "accepted", "discarded", "errors"]) {
    ids.push(`${prefix}-a`, `${prefix}-b`);
  }
  const elements = Object.fromEntries(ids.map((id) => [id, documentRef.getElementById(id)]));
  const state = emptyState();

  function currentRun(generation) {
    return generation === state.generation && state.runId !== null && isActive(state);
  }

  function renderOptions(select, entries, selectedId) {
    const options = entries.map((entry) => {
      const option = documentRef.createElement("option");
      option.value = entry.id;
      option.textContent = entry.label;
      return option;
    });
    select.replaceChildren(...options);
    select.value = selectedId;
  }

  function svgElement(name, attributes = {}) {
    const element = documentRef.createElementNS(SVG_NS, name);
    for (const [attribute, value] of Object.entries(attributes)) {
      element.setAttribute(attribute, String(value));
    }
    return element;
  }

  function svgText(text, attributes = {}) {
    const element = svgElement("text", attributes);
    element.textContent = text;
    return element;
  }

  function chartBins(group) {
    return state.progress.accepted[group] > 0 ? state.histograms[group] : [];
  }

  function renderLegend() {
    const aKey = documentRef.createElement("span");
    aKey.className = "legend-key";
    const aSwatch = documentRef.createElement("span");
    aSwatch.className = "legend-swatch legend-a";
    aSwatch.setAttribute("aria-hidden", "true");
    const aLabel = documentRef.createElement("span");
    aLabel.textContent = "A accepted";
    aKey.append(aSwatch, aLabel);

    const bKey = documentRef.createElement("span");
    bKey.className = "legend-key";
    const bSwatch = documentRef.createElement("span");
    bSwatch.className = "legend-swatch legend-b";
    bSwatch.setAttribute("aria-hidden", "true");
    const bLabel = documentRef.createElement("span");
    bLabel.textContent = "B accepted";
    bKey.append(bSwatch, bLabel);
    elements["histogram-legend"].replaceChildren(aKey, bKey);
  }

  function renderHistogramTable(groups) {
    const scroll = documentRef.createElement("div");
    scroll.className = "histogram-table-scroll";
    const table = documentRef.createElement("table");
    table.className = "histogram-table";
    const caption = documentRef.createElement("caption");
    caption.textContent = "Accepted timing bins, in milliseconds";
    table.append(caption);
    const head = documentRef.createElement("thead");
    const headerRow = documentRef.createElement("tr");
    for (const label of ["Group", "Start (ms)", "End (ms)", "Accepted count"]) {
      const cell = documentRef.createElement("th");
      cell.scope = "col";
      cell.textContent = label;
      headerRow.append(cell);
    }
    head.append(headerRow);
    table.append(head);
    const body = documentRef.createElement("tbody");
    let rowCount = 0;
    for (const group of groups) {
      for (const bin of group.bins) {
        const row = documentRef.createElement("tr");
        for (const value of [
          group.label,
          fixedNumber(bin.startMs),
          fixedNumber(bin.endMs),
          String(bin.count),
        ]) {
          const cell = documentRef.createElement("td");
          cell.textContent = value;
          row.append(cell);
        }
        body.append(row);
        rowCount += 1;
      }
    }
    if (rowCount === 0) {
      const row = documentRef.createElement("tr");
      const cell = documentRef.createElement("td");
      cell.colSpan = 4;
      cell.textContent = "No accepted samples are available.";
      row.append(cell);
      body.append(row);
    }
    table.append(body);
    scroll.append(table);
    return scroll;
  }

  function renderHistogram() {
    const binsA = chartBins("a");
    const binsB = chartBins("b");
    const groups = [
      { bins: binsA, label: "A" },
      { bins: binsB, label: "B" },
    ];
    const allBins = [...binsA, ...binsB];
    const totalAccepted = state.progress.accepted.a + state.progress.accepted.b;
    const minMs = allBins.length > 0 ? Math.min(...allBins.map((bin) => bin.startMs)) : 0;
    const maxMs = allBins.length > 0 ? Math.max(...allBins.map((bin) => bin.endMs)) : 1;
    const zeroRange = minMs === maxMs;
    const domainMax = zeroRange ? minMs + 1 : maxMs;
    const domainRange = domainMax - minMs;
    const width = 720;
    const height = 360;
    const margin = { bottom: 56, left: 64, right: 20, top: 20 };
    const plotWidth = width - margin.left - margin.right;
    const plotHeight = height - margin.top - margin.bottom;
    const maxCount = Math.max(1, ...allBins.map((bin) => bin.count));
    const svg = svgElement("svg", {
      "aria-labelledby": "histogram-title histogram-description",
      class: "histogram-svg",
      role: "img",
      viewBox: `0 0 ${width} ${height}`,
    });
    const title = svgElement("title", { id: "histogram-title" });
    title.textContent = "Accepted A and B response timing histogram";
    const description = svgElement("desc", { id: "histogram-description" });
    description.textContent = "Overlaid accepted response duration bins for groups A and B. Discarded requests are excluded.";
    const defs = svgElement("defs");
    const pattern = svgElement("pattern", {
      height: 8,
      id: "histogram-pattern-b",
      patternTransform: "rotate(0)",
      patternUnits: "userSpaceOnUse",
      width: 8,
    });
    pattern.append(svgElement("rect", { class: "pattern-background", height: 8, width: 8 }));
    pattern.append(svgElement("path", {
      class: "pattern-line",
      d: "M-2,2 L2,-2 M0,8 L8,0 M6,10 L10,6",
    }));
    defs.append(pattern);
    svg.append(title, description, defs);

    const plot = svgElement("g", { class: "histogram-plot" });
    const yScale = (value) => margin.top + plotHeight - ((value / maxCount) * plotHeight);
    const xScale = (value) => margin.left + (((value - minMs) / domainRange) * plotWidth);
    const yTicks = [0, maxCount / 2, maxCount];
    for (const tick of yTicks) {
      const y = yScale(tick);
      plot.append(svgElement("line", {
        class: "histogram-grid",
        x1: margin.left,
        x2: margin.left + plotWidth,
        y1: y,
        y2: y,
      }));
      plot.append(svgText(String(Number.isInteger(tick) ? tick : tick.toFixed(1)), {
        class: "histogram-tick-label",
        textAnchor: "end",
        x: margin.left - 8,
        y: y + 4,
      }));
    }
    plot.append(svgElement("line", {
      class: "histogram-axis",
      x1: margin.left,
      x2: margin.left,
      y1: margin.top,
      y2: margin.top + plotHeight,
    }));
    plot.append(svgElement("line", {
      class: "histogram-axis",
      x1: margin.left,
      x2: margin.left + plotWidth,
      y1: margin.top + plotHeight,
      y2: margin.top + plotHeight,
    }));
    const xTicks = [...new Set([minMs, minMs + (domainRange / 2), domainMax])];
    for (const tick of xTicks) {
      const x = xScale(tick);
      plot.append(svgElement("line", {
        class: "histogram-tick",
        x1: x,
        x2: x,
        y1: margin.top + plotHeight,
        y2: margin.top + plotHeight + 6,
      }));
      plot.append(svgText(fixedNumber(tick), {
        class: "histogram-tick-label",
        textAnchor: "middle",
        x,
        y: margin.top + plotHeight + 22,
      }));
    }
    plot.append(svgText("Accepted samples (count)", {
      class: "histogram-axis-label",
      textAnchor: "middle",
      transform: `rotate(-90 16 ${margin.top + (plotHeight / 2)})`,
      x: 16,
      y: margin.top + (plotHeight / 2),
    }));
    plot.append(svgText("Response duration (ms)", {
      class: "histogram-axis-label",
      textAnchor: "middle",
      x: margin.left + (plotWidth / 2),
      y: height - 12,
    }));

    for (const [index, group] of groups.entries()) {
      const series = svgElement("g", {
        "aria-label": `${group.label} accepted samples`,
        class: `histogram-series-${group.label.toLowerCase()}`,
      });
      for (const bin of group.bins) {
        if (bin.count <= 0) {
          continue;
        }
        const rawX = xScale(bin.startMs);
        const rawWidth = xScale(bin.endMs) - rawX;
        const barWidth = zeroRange ? 10 : Math.max(3, rawWidth - 2);
        const x = zeroRange
          ? margin.left + (plotWidth / 2) - (barWidth / 2)
          : rawX + 1;
        const y = yScale(bin.count);
        series.append(svgElement("rect", {
          class: `histogram-bar histogram-bar-${group.label.toLowerCase()}`,
          height: Math.max(1, margin.top + plotHeight - y),
          width: barWidth,
          x,
          y,
        }));
      }
      plot.append(series);
      if (index === 0) {
        plot.append(svgText("A", {
          class: "histogram-label",
          x: margin.left + 6,
          y: margin.top + 16,
        }));
      }
    }
    if (binsB.length > 0) {
      plot.append(svgText("B", {
        class: "histogram-label",
        x: margin.left + 28,
        y: margin.top + 16,
      }));
    }
    svg.append(plot);

    const message = documentRef.createElement("p");
    message.className = "histogram-empty";
    if (totalAccepted === 0) {
      message.textContent = "INCONCLUSIVE — no accepted samples to plot.";
      elements["histogram-status"].textContent = "No accepted samples are available for the histogram.";
    } else if (allBins.length === 0) {
      message.textContent = "Accepted samples exist, but histogram bins are unavailable.";
      elements["histogram-status"].textContent = "Histogram bins are unavailable.";
    } else {
      message.textContent = "Discarded requests are not plotted.";
      elements["histogram-status"].textContent = "Showing accepted response timing bins.";
    }
    const table = renderHistogramTable(groups);
    elements["histogram-output"].replaceChildren(svg, message, table);
  }

  function renderEvidence() {
    const statistics = state.evidence.statistics;
    const lowPercentile = statistics?.lowPercentile;
    const mannWhitney = statistics?.mannWhitney;
    elements["evidence-u-a"].textContent = fixedNumber(mannWhitney?.uA);
    elements["evidence-u-b"].textContent = fixedNumber(mannWhitney?.uB);
    elements["evidence-p-value"].textContent = fixedNumber(mannWhitney?.pValue, 4);
    elements["evidence-percentile-a"].textContent = fixedMilliseconds(lowPercentile?.a);
    elements["evidence-percentile-b"].textContent = fixedMilliseconds(lowPercentile?.b);
    elements["evidence-delta"].textContent = lowPercentile
      ? `${fixedNumber(lowPercentile.signedDelta)} ms (absolute ${fixedNumber(lowPercentile.absoluteDelta)} ms)`
      : "unavailable";
    elements["evidence-sensitivity"].textContent = state.evidence.sensitivityMs === null
      ? "unavailable"
      : `${fixedNumber(state.evidence.sensitivityMs)} ms`;
    elements["evidence-stop-reason"].textContent = state.evidence.stopReason ?? "unavailable";
    elements["evidence-discarded-a"].textContent = String(state.progress.discarded.a);
    elements["evidence-discarded-b"].textContent = String(state.progress.discarded.b);
    elements["evidence-errors-a"].textContent = String(state.progress.errors.a);
    elements["evidence-errors-b"].textContent = String(state.progress.errors.b);
    const warningItems = state.evidence.warnings.map((warning) => {
      const item = documentRef.createElement("li");
      item.textContent = WARNING_LABELS[warning.code] ?? "Warning unavailable.";
      if (warning.code === "BODY_LENGTH_DIFFERENCE") {
        item.textContent += ` Difference: ${fixedNumber(warning.differenceBytes, 0)} bytes.`;
      }
      if (warning.code === "DISCARD_RATE_DIFFERENCE") {
        item.textContent += ` A: ${fixedNumber(warning.rateA * 100, 1)}%; B: ${fixedNumber(warning.rateB * 100, 1)}%.`;
      }
      return item;
    });
    if (warningItems.length === 0) {
      const item = documentRef.createElement("li");
      item.textContent = state.evidence.statistics === null ? "unavailable" : "No warnings recorded.";
      warningItems.push(item);
    }
    elements["warning-list"].replaceChildren(...warningItems);
  }

  function render() {
    const active = isActive(state);
    const canRun = state.metadataReady && !active && !state.cooldownActive;
    renderOptions(elements["target-select"], state.metadata.targets, state.selectedTargetId);
    renderOptions(elements["noise-select"], state.metadata.noisePresets, state.selectedNoisePresetId);
    elements["target-select"].disabled = !state.metadataReady || active;
    elements["noise-select"].disabled = !state.metadataReady || active;
    elements["run-button"].disabled = !canRun;
    elements.dashboard.setAttribute("aria-busy", active || !state.metadataReady ? "true" : "false");

    elements["load-status"].textContent = state.metadataReady
      ? "Demo choices ready."
      : state.phase === "failed" && state.errorMessage
        ? "Demo choices unavailable."
        : "Loading demo choices…";
    elements["error-message"].hidden = state.errorMessage.length === 0;
    elements["error-message"].textContent = state.errorMessage;
    elements["scan-status"].textContent = statusLabel(state.phase);
    elements["progress-message"].textContent = state.message;
    elements["verdict-badge"].className = verdictClass(state.verdict, state.phase);
    elements["verdict-badge"].textContent = formatVerdict(state.verdict, state.sensitivityMs);
    elements["evidence-summary"].textContent = state.evidenceMessage;
    elements["side-channel-note"].textContent = SIDE_CHANNEL_NOTE;

    for (const prefix of ["attempts", "accepted", "discarded", "errors"]) {
      elements[`${prefix}-a`].textContent = String(state.progress[prefix].a);
      elements[`${prefix}-b`].textContent = String(state.progress[prefix].b);
    }
    renderLegend();
    renderHistogram();
    renderEvidence();
  }

  function clearPollingTimer() {
    if (state.pollTimer !== null) {
      timers.clearTimeout(state.pollTimer);
      state.pollTimer = null;
    }
  }

  function closeEventSource() {
    if (state.eventSource !== null) {
      state.eventSource.close();
      state.eventSource = null;
    }
    state.sseMode = "unavailable";
  }

  function stopLiveUpdates() {
    clearPollingTimer();
    closeEventSource();
  }

  function startCooldown() {
    if (state.cooldownTimer !== null) {
      timers.clearTimeout(state.cooldownTimer);
    }
    state.cooldownActive = true;
    state.cooldownTimer = timers.setTimeout(() => {
      state.cooldownTimer = null;
      state.cooldownActive = false;
      render();
    }, START_COOLDOWN_MS);
    render();
  }

  function setError(message, { cooldown = false } = {}) {
    state.phase = "failed";
    state.errorMessage = message;
    state.message = "The scan could not continue.";
    state.evidenceMessage = "No final inference is available for this run.";
    stopLiveUpdates();
    render();
    if (cooldown) {
      startCooldown();
    }
  }

  function applyProgress(payload) {
    state.progress = normalizeProgress(payload);
    state.histograms = normalizeHistograms(payload.histograms);
    state.lookIndex = safeCount(payload.lookIndex);
  }

  function applySnapshot(snapshot, generation) {
    if (!currentRun(generation) || snapshot?.runId !== state.runId) {
      return;
    }
    applyProgress(snapshot.progress ?? {});
    state.histograms = normalizeHistograms(snapshot.histograms);
    state.evidence = normalizeEvidence(snapshot.evidence);
    state.verdict = typeof snapshot.verdict === "string" ? snapshot.verdict : null;
    state.sensitivityMs = safeNumber(snapshot.inference?.sensitivityMs);
    state.stopReason = typeof snapshot.inference?.stopReason === "string"
      ? snapshot.inference.stopReason
      : null;
    if (snapshot.status === "complete") {
      state.reportUrl = typeof snapshot.reportUrl === "string" ? snapshot.reportUrl : null;
      state.phase = "done";
      state.message = "The scan finished.";
      state.evidenceMessage = state.stopReason
        ? `Stop reason: ${state.stopReason}.`
        : "The scan finished without a stop reason.";
      stopLiveUpdates();
    } else if (snapshot.status === "failed") {
      setError(`Scan failed (${snapshot.failureCode || "unknown"}).`);
      return;
    } else if (snapshot.status === "expired") {
      setError("This scan has expired and is no longer available.");
      return;
    } else {
      state.phase = "running";
      state.message = state.sseMode === "polling"
        ? "Polling for live progress."
        : "The scan is running.";
    }
    render();
  }

  function applyEvent(eventName, payload, generation) {
    if (!currentRun(generation) || payload?.runId !== state.runId) {
      return;
    }
    if (eventName === "scan:started") {
      state.phase = "running";
      state.message = "The scan is running.";
      render();
      return;
    }
    if (eventName === "scan:progress") {
      state.phase = "running";
      applyProgress(payload);
      state.message = "Live progress received.";
      render();
      return;
    }
    if (eventName === "scan:complete") {
      state.phase = "done";
      state.verdict = typeof payload.verdict === "string" ? payload.verdict : null;
      state.sensitivityMs = safeNumber(payload.sensitivityMs);
      state.stopReason = typeof payload.stopReason === "string" ? payload.stopReason : null;
      state.evidence = normalizeEvidence(payload.evidence);
      state.reportUrl = typeof payload.reportUrl === "string" ? payload.reportUrl : null;
      state.message = "The scan finished.";
      state.evidenceMessage = state.stopReason
        ? `Stop reason: ${state.stopReason}.`
        : "The scan finished without a stop reason.";
      stopLiveUpdates();
      render();
      return;
    }
    if (eventName === "scan:error") {
      setError(payload.message || "The scan failed.");
      return;
    }
    if (eventName === "scan:expired") {
      setError("This scan has expired and is no longer available.");
    }
  }

  function schedulePoll(generation) {
    if (!currentRun(generation) || state.pollTimer !== null || state.pollInFlight) {
      return;
    }
    state.pollTimer = timers.setTimeout(() => {
      state.pollTimer = null;
      void pollOnce(generation);
    }, POLL_INTERVAL_MS);
  }

  async function pollOnce(generation) {
    if (!currentRun(generation)) {
      return;
    }
    state.pollInFlight = true;
    try {
      const snapshot = await readJsonResponse(await fetchImpl(
        `/api/scans/${encodeURIComponent(state.runId)}`,
      ));
      if (!currentRun(generation)) {
        return;
      }
      state.pollFailures = 0;
      applySnapshot(snapshot, generation);
    } catch (error) {
      if (!currentRun(generation)) {
        return;
      }
      state.pollFailures += 1;
      if (state.pollFailures >= MAX_POLL_FAILURES) {
        setError("Live progress polling stopped after five consecutive failures.");
      } else {
        state.message = `Live progress unavailable; retrying (${state.pollFailures}/${MAX_POLL_FAILURES}).`;
        render();
      }
    } finally {
      state.pollInFlight = false;
      if (currentRun(generation) && state.pollFailures < MAX_POLL_FAILURES) {
        schedulePoll(generation);
      }
    }
  }

  function startPolling(generation) {
    if (!currentRun(generation)) {
      return;
    }
    state.sseMode = "polling";
    state.message = "Live updates reconnecting; polling fallback active.";
    render();
    schedulePoll(generation);
  }

  function parseEventData(event) {
    try {
      return JSON.parse(event.data);
    } catch {
      return null;
    }
  }

  function openEventSource(generation) {
    if (!EventSourceImpl || !currentRun(generation)) {
      startPolling(generation);
      return;
    }
    let source;
    try {
      source = new EventSourceImpl(`/api/scans/${encodeURIComponent(state.runId)}/events`);
    } catch {
      startPolling(generation);
      return;
    }
    state.eventSource = source;
    state.sseMode = "connecting";
    render();
    source.onopen = () => {
      if (state.eventSource !== source || !currentRun(generation)) {
        return;
      }
      state.sseMode = "stream";
      state.pollFailures = 0;
      clearPollingTimer();
      state.message = "Live progress connected.";
      render();
    };
    source.onerror = () => {
      if (state.eventSource !== source || !currentRun(generation)) {
        return;
      }
      startPolling(generation);
    };
    for (const eventName of EVENT_NAMES) {
      source.addEventListener(eventName, (event) => {
        const payload = parseEventData(event);
        if (payload !== null) {
          applyEvent(eventName, payload, generation);
        }
      });
    }
  }

  async function loadMetadata() {
    try {
      const metadata = await readJsonResponse(await fetchImpl("/api/targets"));
      const targets = metadataEntries(metadata?.targets, { id: "id", label: "label" });
      const noisePresets = metadataEntries(metadata?.noisePresets, { id: "id", label: "label" });
      if (targets.length === 0 || noisePresets.length === 0) {
        throw new Error("No usable demo choices were returned");
      }
      state.metadata = { noisePresets, targets };
      state.selectedTargetId = targets[0].id;
      state.selectedNoisePresetId = noisePresets[0].id;
      state.metadataReady = true;
      state.message = "Choose a demo and start a scan.";
      render();
    } catch {
      setError("Demo choices could not be loaded.");
    }
  }

  async function startScan() {
    const generation = state.generation;
    const body = {
      noisePresetId: state.selectedNoisePresetId,
      targetId: state.selectedTargetId,
    };
    try {
      const run = await readJsonResponse(await fetchImpl("/api/scans", {
        body: JSON.stringify(body),
        headers: { "content-type": "application/json" },
        method: "POST",
      }));
      if (generation !== state.generation || typeof run?.runId !== "string") {
        return;
      }
      state.runId = run.runId;
      state.phase = "running";
      state.evidence = emptyEvidence();
      state.progress = emptyCounts();
      state.histograms = { a: [], b: [] };
      state.lookIndex = 0;
      state.pollFailures = 0;
      state.message = "The scan is running.";
      state.errorMessage = "";
      state.evidenceMessage = "Waiting for enough evidence to classify this run.";
      render();
      openEventSource(generation);
    } catch (error) {
      if (generation !== state.generation) {
        return;
      }
      const message = error instanceof ApiRequestError && error.message
        ? error.message
        : "The scan could not be started.";
      setError(message, { cooldown: error instanceof ApiRequestError && error.status === 429 });
    }
  }

  function handleSubmit(event) {
    event.preventDefault();
    if (!state.metadataReady || isActive(state) || state.cooldownActive) {
      return;
    }
    stopLiveUpdates();
    state.generation += 1;
    state.runId = null;
    state.phase = "starting";
    state.errorMessage = "";
    state.evidence = emptyEvidence();
    state.verdict = null;
    state.sensitivityMs = null;
    state.stopReason = null;
    state.reportUrl = null;
    state.message = "Starting the scan…";
    state.evidenceMessage = "Preparing the bounded demo run.";
    // Render synchronously before the first await/fetch so a double click
    // cannot submit two scan starts.
    render();
    void startScan();
  }

  elements["scan-form"].addEventListener("submit", handleSubmit);
  elements["target-select"].addEventListener("change", () => {
    state.selectedTargetId = elements["target-select"].value;
    render();
  });
  elements["noise-select"].addEventListener("change", () => {
    state.selectedNoisePresetId = elements["noise-select"].value;
    render();
  });

  render();
  void loadMetadata();

  return {
    destroy() {
      state.generation += 1;
      stopLiveUpdates();
      if (state.cooldownTimer !== null) {
        timers.clearTimeout(state.cooldownTimer);
        state.cooldownTimer = null;
      }
    },
    elements,
    state,
  };
}

if (typeof document !== "undefined") {
  createDashboard();
}
