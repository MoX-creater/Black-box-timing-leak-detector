# Product Requirements Document: Black-box Timing Leak Detector

**Status:** Draft for review
**Project:** `Black-box-timing-leak-detector`
**Build window:** Solo hackathon, four days
**Primary runtime:** JavaScript/Node.js only

## 1. Product summary

Black-box Timing Leak Detector tests whether a web login or password-reset endpoint reveals account existence through response-time differences. It does not inspect application source code. It sends two request types in an interleaved, randomized order:

- **A:** a request for a known-existing user;
- **B:** a request for a nonexistent user.

The detector compares the observed timing distributions with a Mann-Whitney U test and reports an effect size for the low end of those distributions. It stops adaptively when the evidence is sufficient, the run reaches its useful limit, or the data quality prevents a responsible conclusion.

The product must prefer an honest `INCONCLUSIVE` result over an unsupported claim. Its user-visible verdicts are:

- `LEAK`;
- `NO LEAK DETECTED (sensitivity >= X ms)`; or
- `INCONCLUSIVE`.

`X` is not a hardcoded product claim. It is a minimum detectable difference computed from the collected run and reported with the actual measured value. The default user-configurable sensitivity threshold remains **TBD, measured in the benchmark** until real benchmark runs establish it.

## 2. Problem and opportunity

Authentication endpoints can expose whether an account exists even when their HTTP status and response body are identical. A meaningful timing difference can be difficult to see by manually sending a few requests because network noise, request ordering, and outliers obscure the signal.

The hackathon product should make this narrow question easy to test and easy to interpret without pretending that a noisy or underpowered run proves security. A reproducible CLI is useful for arbitrary authorized targets, while a constrained public demo gives visitors a safe way to understand the result without turning the hosted service into an arbitrary URL scanner.

## 3. Goals

### 3.1 Primary goals

1. Detect or fail to detect timing differences between two request templates using interleaved randomized sampling.
2. Quantify evidence with a Mann-Whitney U test, a low-percentile effect-size view, and a run-specific minimum detectable difference.
3. Stop adaptively and classify the result as `LEAK`, `NO LEAK DETECTED`, or `INCONCLUSIVE` with an explanation and data-quality counts.
4. Make every demo and benchmark run reproducible with a seeded PRNG.
5. Provide a minimal CLI for explicitly authorized arbitrary targets.
6. Provide a public single-page demo dashboard that can scan only the two built-in demo applications.
7. Ship a runnable, portable Node.js project with Docker, Docker Compose, pinned dependencies, an exact lockfile, and one `npm test` command.

### 3.2 Non-goals

- Scanning arbitrary URLs from the public web UI.
- Proving that an endpoint is free of every timing side channel.
- Source-code or binary analysis.
- User accounts, authentication, a database, or stored scan history.
- A general-purpose load-testing or monitoring service.
- Serverless deployment.
- Java, Spring, or any non-Node implementation.
- Claiming benchmark performance, accuracy, or a default threshold before a real benchmark has produced the values.

## 4. Users and first-use outcomes

### 4.1 Public demo visitor

The visitor wants to understand how a vulnerable and a fixed authentication endpoint differ under controlled noise.

**First-use outcome:** select a built-in target, choose an available noise level, start a scan, watch progress, inspect overlaid timing histograms and the verdict explanation, then download the JSON report.

### 4.2 Authorized engineer using the CLI

The engineer has permission to test an endpoint and has two request templates: one for an existing account and one for a nonexistent account.

**First-use outcome:** provide a JSON config and request overrides, explicitly confirm authorization for non-localhost targets, run a bounded detector, and receive a report that includes the result, evidence, discarded samples, and the run's measured sensitivity.

## 5. Product surfaces

### 5.1 Public demo dashboard

The public web application is a single demo dashboard. It must offer:

- a target selector containing only the built-in vulnerable and fixed demo applications;
- a noise-level selector backed by the server's configured demo presets;
- a start/run action;
- live progress while the scan is running;
- accepted and discarded sample counts, current progress, and the current evidence state;
- overlaid timing histograms for A and B, using the samples from the current run;
- a verdict badge with the exact verdict category;
- a concise explanation of the evidence, sensitivity, and data quality; and
- a download action for the JSON report of that run.

The dashboard must not accept a user-entered arbitrary URL, arbitrary request headers, or arbitrary request body. It must select demo targets by an internal identifier so the public service cannot be used as a general SSRF or endpoint scanner.

There are no accounts, database writes, or stored scan-history pages. A report is available for download for the active run, but the service does not retain a completed run as product data.

