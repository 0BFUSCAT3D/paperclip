---
type: Verification Evidence
title: Phase 7M clean-room live chat verification
description: Command-and-result record for the clean-room chat added beside the preset scenario explorer — blank-seed enforcement, exposure profile, live Codex smoke, browser coverage, screenshot determinism, and the scenario-explorer regression check.
tags: [native-runner, phase-7, clean-room, live-codex, verification, evidence]
status: stable
generated: { by: anthropic/claude-opus-5, at: 2026-08-10T15:45:00Z }
entry_kind: evidence
phase: "7"
---

# Scope

Track 7M (PAP-16972) adds a clean-room chat as a second primary path in the
Phase 7 standalone app, beside the preset scenario explorer. This page records
what was run and what was observed on branch `PAP-16679-paperclip-runner`.

The clean room seeds only a mock company, agent, and blank work issue, then
drives the same real `paperclip-runnerd` + real Codex loop the scenario path
uses. It has no fake or replay path: every Paperclip operation still terminates
in the in-process mock `ControlPlanePort`, and no request reaches a real
Paperclip API.

See [the clean-room reference](../../docs/phase-07-clean-room-chat.md) for the
design and [its tutorial](../../docs/tutorials/phase-07-clean-room-chat.md) for
the clean-start walkthrough.

# Environment

- Node.js 22.22.2, pnpm 9.15.4, vitest 4.1.10, Playwright 1.61.1.
- Chromium 151.0.7922.34, pinned through `PAPERCLIP_RUNNER_CHROMIUM_PATH`. The
  committed PNG matrix is byte-stable only against that build.
- Rust toolchain and Codex CLI 0.132.0 (locally authenticated) for the live rows
  only.
- `NODE_ENV=development` for install and build: an inherited
  `NODE_ENV=production` makes pnpm skip the devDependencies the toolchain needs.

# Offline verification

Commands are prefixed `pnpm --filter @paperclipai/paperclip-runner`.

| Surface | Command | Observed result |
| --- | --- | --- |
| Type surfaces (package + browser) | `typecheck:typescript`, `typecheck:browser` | exit 0, no diagnostics |
| Clean-room seed, exposure profile, identity rotation | `exec vitest run src/phase7/clean-room.test.ts` | 7 tests pass |
| Clean-room HTTP routes end to end (stub provider) | `exec vitest run src/phase7/clean-room-server.test.ts` | 9 tests pass |
| Route contract, including explorer deep-link regression | `exec vitest run devtools/issue-thread/src` | 6 tests pass |
| Full Phase 7 suite | `test:phase7` | 14 files, 159 tests pass |
| Browser suite (issue thread + clean room) | `test:browser:issue-thread` | 58 Playwright tests pass, axe clean |
| Deterministic screenshot matrix | `record:phase7:ui` then `check:phase7:ui` | 24 images; all reproduce byte-for-byte |
| Doc links + OKF bundle | `docs:validate` | 93 files; 34 OKF concepts, 8 indexes |

The 24-image matrix was re-recorded because the surface rail that carries the
clean-room entry is a real, always-visible element of the app. Hiding it from
the capture would have kept the old bytes at the cost of screenshots that no
longer show the shipped surface.

# Live verification

| Surface | Command | Observed result |
| --- | --- | --- |
| Real Codex through real runnerd on a fresh mock tenant | `smoke:phase7:cleanroom -- --json` | all 15 assertions `true` |
| Clean-room screenshots | `record:phase7:cleanroom` | 7 images captured (`MCK-3799` → `MCK-7394`) |

Observed smoke output (abridged; identifiers differ per run because each open
mints a new mock tenant):

