---
type: Verification Evidence
title: Phase 7Q live turn streaming verification
description: Command-and-result record for streaming real Codex output end to end through the package session server and the browser — live turn events, the NDJSON turn stream, incremental rendering, stop behaviour, and the regression set.
tags: [native-runner, phase-7, clean-room, live-codex, streaming, verification, evidence]
status: stable
generated: { by: anthropic/claude-opus-5, at: 2026-08-10T18:40:00Z }
entry_kind: evidence
phase: "7"
---

# Scope

Track 7Q (PAP-16981) fixes the defect the board reported against the clean-room
chat: "it needs to stream — it seems like the response just simply shows up".
It did. A turn was awaited whole in `Phase7LiveSession`, answered as one JSON
body by the package session server, and consumed with `response.json()` in the
browser, so the earliest a reply could appear was after it was finished.

The rejected surface is `#/chat` in `devtools/issue-thread`, served by
`scripts/phase7-issue-thread-server.mjs` over `Phase7LiveSessionService`. The
scenario explorer (`examples/phase7-explorer` with `phase7i-demo-server.ts`) is
a different, deterministic path and is unchanged: its preset routes and its
staged `?stage=streaming` screenshot state are untouched, and neither is treated
here as evidence of live streaming.

# What changed

* `Phase7LiveSession` publishes bounded, ordered live turn events — assistant
  deltas, tool call and result activity, stop requests, terminal, and error —
  and mirrors the turn waiter's assembled text into the transcript entry the
  reply will finally occupy. The waiter's buffer stays the only assembly point,
  so the streamed draft cannot diverge from the settled reply.
* `src/phase7/turn-stream.ts` defines the NDJSON frame codec: `frame` for an
  interim projection, `settled` for the authoritative payload, `error` for a
  named failure. The decoder rejects a replayed, reordered, oversized, late, or
  truncated frame.
* `POST /api/phase7/ui/message` flushes headers, then writes one frame per
  event-loop tick of provider activity. Admission checks still answer with a
  JSON body and their own status code, because they are decided before the
  first frame.
* The browser client reads the frames and hands each projection to the surface,
  which renders it in place. One assistant card grows; the settled payload is
  applied last.

# Commands and results

All commands were run in `packages/paperclip-runner` on branch
`PAP-16679-paperclip-runner`.

| Command | Result |
| --- | --- |
| `vitest run src/phase7/turn-stream.test.ts` | 6 passed — codec round trip under one-character chunks, replay/late/truncation refusals, three gated deltas, interrupted partial retention, settled-payload read, error frame |
| `vitest run src/phase7/clean-room-server.test.ts` | 11 passed (9 pre-existing + 2 new) — including frames read before the gated turn is released, and provider interrupt on client abort |
| `vitest run` (package) | 40 files, 363 passed |
| `pnpm test:phase7` | 15 files, 167 passed |
| `playwright test --config devtools/issue-thread/playwright.config.ts` | 62 passed (60 pre-existing + 2 new streaming tests) |
| `playwright test --config examples/playwright.phase7.config.ts` | 43 passed — scenario explorer unchanged |
| `node scripts/check-forbidden-imports.mjs` | passed |
| `node scripts/check-phase7-inventory.mjs` | passed |
| `node scripts/check-browser-tokens.mjs` | passed |
| `node scripts/validate-doc-links.mjs` / `validate-okf.mjs` | passed |
| `pnpm build` | passed (TypeScript, Rust, browser, phase 5/6/7, issue thread; strict Phase 7I CSP check green) |
| `node scripts/phase7-clean-room-smoke.mjs --json` (real Codex) | 16/16 assertions true, including the new `streamedIncrementally` |

## Live Codex streaming measurement

A single clean-room turn against real Codex through real `paperclip-runnerd`,
asking for a four-sentence answer and no tool call:

```
headers at +265ms: application/x-ndjson; charset=utf-8   no-store, no-transform
frames: 64 (62 carrying assistant text)
  +2184ms    1 char   "I"
  +2188ms    3 chars  "I’m"
  +2193ms   11 chars  "I’m working"
  +2194ms   16 chars  "I’m working on a"
  ...
  +3066ms  301 chars  (terminal)
monotonic: true
last interim state === settled reply: true
assistant cards in the settled thread: 1
```

Response headers arrive at 265 ms — roughly two seconds before the provider's
first token — and the reply is delivered in 62 growing states rather than one.
The last interim state is byte-identical to the settled reply, and the settled
thread holds exactly one assistant card, so the streamed draft was finalised
rather than duplicated.

# Behaviour under stop and abandonment

* Stop during a stream reaches the Codex interrupt through the existing
  `/interrupt` route. The stopped turn keeps what it had streamed, the turn is
  marked stopped by the user, and nothing is appended afterwards
  (`src/phase7/turn-stream.test.ts`, plus the browser test that stops a live
  stream and re-reads the card after a delay).
* Abandoning the stream — reload, navigation, `New chat`, `Reset`, or an
  aborted fetch — disconnects the socket, and the server interrupts the turn
  rather than leaving it running. The session returns to `ready`, which an
  active turn would not (`clean-room-server.test.ts`).
* The client drops frames from a turn generation that has been abandoned, so a
  late chunk cannot land in a thread that has since been rotated.

# Preserved properties

* Mock-only control plane, the live-only projection guard on every frame, the
  real-API block record, redaction, per-session turn and message limits,
  bounded sessions, and the credential-absence probes are unchanged and still
  asserted by the clean-room suite on the streamed path.
* The frame count per turn is bounded; past the bound the turn still runs and
  still settles, only interim views stop.
* `Cache-Control: no-store, no-transform` and `X-Accel-Buffering: no` are set on
  the turn response, and no `Content-Length` is sent, so an intermediary cannot
  compress or buffer the frames back into a single body.
* Replay, preset, and fixture routes are unchanged and remain deterministic.

# Known limitation

The byte-stable 24-PNG issue-thread screenshot matrix
(`node scripts/record-phase7-ui-evidence.mjs --check`) reports a wholesale
mismatch on this host. It reproduces identically with the UI sources reverted to
`HEAD`, so it is an environment fingerprint difference rather than a regression
from this work; the recorded set is pinned to the Chromium build that produced
the committed PNGs.
