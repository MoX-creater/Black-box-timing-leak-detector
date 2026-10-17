# Technical Plan: Black-box Timing Leak Detector

**Status:** Draft for review
**Source:** `PRD.md` and `AGENTS.md`

## Uncertain decisions to resolve during implementation

- Candidate low percentile is **p10**; the percentile and interpolation rule must be confirmed by deterministic tests and benchmark evidence.
- Alpha, target power, bootstrap count, look batch, minimum/maximum samples, timeout, and discard-rate limits are configuration decisions, not measured results; do not publish defaults until benchmarked.
- The pinned stack does not include Socket.io. Use native SSE for this release; define compatible event names below in case a Socket.io adapter is later approved.
- Render provides one Docker Web Service, while Compose requires separate demo processes. The planned Render image therefore uses a small Node launcher to supervise three child processes; verify this in the first deployment smoke test.

## 1. Architecture

### Components

- **Shared PRNG (`src/prng.js`):** seeded integer/draw helpers used by request ordering, demo noise, and benchmarks. Never expose a second random source.
- **Detector (`src/detector/`):** owns paired interleaving, bounded execution, monotonic timing, status validation, adaptive looks, and progress callbacks.
- **HTTP transport (`src/http/`):** builds redacted request metadata and uses `undici` with one bounded client/pool, timeouts, body consumption, and typed errors.
- **Statistics (`src/stats/`):** percentile, Mann-Whitney U, low-tail effect, bootstrap sensitivity, and verdict calculations. Keep this module independent of HTTP.
- **Reports (`src/report/`):** validates and serializes the configuration/observation/inference schema; redacts secrets before output.
- **CLI (`src/cli/`):** parses the minimal config/flags, applies the authorization gate, runs the detector, and writes one JSON report to stdout or a file.
- **Web/API (`src/server/`):** serves static assets, exposes the demo-only allowlist, rate-limits starts, owns bounded active-run state, and streams progress.
- **Demo apps (`src/demos/`):** vulnerable and fixed authentication-shaped services with the same response contract and seeded noise middleware.
- **Dashboard (`public/`):** browser-native HTML/CSS/ES modules; renders progress, A/B histograms, verdicts, and the active report download.
- **Benchmarks (`bench/`):** scripts that run real local targets and write `bench/results.json` only from measured output.

### Data flow

```text
CLI config + flags
        |
        v
  authorization gate --> Detector --> request builder --> undici --> arbitrary authorized target
                              |             |                 |
                              |             +--> redacted report
                              +--> Stats --> progress/report

Browser --> Express web/API :3000 --> demo allowlist --> Run manager --> Detector
   ^             |                                  |           |
   |             +--> static dashboard/Benchmarks   |           +--> vulnerable :3001
   |                                                +-----------> fixed      :3002
   +<---------------- SSE progress + report download

bench scripts --> Detector --> local demo targets --> real measured bench/results.json
```

The web server never accepts a destination URL from the browser. It maps an
internal `targetId` to an internal service URL. The CLI is the only arbitrary-
URL path. The web process keeps only bounded active-run state in memory and
expires completed reports; it does not create scan history.

## 2. Key technical decisions

- **Mann-Whitney U, not a t-test:** timings are commonly skewed, heavy-tailed,
  tied, and outlier-prone. U tests a rank/distribution shift without assuming
  normality. A t-test remains a useful diagnostic but cannot be the verdict
  test. Use tie-aware ranks and a two-sided decision because either account
  type may be slower.
- **Low-tail percentile difference, not only a mean:** report the signed
  `Q(A) - Q(B)` difference at the selected low percentile and its absolute
  magnitude in milliseconds. This preserves the requested low-percentile
  effect and avoids hiding the practical signal behind a mean.
- **`undici`, not raw sockets:** it is the pinned Node HTTP client, handles
  connection reuse and response bodies, and reduces transport code. Raw sockets
  would add parsing, timeout, pooling, and cleanup risk without improving the
  measurement. Start the monotonic timer immediately before the request and
  stop only after the body is consumed.
