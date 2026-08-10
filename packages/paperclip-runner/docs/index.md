# Native Runner Tutorials

The tutorials are cumulative and are always run from the repository root.
Each tutorial starts with an explanation of what the phase is and what the phase proves.

## Implemented phases

- [Phase 0: standalone tracer](tutorials/phase-00-standalone-tracer.md) — install the workspace, validate its Rust/TypeScript boundary and knowledge bundle, then run the deterministic Rust mock-core path and cross-language parity check.
- [Phase 1: static PRP replay](tutorials/phase-01-static-replay.md) — validate the shared schema/fixture corpus, reduce a fixture in the CLI, and inspect the same final snapshot in the standalone browser page.
- [Phase 2: local runner and fake harness](tutorials/phase-02-local-runner.md) — run a supervised Rust process, exercise scripted live scenarios, resolve requests, interrupt a turn, and confirm live/replay parity.
- [Phase 3: break recovery on purpose](tutorials/phase-03-break-recovery.md) — lose an ACK, drop the socket, restart the runner side, replay durable events, and inspect recovery diagnostics.
- [Phase 4: run the skillless Codex driver](tutorials/phase-04-skillless-codex.md) — run a safe real-model task, inspect the exact context boundary, steer or interrupt it, and confirm one replay-safe result.
- [Phase 4b: run the protocol demo server](tutorials/phase-04b-protocol-server.md) — exercise the server-only Codex boundary, canonical replay, typed controls, and reconnect with `curl`.
- [Phase 4b: run the live Codex protocol console](tutorials/phase-04b-live-console.md) — chat with a live session in the browser, steer it, stop it three ways, answer its requests, change its goal, break its connection, and replay the record.
- [Phase 5: run the SDK console and mini consumer](tutorials/phase-05-sdk-console.md) — exercise the versioned public browser/React surface in two independent consumers against fake and real drivers.
- [Phase 6: run the thin Paperclip adapter](tutorials/phase-06-thin-paperclip-adapter.md) — prove mock/real conformance, run one feature-flagged local task, inspect replay/finalization, disable the kill switch, and verify legacy fallback.
- [Phase 7: the Paperclip-style issue thread over a mock control plane](tutorials/phase-07-issue-thread.md) — the canonical clean-start tutorial for the final build: prove the 106-case conformance suite, open the issue thread in deterministic fake mode, record the byte-stable screenshot matrix, and optionally drive a real Codex turn — all from a clean checkout with no Paperclip service.
- [Phase 7: explore the capability contract and scenario explorer](tutorials/phase-07-scenario-explorer.md) — companion tour of the read-only browser explorer over the mock control plane and the focused verification set.
- [Phase 7I: chat with the mock control plane](tutorials/phase-07i-scenario-chat.md) — the scenario-explorer chat surface: send prompts to a Phase 7 scenario and watch the mock Paperclip activity for every turn: exposure, typed calls, denials, control-plane-owned actions, state diffs, wakes, and per-turn parity.
- [Phase 7: chat with real Codex in a clean room](tutorials/phase-07-clean-room-chat.md) — the second primary path: open a blank chat on a freshly minted mock tenant, send a free-form message to real Codex through real runnerd, and inspect the tool, policy, and state evidence on demand.
- [Cumulative end-to-end tutorial](tutorials/end-to-end.md) — the shortest complete workflow available at the current phase.

## Reference

- [Architecture and dependency boundary](architecture.md)
- [PRP compatibility and versioning policy](protocol-compatibility.md)
- [Phase 2 local protocol and supervision](phase-02-local-protocol.md)
- [Phase 3 durable transport and recovery](phase-03-durable-transport.md)
- [Phase 4 skillless Codex driver](phase-04-skillless-codex-driver.md)
- [Phase 4b protocol and demo server](phase-04b-protocol-server.md)
- [Phase 4b live console](phase-04b-live-console.md)
- [Phase 5 browser SDK and reference console](phase-05-sdk.md)
- [Phase 6 thin Paperclip adapter](phase-06-thin-paperclip-adapter.md)
- [Phase 7 capability contract (generated)](phase-07-capability-contract.md)
- [Phase 7 capability disposition](phase-07-capability-disposition.md)
- [Phase 7 mock ControlPlanePort](phase-07-mock-control-plane-port.md)
- [Phase 7 semantic catalog and authorization](phase-07-semantic-catalog.md)
- [Phase 7 semantic tool catalog](phase-07-semantic-tools.md)
- [Phase 7 authorization and exposure](phase-07-authorization-and-exposure.md)
- [Phase 7 eval-derived conformance](phase-07-eval-conformance.md)
- [Phase 7 browser scenario explorer](phase-07-scenario-explorer.md)
- [Phase 7 live runnerd/Codex loop](phase-07-live-runnerd-codex.md)
- [Phase 7 execution modes and identity (fake vs real Codex)](phase-07-execution-modes.md)
- [Phase 7 Paperclip-style issue-thread UI](phase-07-issue-thread-ui.md)
- [Phase 7 clean-room live chat](phase-07-clean-room-chat.md)
- [Phase 7I interactive scenario chat](phase-07i-scenario-chat.md)
- [Phase 7 final evidence manifest (Revision 3/4)](../knowledge/evidence/2026-08-10-phase-07i-final-evidence.md)
- [Phase 7 future binding boundary (Phase 8 / ACPX)](phase-07-future-binding-boundary.md)
- [Phase 7 verification commands](phase-07-verification-commands.md)
- [Phase 7 scenario explorer UX interaction map](design/phase-7-scenario-explorer-ux.md)
- [Phase 7I mobile chat UX interaction map](design/phase-7i-mobile-chat-ux.md)
- [Engineering journal guide](journal.md)
- [Dated shadcn/ui and AI Elements compatibility note](research/2026-08-07-ui-library-compatibility.md)
- [Phase 4b live-console interaction map](design/phase-4b-interaction-map.md)
- [Phase 4b component decision record (shadcn/ui, AI Elements)](design/phase-4b-component-decisions.md)
- [Phase 5 component and SDK surface plan](design/phase-5-component-plan.md)
- [Phase 5 SDK extraction decision record](design/phase-5-component-decisions.md)
- [Phase 6 thin Paperclip adapter boundary](design/phase-6-thin-paperclip-adapter.md)
- [Package README](../README.md)

Phase 6 is implemented as a default-off server integration at the public
package boundary. Production Paperclip UI integration remains deferred.
