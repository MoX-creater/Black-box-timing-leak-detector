# Black-box Timing Leak Detector

Black-box Timing Leak Detector tests whether an HTTP login or password-reset
endpoint reveals account existence through response-time differences. It does
not inspect application source code. It compares two request templates in a
seeded, interleaved run and reports the evidence, data quality, and an honest
verdict.

## The problem, in plain language

Imagine a receptionist checking people into a building. If the receptionist
spends the same amount of time checking every visitor, an observer learns less.
If the receptionist quickly turns away a person whose name is not in the list,
but spends much longer checking a person who is in the list, the time taken
becomes a clue about who is expected.

Authentication endpoints can create the same clue. A login or password-reset
request may return the same status and body for an existing and nonexistent
account while doing different amounts of work. A few manual requests are not a
reliable way to see that difference because network noise, request ordering,
and outliers can hide it.

## What it does

The detector sends two otherwise symmetric request types:

- **A:** a request for a known-existing identity;
- **B:** a request for a nonexistent identity.

It then:

1. interleaves A/B requests using a seeded PRNG;
2. records monotonic response durations and status outcomes;
3. counts discarded requests and transport errors instead of silently hiding
   them;
4. applies a Mann–Whitney U test and a low-percentile effect analysis;
5. computes a run-specific measured sensitivity (minimum detectable difference);
6. stops when evidence, the useful sample budget, or data quality requires it;
7. reports `LEAK`, `NO_LEAK_DETECTED`, or `INCONCLUSIVE` with the stop reason.

The public dashboard is deliberately restricted to the built-in vulnerable and
fixed demos. The CLI can test arbitrary endpoints, but only when the operator
is authorized to test them.

## Live demo