- **Sequential randomized pairs, not concurrent batches:** each round contains
  one A and one B; the seeded PRNG decides which is sent first. This guarantees
  interleaving while avoiding queueing and CPU contention created by concurrent
  requests. Throughput is deliberately sacrificed for cleaner comparisons.
- **Monotonic duration, not wall-clock time:** use `process.hrtime.bigint()` (or
  an injected monotonic clock in tests). `Date.now()` is unsuitable because
  system-clock corrections can change elapsed time.
- **Explicit warmup, never hidden samples:** use one recorded-but-excluded A/B
  warmup pair to establish connections. Report warmup outcomes separately;
  never silently mix them into the statistical sample.
- **Status baseline from the first valid pair:** after warmup, the first valid A
  and B responses must have the same status. That status becomes the expected
  status for the run; later errors, mismatches, and unexpected statuses are
  discarded and counted. A baseline mismatch is `INCONCLUSIVE`.
- **Native browser UI, not a frontend framework:** the dashboard needs one
  live view and avoids an unapproved dependency, build pipeline, and bundle.
- **SSE, not Socket.io for this release:** progress is one-way server-to-browser
  traffic, so native `EventSource` is sufficient and keeps dependencies pinned.
  The event names/payloads below are intentionally Socket.io-compatible if a
  dependency is approved later.
- **In-memory run manager, not a database:** the PRD requires no accounts,
  history, or persistence. Bound active runs, expire reports, and clean up on
  completion, client disconnect, timeout, or child-process failure.
- **Node launcher on Render, not a supervisor package:** Compose retains three
  services, but one Render Web Service must host the web and demo processes.
  `child_process.spawn` plus signal forwarding avoids adding a dependency.
  Multiple Render services were rejected for free-tier complexity and private
  networking uncertainty.
- **Real CPU noise, not `sleep()`:** seeded middleware selects bounded real hash
  work to vary response cost. The vulnerable/fixed distinction remains the
  scrypt work in the demo itself. No branch uses sleep to manufacture the leak.

## 3. Statistical design

### Sampling and observations

1. Validate the run configuration, create a seeded PRNG, and record the seed.
2. Execute exactly one A/B warmup pair; `warmupPairs` is not configurable.
   Send warmup requests without an expected status. The transport classifies a
   2xx response as accepted and errors, timeouts, redirects, and other statuses
   as discarded. Record the warmup attempts, but exclude them from inference.
3. For each measured round, draw the order of `[A, B]` from the PRNG and send
   requests sequentially through the same transport settings.
4. After both warmup responses are accepted, require their status codes to
   match and use that status as the expected measured-request baseline. Record
   monotonic duration only for a measured response whose body was fully
   consumed and whose status matches that baseline.
5. Record every attempt as accepted, request error/timeout, unexpected status,
   or status mismatch, split by A/B. Never substitute or impute discarded
   durations.
6. Look only after a configured batch of new valid observations in both groups;
   this prevents a run from making a decision from one overrepresented group.

### Test and effect

- Rank the combined accepted durations with midranks for ties.
- Compute U, the rank-biserial/rank direction for diagnostics, and a two-sided
  p-value using a tie-corrected normal approximation for normal-sized samples.
  An exact no-tie calculation for small samples is preferred if it fits the
  four-day implementation; otherwise mark small-sample results inconclusive.
- Candidate low percentile is `q = 0.10`, using one documented interpolation
  algorithm. Report `lowPercentileA`, `lowPercentileB`, signed
  `lowPercentileDeltaMs = Qq(A) - Qq(B)`, and its absolute value.
- Treat the percentile choice and exact small-sample p-value path as uncertain
  until known-reference unit tests and real benchmark runs support them.

### Sensitivity / minimum detectable difference

Use a seeded nonparametric bootstrap of the accepted A and B samples:

