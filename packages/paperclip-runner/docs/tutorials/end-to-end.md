# Native Runner Cumulative End-to-End Tutorial

## What this tutorial is

This tutorial combines each implemented Native Runner phase into one procedure. It currently includes Phase 0, Phase 1, and Phase 2.

## What this tutorial proves

This tutorial proves that the standalone package boundary, static replay path,
and local live-run path work together. It does not use Paperclip or a real model.

The current system includes the Rust mock-core tracer, shared protocol fixtures,
the Rust supervisor, a scripted fake harness, CLI live runs, and browser live and
replay modes.

## Current end-to-end path

1. Follow [Phase 0: Run the Standalone Tracer](phase-00-standalone-tracer.md).
2. Confirm the final JSON contains `run_phase0_0001`,
   `session_phase0_0001`, and `succeeded`.
3. Confirm the cross-language parity check passes.
4. Confirm the shell prompt returns and no Paperclip service was started.
5. Open the [Phase 0 journal entry](../../knowledge/journal/2026-08-07-phase-00.md)
   and its linked verification evidence.
6. Follow [Phase 1: Validate and Replay a PRP Fixture](phase-01-static-replay.md).
7. Compare the happy-path CLI snapshot with the browser page.
8. Exercise the duplicate, gap, unknown-field, and unsupported-version fixtures.
9. Open the [Phase 1 journal entry](../../knowledge/journal/2026-08-07-phase-01.md)
   and its linked verification evidence.
10. Follow [Phase 2: Run the Local Runner and Fake Harness](phase-02-local-runner.md).
11. Run the happy, permission/input, interruption, error, and duplicate-terminal scenarios.
12. Open the browser live mode and confirm the completed run says `Match` for live and replay output.
13. Open the [Phase 2 journal entry](../../knowledge/journal/2026-08-07-phase-02.md)
    and its linked verification evidence and screenshots.

The one-command form after installation is:

```sh
pnpm --filter @paperclipai/paperclip-runner verify
```

On a minimal Debian or Ubuntu host without root access, use the rootless browser
dependency path:

```sh
pnpm --filter @paperclipai/paperclip-runner verify:rootless
```

## Cumulative guarantees

- the fixture is validated before any mock-core mutation;
- event sequence and run identity agree through the terminal result;
- Rust and TypeScript printed output is covered by exact string and parity assertions;
- deliberate TypeScript and Cargo references to Paperclip core are rejected;
- documentation and journal indexes are machine checked;
- the package remains runnable without Paperclip core;
- JSON Schema remains the language-neutral authority for TypeScript and Rust;
- replay is deterministic and idempotent under duplicate delivery;
- source gaps are visible and never synthesized away;
- CLI and browser paths use the same validator/reducer module;
- browser components keep visual values in the package-local token layer.
- the Rust supervisor owns the fake harness process group and cleans it up when the controller closes;
- command IDs are idempotent and controller sequence numbers stay contiguous;
- runtime permission and input requests round-trip over the local protocol;
- process exit is recorded separately from the structured semantic result;
- bounded logs retain only their configured tail;
- exactly one terminal event closes every completed local trace;
- every live browser event passes the Phase 1 validator and reducer before display;
- replaying the completed live event list produces the same final snapshot.

Phase 3 may extend this tutorial only after the Phase 2 human checkpoint is
accepted and the next phase is authorized.
