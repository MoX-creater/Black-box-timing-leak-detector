# AGENTS.md

## Project summary
Black-box Timing Leak Detector tests whether an HTTP endpoint leaks account existence through response time.
It interleaves seeded A/B requests, applies Mann-Whitney U and low-percentile effect analysis, and reports an honest verdict.
It ships a Node.js CLI for authorized targets plus a public dashboard restricted to the built-in vulnerable/fixed demos.

## Repository structure
```text
src/              Application code: CLI, detector, HTTP, server, demos, stats, shared PRNG
public/           Dashboard and static Benchmarks page
bench/            Reproducible benchmark scripts and real-only results.json
test/             Node test-runner unit/integration tests
Dockerfile        Production image
compose.yaml      Web/API plus vulnerable and fixed demo services
package.json      Exact scripts and dependency versions
package-lock.json Committed lockfile
```

## Pinned stack
- Node.js `22.23.3`; npm `10.9.9`; Docker base `node:22.23.3-bookworm-slim`.
- `express@5.3.0`; `undici@8.12.2`; use Node built-ins (`node:test`, `node:crypto`) otherwise.
- Use browser-native HTML/CSS/ES modules; add no frontend framework without approval.
- Keep `package.json`, `package-lock.json`, `.nvmrc`, and Docker versions exact and aligned.

## Commands
```bash
npm ci
npm run dev
npm test
npm run bench
docker build -t black-box-timing-leak-detector:local .
docker run --rm -p 3000:3000 black-box-timing-leak-detector:local
docker compose up --build
```
Run commands from the repository root. Keep `npm test` offline-capable after `npm ci`.

## Code conventions
- Use ESM only: set `"type": "module"`, use explicit `.js` relative imports, and never add CommonJS.
- Keep modules small and place code by responsibility under the structure above; share PRD terms and report schemas.
- Use monotonic clocks for durations. Never use `sleep()` to create demo timing differences.
- Handle errors explicitly: preserve typed causes at boundaries, count discarded requests, sanitize user-facing errors, and never swallow failures.
- Redact headers, cookies, bodies, URLs, and response data in logs/reports unless explicitly safe.

## Testing rules
- Run `npm test` after every change; a task is not done until it passes.
- Statistical code must have unit tests against known reference values, including Mann-Whitney, percentiles, effect size, and sensitivity calculations.
- Use seeded fixtures, fake clocks/transports, and local services; do not make timing tests depend on live network luck.
- Test request validation, discard/error accounting, redaction, authorization gates, rate limits, and all three verdict paths.

## Determinism rules
- Route every random choice through the shared seeded PRNG module: sampling order, demo jitter, and benchmarks.
- Never call `Math.random()` or introduce an unseeded random source. Record seeds and relevant configuration in reports.
- Keep benchmark inputs, code version, environment assumptions, and outputs reproducible.

## Safety rules
- Never accept or resolve arbitrary target URLs in the web/API path; use an allowlist of built-in target IDs.
- Require `--i-am-authorized` for every non-localhost CLI target and print the warning before requests.
- Rate-limit scan starts, bound active work, enforce timeouts, clean up disconnected runs, and expose only the web/API port.

## Honesty rules
- Never fabricate benchmark numbers, thresholds, timings, or detection claims.
- `bench/results.json` may contain only outputs produced by scripts in `/bench` from real runs; otherwise render an explicit unavailable state.
- Label configuration, observation, and inference separately; disclose errors, discards, stop reasons, and sensitivity.

## Git rules
- Make small, focused commits with one task per commit and conventional messages (`feat:`, `fix:`, `test:`, `docs:`, `chore:`, `refactor:`).
- Do not commit secrets, generated noise, or unrelated edits; inspect status and diff before committing.

## Ask before doing
Ask the user before adding a dependency, changing the statistical approach or verdict semantics, or deleting/renaming files.

## Definition of done
- [ ] Scope matches `PRD.md`; no unapproved dependency, stats, or file deletion.
- [ ] `npm test` passes, including reference-value statistical tests and relevant safety tests.
- [ ] Seeded determinism, validation/discard accounting, redaction, and honest verdict behavior are covered.
- [ ] Public paths remain demo-only and scan starts are rate-limited and bounded.
- [ ] Docs, scripts, lockfile, Docker/Compose behavior, and commands stay aligned.
- [ ] No fabricated benchmark result is added; changes are reviewed in a small conventional commit.
