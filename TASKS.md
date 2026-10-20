# Implementation Tasks: Black-box Timing Leak Detector

Tasks are ordered within each day. Each task is deliberately scoped to one
agent session and one conventional commit. Run `npm test` after every code
change; never combine unrelated tasks in one commit.

## PRD requirement links

- **FR-01 — Detector:** interleaved seeded sampling, timing measurement, adaptive stopping, and all three honest verdicts (PRD §§3, 6).
- **FR-02 — Statistics:** Mann-Whitney U, low-percentile effect, sensitivity/MDE, and reference-value tests (PRD §§6.4, 13).
- **FR-03 — Request handling:** A/B templates, body/header/cookie construction, status validation, errors, and discard accounting (PRD §§5.3, 6.2–6.3).
- **FR-04 — CLI safety:** arbitrary authorized CLI targets, localhost exception, authorization warning, and minimal flags (PRD §5.3, §11).
- **FR-05 — Reports:** configuration/observation/inference schema, redaction, progress data, and downloadable JSON (PRD §8, §11).
- **FR-06 — Demos:** vulnerable/fixed real-work behavior and seeded configurable noise (PRD §7).
- **FR-07 — Public web:** demo-only target selection, live progress, histograms, verdict UI, and no history (PRD §5.1).
- **FR-08 — Reproducibility:** one shared seeded PRNG and real-only benchmark provenance (PRD §9).
- **FR-09 — Packaging/deploy:** pinned Node stack, lockfile, Docker, Compose, Render Web Service, and healthcheck (PRD §10).
- **FR-10 — Safety/operations:** allowlist, rate limits, active-run bounds, timeouts, cleanup, and public-port limits (PRD §11).
- **FR-11 — Release evidence:** acceptance coverage, README runbook, cold-start note, and clean-checkout verification (PRD §§10, 12–13).

## Day 1 — Core, packaging, and skeleton deployment

### T1.1 — [Must-have] Bootstrap the pinned Node.js project and test scripts.

- **Description:** Create `.nvmrc`, ESM `package.json`, exact Express/undici dependencies, lockfile, and `dev`, `test`, and `bench` scripts.
- **Acceptance:** `node --version` is `v22.23.3`; `npm ci` succeeds; `npm test` runs the Node test runner; `package.json` pins `express@5.3.0` and `undici@8.12.2`.
- **Dependencies:** None
- **Estimate:** S
- **Linked PRD:** FR-09, FR-11

### [x] T1.2 — [Must-have] Create the source/test layout and minimal health entrypoints.

- **Description:** Add the `src/`, `public/`, `bench/`, and `test/` structure plus a minimal ESM web health route and stub service entrypoints for packaging tests.
- **Acceptance:** `npm test` passes a real health/entrypoint smoke test; imports use explicit `.js` extensions; no CommonJS files are added.
- **Dependencies:** T1.1
- **Estimate:** S
- **Linked PRD:** FR-07, FR-09

### [x] T1.3 — [Must-have] Add the production Dockerfile and ignore rules.

- **Description:** Build a production image from `node:22.23.3-bookworm-slim` using `npm ci` and the repository entrypoint.
- **Acceptance:** `docker build -t black-box-timing-leak-detector:local .` succeeds; `docker run --rm -p 3000:3000 black-box-timing-leak-detector:local` serves `/healthz`; `.dockerignore` excludes dependencies, secrets, and generated output.
- **Dependencies:** T1.1, T1.2
- **Estimate:** M
- **Linked PRD:** FR-09

### [x] T1.4 — [Must-have] Add the three-service Docker Compose skeleton.

- **Description:** Define web, vulnerable, and fixed services with internal demo ports and only the web/API port published.
- **Acceptance:** `docker compose config` succeeds; `docker compose up --build -d` starts all skeleton services; `curl -fsS http://localhost:3000/healthz` succeeds; Compose publishes no host ports for demo services; `docker compose down -v` cleans up.
- **Dependencies:** T1.3
- **Estimate:** M
- **Linked PRD:** FR-06, FR-09, FR-10

### [x] T1.5 — [Must-have] Add the Render deployment skeleton.

