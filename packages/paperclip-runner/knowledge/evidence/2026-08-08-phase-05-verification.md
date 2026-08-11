---
type: Verification Evidence
title: Phase 5 browser SDK verification
description: Targeted and package-acceptance evidence for the versioned SDK, two public consumers, fake/real drivers, accessibility, reconnect, and replay.
tags: [native-runner, phase-5, sdk, browser, react, codex, evidence]
status: stable
generated: { by: openai/codex-local, at: 2026-08-08T07:50:00Z }
---

# Scope

This record covers Phase 5 under `packages/paperclip-runner/`: the versioned
browser and React surface, scoped styles, reference console, mini consumer,
package boundaries, fake and real drivers, documentation, and visual evidence.
It does not change production `server/`, `ui/`, database, routes, persistence,
or legacy adapters.

# Targeted tests

```sh
pnpm --filter @paperclipai/paperclip-runner test:phase5
pnpm --filter @paperclipai/paperclip-runner typecheck:typescript
pnpm --filter @paperclipai/paperclip-runner typecheck:browser
pnpm --filter @paperclipai/paperclip-runner check:browser-tokens
pnpm --filter @paperclipai/paperclip-runner check:forbidden-imports
```

Results:

- Phase 5 Vitest: **3 files, 21 tests passed**.
- TypeScript public and browser configurations: passed.
- Generated protocol source check: passed.
- SDK token gate: passed.
- Package/deep-import boundary gate: passed.

Coverage includes framework-free client errors and injection, exact duplicate
event delivery to the shared reducer, file/tool/plan projection, exact failure
diagnostics, component `data-slot` contracts, request locking, and the five
extension points. The React contract also verifies that semantic Codex JSON is
rendered as a clear response while the exact payload remains inspectable.

# Fake-driver browser acceptance

```sh
cd packages/paperclip-runner
bash scripts/verify-rootless-linux.sh pnpm run test:browser:phase5
```

Result: **5 Playwright tests passed** in 16.3 seconds after adding an explicit
responsive-tree readiness check before mobile evidence capture.

The tests cover both public consumers, every required fake lifecycle state,
Composer/menu/dialog/tabs/replay keyboard behavior, one polite live region,
semantic control names, status text, reduced-motion-safe styles, exact mobile
and desktop bounding-box measurements, reconnect and gap recovery, durable
cursor replay, and live/replay reducer parity. The completion flow also checks
that the visible assistant answer grows between frames, proving progressive
character-level presentation over canonical streamed deltas.

# Real Codex evidence

Direct server trace:

```sh
pnpm --filter @paperclipai/paperclip-runner record:phase4b -- \
  knowledge/evidence/phase-05/phase5-real-codex-trace.json
```

Result: passed. The trace proves exact file output, a validated semantic
result, one terminal event, continuous source sequence, stable run/session and
provider identity after reconnect, replay, explicit unsupported-goal state,
and absent provider credentials and host paths.

Browser consumers:

```sh
cd packages/paperclip-runner
bash scripts/verify-rootless-linux.sh pnpm run record:phase5:codex
```

Result: reference console passed and produced its live screenshot. The mini
consumer was then rerun independently after replacing a timing-sensitive real
steering visual with the safe completion manifest:

```sh
bash scripts/verify-rootless-linux.sh pnpm exec playwright test \
  --config examples/playwright.real.config.ts --grep 'mini consumer'
```

Result: **1 test passed** in 14.1 seconds. Codex explicitly reported goals as
disabled; the consumer kept its goal controls disabled. The public consumer
completed a safe real turn, reconnected the same session, entered replay, and
reported parity. Provider credentials were not rendered.

The reviewer-facing tailnet preview was rebuilt with `build:phase5`, and the
watchdog-managed `vite preview` process was restarted so it served the new
bundle rather than the prior build. After reviewer feedback that protocol
events visually buried the answer, the console now anchors the latest settled
assistant response, presents the semantic summary as the dominant content, and
keeps checks plus raw JSON behind `Completion details`. A fresh real Codex turn
passed the viewport assertion at `/reference-console/`; a DOM scan again found
no bearer token or `auth.json`.

# Screenshots

The [`phase-05/`](phase-05/) directory contains 34 files:

- Reference console at 1440x900 and 390x844: idle, streaming, steering,
  interrupt, pending and resolved requests, goal, reconnect, replay, and
  failure.
- Mini consumer at both viewports: idle, custom renderer and token override,
  pending request with custom detail, reconnect, and replay.
