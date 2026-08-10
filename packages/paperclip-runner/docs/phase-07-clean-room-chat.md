# Phase 7 clean-room live chat

Phase 7M adds a second primary path beside the preset scenario explorer. A board
user opens a blank chat, sends a free-form message, and watches real Codex work
a mock Paperclip issue through real runnerd. There is no scenario to pick, no
recorded transcript, and no scripted tool tour.

Both paths ship in the same app and share one view contract. What separates them
is what the session is seeded with, and whether a fixture is allowed to stand in
for a provider.

| | Preset scenario explorer | Clean-room chat |
| --- | --- | --- |
| Route | `#/issue/<fixtureProfile>` | `#/chat` |
| Seed | A recorded eval case: transcript, scripted calls, parity verdicts | A company, an agent, and one blank issue |
| Modes | `fake` (default), `replay`, `mode=live` | Live only — no fixture, no recording |
| Tool calls | Fixed by the scenario | Chosen by the conversation |
| Evidence drawer | Collapsed by default | Collapsed by default |

## What "clean room" means

Every open mints a new mock tenant — a new company, actor, task, and `MCK-`
identifier — and seeds nothing else. `assertPhase7CleanRoomSeedIsBlank` fails the
open if any comment, document, interaction, approval, artifact, blocker, wake,
or fault is present, so "the thread starts blank" is enforced at the seam that
creates the session rather than assumed.

The only mutation an open performs is the run checking the mock issue out, which
is why a fresh room reads `in_progress` rather than `todo`.

## Live only, and loudly so

The clean room never falls back:

- `parsePhase7Route` pins `mode` to `live` on `#/chat` and drops `shot` and
  `at`. No URL can talk it into rendering a fixture or a recording.
- The package server has no scripted path for this route. It projects the live
  session and refuses any view that is not `mode=live` with a `Real Codex`
  agent label.
- When runnerd or the Codex app-server cannot start, the surface says exactly
  that and offers `Try again`. It does not render a canned thread.

## Exposure profile

The profile is deterministic and inspectable even though the calls are not.
`PHASE7_CLEAN_ROOM_CLAIMS` grants the read, comment, document, interaction,
deliverable, delegation, dependency, wake, and approval-request operations.

Three grants stay withheld on purpose:

| Withheld grant | Effect |
| --- | --- |
| `governance:approvals:decide` | The agent may request an approval; the board decides it. |
| `workspace:control` | No service lifecycle changes from a chat. |
| `test:generic_api_request` | The escape hatch stays off. |

Withholding them keeps a denial reachable in a conversation nobody scripted: if
the model reaches for one, it gets a typed denial with a named code and the mock
state does not move. The Evidence drawer's Tools section lists all three under
`Control plane (not exposed to the agent)`.

The run itself holds the wider adapter claim set that the mock command boundary
requires (`phase7FixtureRunCapabilities`). That union widens the port, never the
catalog the model sees: effective claims are the intersection of run claims,
scenario claims, and explicitly delegated claims.

## Session lifecycle

```text
GET  /api/phase7/ui/cleanroom/session[?sessionId=…]   open or reconnect
POST /api/phase7/ui/cleanroom/session {sessionId?}    New chat (retires the caller's room)
POST /api/phase7/ui/message      {sessionId, message}
POST /api/phase7/ui/interrupt    {sessionId}
POST /api/phase7/ui/reconnect    {sessionId}
POST /api/phase7/ui/reset        {sessionId}
POST /api/phase7/ui/interaction  {sessionId, interactionId, outcome, result}
```

`Reset` and `New chat` both stop active work, clear the previous session's
authority, drop its workspace directory, and open a new tenant. A retired
session id answers `404` on every route afterwards — the rotation is verifiable,
not just visible. Refresh reconnects to the same durable session; a stale id
from `localStorage` opens a fresh room rather than dead-ending.

The clean room stores its session id under its own `localStorage` key, so a
scenario session can never be handed to the chat route or the reverse.

## Bounds

| Bound | Value |
| --- | --- |
| Turns per chat | 24, then a named `turn_limit` refusal that points at `New chat` |
| Message size | 8 KiB |
| Concurrent clean rooms | 4; the oldest yields to a new board user |
| Turn timeout | 120 s (`Phase7LiveSessionService` default) |

## Real-API block

`Phase7LiveSession` routes every Paperclip operation through the in-process mock
`ControlPlanePort`; no code path reaches a Paperclip URL. The projection turns
that into a record rather than a claim: the Control plane section of the
Evidence drawer carries a `network-guard-<sessionId>` row reading
`Real Paperclip API requests: 0. Child PAPERCLIP_* environment keys: none.`

The child environment is allowlisted by `createSanitizedCodexEnvironment`, so no
`PAPERCLIP_*` value reaches runnerd or Codex, and the browser receives no
provider, runner, or control-plane credential.

## Verification

| Surface | Command |
| --- | --- |
| Seed, exposure profile, and identity rotation | `pnpm --filter @paperclipai/paperclip-runner test:phase7` |
| Clean-room HTTP routes end to end (stub provider) | included in `test:phase7` |
| Browser entry, blank state, evidence-on-demand, narrow layout, axe | `pnpm --filter @paperclipai/paperclip-runner test:browser:issue-thread` |
| Real Codex through real runnerd | `pnpm --filter @paperclipai/paperclip-runner smoke:phase7:cleanroom` |
| Live screenshots | `pnpm --filter @paperclipai/paperclip-runner record:phase7:cleanroom` |

See the [clean-room chat tutorial](tutorials/phase-07-clean-room-chat.md) for the
clean-start walkthrough, [execution modes and identity](phase-07-execution-modes.md)
for the fake/live eligibility rules, and the
[issue-thread UI reference](phase-07-issue-thread-ui.md) for the thread,
composer, and Evidence panel this surface reuses.