- **Description:** Add the Docker Web Service configuration, health path, environment placeholders, and the production launcher entrypoint without performing the live deploy yet.
- **Acceptance:** `render.yaml` references `./Dockerfile`, the `/healthz` health check, and no secret values; the image builds with the launcher command; the launcher forwards termination to child processes in its smoke test.
- **Dependencies:** T1.3, T1.4
- **Estimate:** M
- **Linked PRD:** FR-09, FR-11

### [x] T1.6 — [Must-have] Implement the shared seeded PRNG and monotonic clock abstraction.

- **Description:** Provide deterministic seeded draws for sampling/noise and an injectable `process.hrtime.bigint()`-based duration clock.
- **Acceptance:** `node --test test/prng.test.js` proves identical seeds produce identical sequences and different seeds produce different sequences; `node --test test/clock.test.js` proves duration conversion; `rg 'Math\.random' src bench test` returns no matches.
- **Dependencies:** T1.2
- **Estimate:** S
- **Linked PRD:** FR-01, FR-08

### [x] T1.7 — [Must-have] Implement request-template validation and body/header/cookie construction.

- **Description:** Parse A/B JSON templates and support common method, repeatable headers, cookies, JSON bodies, and form bodies without losing A/B differences.
- **Acceptance:** `node --test test/request-builder.test.js` verifies JSON and form serialization, repeatable overrides, cookie formatting, method override, and distinct A/B payloads; malformed input fails before networking.
- **Dependencies:** T1.1, T1.6
- **Estimate:** M
- **Linked PRD:** FR-03, FR-04

### [x] T1.8 — [Must-have] Implement the CLI authorization gate and redaction primitives.

- **Description:** Reject non-localhost URLs without `--i-am-authorized`, warn before requests when authorized, allow the localhost exception, and redact sensitive metadata.
- **Acceptance:** `node --test test/authorization.test.js` proves non-localhost requests make zero transport calls without the flag, authorized runs emit a warning to stderr, localhost runs do not require it, and reports/logs omit cookie/body secrets.
- **Dependencies:** T1.7
- **Estimate:** M
- **Linked PRD:** FR-04, FR-05, FR-10

### [x] T1.9 — [Must-have] Implement the undici transport and attempt classification.

- **Description:** Measure request duration around a fully consumed response and classify accepted, error, timeout, unexpected-status, and mismatch outcomes.
- **Acceptance:** `node --test test/http-transport.test.js` uses a local fake server/clock to verify monotonic duration, body consumption, timeout/error causes, status classification, and no live-network dependency.
- **Dependencies:** T1.7, T1.8
- **Estimate:** M
- **Linked PRD:** FR-03, FR-05

### [x] T1.10 — [Must-have] Implement tested statistical primitives.

- **Description:** Add percentile interpolation, tie-aware Mann-Whitney U, low-percentile signed/absolute effect, and stable result schemas.
- **Acceptance:** `node --test test/stats.test.js` matches committed known reference values for U, p-value, percentiles, ties, and effect size; invalid/empty samples fail explicitly; `npm test` passes.
- **Dependencies:** T1.6
- **Estimate:** M
- **Linked PRD:** FR-02

### [x] T1.11 — [Must-have] Implement seeded sensitivity, adaptive stopping, and the detector loop.

- **Description:** Combine paired randomized rounds, bootstrap MDE, quality gates, stop reasons, and `LEAK`/`NO LEAK DETECTED`/`INCONCLUSIVE` decisions.
- **Acceptance:** `node --test test/detector.test.js test/inference.test.js` proves seeded interleaving, discard accounting, stable sensitivity for a fixture, early leak stopping, negative-at-sensitivity behavior, and inconclusive insufficient/invalid-data behavior; all rule inputs are reported.
- **Dependencies:** T1.6, T1.9, T1.10
- **Estimate:** L
- **Linked PRD:** FR-01, FR-02, FR-03, FR-08

### [x] T1.12 — [Must-have] Define and validate the run-report envelope.