```json
{
  "schema": "paperclip.phase7.clean-room-smoke.v1",
  "firstIssue": "MCK-2114",
  "newChatIssue": "MCK-9539",
  "turns": 2,
  "toolCalls": [
    { "operationId": "get_task_context", "outcome": "ok" },
    { "operationId": "report_progress", "outcome": "ok" }
  ],
  "authorizationRecords": 30,
  "assertions": {
    "cleanRoomOpened": true, "blankThread": true, "noCannedEvidence": true,
    "liveIdentity": true, "freshMockTenant": true, "realCodexTurn": true,
    "semanticToolCalled": true, "mockStateMutated": true,
    "authorizationRecorded": true, "multiTurnSameSession": true,
    "composerReady": true, "realApiBlocked": true, "noCredentialInView": true,
    "newChatRotatesIdentity": true, "priorAuthorityRetired": true
  }
}
```

# Acceptance criteria

| Criterion | Where it is proved |
| --- | --- |
| 1. Blank thread, no scenario selection or canned evidence | `clean-room-server.test.ts` "opens a blank live thread…"; browser "a new chat opens a blank live thread…"; `clean-room-blank--desktop.png` |
| 2. First message starts a real Codex turn through real runnerd | `smoke:phase7:cleanroom` (`realCodexTurn`, `liveIdentity`); `clean-room-live-turn--desktop.png` |
| 3. Allowed call mutates only the mock port; denied call returns a typed denial with no state change | `clean-room-server.test.ts` "runs an allowed semantic call…" and "returns a typed denial…" |
| 4. Multi-turn, one inline interaction, refresh/reconnect, stop, retry on one durable session | `clean-room-server.test.ts` "keeps one durable session…" |
| 5. Reset/new-chat isolation, with new session and mock identities | `clean-room-server.test.ts` "reset and new chat both rotate identities…"; browser "New chat visibly rotates…"; smoke `newChatRotatesIdentity` / `priorAuthorityRetired` |
| 6. Network guards prove no real Paperclip API call | `network-guard-<sessionId>` control-plane record; `clean-room-server.test.ts` "publishes the real-API block…"; smoke `realApiBlocked` |
| 7. Desktop and narrow mobile stay usable with no horizontal scrolling | browser "the narrow layout keeps thread and composer usable…"; `record:phase7:cleanroom` asserts zero overflow at 390px before each mobile capture |
| 8. Existing scenario-explorer tests remain green | `test:phase7` 159/159; `test:browser:issue-thread` 58/58; `check:phase7:ui` 24/24 byte-identical; route test covers the existing deep links |
| 9. Targeted tests and a safe local live smoke pass | tables above |

# Notes and gotchas

- **`sk-` credential heuristic.** The clean room's `task-cleanroom-<token>` ids
  contain the substring `sk-`, which the unanchored `sk-[a-z0-9]{8,}` probe used
  by the smoke scripts read as an OpenAI-style key. The probe is now anchored
  with `(?<![A-Za-z0-9])`; the same fix was applied to the Phase 7G smoke and
  the issue-thread test so the heuristic cannot cry wolf on a mock id.
- **Stale settled frame.** A hash change commits the new route in the same frame
  that still renders the previous surface's snapshot, so `data-thread-state`
  briefly read `settled` for the surface just navigated away from. The app now
  tracks which surface produced the current snapshot; a capture or test waiting
  on `[data-surface="chat"][data-thread-state="settled"]` can no longer catch
  the old frame.
- **Chromium pin.** A wholesale 24/24 screenshot mismatch means the wrong
  Chromium, not a UI regression. Pin `PAPERCLIP_RUNNER_CHROMIUM_PATH` to
  151.0.7922.34.
- **Panel preference.** The clean room stores its Evidence-drawer preference
  under its own key, so an explorer session with the drawer pinned open does not
  make the first clean-room visit open with evidence showing.

# Related

- [Clean-room chat reference](../../docs/phase-07-clean-room-chat.md)
- [Clean-room chat tutorial](../../docs/tutorials/phase-07-clean-room-chat.md)
- [Phase 7 final evidence manifest (Revision 3/4)](2026-08-10-phase-07i-final-evidence.md)
- [Phase 7G issue-thread UI verification](2026-08-10-phase-07g-issue-thread-ui-verification.md)
- [Clean-room screenshots](phase-07/clean-room/index.md)
