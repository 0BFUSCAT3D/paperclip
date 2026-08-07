---
type: Verification Evidence
title: Phase 2 verification
description: Exact tools, commands, results, and screenshots for the local runner and fake harness.
tags: [native-runner, phase-2, verification, rust, supervisor, fake-driver, browser]
status: stable
generated: { by: openai/gpt-5, at: 2026-08-07T21:10:00Z }
phase: "2"
---

# Environment

- OS: `Linux 6.17.0-1019-aws aarch64`
- Node.js: `v22.22.2`
- pnpm: `9.15.4`
- Vitest: `4.1.10`
- Vite: `6.4.1`
- Playwright: `1.61.1`
- Rust/Cargo: `1.97.1` in the run scratch directory

# Commands and observed results

## 1. Rust formatting, tests, and process cleanup

```sh
cargo fmt --manifest-path packages/paperclip-runner/runner/Cargo.toml --all -- --check
cargo test --manifest-path packages/paperclip-runner/runner/Cargo.toml --locked --workspace
```

Result: exit 0. Rust formatting passed. Fifteen library tests and one supervisor
integration test passed. The cleanup test proved that the harness and spawned
worker process group both stop.

## 2. TypeScript and live-run conformance

```sh
pnpm --filter @paperclipai/paperclip-runner test:typescript
pnpm --filter @paperclipai/paperclip-runner typecheck:typescript
pnpm --filter @paperclipai/paperclip-runner typecheck:browser
```

Result: exit 0. Seven Vitest files and 38 tests passed. The Phase 2 cases cover
driver lifecycle, command and file items, bounded logs, duplicate commands,
permission/input, interruption, error exit versus semantic result, duplicate
terminal suppression, controller-disconnect cleanup, credentials, and
live/replay parity.

## 3. CLI scenario matrix

```sh
for scenario in happy-path permission-input interrupted error duplicate-terminal; do
  node packages/paperclip-runner/dist/cli/phase2-mock-core.js --scenario "$scenario" --quiet
done
node packages/paperclip-runner/dist/cli/phase2-mock-core.js \
  --scenario happy-path --quiet --duplicate-turn-command
```

Observed facts:

| Scenario | Events | Terminal | Semantic result | Harness exit | Runner exit |
|---|---:|---:|---|---:|---:|
| happy path | 18 | 1 | `done` | 0 | 0 |
| permission/input | 19 | 1 | `done` | 0 | 0 |
| interrupted | 15 | 1 | `yielded` | 130 | 0 |
| error | 14 | 1 | `yielded` | 7 | 0 |
| duplicate terminal | 14 | 1 | `done` | 0 | 0 |

The duplicate turn command returned one duplicate receipt and did not create a
second `turn.started` event.

## 4. Browser build, interactions, and screenshots

```sh
pnpm --filter @paperclipai/paperclip-runner build:browser
pnpm --filter @paperclipai/paperclip-runner check:browser-tokens
pnpm --filter @paperclipai/paperclip-runner test:browser
```

Result: exit 0. Vite transformed 219 modules. The token check passed. Five
Playwright tests passed in 3.5 seconds. They cover Phase 1 static replay,
duplicate/version states, live completion and replay parity, permission/input,
and interruption with one terminal event.

The minimal host lacked Chromium libraries. The test used Ubuntu packages
extracted under `$PAPERCLIP_RUN_SCRATCH_DIR/playwright-libs` through
`LD_LIBRARY_PATH`; no system library was installed.

## 5. Boundary and knowledge checks

```sh
pnpm --filter @paperclipai/paperclip-runner check:forbidden-imports
pnpm --filter @paperclipai/paperclip-runner docs:validate
```

Result: exit 0. The standalone boundary passed. Documentation links and the OKF
v0.2 bundle passed validation.

## 6. Complete package acceptance sequence

```sh
pnpm --filter @paperclipai/paperclip-runner verify
```

Result: exit 0 with the run-scratch Rust and browser-library paths active. The
command built Rust, TypeScript, and browser outputs; ran all typechecks, tests,
goldens, parity, token, boundary, browser, docs, and OKF checks; ran the Phase 0
tracer and Phase 1 replay; and finished with the Phase 2 happy-path summary.

# Browser artifacts

## Completed live run

[Phase 2 completed run screenshot](phase-02-live-complete.png)

- PNG: 1440 × 1786, RGB
- SHA-256: `6c49da63df4de4e2d7e5958bd66cdefa492819474526c345328dcd2b575b887a`
- Shows 18 validated events, process exit 0, semantic result `done`, one terminal
  event, and live/replay `Match`.

## Permission request

[Phase 2 permission screenshot](phase-02-live-permission.png)

- PNG: 1440 × 1131, RGB
- SHA-256: `192c0b244694d22cfe880e814dade1714ae48ab18a2047aaa2c7714419a0328b`
- Shows the live pending permission request before resolution.

## Interrupted run

[Phase 2 interrupted run screenshot](phase-02-live-interrupted.png)

- PNG: 1440 × 1591, RGB
- SHA-256: `11003e92e776afe670a4a2c958770b4f844ff373115ff93c3aee1e54238b2bd4`
- Shows exit 130, semantic result `yielded`, cancelled terminal state, one
  terminal event, and live/replay `Match`.

# Acceptance mapping

- Deterministic Rust runner and supervisor: passed.
- Small local harness transport: stdio JSONL passed.
- Timing, error, permission, input, interruption, and terminal scripts: passed.
- Mock-core command/event loop through package contracts: passed.
- Bounded logs and separate process/semantic facts: passed.
- Driver conformance and controller/harness cleanup: passed.
- Duplicate commands and exactly one terminal event: passed.
- Browser live mode with Phase 1 validator/reducer: passed.
- Live/replay parity: passed.
- Package reference, tutorial, cumulative steps, evidence, OKF journal, and
  screenshot set: linked and validated.

# Remaining risk

The local process and in-memory browser path do not prove Phase 3 durable
delivery or reconnect behavior. Production Paperclip behavior remains unchanged.
