# Native Runner Cumulative End-to-End Tutorial

This tutorial grows with each accepted phase. At Phase 0, the complete runnable
system is the standalone Rust mock-core tracer plus its TypeScript parity oracle;
there is intentionally no daemon, network connection, browser console, real
harness, or Paperclip bridge.

## Current end-to-end path

1. Follow [Phase 0: Run the Standalone Tracer](phase-00-standalone-tracer.md).
2. Confirm the final JSON contains `run_phase0_0001`,
   `session_phase0_0001`, and `succeeded`.
3. Confirm the cross-language parity check passes.
4. Confirm the shell prompt returns and no Paperclip service was started.
5. Open the [Phase 0 journal entry](../../knowledge/journal/2026-08-07-phase-00.md)
   and its linked verification evidence.

The one-command form after installation is:

```sh
pnpm --filter @paperclipai/paperclip-runner verify
```

## Cumulative guarantees

- the fixture is validated before any mock-core mutation;
- event sequence and run identity agree through the terminal result;
- Rust and TypeScript printed output is covered by exact string and parity assertions;
- deliberate TypeScript and Cargo references to Paperclip core are rejected;
- documentation and journal indexes are machine checked;
- the package remains runnable without Paperclip core.

The next phase may extend this tutorial only after its own implementation and
human checkpoint are authorized.
