# Native Runner Tutorials

The tutorials are cumulative and are always run from the repository root.
Each tutorial starts with an explanation of what the phase is and what the phase proves.

## Implemented phases

- [Phase 0: standalone tracer](tutorials/phase-00-standalone-tracer.md) — install the workspace, validate its Rust/TypeScript boundary and knowledge bundle, then run the deterministic Rust mock-core path and cross-language parity check.
- [Phase 1: static PRP replay](tutorials/phase-01-static-replay.md) — validate the shared schema/fixture corpus, reduce a fixture in the CLI, and inspect the same final snapshot in the standalone browser page.
- [Phase 2: local runner and fake harness](tutorials/phase-02-local-runner.md) — run a supervised Rust process, exercise scripted live scenarios, resolve requests, interrupt a turn, and confirm live/replay parity.
- [Phase 3: break recovery on purpose](tutorials/phase-03-break-recovery.md) — lose an ACK, drop the socket, restart the runner side, replay durable events, and inspect recovery diagnostics.
- [Cumulative end-to-end tutorial](tutorials/end-to-end.md) — the shortest complete workflow available at the current phase.

## Reference

- [Architecture and dependency boundary](architecture.md)
- [PRP compatibility and versioning policy](protocol-compatibility.md)
- [Phase 2 local protocol and supervision](phase-02-local-protocol.md)
- [Phase 3 durable transport and recovery](phase-03-durable-transport.md)
- [Engineering journal guide](journal.md)
- [Dated shadcn/ui and AI Elements compatibility note](research/2026-08-07-ui-library-compatibility.md)
- [Package README](../README.md)

Phase 3 is implemented and ready for its review and human checkpoint. Later tutorials remain deferred.
