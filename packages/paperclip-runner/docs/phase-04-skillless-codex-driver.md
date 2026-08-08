# Phase 4 Skillless Codex Driver

## Scope

Phase 4 implements a direct Codex app-server v2 driver behind the package's
existing `HarnessDriver` contract. The driver, mock core, example CLI, tests,
and evidence stay inside `packages/paperclip-runner/`. They do not import or
change Paperclip server, UI, database, or production control-plane behavior.

The app-server process is local to the execution environment and uses newline
delimited JSON-RPC over stdio. It is not exposed as a network service.

## Identity mapping

| Runner identity | Codex source | Persistence rule |
| --- | --- | --- |
| run ID | mock-core input | Never replaced during recovery. |
| normalized session ID | `session:<runId>` | Stable across transport/process recovery. |
| driver session ID | `thread.id` | Resumed by exact ID. A different returned ID fails recovery. |
| provider session ID | `thread.sessionId` | Kept separately from the driver thread ID. |
| turn ID | `turn.id` | Required by steer and interrupt preconditions. |
| item ID | `item.id`, request ID, or deterministic turn/kind key | Preserved on lifecycle and delta events. |
| source event ID | runner instance + run + source sequence | Source sequence continues from the persisted snapshot. |

The persisted session snapshot records run, normalized session, driver
session, provider session, active turn, and last source sequence. Recovery
starts a new local app-server transport, calls `thread/resume`, then uses
`thread/read` for reconciliation. It never silently starts a replacement
thread.

## App-server operations

| Driver operation | App-server method | Degradation |
| --- | --- | --- |
| initialize | `initialize`, then `initialized` | Startup fails visibly. |
| create | `thread/start` | Required. |
| resume | `thread/resume` | `recovered: false` with a redacted reason. |
| read | `thread/read` | Explicit `UnsupportedCodexOperationError`. |
| start turn | `turn/start` | Required. |
| steer | `turn/steer` with `expectedTurnId` | Explicit unsupported diagnostic; no stdin fallback. |
| interrupt | `turn/interrupt` | Explicit unsupported diagnostic; session is not killed. |
| usage | `thread/tokenUsage/updated` | Returns the last snapshot or explicit unsupported error. |
| reconcile | `thread/read` plus `session.reconciled` | Disabled when read is unavailable. |

Capability flags are descriptive and executable. Unsupported operations emit
canonical `harness.diagnostic` events with secret-redacted detail. No
harness-specific branch is required in the mock core.

## Skillless context boundary

The model receives one text input containing `paperclip.skillless_task.v1`:

- objective;
- completion-contract revision and criteria;
- task constraints; and
- the expected canonical result schema name.

The thread config explicitly disables automatic skill, app, and collaboration
instruction blocks. The model input accepts only text, never a Codex `skill`
input. The driver captures the returned instruction-source list and requires it
to be empty for the skillless assertion.

The child process environment is allowlisted. It may receive only local runtime
keys such as `PATH`, `HOME`, `CODEX_HOME`, locale, temporary-directory, trusted
certificate, and credential-free proxy settings. Paperclip bearer values,
`OPENAI_API_KEY`, arbitrary skill paths, and other inherited variables are not
passed. Diagnostics redact bearer/basic credentials, credentialed proxy URLs,
secret query parameters, sensitive JSON keys, and common key assignments.

The context snapshot records configuration and environment **key names**, not
secret values.

## Semantic completion

The provider-facing structured-output schema covers `done` and `needs_review`.
It uses the strict OpenAI shape: every object rejects additional properties and
the constant schema field includes both `type: "string"` and `const`.

Two dynamic semantic tools are registered when supported:

- `paperclip_finish` accepts `done` or `needs_review`;
- `paperclip_block` accepts `blocked` and requires a blocker owner, action,
  reason, and scope.

Both normalize through the canonical `paperclip.run_result.v1` validator. The
first valid result is committed. Repeating the same result is idempotent; a
different later result is rejected. A completed turn with no valid semantic
result produces one explicit `needs_review` result and one failed terminal
event. Process exit or prose alone never implies completion.

## Canonical event mapping

- thread lifecycle -> `session.started`, `session.resumed`,
  `session.reconciled`;
- turn lifecycle -> `turn.submitted`, `turn.accepted`, `turn.started`, and one
  terminal turn event;
- messages, reasoning, plans, commands, file changes, dynamic tools, and diffs
  -> `item.started`, `item.delta`, `item.completed`;
- model selection -> a completed `model` item;
- app-server decisions -> `runtime_request.created` and
  `runtime_request.resolved` with redacted detail;
- token snapshots -> completed `usage` items;
- semantic verification rows -> completed `verification` items;
- completion -> one `run.result.proposed` and one `run.terminal`.

The existing Phase 1 reducer consumes the live stream and the replay stream.
The Phase 4 tracer requires byte-equivalent snapshots, contiguous source
sequences, stable item IDs, one result, and one terminal event.

## Runnable example

`trace:phase4` starts a real local `codex app-server` session through the mock
core. Its safe task can create only `hello.txt`, disables network access, and
checks the exact file contents. See the
[Phase 4 tutorial](tutorials/phase-04-skillless-codex.md).

This phase changes no browser surface, so no new browser screenshot applies.
The canonical events are proved through the existing reducer/replay path and
JSON trace evidence.