### 5.2 Static Benchmarks page

Add one static `Benchmarks` page that renders `bench/results.json`.

- The file must contain only results from real, reproducible benchmark runs.
- No placeholder, fabricated, or hand-tuned metric may be presented as a result.
- The page must identify the benchmark input/configuration, seed, build version, and measured outputs sufficiently for a reader to reproduce it.
- Until real benchmark runs exist, the page must show an explicit "benchmark data not yet available" state rather than invented numbers.
- The page may summarize benchmark outcomes, but it must not silently turn them into permanent product guarantees.

### 5.3 CLI

The CLI is the only surface that may target an arbitrary URL. It must stay minimal and support:

- a JSON config file containing request template A and request template B;
- request method selection;
- repeatable additional headers;
- cookies;
- JSON request bodies;
- form request bodies;
- an explicit `--i-am-authorized` confirmation for every non-localhost target; and
- a warning when that authorization confirmation is used.

The CLI must reject a non-localhost run without the explicit confirmation. The authorization check is a safety gate, not proof that the user is authorized. The CLI must not add unrelated scanning, crawling, or enumeration features.

The CLI config and overrides must make it possible to express different A and B bodies or parameters while sharing common method, headers, cookies, and transport settings where appropriate. The final config schema and command examples belong in the implementation documentation and must include safe redaction guidance for credentials and cookies.

## 6. Detector behavior

### 6.1 Sampling

For each attempt, the detector chooses A or B through a seeded PRNG and sends requests in the resulting interleaved order. It must not send all A requests followed by all B requests, because that would confound account type with time-varying network or server conditions.

The seed must be recorded in the report. Given the same detector version, configuration, seed, demo behavior, and controlled environment, the sampling decisions and seeded demo jitter must be reproducible.

### 6.2 Timing measurement

Measure request duration using a monotonic clock. The report must distinguish raw attempts from valid samples and must not silently drop errors or invalid responses.

The detector must count at least:

- attempts for A and B;
- accepted samples for A and B;
- request errors/timeouts for A and B; and
- responses rejected because the status is unexpected or the A/B status validation fails.

The exact report field names may be finalized during implementation, but the counts and rejection reasons are part of the product contract.

### 6.3 Response validation

Both templates must produce the same expected status for a valid comparison. Samples with request errors or unexpected/mismatched status codes are discarded from statistical analysis and counted in the report. The run must surface a warning when discard rates or missing groups make the evidence unreliable.

The implementation must never treat a smaller accepted sample set as if the discarded requests had succeeded.

### 6.4 Statistical evidence

The report and dashboard must expose, with the actual values from the run:

- the two accepted timing samples or an equivalent data representation;
- the Mann-Whitney U statistic and its decision output;
- low-percentile timing summaries for A and B;
- a low-percentile effect-size/difference view;
- the run-specific minimum detectable difference in milliseconds; and
- the rule inputs and data-quality warnings used for the verdict.

The statistical decision rule, adaptive stopping limits, low-percentile definition, and any significance/power constants must be explicit in code and the report. They must not be presented as measured facts until benchmarked. Any default numeric threshold marked TBD in this document must remain TBD in the product until a real benchmark justifies it.

### 6.5 Adaptive stopping and verdicts

The detector must evaluate evidence during the run and stop when its predefined stopping rule says that the run has enough evidence, or when the run reaches its configured useful limit. It must report why it stopped.

The verdict contract is:

- **`LEAK`:** the run meets the predeclared evidence rule for a meaningful timing difference, and the report shows the observed effect and measured sensitivity that support the claim.
- **`NO LEAK DETECTED (sensitivity >= X ms)`:** the run has enough valid data to support a negative finding at the displayed, computed sensitivity `X`; this means no leak was detected at or above that sensitivity, not that all timing differences are impossible.
- **`INCONCLUSIVE`:** the run cannot responsibly support either conclusion, including when data quality, inconsistent responses, noise, or stopping conditions prevent the required evidence.

The UI and CLI must show the verdict explanation, measured sensitivity, stop reason, valid sample counts, and discarded/error counts. A verdict must never be based only on a visually separated histogram.

## 7. Built-in demo applications

The vulnerable and fixed demo apps live in this repository and run as separate
processes in the same Docker Compose stack. They are reachable by the web
application/API over internal container networking. Only the web UI/API port
is public.

Both demo apps must expose the same simple authentication-shaped request
contract so the detector compares like with like. They must return the same
successful status and equivalent response shape for the existing and
nonexistent-user cases.

### 7.1 Vulnerable app

The vulnerable app must perform less real work when the user does not exist:

- existing-user requests perform a password verification hash;
- nonexistent-user requests skip that hash; and
- the response contract remains otherwise equivalent.

The timing difference must come from real computation. The implementation must
not use `sleep()` or an artificial delay to create the leak.

### 7.2 Fixed app

The fixed app must always perform a dummy password hash, including when the
user does not exist. Use Node.js `node:crypto` `scrypt` so the demo does not
require native dependencies. The fixed app must keep the external response
contract equivalent between A and B.

### 7.3 Seeded network noise

A middleware layer injects configurable jitter into demo responses using the
same reproducible PRNG approach as the detector. Jitter must model timing
noise without replacing the real-work distinction between the demo apps.

The configured jitter value, seed, and behavior must be included in the report.
The dashboard's noise selector may expose named presets, but their actual
values must be documented from the implementation and benchmarked before any
preset is described as a performance or detection guarantee.

## 8. Run reports

Every completed scan must produce a JSON report that can be downloaded from
the dashboard or written by the CLI. A report is an audit trail for one run,
not a stored history record.

At minimum, the report must contain:

- report schema/version;
- detector/build version;
- target kind and safe target identifier or redacted target metadata;
- request-template identifiers, with secrets, cookies, and credentials
  redacted or omitted;
- PRNG seed and relevant noise configuration;
- start/end timestamps and stop reason;
- attempted, accepted, discarded, error, and status-validation counts split by
  A and B where applicable;
- the accepted timing data or a documented lossless/adequate representation;
- status-validation details without leaking sensitive response bodies;
- Mann-Whitney U outputs;
- low-percentile summaries and effect-size outputs;
- the computed minimum detectable difference in milliseconds;
- the exact verdict and a human-readable explanation; and
- warnings, including data-quality limitations.

All numeric values in a report must be measured or calculated from that run.
A report may contain configuration values, such as a selected jitter setting,
that are not measurements; those fields must be labeled as configuration rather
than observed results.

## 9. Reproducibility and benchmark contract

The project must use a seeded PRNG for randomized sampling and demo jitter.
The seed must be controllable for benchmark runs and visible in reports. The
same benchmark command must be runnable offline after dependencies are
installed.

`bench/results.json` is a checked-in artifact only after its contents have been
created by real runs. Each result must retain enough provenance to identify:

- the exact code/dependency version;
- benchmark target and configuration;
- seed;
- environment assumptions that affect timing; and
- the raw or summarized measured outputs used to set any default.

The benchmark must be used to decide the default sensitivity threshold and to
record the real behavior of vulnerable, fixed, and noisy demo cases. Until
that run is complete, the default is explicitly **TBD, measured in benchmark**
and the UI/docs must not invent a number.

The product must distinguish these concepts:

- **configuration:** what the run was asked to do;
- **observation:** timing/status/error data collected from requests; and
- **inference:** statistical calculations and the verdict derived from those
  observations.

This distinction must be visible in the report and prevent a configuration
value from being mistaken for a measured metric.

## 10. Technical and operational requirements

These are product delivery requirements for this four-day build:

- JavaScript/Node.js only.
- Express may serve the web/API surface and demo apps; `undici` must be used
  for outbound HTTP requests where the implementation needs an HTTP client.
- Exact dependency versions must be pinned in `package.json` and a committed
  lockfile must be used with `npm ci`.
- A Dockerfile must install all required system packages and dependencies and
  build/run the project on a clean Linux machine.
- Docker Compose must start the web UI/API and the two demo processes as
  separate services/processes with only the web UI/API port exposed to the
  host.
- `npm test` must be the single documented test command and must work offline
  after dependencies are available.
- Runtime versions must be pinned in the repository.
- No secrets may be committed; provide `.env.example` for configurable values.
- The README must contain exact setup, run, test, deploy, and cold-start steps.
- The deployment target is Render as a Dockerfile-backed Web Service using the
  free `onrender.com` subdomain. No custom domain is required.
- The source of truth is a GitHub repository.

The implementation must keep the public service stateless. In-memory state may
exist for an active scan, but it must be bounded, cleaned up when the run
finishes or disconnects, and never treated as durable history.

## 11. Safety, privacy, and abuse boundaries

- Public dashboard requests are mapped to an allowlist of built-in demo target
  identifiers. They must not accept arbitrary destination URLs.
- CLI runs against non-localhost destinations require the literal explicit
  authorization flag and print a warning before requests begin.
- Headers, cookies, bodies, URLs, and reports must avoid printing secrets by
  default. Downloadable CLI reports must redact sensitive request metadata.
