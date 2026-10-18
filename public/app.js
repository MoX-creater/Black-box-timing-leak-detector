const POLL_INTERVAL_MS = 1_000;
const MAX_POLL_FAILURES = 5;
const START_COOLDOWN_MS = 1_000;
const NO_LEAK_VERDICT = "NO_LEAK_DETECTED";
const SIDE_CHANNEL_NOTE = "A NO LEAK DETECTED result does not prove universal absence of timing side channels.";

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

function emptyState() {
  return {
    cooldownActive: false,
    cooldownTimer: null,
    errorMessage: "",
    eventSource: null,
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
    .filter((bin) => bin.startMs !== null && bin.endMs !== null);
  return {
    a: normalize(histograms?.a),
    b: normalize(histograms?.b),
  };
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
    "load-status",
    "noise-select",
    "progress-message",
    "run-button",
    "scan-form",
    "scan-status",
    "side-channel-note",
    "target-select",
    "verdict-badge",
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