- **Description:** Serialize configuration, observations, inference, seed, counts, stop reason, warnings, and redacted request metadata as one JSON report.
- **Acceptance:** `node --test test/report.test.js` validates required fields, distinguishes configuration/observation/inference, preserves error/discard counts, omits secrets, and round-trips a completed fixture.
- **Dependencies:** T1.8, T1.11
- **Estimate:** M
- **Linked PRD:** FR-05, FR-08

## Day 2 — Demo services, CLI flow, and benchmarks

### [x] T2.1 — [Must-have] Define the shared demo authentication contract and scrypt helper.

- **Description:** Create the same login-shaped request/response contract for both demos and an injectable `node:crypto` scrypt password-work helper.
- **Acceptance:** `node --test test/demo-contract.test.js` verifies existing and nonexistent requests have the same successful status and response shape; the helper is exercised through an injected fake in tests; no `sleep()` is used.
- **Dependencies:** T1.2, T1.10
- **Estimate:** M
- **Linked PRD:** FR-06

### [x] T2.2 — [Must-have] Implement vulnerable and fixed demo processes.

- **Description:** Make the vulnerable app skip the hash only for nonexistent users and make the fixed app run a dummy scrypt hash for both cases.
- **Acceptance:** `node --test test/demos.test.js` proves the vulnerable hasher call count differs by account existence, the fixed call count is equal for A/B, responses remain equivalent, and source contains no sleep-based delay.
- **Dependencies:** T2.1
- **Estimate:** M
- **Linked PRD:** FR-06

### [x] T2.3 — [Must-have] Implement seeded real-work noise middleware and named presets.

- **Description:** Add PRNG-driven bounded hash work with configurable noise settings while preserving the demo's real-work distinction.
- **Acceptance:** `node --test test/noise.test.js` proves the same seed/config produces the same work sequence, each preset is serializable as configuration, and `rg 'Math\.random|sleep\(' src/demos` returns no matches.
- **Dependencies:** T1.6, T2.2
- **Estimate:** M
- **Linked PRD:** FR-06, FR-08

### [x] T2.4 — [Must-have] Wire real demo services into Compose and healthchecks.

- **Description:** Replace stubs with vulnerable/fixed services and configure the web process to use only their internal service names and ports.
- **Acceptance:** `docker compose up --build -d` starts all services; healthchecks pass; a request from the web container reaches both demos; host access to demo ports fails; `docker compose down -v` removes the stack.
- **Dependencies:** T1.4, T2.2, T2.3
- **Estimate:** M
- **Linked PRD:** FR-06, FR-09, FR-10

### [x] T2.5 — [Must-have] Connect the minimal CLI command to the detector.

- **Description:** Add the CLI entrypoint that loads config, applies flags, runs the detector, prints a redacted JSON report, and maps verdict/runtime exit codes.
- **Acceptance:** `npm run detect -- --config test/fixtures/local.json` completes against a local fake/demo target; the non-localhost fixture fails without `--i-am-authorized`; authorized execution prints the warning and emits valid JSON; `npm test` passes.
- **Dependencies:** T1.8, T1.11, T1.12, T2.2
- **Estimate:** M
- **Linked PRD:** FR-03, FR-04, FR-05

### [x] T2.6 — [Must-have] Add the reproducible benchmark runner and unavailable-state contract.

- **Description:** Run the detector against real local vulnerable/fixed/noise cases and write provenance-rich results only when a real run is requested.
- **Acceptance:** `npm run bench` runs offline against local services or reports a clear unavailable state; a real run records seed, configuration, code/dependency version, environment, and measured outputs; no fabricated placeholder appears in `bench/results.json`.
- **Dependencies:** T2.4, T2.5
- **Estimate:** M
- **Linked PRD:** FR-02, FR-06, FR-08

### [x] T2.7 — [Must-have] Add deterministic demo/CLI integration coverage.

- **Description:** Exercise the CLI, both demos, status failures, transport errors, seeded noise, and report counters through local services.
- **Acceptance:** `npm test` passes without live internet; fixtures prove discarded samples never enter statistics, all errors are counted, seeds are recorded, and the report contains no secrets.
- **Dependencies:** T2.4, T2.5, T2.6
- **Estimate:** M
- **Linked PRD:** FR-01, FR-03, FR-05, FR-08