- Live Codex reference-console and mini-consumer captures at 1440x900.
- A separate reviewer-facing live-preview capture at 1440x900 after the
  production bundle rebuild.
- The redacted real Codex trace described above.

Visual inspection covered a desktop idle surface, mobile pending request,
custom renderer/token override, mini real replay, and reference real Codex
completion. The mobile request controls fit the viewport; the live reference
shows a completed terminal tool and passed observations.

# Package acceptance

```sh
cd packages/paperclip-runner
bash scripts/verify-rootless-linux.sh pnpm run verify
```

Result: **passed with exit status 0**. Notable totals in the cumulative run:

- TypeScript: **18 files, 171 tests passed**;
- Rust: **37 unit tests and 2 supervisor integration tests passed**;
- boundary/recorder Node tests: **8 passed**;
- Phase 5 targeted suite: **21 passed**;
- accepted Phase 1–4b browser suite: **28 passed**;
- Phase 5 browser suite: **5 passed**;
- Phase 0 Rust/TypeScript and Phase 1 fixture/reducer parity: passed;
- Phase 0 tracer, Phase 1 replay, Phase 2 happy path, and Phase 3 lost-ACK
  recovery: passed.

# Documentation

```sh
pnpm --filter @paperclipai/paperclip-runner docs:validate
```

Result: documentation links and OKF v0.2 validation pass.

# Known provider constraints

Real-provider timing is not the oracle for race screenshots. The deterministic
driver owns steering, interrupt, request, and goal branches. Real Codex owns
the provider authentication boundary, normalized identity, redaction, safe
completion, reconnect, and replay. This preserves upstream terminal and
capability truth instead of hiding a real failure or fabricating support.

# Direct chat iteration — 🪁 v0.1.1

The reviewer requested a normal Codex chat with protocol debug information.
Version `0.1.1` adds an explicit direct conversation mode. The mode sends plain
user text to Codex. It does not add the Phase 4 task envelope, semantic result
tools, or output schema. The safe disposable workspace and server-only provider
authentication remain active.

Verification:

```sh
pnpm --filter @paperclipai/paperclip-runner typecheck:typescript
pnpm --filter @paperclipai/paperclip-runner exec vitest run \
  src/drivers/codex/codex-app-server-driver.test.ts \
  src/react/public-contract.test.tsx \
  src/browser/client.test.ts \
  src/browser/transcript-model.test.ts
bash packages/paperclip-runner/scripts/verify-rootless-linux.sh \
  pnpm --filter @paperclipai/paperclip-runner exec playwright test \
  --config examples/playwright.config.ts
bash packages/paperclip-runner/scripts/verify-rootless-linux.sh \
  pnpm --filter @paperclipai/paperclip-runner exec playwright test \
  --config examples/playwright.real.config.ts --grep 'direct multi-turn'
pnpm --filter @paperclipai/paperclip-runner docs:validate
```

Results: TypeScript passed; 61 Vitest tests passed; 6 fake-driver browser tests
passed; the real Codex direct-chat test passed for two turns; documentation and
OKF validation passed. The real-chat screenshot is
`phase-05/reference-direct-chat-codex-1440x900.png`.

The refreshed preview returns HTTP 200 at
`http://paperclip-dev.tail29c1aa.ts.net:4195/reference-console/`. The page
header marker is `🪁 v0.1.1`.

# Review refresh — 🖇️ v0.1.2

Date: 2026-08-09

The package-local reference console now wraps long chat, command, and payload
content at mobile widths. Terminal rows expose command input and output, plus
every canonical item event retained by the transcript projection, inside a
nested folded `Debug details` disclosure. The browser still receives no Codex
credential: real chat is backed by the server-owned `CodexAppServerDriver` and
a real local `codex app-server` subprocess; deterministic manifests use the
scripted driver behind the same routes.

Focused verification:

```sh
pnpm --filter @paperclipai/paperclip-runner test:phase5
pnpm --filter @paperclipai/paperclip-runner typecheck:browser
pnpm --filter @paperclipai/paperclip-runner typecheck:typescript
```

Results: 22 targeted Vitest tests passed; browser and package TypeScript
typechecks passed; browser tokens and documentation validation passed; all six
rootless Playwright flows passed. The suite explicitly opens Terminal and
`Debug details`, verifies canonical event fields, captures
`reference-terminal-debug-1440x900.png` and
`reference-terminal-debug-390x844.png`, and confirms no horizontal page
overflow at 390 by 844. The unchanged public preview returned HTTP 200 with
marker `🖇️ v0.1.2` and measured zero pixels of horizontal overflow.