[Open the public dashboard](https://black-box-timing-leak-detector.onrender.com)

The hosted dashboard accepts only the built-in target IDs. It does not accept
arbitrary destination URLs. Scans are ephemeral and are not durable history.

## Requirements

- Node.js `22.23.3` and npm `10.9.9` (the versions are pinned in
  `package.json` and `.nvmrc`);
- Docker for the image and Compose sections;
- a Git checkout of this repository.

The project is ESM-only and has no frontend framework or additional runtime
dependency beyond the pinned packages in `package.json`.

## Quick start

From the repository root:

```bash
npm ci
npm run dev
```

Open <http://localhost:3000/> in a browser. The development server serves the
web/API process. The complete local vulnerable/fixed demo topology is provided
by Docker Compose below.

In a second terminal, the single documented test command is:

```bash
npm test
```

The test command is intended to work offline after `npm ci` has installed the
committed lockfile dependencies.

## Environment variables

`.env.example` is a reference list of variables read by the source code. The
application does **not** automatically load `.env`, and no `dotenv` package is
used. Supply variables through the shell that starts the process. The npm
scripts do not add a `--env-file` option.

Bash:

```bash
export TRUST_PROXY_HOPS=0
export SCAN_SEED=local-web-seed
npm run dev
```

PowerShell:

```powershell
$env:TRUST_PROXY_HOPS = "0"
$env:SCAN_SEED = "local-web-seed"
npm run dev
```

The shell values above are safe local examples. Do not put credentials or
tokens in tracked files. The CLI also supports `$ENV_NAME` references inside
headers and cookies in a config file; those names are chosen by the config and
are resolved from the process environment at runtime.

## Exact npm commands

These commands match `package.json`:

```bash
npm ci
npm run dev
npm test
npm run bench
npm run detect -- --config scan.json [options]
```

`npm run dev` starts `node --watch src/server/index.js`.
`npm test` runs `node --test`.
`npm run bench` runs `node bench/run.js`.
`npm run detect` runs `node src/cli/index.js`.

## Docker image

The Dockerfile uses `node:22.23.3-bookworm-slim`, installs the committed
production dependencies with `npm ci --omit=dev`, copies `src`, `public`, and
`bench`, exposes only port `3000`, and defaults to:

```text
node src/server/index.js
```

Build and run the image with the Dockerfile default command:

```bash
docker build -t black-box-timing-leak-detector:local .
docker run --rm -p 3000:3000 black-box-timing-leak-detector:local
```

This is a web-process smoke run. Check <http://localhost:3000/healthz>. The
default web process does not create the two demo processes by itself; use
Compose for the complete local stack or the explicit launcher command in the
Render section.

## Docker Compose

Compose starts three services from the same pinned Dockerfile/build context:

```text
web         host port 3000 -> container port 3000
vulnerable  internal port 3001 only
fixed       internal port 3002 only
```

Only the web port is published to the host. The web service waits for the two
demo healthchecks and sends requests to the internal service names.

Bash:

```bash
docker compose up --build
```

PowerShell:

```powershell
docker compose up --build
```

Check <http://localhost:3000/healthz> and <http://localhost:3000/> while the
foreground Compose process is running. Stop the stack from another terminal:

Bash:

```bash
docker compose down
```

PowerShell:

```powershell
docker compose down
```

Use `docker compose down`; no volume cleanup flag is needed because this stack
does not use a persistent volume for its ephemeral scan state.

## CLI usage

Show the implemented CLI help with:

```bash
npm run detect -- --help
```

The usage form is:

```text
npm run detect -- --config <file> [options]
```

Supported options are:

```text
--config <file>          JSON config containing request templates A and B (required)
--method <METHOD>        Override the common request method
--header <name: value>   Repeatable common header override
--cookie <name=value>    Repeatable common cookie override
--cookie-file <file>     Read common cookie entries from a file
--seed <seed>            Override the required detector seed
--i-am-authorized        Confirm authorization for non-localhost targets
--out <file>             Write the report instead of stdout
--force                  Allow replacing an existing --out file
--help                   Show this help
```

Bodies come from the A/B templates in the JSON config. The CLI deliberately
does not support a `--body` flag. Values typed directly in a shell can appear
in shell history; prefer environment references in the config or
`--cookie-file` for sensitive local inputs.

For a non-localhost target, the operator must explicitly confirm authorization
before any request is made:

```bash
npm run detect -- \
  --config scan.json \
  --i-am-authorized \
  --out report.json
```

The CLI prints a warning to stderr before the first authorized request. The
literal flag is not a substitute for permission from the target owner. For
`localhost`, `127.0.0.1`/the loopback range, and `::1`, the local pair does not
require that flag.

## CLI request schema

`scan.json` is a JSON object. The required top-level fields are
`defaultsStatus`, `method`, `a`, `b`, `seed`, and `detector`. Common `headers`
and `cookies`, `noise`, `requestTemplateIds`, and `target` are optional. The
following safe example uses documentation-only hostnames and placeholder
values; replace it only with a target you are authorized to test:

```json
{
  "defaultsStatus": "TBD",
  "method": "POST",
  "headers": {
    "content-type": "application/json"
  },
  "a": {
    "url": "https://authorized.example/login",
    "body": {
      "type": "json",
      "value": {
        "username": "known-example",
        "password": "placeholder-only"
      }
    }
  },
  "b": {
    "url": "https://authorized.example/login",
    "body": {
      "type": "json",
      "value": {
        "username": "missing-example",
        "password": "placeholder-only"
      }
    }
  },
  "seed": "example-seed",
  "detector": {
    "alphaTotal": 0.05,
    "bootstrapReplicates": 100,
    "lookBatchPerGroup": 4,
    "materialDiscardRateDifference": 0.2,
    "maxAttempts": 20,
    "maxConsecutiveFailures": 3,
    "maxDiscardRate": 0.5,
    "maxValidPerGroup": 8,
    "minAttemptsForDiscardRate": 2,
    "minValidPerGroup": 4,
    "quantile": 0.1,
    "targetPower": 0.8
  }
}
```

The detector constants in this example are configuration values, not a claim
that the project has calibrated universal defaults. Keep `defaultsStatus` as
`TBD` unless you have an approved, traceable calibration record.

### A/B symmetry rule

A and B must have the same:

- HTTP method;
- body type (`json`, `form`, or no body);
- header set and header values;
- URL path.

Only identity-related body field values should differ. The request builder
rejects mismatched request shapes and warns when serialized A/B body lengths
differ by more than eight bytes. Keeping the pair symmetric helps make the
identity value, rather than an unrelated request-shape change, the intended
contrast.

## Reading a result

The detector reports three user-visible outcomes:

- `LEAK`: the configured evidence and practical-effect rules found a timing
  difference that met the run's decision criteria;
- `NO LEAK DETECTED (sensitivity >= X ms)`: no difference above the measured,
  run-specific sensitivity was detected. The serialized verdict value is
  `NO_LEAK_DETECTED`;
- `INCONCLUSIVE`: the run stopped without enough reliable evidence, for
  example because the useful sample budget or data quality boundary was
  reached.

The report separates configuration, observation, and inference. It includes
accepted and discarded counts, discard reasons, errors, stop reason, timing
statistics, low-percentile effect information, sensitivity when available,
and the exact verdict. A `NO_LEAK_DETECTED` result is bounded by its measured
sensitivity; it is not proof of universal absence of a timing side channel.

## Safety, authorization, and redaction

- The public API accepts only the built-in `fixed` and `vulnerable` target IDs;
  it never resolves arbitrary URLs from browser input.
- Non-localhost CLI pairs require the literal `--i-am-authorized` flag and a
  warning is printed before requests begin.
- The CLI refuses unsafe or asymmetric request configurations before opening
  its transport.
- Headers, cookies, bodies, query strings, credentials, response data, and
  sensitive request metadata are not printed by default. Downloadable reports
  use redacted request metadata.
- Response bodies are consumed for connection reuse but are not logged as
  detector evidence.
- Timeouts, bounded active runs, start rate limits, retained-run limits,
  disconnect cleanup, and shutdown cleanup prevent abandoned work from living
  forever.
- Status mismatches, redirects, transport errors, and other discarded samples
  are counted and disclosed rather than silently filtered.

These controls are safeguards for authorized testing, not permission to test a
third-party service.

## Benchmark evidence

The repository's committed benchmark artifact is
[`bench/results.json`](bench/results.json). The read-only Benchmarks page is
available at
[`/benchmarks`](https://black-box-timing-leak-detector.onrender.com/benchmarks)
when the hosted service is running.

The following observations are quoted from that committed JSON artifact at the
time this README was written:

- the artifact status is `complete` and contains `180` completed trials;
- those trials cover `6` target/preset combinations, with `30` trials in each
  combination and `0` failed trials;
- the vulnerable target has a detection rate of `1` for each committed
  `none`, `low`, and `high` noise preset;
- the fixed target has a false-positive rate of `0` for each committed noise
  preset, with `1` inconclusive trial for `none`, `1` for `low`, and `2` for
  `high`;
- the recorded provenance is platform `win32`/Windows, architecture `x64`,
  Node `v24.13.1`, package version `0.1.0`, and trial seed
  `t4.1-master-v1`.

These are observations of the committed run, not product guarantees. The run
was performed on Windows with Node `v24.13.1`, while this project pins Node
`22.23.3`; that runtime deviation is disclosed in the artifact and is not a
reason to silently reinterpret the numbers. Default calibration remains TBD.
The observations are limited to the tested demos, presets, configuration,
machine, and runtime.

### Reproduce the benchmark

Without `--yes-full-run`, the runner does not start the full matrix. It prints
an estimate-only message; when no `--out` is supplied it also prints an
explicit unavailable result. It does not write `bench/results.json`.

```bash
npm run bench
```

The runner refuses the reserved output path `bench/results.json`, so do not use
that path for a new run. A real full-run reproduction command writes outside
the repository:

Bash:

```bash
npm run bench -- --yes-full-run --out /tmp/black-box-timing-leak-detector-results.json
```

PowerShell:

```powershell
npm run bench -- --yes-full-run --out "$env:TEMP\black-box-timing-leak-detector-results.json"
```

The commands above are a reproduction recipe, not a claim that a new run has
been performed here. A new run will not byte-match the committed artifact: its
timings, provenance, commit, and possibly outcomes depend on the machine,
runtime, load, and current code. Never replace the committed artifact with
unverified or fabricated output.

## Render deployment runbook

This repository contains [`render.yaml`](render.yaml), which is the deployment
configuration source of truth. It defines a Docker-backed Web Service named
`black-box-timing-leak-detector` on the free plan, uses `./Dockerfile`, and
sets:

- Docker Command: `node src/launcher.js`;
- health check path: `/healthz`;
- `HOST=0.0.0.0`;
- `TRUST_PROXY_HOPS=1`.

Render supplies the runtime `PORT`; do not set `PORT` manually in the Render
dashboard. The launcher uses that port for the public web process and starts
the vulnerable and fixed demo children on internal ports `3001` and `3002`.

### Manual Render steps

1. Create a new Render **Web Service** from the repository.
2. Select the Docker runtime and the free plan.
3. Set the Dockerfile path to `./Dockerfile`.
4. Set the Docker Command explicitly to:

   ```text
   node src/launcher.js
   ```

5. Set the health check path to:

   ```text
   /healthz
   ```

6. Add the environment variables shown in `render.yaml`:
   `HOST=0.0.0.0` and `TRUST_PROXY_HOPS=1`.
7. Deploy and wait for `/healthz` to report healthy.
8. Open the generated `onrender.com` URL, load the dashboard, and run both
   built-in target scans.

### The Docker Command trap

Do not leave Render's Docker Command field blank. If it is blank, Render uses
the Dockerfile default command, `node src/server/index.js`. That command starts
the web process but does not start the Render three-process launcher. The
production Render configuration must explicitly use `node src/launcher.js`.

After a deployment, verify that the public dashboard works, both built-in
targets run, arbitrary target input is unavailable, and the service responds
to `/healthz`. A free-tier instance may take a while to wake after idling; the
exact cold and warm times depend on the observation environment and are not
stated here.

## Limitations

- The CLI authorization check is hostname-based. It is a guardrail, not proof
  that the operator has permission or that a hostname resolves to an expected
  owner.
- The detector uses bounded sample budgets. A short run can be underpowered,
  and an inconclusive result is an honest outcome.
- Response timings are observations from one run, machine, runtime, network,
  and load context. They do not generalize automatically to every deployment.
- Free-tier cold starts can affect the first request after idling; the
  detector's startup and warmup behavior does not remove that environmental
  limitation.
- `NO_LEAK_DETECTED` is not proof of absence. It means no detectable
  difference above that run's measured sensitivity under that run's conditions.
- The public demo is a teaching and smoke-test surface, not evidence about an
  arbitrary production authentication system.
- Network noise, load changes, status mismatches, transport failures, and
  discarded samples can reduce the strength of an inference.

## Project documentation

- [`AGENTS.md`](AGENTS.md) — repository contribution and safety instructions;
- [`AI_WORKFLOW.md`](AI_WORKFLOW.md) — approved task history and verification
  record;
- [`PRD.md`](PRD.md) — product requirements;
- [`PLAN.md`](PLAN.md) — implementation and deployment design;
- [`TASKS.md`](TASKS.md) — task acceptance criteria and status;
- [`public/benchmarks.html`](public/benchmarks.html) — source for the public
  benchmark view.
