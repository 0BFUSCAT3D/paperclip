---
type: Verification Evidence
title: Phase 7U streamed-evidence disclosure and session capability remediation verification
description: Command-and-result record for the two exact-build security findings — allowlisted public stream DTO with redaction applied before evidence persistence, and per-browser session capability binding — including the observed failure of each new regression test against the rejected behaviour.
tags: [native-runner, phase-7, clean-room, streaming, security, redaction, authorization, verification, evidence]
status: stable
generated: { by: anthropic/claude-opus-5, at: 2026-08-10T22:40:00Z }
entry_kind: evidence
phase: "7"
---

# Scope

Track 7U (PAP-16991) remediates both findings the exact-build security review
(PAP-16983) raised against source `b73524ec2ac5c9f796f4067a85d8848801e2735b`,
build `phase7r-b73524ec2ac5-index-CXqou55h.js-f97f184f34e448c2`, bundle
`index-CXqou55h.js`, SHA-256
`fa0960a14279bb72941b2ece623d92124dffa1116974edfec3ad485a6e8dbd41`.

The runtime remains mock-Paperclip only. No ACPX, real Paperclip bridge, HTTPS
promotion, Tailscale Serve/cert/operator change, sudo work, node, or port is
introduced.

Finding 1 (High) was streamed sensitive-information disclosure: every projected
view carried raw `provider_event` records and unredacted tool results, so an
admitted browser received provider protocol traffic, the echoed prompt, provider
thread/turn/item identifiers, model and token metadata, and complete tool
payloads. Finding 2 (Medium) was cross-session BOLA: the only capability was
minted once per gateway process, so possession of a session id — not ownership of
it — authorized reads and mutations.

# What changed

* `src/phase7/evidence-redaction.ts` (new) is the single gate every live evidence
  record passes through before it is retained. Provider notifications reduce to a
  coarse category, provider diagnostics to the fact that one occurred, tool
  arguments to the catalog-declared field names they used, and tool results to
  the outcome, our own denial copy, the revisions, and the mock entity refs the
  projection resolves into cards. Unlisted kinds and unlisted fields produce
  nothing. `Phase7LiveSession.#appendEvidence` calls it, so redaction happens at
  record time — a raw payload never enters the snapshot, the store, a frame, or a
  log.
* `src/issue-thread/public-view.ts` (new) publishes the DTO. It copies the view
  field by field, so a field added to the projection cannot ship; replaces
  provider-authored turn and call identifiers with in-view aliases that stay
  consistent across anchors, evidence refs, and successive frames of one turn;
  and scrubs caller-declared withheld values (provider thread and session
  identity) from the encoded result.
* `src/issue-thread/live-projection.ts` composes `Runner & events` details from
  the redacted record instead of stringifying it, names the operation and its
  field count in `Calls & results` instead of echoing arguments, and re-narrows
  tool results on the way out.
* `scripts/phase7-issue-thread-server.mjs` publishes the DTO on every response
  path — interim frames, settled payloads, reconnect and replay replies — mints a
  per-browser capability per surface, stores only its SHA-256, compares it in
  constant time on every session-scoped route, answers `404` for a session owned
  by another capability, rotates on reset and `New chat` after revoking the old
  binding, and reports a streamed failure as a code with fixed operator copy
  rather than the underlying provider text.
* `src/phase7/turn-stream.ts` enforces the named byte cap on encoded UTF-8 bytes
  via `phase7Utf8ByteLength` instead of UTF-16 code units.
* `devtools/issue-thread/src/live-client.ts` states `credentials: "same-origin"`
  on every request, and `scripts/phase7-cookie-jar.mjs` (new) gives the smoke
  scripts one-browser behaviour.

# Observed failure against the rejected behaviour, then the fix

The rejected behaviour was reinstated in place (evidence redaction and the DTO
reduced to passthroughs, projection details stringified, capability comparison
forced true, raw error text restored, byte cap back to `String#length`), the
package rebuilt, and the new tests run.

```text
$ npx vitest run src/phase7/clean-room-server.test.ts \
    src/issue-thread/public-view.test.ts src/phase7/turn-stream.test.ts
Tests  19 failed | 18 passed (37)
```

All 19 new assertions failed; all 18 pre-existing tests in those files still
passed, so the new coverage — not a broken harness — is what fails. The
end-to-end canary sweep failed on the exact disclosure the review reported:

```text
AssertionError: expected '{"schema":"paperclip.phase7.issue-thr…' not to contain 'codex-thread-clean-room'
  runner[].detail = "{\"action\":\"started\",\"sessionId\":\"…\",
    \"providerThreadId\":\"codex-thread-clean-room\",
    \"providerSessionId\":\"codex-provider-clean-room\",…}"
```

With the fix restored:

```text
$ pnpm run test:phase7
Test Files  16 passed (16)
      Tests  188 passed (188)
```

