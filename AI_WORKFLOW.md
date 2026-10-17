# AI Workflow Log

## 1. Overview

This is a solo four-day hackathon build.
The agent used was omnirush with GPT 6 Astra.
The workflow was to write planning documents first, one at a time.
Each implementation task was handled in its own session and commit.
Human approval gates were used before implementation and scope changes.

## 2. The workflow loop

- **Planning:** The agent wrote `PRD.md`, `AGENTS.md`, `PLAN.md`, and
  `TASKS.md` one at a time; I reviewed each before the next document.
- **Per task:** The agent re-read `AGENTS.md` and the relevant `TASKS.md`
  entry, showed a plan, waited for my OK, implemented, ran acceptance checks,
  pasted real output, and made one commit.
- **Human verification:** I checked `git status`, `git log`, and `npm test`
  before starting the next task.

## 3. Rules the agent works under

- Never invent benchmark numbers, thresholds, timings, or detection claims;
  benchmark results come only from real scripts in `/bench`.
- Route every random choice through the shared seeded PRNG; never use
  `Math.random()` or an unseeded random source.
- Keep the public web/API path demo-only; never accept arbitrary target URLs.
- Run `npm test` after changes, use reference-value tests for statistical code,
  count discarded/errors, and redact sensitive metadata.
- Ask before adding dependencies, changing the statistical approach or verdict
  semantics, or deleting/renaming files.
- Make small, focused conventional commits with one task per commit; keep
  pinned versions, lockfiles, Docker, and Compose aligned.

## 4. Log

| Task | What the agent proposed | What I changed or caught | Outcome |
|---|---|---|---|
| Step 0 (context prompt) | Asked five clarifying questions before writing anything. | I answered public site scope, CLI scope, sensitivity threshold, deployment target, and demo app behavior. | Product scope was clarified before `PRD.md`. |
| T1.1 (bootstrap) | Proposed Node `22.23.3`, `express@5.3.0`, and `undici@8.12.2`. | I required verification that every version existed before pinning and required `.gitignore` in the same commit. | No version changed: local Node was `v22.23.3`; npm verified Express `5.3.0` and undici `8.12.2`. `.gitignore` was added in commit `0dfe7df`. |
| T1.2 | Added the `src/`, `public/`, `bench/`, and `test/` structure, a minimal ESM web health route, and stub service entrypoints for packaging tests. | No changes needed. | Committed as `1cd8495`; `npm test` and the health smoke tests passed. |
| T1.3 (Dockerfile) | Added the production Dockerfile and `.dockerignore`. | The command sandbox crashed after writing files (`sandbox is not reachable`). The agent refused to claim checks passed, did not tick the task, and did not commit. I ran `npm test`, `docker build`, `docker run`, and `curl /healthz`, then pasted the output. | The agent verified both files against my output, ticked T1.3, and committed `548a8ce`. |
| T1.4 (Compose) | Proposed a three-service Compose skeleton with `web`, `vulnerable`, and `fixed`, internal demo ports, and only the web port published. | I required verification of `process.env.PORT`, service-specific healthcheck ports, explicit staging paths, and parsed port mappings. The Docker engine was down during the agent-side startup check, so I ran the startup checks myself after Docker Desktop was running. | `npm test`, Compose config, parsed port mappings, `/healthz`, and healthy `docker compose ps` output passed; only `web` published port 3000; `docker compose down -v` removed the containers and network. |
| T1.5 (Render skeleton) | Proposed a launcher that starts web on `process.env.PORT`, vulnerable/fixed demos on ports 3001/3002, supervises child processes, and a Render Docker service with `/healthz`. | I required no new dependency, no `.gitattributes` change, explicit staging paths, and exit-on-child-failure behavior. | `npm test` passed 5 tests; `render.yaml` validation, Docker build, launcher container health, child-failure test, and clean shutdown passed. |
| T1.6 (PRNG and clock) | Proposed Mulberry32 with splitmix-style seed expansion, rejection-sampled bounded integers, half-open floats, and per-instance monotonic clocks. | I required known seed-42 outputs, number/string seed tests, 10,000 float-range samples, fake-clock isolation, and a `src/`-only `Math.random`/`Date.now` check. | PRNG, clock, focused tests, and `npm test` passed; `rg` was unavailable, so an equivalent Node source scan passed. |
| T1.7 (request builder) | Proposed a paired request builder for shared method/path/body shape/header sets, JSON/form serialization, cookies, overrides, warnings, and parsed hostnames. | I required strict A/B compatibility checks, body-length warnings, normalized safe headers, automatic content types, value-free errors, hostname output, and tests for each rule. | Focused request-builder tests and `npm test` passed with 20 total tests; no dependencies or hosting actions were used. |
| T1.8 (authorization and redaction) | Proposed a hostname authorization gate for both A/B requests, no-redirect transport options, redirect discard classification, safe-field redaction, and tests. | I required exact URL hostname parsing, 127/8/::1/localhost rules, one warning before requests, credential/query stripping, explicit file modes, and the future README limitation line: `authorization gate is hostname-based and does not resolve DNS`. | Focused authorization tests and `npm test` passed with 28 total tests; no dependencies or hosting actions were used. |
| T1.9 (undici transport) | Proposed direct `undici.request` with an injected shared dispatcher, monotonic timing, full body consumption, timeout/error classification, and safe result shapes. | I required checking the installed v8.12.2 redirect API before coding, a local 302 server test, no `durationMs` on discarded results, whitelisted error codes, and explicit 100644 staging. | Focused transport tests and `npm test` passed with 33 total tests; direct undici request behavior returned one 302 without a second request. |

## 5. Where the agent helped vs. where I intervened

**The agent helped by:**

- Asking clarifying questions before drafting the product requirements.
- Turning the approved scope into reviewed planning documents and task-sized
  implementation steps.
- Implementing T1.1 and T1.2 with acceptance checks, then reviewing T1.3
  against the verification output I supplied.

**I intervened by:**

- Supplying the product decisions that resolved the five initial questions.
- Requiring version verification and same-commit `.gitignore` coverage for T1.1.
- Running T1.3 verification by hand after the sandbox failure and supplying
  the real output before the task was ticked and committed.

## 6. Honest limitations

- The agent's command sandbox failed once during T1.3.
- I ran some T1.3 verification by hand and supplied its output.
- All benchmark numbers will come from scripts in `/bench`, never from the
  agent's memory.
