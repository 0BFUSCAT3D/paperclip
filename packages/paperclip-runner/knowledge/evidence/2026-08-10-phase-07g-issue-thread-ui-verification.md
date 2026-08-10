---
type: Verification Evidence
title: Phase 7G issue-thread UI verification
description: Commands, versions, and results for the package-local issue thread, its deterministic screenshot matrix, its accessibility gate, and its live runnerd/Codex smoke.
tags: [native-runner, phase-7, ui, screenshots, accessibility, live-codex]
status: stable
generated: { by: anthropic/claude-opus-5, at: 2026-08-10T04:05:00Z }
entry_kind: evidence
phase: "7"
---

# Environment

* Node 22.22.2, pnpm workspace package `@paperclipai/paperclip-runner`.
* Playwright 1.62.1, Chromium 151.0.7922.34, axe-core 4.13.0.
* Codex CLI 0.132.0 with a local authenticated installation.
* Linux aarch64. `PAPERCLIP_RUNNER_CHROMIUM_PATH` pointed at a preinstalled
  Chromium because the Playwright download lacked system libraries on this host;
  `pnpm verify:rootless` is the alternative.

# Static and unit results

| Command | Result |
|---------|--------|
| `pnpm typecheck:typescript` | passed |
| `pnpm typecheck:browser` | passed |
| `pnpm check:browser-tokens` | passed — browser surfaces reference semantic tokens only |
| `pnpm check:forbidden-imports` | passed |
| `pnpm docs:validate` | passed |
| `pnpm exec vitest run src/issue-thread/issue-thread.test.ts` | 16/16 passed |
| `pnpm test:phase7` | 23/23 passed |

The view-model suite asserts the contract directly: all twelve §10.2 slugs build
a schema-valid snapshot, each slug is byte-identical across two builds, the
matrix covers every §3 thread item type and the §5 interaction state matrix and
every §4 composer state, the denial strip quotes its authorization record
verbatim, replay is labelled fake-derived, the withheld control-plane list is
non-empty, and no fixture or projected view matches a credential pattern.

# Browser suite

`pnpm test:browser:phase7` — **50/50 passed**.

The script now runs `build:issue-thread` before Playwright. It did not, and the
suite's `vite preview` server serves the built bundle, so a run could pass
against a stale `dist-issue-thread/` that predated the source under test. That
is how the four round-2 regressions below first came up red against fixed code.

Functional coverage: baseline item types and turn headers; durable comments
distinguished from model prose; collapsed tool strips with `aria-expanded` and
`View in Evidence` deep links; a pending question card refusing an incomplete
submit and then resolving inline; a revision-bound confirmation requiring a
reject reason; four distinct resolved/expired treatments in history; a verbatim
denial with its Evidence badge; the eight-section panel with turn selector and
the `Control plane (not exposed to the agent)` group; Evidence records linking
back to their thread anchor; keyboard splitter resize; the reset confirm dialog
with default-focused Cancel and Escape dismissal; Stop preserving partial output
with a `Stopped by user` marker; the reconnect banner and its `Reconnected`
confirmation; read-only replay; a terminal disposition disabling the composer;
draft survival across refresh; the 390px no-horizontal-scroll assertion; the
mobile denial badge; 44px touch targets; Escape closing the `⋯` menu; focus
moving to the Evidence heading; and the `waiting` composer anchor.

Round-2 additions from the PAP-16952 gate review:

* **Escape closes the desktop overlay sheet** at 1000×800 and returns focus to
  the `Evidence` toggle (§9.1, was blocking).
* **Resolving a card moves focus to its state chip** (§9.2, was blocking).
* **The replay strip steps, advances, and plays through** to 18/18, then parks
  itself with `Next turn` disabled (§6 `play-all`).
* **The deliverable strip and card report one size in one unit** — both now
  format through `phase7FormatBytes`.

Accessibility gate: axe (WCAG 2.1 A/AA) on all **12 slugs × 2 viewports** —
zero serious or critical violations, re-run after the round-2 fixes.

# Screenshot matrix

```sh
node scripts/record-phase7-ui-evidence.mjs          # Recorded 24 Phase 7 UI screenshots
node scripts/record-phase7-ui-evidence.mjs --check  # All 24 reproduce byte-for-byte
```

Output: `knowledge/evidence/phase-07/ui/<slug>--<desktop|mobile>.png`, twelve
slugs at 1440×900 and 390×844. Every mobile capture asserts
`scrollWidth - clientWidth <= 0` on the scrolling element before the shot. All
frames are deterministic `fake` mode rendered from package fixtures, so no
provider, runner process, or credential is involved.

Five frames were re-recorded for the round-2 fixes and re-verified byte-stable:
`replay-mode--{desktop,mobile}` (the `Play all` control, and the progress bar
wrapping to its own row at 390px so it is not squeezed to a stub),
`debug-panel-open--{desktop,mobile}` (`?panel=` without `rec=` now scrolls the
opened section clear of the sticky panel head, so the §10.2 "authorization
records" requirement is met in frame rather than below the fold), and
`deliverable-registered--desktop` (`18.4 kB` → `18.0 kB`, matching its card).

# Live runnerd and Codex

```sh
node scripts/phase7-issue-thread-smoke.mjs --json
```

Result: session created, 2 turns, 2 tool calls, 30 authorization records, and
every assertion true — `liveIdentity` (`Real Codex` / `Real runnerd` /
`Mock Paperclip`), `mockIdentifier` (`MCK-`), `userMessageRendered`,
`toolActivityRendered`, `durableCommentRendered`, `authorizationRecorded`,
`callsRecorded`, `controlPlaneWithheld`, `multiTurnThread`, `composerReady`,
and `noCredentialInView`.

```sh
node scripts/record-phase7-ui-live-evidence.mjs
```

Captured `knowledge/evidence/phase-07/ui-live/` — a real browser driving a real
Codex turn through the package server, the same session with the Evidence panel
open, and the mobile frame. The recorder fails if the identity chips do not read
live or if the live thread scrolls horizontally at 390px. These frames are not
byte-stable by construction and are excluded from the determinism gate.

The supporting Phase 7E smoke was re-run on the same tree:
`pnpm trace:phase7 -- --json` passed all twelve assertions, including
`noRealPaperclipRequest`, `noPaperclipAuthorityInChild`, `authorityCleared`, and
`runnerExited`.

# Deviations

* Phase 7B contract §5 asks for 60% opacity on expired-family interaction cards.
  Measured 3.16:1, which fails the blocking axe gate in §9.7. Implemented as a
  recessed surface plus muted text at ≥4.5:1 and reported to the contract owner.