# New coverage

`src/phase7/clean-room-server.test.ts` drives the real middleware, live session,
semantic dispatcher, authorization engine, and mock `ControlPlanePort` over HTTP.

* One turn plants a canary prompt echo, a credential in provider request
  headers, an environment value inside a provider diagnostic, model and token
  metadata, a provider-shaped item id, and an argument no catalog schema
  declares. The sweep scans every interim frame, the settled payload, the
  reconnect payload, the replay payload, the persisted public evidence, and
  captured `stdout`/`stderr`, and asserts none of the canaries, the provider
  thread id, the provider session id, the browser's own capability, the
  undeclared argument name, or `inputTokens` appears in any of them. The user's
  own message card is removed before scanning rather than exempted, so the one
  legitimate echo of the prompt cannot mask a second copy. The same test asserts
  the evidence panel still reports what happened, so the fix is a summary rather
  than a blank section.
* Two independent cookie jars prove reciprocal read denial and reciprocal
  mutation denial across `message`, `interrupt`, `reconnect`, `reset`, and
  `interaction`, on both the clean-room and the issue surface, plus denial to a
  cookie-less caller, while the owner keeps access throughout.
* Reset and `New chat` rotate the capability, and the previous cookie is proved
  dead against the replacement session as well as the retired one, on both
  surfaces.
* Two tabs of one browser each hold their own session without revoking the
  other, and a different browser still reaches neither. Rotation belongs to the
  actions that start something new — `New chat`, a scenario POST, reset — not to
  reopening a page whose stored id is simply gone, because rotating there would
  make two tabs ping-pong while protecting nothing: one browser is one
  principal, and cross-browser denial rests on the binding rather than on how
  often the value changes.

`src/issue-thread/public-view.test.ts` pins the two components: allowlist copying
drops injected fields, tool payloads narrow to the rendered summary, provider
identifiers alias consistently, withheld values are scrubbed from free text, and
each redaction rule is asserted against a canary.

`src/phase7/turn-stream.test.ts` proves the frame cap trips on encoded bytes for
multi-byte text that is under the cap by code units, and that
`phase7Utf8ByteLength` agrees with `TextEncoder` including surrogate pairs and a
lone surrogate left by a chunk boundary.

# Preserved invariants

Incremental NDJSON streaming, monotonic sequencing, stop and abandonment
cleanup, the turn/session/frame/body limits, mock-only enforcement, the
real-Paperclip API block, and the clean room's live-only guard are all still
asserted by the pre-existing tests in the same files, which pass unchanged.

# Commands and results

```text
$ npx tsc -p tsconfig.json --noEmit                     # clean
$ npx tsc -p tsconfig.browser.json --noEmit             # clean
$ pnpm run test:phase7                                  # 16 files, 188 tests passed
$ pnpm run test:phase5                                  # 3 files, 22 tests passed
$ npx vitest run                                        # 41 files, 384 tests passed
$ pnpm run test:browser:issue-thread                    # 62 passed
$ npx playwright test --config examples/playwright.phase7.config.ts
                                                        # 43 passed
$ pnpm run check:phase7-inventory                       # passed
$ pnpm run check:phase-07-contract                      # passed
$ pnpm run check:forbidden-imports                      # passed
$ pnpm run docs:validate                                # 94 files, 35 concepts, 8 indexes
```

`test:phase7` was widened from `src/issue-thread/issue-thread.test.ts` to
`src/issue-thread` so the new suite is inside the gate rather than beside it.

The browser gates need the vendored aarch64 Chromium libraries on
`LD_LIBRARY_PATH`; without them Playwright's bundled `headless_shell` cannot load
`libatk-1.0.so.0` and every browser test fails to launch. The
`examples/playwright.phase7.config.ts` gate does not read
`PAPERCLIP_RUNNER_CHROMIUM_PATH`, so it needs the library environment rather than
the pin.

# Known pre-existing failure, not caused by this change

`pnpm run check:phase7:ui` reports all 24 committed PNGs as not byte-stable in
this environment, with the pinned Chromium 151.0.7922.34. It is pre-existing:
reverting the only two bundle inputs this track touches
(`devtools/issue-thread/src/live-client.ts`, `src/phase7/turn-stream.ts`) to
`HEAD` and re-running reproduces the same 24-file mismatch. A pixel diff shows a
whole-page difference (for example `denial-optional-tool--desktop.png`, 207,794
differing pixels, bounding box covering the page) rather than a localised copy
change, which is the environment-difference signature the recorder itself warns
about. The re-recorded captures were discarded and the committed PNGs restored
unchanged, because that acceptance set is gated UX evidence and must not be
replaced with bytes from a different rendering environment.

One unhandled rejection surfaces in the full suite from
`src/drivers/codex/app-server-transport.test.ts` ("codex app-server transport
closed"). That file is untouched here and all 384 tests still pass.