## Day 3 — Public API, dashboard, and report experience

### [x] T3.1 — [Must-have] Implement the demo-only target API and start validation.

- **Description:** Expose target/noise metadata and accept scan starts only by allowlisted internal IDs.
- **Acceptance:** `node --test test/api-targets.test.js` proves `/api/targets` returns no URLs, unknown IDs and extra URL fields are rejected, valid starts return `202`, and `/healthz` returns only a static readiness response and never probes or accepts a destination.
- **Dependencies:** T2.4, T2.7
- **Estimate:** M
- **Linked PRD:** FR-07, FR-10

### [x] T3.2 — [Must-have] Add bounded run management, rate limiting, and cleanup.

- **Description:** Track active scans in memory, enforce start/active limits, expire completed reports, and clean up disconnected or timed-out runs.
- **Acceptance:** `node --test test/run-manager.test.js` proves excess starts return `429`, active work is bounded, completed state expires, disconnect cleanup runs, and no persistent history is created.
- **Dependencies:** T3.1, T1.11, T1.12
- **Estimate:** M
- **Linked PRD:** FR-07, FR-10

### [x] T3.3 — [Must-have] Add snapshot polling and SSE progress events.

- **Description:** Expose run snapshots plus `scan:started`, `scan:progress`, `scan:complete`, `scan:error`, and `scan:expired` events.
- **Acceptance:** `node --test test/progress-api.test.js` starts a fake scan, verifies `GET /api/scans/:id`, parses `text/event-stream` events with bounded histogram bins, and confirms a disconnected client does not corrupt the result.
- **Dependencies:** T3.2
- **Estimate:** M
- **Linked PRD:** FR-05, FR-07, FR-10

### [x] T3.4 — [Must-have] Build the dashboard's functional scan flow.

- **Description:** Add browser-native target/noise controls, run action, live progress, counts, and verdict state using SSE with polling fallback.
- **Acceptance:** Start `npm run dev`, open `/`, select only vulnerable/fixed IDs, run a local scan, observe progress/count changes, and verify the browser sends no user-entered URL; static asset smoke tests pass under `npm test`.
- **Dependencies:** T3.1, T3.3
- **Estimate:** L
- **Linked PRD:** FR-07, FR-10

### [x] T3.5 — [Must-have] Render bounded overlaid A/B timing histograms and evidence details.

- **Description:** Draw accepted A/B timing bins and display U/p-value, low-percentile effect, sensitivity, stop reason, warnings, and discard counts.
- **Acceptance:** A completed local scan visibly renders separate overlaid A/B histograms and the exact verdict fields from its report; discarded samples are not plotted; a fixture with no accepted samples shows `INCONCLUSIVE`.
- **Dependencies:** T3.4, T1.12
- **Estimate:** M
- **Linked PRD:** FR-01, FR-02, FR-05, FR-07

### [x] T3.6 — [Must-have] Add active JSON report download and the Benchmarks page.

- **Description:** Serve the current run's redacted report and render real `bench/results.json` or its explicit unavailable state.
- **Acceptance:** `GET /api/scans/:id/report` returns the same validated redacted run report with fixed download headers during retention, distinguishes bounded expired IDs from unknown IDs, and exposes no hosts, ports, client keys, or server-stream seeds; `/benchmarks` serves only the validated fixed artifact route, displays the explicit unavailable state for missing/unreadable/invalid/unavailable data, and displays stored provenance, trial counts, Wilson intervals, and baseline fields without recalculation when complete data exists.
- **Dependencies:** T2.6, T3.2, T3.4
- **Estimate:** M
- **Linked PRD:** FR-05, FR-07, FR-08

### T3.7 — [Nice-to-have] Improve responsive visual polish without changing inference behavior.

- **Description:** Add accessible labels, responsive layout, verdict color/contrast, and optional histogram animation after the functional flow is complete.
- **Acceptance:** `npm test` remains green; keyboard navigation reaches controls; the same report produces the same verdict and histogram values before and after the visual change.
- **Dependencies:** T3.5, T3.6
- **Estimate:** S
- **Linked PRD:** FR-07, FR-11