```text
for each bootstrap replicate:
  resample A and B independently with replacement
  d* = Qq(A*) - Qq(B*)
SEq = sample standard deviation(d*) using replicates - 1
MDE_ms = (z_(1-alpha_look/2) + z_(target_power)) * SEq
```

If there are fewer than two bootstrap replicates, or `SEq` is zero or
non-finite, sensitivity is unavailable and the run is `INCONCLUSIVE` with
stop reason `sensitivity-unavailable`. Bootstrap draws use a fixed,
domain-separated `bootstrap` seed stream derived from the run seed.

`MDE_ms` is the report's run-specific sensitivity. The report must include the
bootstrap method, seed stream, sample counts, look alpha, target power, and
whether the value was unavailable because the samples were insufficient or
degenerate. Alpha, target power, bootstrap count, and minimum sample sizes are
configuration values still awaiting benchmark/implementation selection; they
must not be presented as measured facts.

This is an operational approximation for a low-quantile effect, not a universal
claim about the endpoint.

### Adaptive stopping and verdict calculation

- Use a predeclared finite maximum number of looks derived from the maximum
  sample budget and look batch. Split the total alpha budget across looks
  (initial implementation: conservative equal alpha allocation) and record
  `lookIndex`, `maxLooks`, and `alphaAtLook`.
- Stop early with `LEAK` only when the two-sided Mann-Whitney rule passes at the
  current look **and** `abs(lowPercentileDeltaMs) >= MDE_ms` **and** data quality
  passes. This prevents a statistically significant but practically tiny
  result from becoming a leak claim.
- Stop early with `INCONCLUSIVE` for a baseline status mismatch, fatal transport
  failure, unavailable sensitivity, or configured discard/data-quality failure.
- Otherwise continue paired rounds. At the maximum useful limit, return
  `NO LEAK DETECTED (sensitivity >= MDE_ms)` only when data quality passes, the
  final p-value does not pass its allocated alpha, and the observed absolute
  low-percentile effect is below `MDE_ms`. If those conditions do not hold,
  return `INCONCLUSIVE`.
- Include the stop reason, final counts, p-value/U, effect, sensitivity, and
  warnings in every verdict. A histogram never decides a verdict by itself.

The exact alpha, power, sample budgets, discard limits, and q percentile are
flagged decisions. They require implementation tests and real benchmark output
before becoming documented defaults.

## 4. API and CLI contract

### Public HTTP API

All API errors use `{ "error": { "code": "...", "message": "safe text" } }`.
Messages never include target URLs, request bodies, cookies, or response data.

- `GET /healthz` returns `200 {"status":"ok"}` only when the web process is
  ready to serve. It does not probe arbitrary destinations.
- `GET /api/targets` returns the fixed allowlist and noise choices:

  ```json
  {
    "targets": [
      {"id": "vulnerable", "label": "Vulnerable demo"},
      {"id": "fixed", "label": "Fixed demo"}
    ],
    "noisePresets": [{"id": "none", "label": "Noisy setting label"}]
  }
  ```

  The actual preset list and values come from server configuration; URLs are
  never returned.
- `POST /api/scans` accepts only `{ "targetId": "vulnerable", "noisePresetId":
  "none" }`. The server assigns the next seed from its configured PRNG stream.
  It returns `202`:

  ```json
  {"runId":"run-0001","status":"running","targetId":"vulnerable","noisePresetId":"none"}
  ```

  Reject unknown fields/IDs. Return `429` when the start rate limit or active
  run bound is exceeded; return `400` for invalid input.
- `GET /api/scans/:runId` returns a current snapshot for polling fallback:

  ```json
  {
    "runId": "run-0001",
    "status": "running",
    "progress": {
      "attempts": {"a": 4, "b": 4},
      "accepted": {"a": 3, "b": 3},
      "discarded": {"a": 1, "b": 1},
      "errors": {"a": 0, "b": 1}
    },
    "histograms": {"a": [], "b": []},
    "verdict": null
  }
  ```

  Completed snapshots include the inference summary and `reportUrl`; active
  runs only expose accepted samples/histogram bins needed by the UI.