- The detector must not log full response bodies unless a future, explicit
  product decision adds safe redaction.
- Request limits, timeouts, and active-run cleanup must prevent an abandoned
  browser connection from holding resources forever.
- The report must disclose discarded samples and errors rather than silently
  filtering them.
- Public copy must explain that a `NO LEAK DETECTED` result is bounded by its
  measured sensitivity and does not prove universal absence of a side channel.

## 12. Success criteria

The four-day build is successful when all of the following are demonstrably
true in a clean checkout:

1. A visitor can use the public dashboard to select either built-in demo app,
   select a configured noise level, run a scan, see live progress, inspect
   overlaid A/B timing histograms, view the verdict, and download that run's
   JSON report.
2. The dashboard cannot be used to submit an arbitrary URL.
3. The vulnerable demo's difference is caused by skipped real password-hash
   work, not `sleep()`.
4. The fixed demo always performs a `node:crypto` `scrypt` dummy hash.
5. A CLI user can supply two request templates and the requested method,
   headers, cookies, and JSON/form bodies, subject to the authorization gate.
6. Interleaving and seeded randomness are visible in implementation tests or
   report evidence, and a seeded benchmark can be reproduced.
7. Errors and status-validation failures are discarded from analysis but
   counted in the report.
8. The report contains actual statistical outputs, low-percentile effect
   information, the computed sensitivity, stop reason, and exact verdict.
9. The detector can return all three verdict categories through tested
   evidence/data-quality paths; no category is chosen from a fabricated metric.
10. `npm test` passes offline after installation, Docker Compose starts the
    complete local stack, and the Dockerfile is the documented Render deploy
    artifact.
11. `bench/results.json` and the Benchmarks page contain only real benchmark
    results, or the page explicitly shows that benchmark data is not yet
    available.

## 13. Acceptance tests for the first release

The implementation plan should turn these into automated tests where practical
and a short manual smoke test where browser behavior is involved:

- **Target safety:** a dashboard request can select only the two built-in target
  IDs; an arbitrary URL is rejected or impossible to submit.
- **Authorization gate:** a non-localhost CLI target fails without
  `--i-am-authorized`, and the authorized path emits a warning. Localhost does
  not require that flag.
- **Request construction:** A and B preserve their distinct templates while
  method, repeatable headers, cookies, JSON bodies, and form bodies are
  represented correctly.
- **Interleaving:** a seeded run produces an order containing both A and B
  decisions without a fixed all-A-then-all-B phase.
- **Validation accounting:** request failures and status mismatches do not
  enter either timing sample and increment the appropriate report counters.
- **Statistics:** a deterministic fixture with known input samples produces
  stable Mann-Whitney and low-percentile calculations for a fixed seed/version.
- **Verdict honesty:** insufficient or invalid data produces `INCONCLUSIVE`;
  the negative verdict includes the computed sensitivity; all verdicts include
  a stop reason and warnings where relevant.
- **Demo semantics:** the vulnerable path omits the hash only for the
  nonexistent-user case; the fixed path executes the dummy `scrypt` hash for
  both cases; neither path calls `sleep()`.
- **Noise reproducibility:** the same demo seed and jitter configuration give
  the same injected-noise sequence in a controlled test.
- **Report redaction:** secrets in request metadata are not emitted in the
  downloadable report or default logs.
- **Packaging:** `npm ci`, `npm test`, and the documented Docker Compose flow
  work from a clean checkout without global dependencies.

## 14. Decisions intentionally deferred until benchmark/implementation

The following must be resolved in code and recorded in the next planning
artifacts without inventing values in this PRD:

- default sensitivity threshold;
- exact low-percentile definition;
- statistical significance/evidence constants;
- minimum and maximum adaptive sample limits;
- timeout and request concurrency values;
- named jitter preset values;
- exact CLI command spelling and JSON schema field names; and
- the final benchmark run matrix and measured results.

These are not permission to omit the behavior. They are explicit gates: choose,
implement, measure, and record them before publishing a numeric claim.

## 15. Four-day delivery boundary

The first release prioritizes one complete, honest path over breadth:

- **Day 1:** detector core, seeded sampling, request templates, validation,
  report shape, and unit tests.
- **Day 2:** vulnerable/fixed demo services, seeded jitter, Compose wiring, and
  benchmark harness.
- **Day 3:** dashboard, live progress, histograms, verdict presentation,
  report download, and CLI polish.
- **Day 4:** real benchmark runs, threshold decision, packaging, Render deploy,
  smoke test, README, and cleanup.

The schedule is a prioritization aid, not evidence that the work is complete.
Every measured claim must come from a real run.