## Day 4 — Evidence, live deployment, and release verification

### [x] T4.1 — [Must-have] Run the real benchmark matrix and record only measured outputs.

- **Description:** Execute vulnerable, fixed, and configured-noise benchmark cases with recorded seeds and environment provenance.
- **Acceptance:** `npm run bench` completes against the local stack; every committed `bench/results.json` record is produced by that script and contains seed/configuration/version/environment/observations; if a case cannot run, it remains explicitly unavailable rather than fabricated.
- **Dependencies:** T2.6, T3.6
- **Estimate:** L
- **Linked PRD:** FR-02, FR-06, FR-08

### [x] T4.2 — [Must-have] Calibrate documented defaults without changing the approved statistical approach.

- **Description:** Use real benchmark evidence to choose any default sensitivity/configuration values and update reports/docs while preserving the PRD's Mann-Whitney/low-percentile semantics.
- **Acceptance:** `npm test` passes reference-value stats, sensitivity, all verdict paths, and benchmark regression fixtures; every new numeric default is traceable to a real benchmark record; any proposed stats-method change is stopped for user approval.
- **Dependencies:** T4.1, T1.10, T1.11
- **Estimate:** M
- **Linked PRD:** FR-01, FR-02, FR-08, FR-11

### T4.3 — [Must-have] Complete the Render multi-process launcher and deploy the Web Service.

- **Description:** Run web/vulnerable/fixed processes in the Docker image, forward shutdown signals, configure the free Render Web Service, and verify the public subdomain.
- **Acceptance:** The production image passes its `/healthz` check; Render reports the service healthy; the public URL serves the dashboard, runs both built-in targets, and exposes no arbitrary target input; a cold start is observed and documented.
- **Dependencies:** T1.5, T2.4, T3.6
- **Estimate:** L
- **Linked PRD:** FR-07, FR-09, FR-10, FR-11

### [x] T4.4 — [Must-have] Finish the README and operational runbook.

- **Description:** Document exact install/dev/test/bench/Docker/Compose/CLI/Render commands, request schema, safety warning, redaction, benchmark honesty, and cold-start behavior.
- **Acceptance:** A reviewer can follow the README from a fresh checkout without undocumented flags; commands match `package.json`, `Dockerfile`, `compose.yaml`, and `render.yaml`; README contains no fabricated benchmark metric or secret.
- **Dependencies:** T4.1, T4.3
- **Estimate:** M
- **Linked PRD:** FR-04, FR-08, FR-09, FR-11

### [x] T4.5 — [Must-have] Perform the final safety, determinism, and scope audit.

- **Description:** Review the diff for arbitrary web URLs, unseeded randomness, sleeps, leaked metadata, unbounded runs, unpublished demo ports, generated noise, and unrelated changes.
- **Acceptance:** `git diff --check` is clean; `rg 'Math\.random|sleep\(' src bench test` returns no forbidden use; tests cover authorization, rate limits, redaction, discard accounting, and all verdicts; `docker compose config` publishes only the web port; `git status` contains only intended release files.
- **Dependencies:** T4.2, T4.3, T4.4
- **Estimate:** M
- **Linked PRD:** FR-01, FR-03, FR-05, FR-08, FR-10, FR-11

**Future work (needs approval): load/contention gate.** Define a bounded,
evidence-backed way to detect severe host or process contention before treating
a timing verdict as evidence. This follow-up is not implemented here.

### T4.6 — [Must-have] Verify the clean-clone release path last.

- **Description:** Reproduce the project from a fresh clone, bring up Compose, run the single test command, and tear down the stack.
- **Acceptance:** In a disposable directory, run `git clone <repo-url> clean-checkout`, `cd clean-checkout`, `npm ci`, `docker compose up --build -d`, wait for `curl -fsS http://localhost:3000/healthz`, then run `npm test` and finish with `docker compose down -v`; all commands succeed and the dashboard/demo smoke path works.
- **Dependencies:** T4.5
- **Estimate:** M
- **Linked PRD:** FR-06, FR-07, FR-09, FR-11