- `GET /api/scans/:runId/events` returns `text/event-stream`. It emits the
  events below and sends a keepalive comment. Disconnecting the browser does
  not silently abandon the scan; the run manager applies its bounded cleanup
  policy.
- `GET /api/scans/:runId/report` returns the completed run's JSON report with
  `Content-Disposition: attachment`. It is available only during the bounded
  active-report retention window; there is no history endpoint.
- `GET /` serves the dashboard; `GET /benchmarks` serves the static page that
  reads `bench/results.json` or renders its explicit unavailable state.

### Progress event contract

These are logical event names. Native SSE uses `event: <name>` and JSON in the
data field. If Socket.io is later approved, emit the same names and payloads:

- `scan:started`: `{runId, targetId, noisePresetId}`.
- `scan:progress`: `{runId, attempts, accepted, discarded, errors, histograms,
  lookIndex, status}`. Histograms are bounded bins, not unbounded raw event
  streams.
- `scan:complete`: `{runId, status:"complete", verdict, sensitivityMs,
  stopReason, reportUrl}`.
- `scan:error`: `{runId, status:"failed", code, message}` with sanitized text.
- `scan:expired`: `{runId, status:"expired"}` when the active report is gone.

### CLI contract

Proposed invocation (exact npm script spelling is an implementation detail):

```bash
npm run detect -- \
  --config scan.json \
  --method POST \
  --header 'content-type: application/json' \
  --header 'x-example: value' \
  --cookie 'session=redacted' \
  --body '{"password":"example"}' \
  --i-am-authorized
```

The JSON config keeps the distinct templates; common flags overlay common
transport fields. A proposed schema is:

```json
{
  "method": "POST",
  "headers": {"content-type": "application/json"},
  "cookies": {"session": "secret"},
  "a": {
    "url": "https://authorized.example/login",
    "body": {"type": "json", "value": {"username": "known", "password": "x"}}
  },
  "b": {
    "url": "https://authorized.example/login",
    "body": {"type": "json", "value": {"username": "missing", "password": "x"}}
  },
  "seed": "benchmark-seed"
}
```

A and B must share method, body type, header set and URL path; only body field values (the identity) may differ. The request builder rejects mismatched pairs and warns when body lengths differ by more than 8 bytes.

`--method` overrides the common method. Each `--header` and `--cookie` adds or
overrides one common value. `--body` is a common raw override; its encoding
follows `content-type` (`application/json` parses JSON and form content sends
URL-encoded fields). Distinct A/B bodies remain in the config. The final body
flag grammar is uncertain and must be kept minimal.

The CLI parses URLs before networking. Hosts `localhost`, `127.0.0.1`, and
`[::1]` are local; every other host requires literal `--i-am-authorized`. Print
a warning to stderr before the first request on the authorized path. Missing
flag, invalid config, malformed header/cookie, or unsafe URL exits before any
request. Print the redacted JSON report to stdout; use stderr for diagnostics.
Exit-code mapping should be `0` for a completed LEAK/NO LEAK result, `2` for
INCONCLUSIVE, and `1` for input/runtime failure; confirm this during CLI tests.

## 5. Deployment design

### Local Docker Compose

```text
web       :3000 (host 3000 only)
  -> http://vulnerable:3001 (internal only)
  -> http://fixed:3002      (internal only)

vulnerable :3001 (no host port)
fixed      :3002 (no host port)
```

`compose.yaml` defines three services from the pinned image/build context,
with command overrides for the two demo processes, plus healthchecks for each app, and `depends_on` readiness for the web service.
The demo services share the same source but different mode configuration. The
web service receives only internal target IDs and service names. Do not publish
3001 or 3002.

### Image and process layout

- `Dockerfile` uses `node:22.23.3-bookworm-slim`, copies the package manifests,
  runs `npm ci`, copies source/public/bench files, and exposes only 3000.
