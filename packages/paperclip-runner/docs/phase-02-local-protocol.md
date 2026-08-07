# Phase 2 Local Protocol and Supervision Reference

## Scope

Phase 2 proves one native local session. It uses no Paperclip service, database,
network provider, or model. The TypeScript mock core, Rust runner, and Rust fake
harness are all inside `packages/paperclip-runner/`.

## Processes and transports

| Boundary | Transport | Input | Output |
|---|---|---|---|
| Mock core → runner | stdin JSONL | `paperclip.prp.command.v1` | — |
| Runner → mock core | stdout JSONL | — | `paperclip.runner.stream.v1` |
| Runner → fake harness | stdin JSONL | `paperclip.fake_harness.command.v1` | — |
| Fake harness → runner | stdout JSONL | — | `paperclip.fake_harness.message.v1` |
| Mock core → browser | local HTTP + NDJSON | start/actions | validated events and final trace |

Stderr is diagnostic input. It never becomes a command or canonical event.

## Deterministic lifecycle

1. `run.prepare` creates the harness process group.
2. The harness sends `ready`.
3. `session.open` starts one fake driver session.
4. `turn.start` starts one scripted turn.
5. The harness emits typed events, requests, logs, a semantic result, and a
   terminal proposal.
6. The runner waits for the harness process and records `harness.exited`.
7. The runner emits one `run.terminal` event and exits zero.

The runner gives each canonical event a deterministic source ID, source
sequence, and timestamp. Script delay can be overridden for fast tests.

## Command rules

- `controllerSeq` starts at 1 and is contiguous.
- The runner stores the canonical JSON for each accepted `commandId`.
- The same ID and same content returns `duplicate` without repeating an effect.
- The same ID with different content is rejected.
- A sequence gap is rejected.
- Phase 2 supports prepare, open, turn start, request resolution, interruption,
  stop, close, and cancel command shapes. A script consumes only the commands it
  expects.

## Fake-driver scripts

Scripts live under `protocol/fixtures/phase-02/scripts/`.

| Script | Proof |
|---|---|
| `happy-path` | Lifecycle, tool/command item, file item, logs, result, and success terminal |
| `permission-input` | Permission request and free-text input round-trip |
| `interrupted` | Operator interruption, yielded result, exit 130, and cancelled terminal |
| `error` | Non-zero process exit stays separate from the yielded semantic result |
| `duplicate-terminal` | A second terminal proposal is ignored and diagnosed |
| `linger` | Supervisor terminates the harness and its worker process group |

## Cleanup and credential boundary

The runner starts the harness in a new process group on Unix. Normal exit waits
for the process. Controller EOF or explicit cleanup sends `TERM`, waits for the
configured grace time, and then sends `KILL` to the full group. Drop cleanup is
a final guard.

The mock core passes only a small process environment. The runner also clears
the inherited environment before it starts the fake harness. Paperclip keys,
model keys, and AgentMail keys are not forwarded.

## Bounded diagnostics

The runner keeps only the configured number of lines and bytes. It reports the
retained lines, retained bytes, and dropped-line count with `harness.exited`.
This log tail is separate from canonical events and the semantic result.

## Result and terminal authority

These facts are independent:

- `run.result.proposed` is the fake driver's structured work claim;
- `harness.exited` is the operating-system process fact;
- `run.terminal` is the one canonical terminal event for the local trace.

A scripted error can report useful yielded work and exit 7. An interruption can
report yielded work and exit 130. Neither process fact silently replaces the
semantic result.

## Browser live mode

The Vite middleware starts the same TypeScript mock-core controller used by
tests. It streams history plus new events as NDJSON. The browser validates each
event with the Phase 1 schema, checks run/session binding, and applies the Phase
1 reducer. At completion it replays the full event list and compares both final
snapshots.

The browser reuses package-local shadcn-style Button, Badge, Card, and Textarea
components. All visual values remain in `styles.css`.

## Deferred work

Phase 2 has no durable outbox, ACK, reconnect, runner restart recovery, real
harness, production Paperclip bridge, or browser-to-runner connection. Those
items require later authorized phases.
