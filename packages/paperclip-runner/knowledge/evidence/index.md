# Verification Evidence

## Phase evidence

* [Phase 0 verification](2026-08-07-phase-00-verification.md) - Clean install, build, tests, boundary, documentation, OKF, and tracer results.
* [Phase 0 Rust correction verification](2026-08-07-phase-00-rust-correction-verification.md) - Rust build/tests, cross-language parity, and corrected boundary evidence.
* [Phase 1 verification](2026-08-07-phase-01-verification.md) - Schema, golden, reducer, Rust parity, CLI, browser, token, boundary, and screenshot evidence.
* [Phase 2 verification](2026-08-07-phase-02-verification.md) - Rust supervisor, fake-driver scenarios, cleanup, live/replay parity, browser flows, screenshots, and complete package verification.
* [Phase 3 verification](2026-08-07-phase-03-verification.md) - Lost-ACK replay, restart recovery, command deduplication, storage, and redacted diagnostics.
* [Phase 4 verification](2026-08-08-phase-04-verification.md) - Direct Codex conformance, exact skillless context, semantic completion, recovery, and real-session replay.
* [Phase 4b protocol/server verification](2026-08-08-phase-04b-protocol-server-verification.md) - Browser-resolved requests, goals, lineage, controls, reconnect, redaction, and real Codex server evidence.
* [Phase 4b live console verification](2026-08-08-phase-04b-live-console-verification.md) - Demo-driver, transcript-model, browser, keyboard, boundary, token, and screenshot evidence for the live console.
* [Phase 4b QA verification](2026-08-08-phase-04b-qa-verification.md) - Independent QA pass: clean-start tutorial in a real browser, deterministic demos, real Codex end-to-end session, full `verify` acceptance (exit 0), and screenshots (PAP-16837).
* [Phase 5 browser SDK verification](2026-08-08-phase-05-verification.md) - Targeted and package-acceptance evidence for the versioned SDK, both public consumers, fake/real drivers, accessibility, reconnect, replay, and screenshots.
* [Phase 6 thin Paperclip adapter verification](2026-08-09-phase-06-verification.md) - Mock and database-backed conformance, authoritative completion, restart recovery, migration repair, atomic liveness, internal canary, and deterministic post-kill-switch legacy evidence.
* [Phase 7F browser scenario explorer verification](2026-08-09-phase-07f-explorer-verification.md) - Scenario index, run artifacts, exposure, authorization, state diff, parity, route determinism, accessibility, and the 24-image screenshot acceptance set.
* [Phase 7I interactive scenario chat verification](2026-08-09-phase-07i-chat-verification.md) - Turn model, per-turn evidence, denied and successful mock interactions from chat, reset isolation, route determinism, responsive and keyboard behaviour, and the ten-image screenshot acceptance set.
* [Phase 7 documentation, tutorial, and evidence manifest (Revision 2, historical)](2026-08-09-phase-07-verification.md) - Command→result matrix for the Revision 2 preview build; retained for comparison and superseded by the final manifest below.
* [Phase 7 evidence](phase-07/) - Screenshot acceptance captures and the eval conformance parity report.
* [Phase 7G issue-thread UI verification](2026-08-10-phase-07g-issue-thread-ui-verification.md) - View-model tests, browser coverage, the axe gate on 12 slugs × 2 viewports, the byte-stable 24-PNG matrix, and the live runnerd/Codex smoke.
* [Phase 7 final evidence manifest (Revision 3/4)](2026-08-10-phase-07i-final-evidence.md) - Authoritative Phase 7I manifest for the final candidate build `865d1a72`: offline and live command results, conformance and approved security results, screenshot eligibility, and the Revision 2 ineligibility record.
* [Phase 7M clean-room live chat verification](2026-08-10-phase-07m-clean-room-verification.md) - Blank-seed enforcement, deterministic exposure profile, allowed/denied semantic calls, durable multi-turn session, identity rotation on reset and new chat, the real-API block record, browser and axe coverage, and the live Codex smoke.