- The normal container command starts the web process. The Render entrypoint
  starts vulnerable, fixed, and web child processes on 3001, 3002, and `$PORT`
  (default 3000), forwards SIGTERM/SIGINT, and exits if a required child dies.
- Use a Node healthcheck against `http://127.0.0.1:${PORT:-3000}/healthz`; do not
  rely on curl being present.
- Bind the public server to `0.0.0.0`; bind demo listeners to the container
  network interface needed by Compose/launcher, never to a host-published port.
- Render is the target host: a Dockerfile-backed Web Service on the free
  `onrender.com` subdomain. Set the health path to `/healthz` and document
  cold-start latency and the fact that scans are ephemeral.

The launcher is a deliberate hackathon compromise. If Render cannot reliably
run the three child processes, fallback to one web process with in-process demo
handlers for the deployed service while retaining separate Compose processes;
do not add a supervisor dependency without approval.

## 6. Four-day schedule and cut-lines

### Day 1 — detector core

**Deliverable:** shared PRNG, request builder/transport, paired interleaving,
status/error accounting, statistics interfaces, report schema, and reference-
value tests. Add the CLI authorization gate with a local fake transport.

**Cut first if behind:** CLI output polish and optional exact-small-sample path.
Do not cut deterministic fixtures, redaction, status accounting, or all three
verdict paths.

### Day 2 — demos and reproducible runs

**Deliverable:** vulnerable/fixed services, real `scrypt` behavior, seeded noise
middleware, Compose topology, healthchecks, and a benchmark script that can
produce real local output without committing fabricated results.

**Cut first if behind:** multiple named noise presets and benchmark-page
styling. Keep one configured preset, both demos, and the real benchmark path.

### Day 3 — web product

**Deliverable:** allowlisted API, rate limiting/active-run bounds, SSE progress,
polling fallback, dashboard controls, bounded histograms, verdict display, and
JSON report download.

**Cut first if behind:** histogram animation and visual polish. Keep the target
allowlist, live or polling progress, exact verdict explanation, and report.

### Day 4 — evidence and release

**Deliverable:** real benchmark runs, measured sensitivity/default decision,
statistical regression tests, Docker smoke test, Render deployment, README
setup/deploy/cold-start instructions, and final safety review.

**Cut first if behind:** optional Socket.io adapter, extra chart detail, and
nonessential copy. Never cut `npm test`, the deployed demo, safety gates,
benchmark provenance, or honest `INCONCLUSIVE` behavior.

Do not make the next day dependent on a fabricated benchmark result. Keep a
visible unavailable state until a real run has produced `bench/results.json`.

## 7. Top five technical risks and fallbacks

1. **Host/network noise masks or mimics the demo signal.** Use sequential paired
   requests, identical transport settings, seeded local noise, and conservative
   quality gates. If the signal is not stable, return `INCONCLUSIVE` and report
   the measured limitation; do not tune a claim to one lucky run.
2. **Low-percentile bootstrap sensitivity is unstable at small sample sizes.**
   Require minimum valid observations and bootstrap stability checks. If they
   fail, omit the sensitivity and return `INCONCLUSIVE`; fall back to a longer
   bounded run rather than substituting a mean-based metric.
3. **Public scan abuse or SSRF/resource exhaustion.** Keep browser inputs to two
   IDs, resolve URLs only from a server allowlist, rate-limit starts, cap active
   runs, enforce timeouts, bound event/report state, and clean up disconnects.
   If abuse appears, disable public starts while leaving static pages available.
4. **Render cannot supervise three processes in one free Web Service.** First
   validate the launcher and child shutdown behavior in the image. Fallback to
   in-process demo handlers for Render or, only with approval, separate hosted
   services; keep Compose's separate internal demo processes unchanged.
5. **SSE disconnects or browser support causes lost live progress.** Make every
   snapshot pollable through `GET /api/scans/:runId`, reconnect SSE from the last
   snapshot, and expire abandoned runs. The scan result and report must remain
   correct even when live updates fail.
