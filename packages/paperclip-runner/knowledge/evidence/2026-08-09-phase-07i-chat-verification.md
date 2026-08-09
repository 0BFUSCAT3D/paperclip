---
type: Verification Evidence
title: Phase 7I interactive scenario chat verification
description: Turn model, per-turn evidence, denial handling, reset isolation, route determinism, responsive behaviour, and the ten-image screenshot acceptance set for the Phase 7I chat.
tags: [native-runner, phase-7, verification, browser, chat, parity]
status: stable
generated: { by: anthropic/claude-opus-5, at: 2026-08-09T16:05:00Z }
---

# Scope

This record verifies the Phase 7I interactive chat (PAP-16916) against the
approved interaction map,
[Phase 7I Mobile Chat UX](../../docs/design/phase-7i-mobile-chat-ux.md), whose
§11a lists every deviation taken during implementation.

The chat runs against the Phase 7C mock control plane in the page. No Paperclip
service is contacted, no ACPX implementation is introduced, and no provider or
Paperclip credential reaches the browser.

# Commands and results

All commands run from the repository root.

| Command | Result |
| --- | --- |
| `pnpm --filter @paperclipai/paperclip-runner run test:phase7` | 5 files, 79 tests passed (49 Phase 7 runtime + 12 chat session + 18 chat rendering, plus the 7F sets) |
| `pnpm --filter @paperclipai/paperclip-runner run test:browser:phase7` | 43 tests passed (25 Phase 7F + 18 Phase 7I) |
| `pnpm --filter @paperclipai/paperclip-runner run typecheck:typescript` | passed |
| `pnpm --filter @paperclipai/paperclip-runner run typecheck:browser` | passed |
| `pnpm --filter @paperclipai/paperclip-runner run check:browser-tokens` | passed — no hex, raw pixel, inline style, or raw font size in the chat components |
| `pnpm --filter @paperclipai/paperclip-runner run check:forbidden-imports` | passed |
| `pnpm --filter @paperclipai/paperclip-runner run test:phase7-evals` | 106 cases, 16 groups — unchanged by 7I |
| `pnpm --filter @paperclipai/paperclip-runner run record:phase7i` | 10 screenshots; the recorder fails the run on any horizontal page scroll |
| `pnpm --filter @paperclipai/paperclip-runner run docs:validate` | passed |

# What was verified

## Turn model and the data contract

`Phase7ChatSession` seeds turn 0 from control-plane work alone (checkout, wake
routing, exposure) and numbers user turns from 1. Every timeline entry carries
its `turn`; the artifact carries `turns[]` with per-turn exposure,
authorization records, state diff, reconciliation events, counts, and verdict.
The UI derives none of these — asserted in `src/phase7/chat-session.test.ts`
and `examples/phase7-explorer/src/chat.test.tsx`.

The turn-0 verdict reports `Pass` over the single claim it makes (control-plane
work with no agent tool) and carries no agent-tool assertion.

## Successful and denied mock interactions from chat

`ap-mcp-gate-01` in a live (non-replay) session: two typed prompts produce an
allowed turn and a denied turn. The denial renders in place on the danger
surface with `policy_denied`, `required_claim_missing`, the missing claim, and
an explicit "not returned — the denial carries no task data". The session
status stays `Scripted · deterministic`; a denial is an outcome, not a failure.
The mobile Activity segment carries a `· 1 deny` count chip.

## Control-plane-owned action with no agent tool

`ix-checkbox-01` turn 3 applies `resolve_human_input` as a control-plane
command. The mock core schedules the continuation wake in response, which
appears as a `wake.scheduled` reconciliation row inside that turn's state-diff
section, badged "Control plane".

## Reset, replay, and session isolation

Reset confirms through the SDK `Dialog`, returns to the seeded turn 0, and
leaves no turn strips and no denials behind — verified in the browser and at
the runtime level (a fresh session shows one turn, no user messages, and an
unchanged diff). Switching scenario mid-session asks the same question.
`replay=fake` plays once per session, so an explicit reset is not undone by the
route.

Replaying the same scenario twice produces byte-identical `timeline` and
`turns` JSON, and the scripted route settles to identical DOM across loads.

## Boundary

- `rs-secret-hygiene-01` in chat: the rendered page contains no raw fixture
  secret, and `localStorage.length` is 0.
- Codex mode is disabled with a named reason (provider relay not running);
  scripted mode drives the same mock core offline.
- All 106 corpus scenarios replay in chat with no harness failure.

## Responsive, keyboard, and accessibility

- Three landmarks on chat routes (`nav` picker, `main` chat, `complementary`
  turn activity), one `h1`, chat-specific segment labels.
- 390×844: no horizontal page scroll on the chat, activity, and long-payload
  routes; segment and turn-strip touch targets meet the minimum; the composer
  stays in the thumb zone while the transcript scrolls.
- Enter sends, Shift+Enter inserts a newline without sending.
- "Back to chat" returns focus to the turn strip that opened the group.
- Turn settle announces politely; a denial announces assertively once.

# Screenshot acceptance set

Ten images in [`phase-07/`](phase-07/), slugs `phase-7i-<slug>-<viewport>` at
1440×900 and 390×844, recorded from the §11 routes after the shell reports the
expected `data-chat-state`. The manifest is
[`phase-07/phase-7i-screenshot-manifest.json`](phase-07/phase-7i-screenshot-manifest.json).

| Slug | Route |
| --- | --- |
| `chat-home` | `#/chat` |
| `chat-session` | `#/chat/ix-checkbox-01?replay=fake` |
| `chat-denied` | `#/chat/ap-mcp-gate-01?replay=fake&view=activity&turn=2` |
| `chat-activity-diff` | `#/chat/ix-checkbox-01?replay=fake&view=activity&turn=3` |
| `chat-streaming` | `#/chat/ap-mcp-gate-01?replay=fake&stage=streaming` |

# Open items

The UXDesigner §11 acceptance review of these ten images is the remaining gate
(PAP-16914 owns it). Deviations are recorded in §11a of the interaction map
rather than left implicit.
