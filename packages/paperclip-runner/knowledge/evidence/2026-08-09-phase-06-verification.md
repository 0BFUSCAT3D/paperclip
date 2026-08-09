---
type: Verification Evidence
title: Phase 6 thin Paperclip adapter verification
description: Targeted package, database-port, finalization, security-boundary, feature-selection, and legacy fallback evidence.
tags: [native-runner, phase-6, verification, paperclip, replay, finalization]
status: stable
generated: { by: openai/gpt-5.6, at: 2026-08-09T03:01:00Z }
---

# Scope

This record verifies the default-off Phase 6 tracer at the approved
`ControlPlanePort`/`NativeSessionBackend` boundary. No browser surface changed,
so Phase 6 has command/database evidence rather than screenshots.

# Package contract and mock tracer

```sh
pnpm --filter @paperclipai/paperclip-runner exec vitest run \
  src/conformance/control-plane-port.test.ts \
  src/backends/harness-driver-backend.test.ts \
  src/contracts/native-execution.test.ts

pnpm --filter @paperclipai/paperclip-runner trace:phase6 -- \
  --target mock --scenario happy-path
```

Result: three files and five tests passed. The stable trace reported native
mode, `runStatus=succeeded`, three events, contiguous source sequence 3,
`workspaceFinalizeStatus=succeeded`, zero legacy invocations, and a server-owned
`done` decision with status version 0 -> 1.

# Real Paperclip adapter and public-session task

```sh
pnpm --filter @paperclipai/paperclip-runner build:typescript
pnpm --filter @paperclipai/server exec vitest run \
  src/services/native-runtime/paperclip-control-plane-port.test.ts \
  src/services/native-runtime/runtime-mode.test.ts \
  src/services/native-runtime/status-arbiter.test.ts
```

Result: three files and ten tests passed against embedded PostgreSQL. The same
package conformance suite passed unchanged against `PaperclipControlPlanePort`.
A selected task then ran end-to-end through `executeNativeSession`, the public
backend/port contracts, durable PRP events, immutable result ingestion,
workspace finalization, assessment, CAS status decision, and audit persistence.
The issue moved from `in_progress` version 0 to `done` version 1.

The focused corpus also proved:

- global flag off and no agent opt-in both select legacy;
- an eligible explicit profile selects native;
- remote, non-standard, or non-Codex explicit profiles fail closed;
- company/run/agent/issue/source bindings reject mismatches;
- source gaps remain visible, identical retries deduplicate, and replay is
  exclusive and byte-stable;
- incomplete/review/yield/cancelled results remain non-terminal;
- only a first-class reported blocker selects `blocked`;
- a completion decision writes immutable assessment/decision/effect records and
  an activity-log audit row.
- a failed workspace barrier preserves the accepted semantic result, leaves the
  issue status unchanged, and records a recoverable `workspace_failed` phase.

# Compile and migration checks

```sh
pnpm --filter @paperclipai/paperclip-runner typecheck
pnpm --filter @paperclipai/shared typecheck
pnpm --filter @paperclipai/server exec tsc --noEmit
pnpm --filter @paperclipai/db typecheck
```

Result: all checks passed. Migration numbering and safety passed. Migration
0211 deterministically resequences historical heartbeat events before adding
the unique run sequence invariant, backfills each run's next allocator value,
and installs issue status-version tracking.

Focused legacy regression:

```sh
pnpm --filter @paperclipai/server exec vitest run \
  src/__tests__/heartbeat-workspace-finalize-branch.test.ts \
  src/__tests__/heartbeat-process-recovery.test.ts \
  src/__tests__/heartbeat-runtime-state.test.ts
```

Result: three files and 106 tests passed, covering unchanged adapter execution,
workspace finalization, cancellation, process recovery, and runtime/session
state behavior with the flag left at its default.

# Credential, governance, budget, and legacy boundaries

`native-execution.test.ts` rejects unknown top-level or nested launch fields and
proves the model envelope omits company/run/agent bindings and credential
references. The native branch never creates a local agent JWT, MCP gateway, raw
adapter environment, or legacy context. Runtime requests cannot auto-approve;
the native interaction bridge rejects unsupported requests explicitly.

Explicit cancellation, agent pause, and budget hard-stop share
`cancelRunInternal`, which now invokes the run-scoped normalized native session
before existing process/resource cleanup. The default and kill-switch paths
execute the pre-existing adapter branch; no same-run native-to-legacy fallback
exists. Recovery queries persisted native mode/coordinator state rather than
the current flag.

```sh
pnpm --filter @paperclipai/server exec vitest run \
  src/services/native-runtime/native-session-executor.test.ts

pnpm --filter @paperclipai/server exec vitest run \
  src/__tests__/heartbeat-stale-queue-invalidation.test.ts \
  -t "daily cost cap"
```

Result: native cancellation reached the active normalized session and removed
the handle afterward; the daily cost hard stop cancelled a queued run before
any adapter execution.

# Remaining operational checkpoint

The [Phase 6 tutorial](../../docs/tutorials/phase-06-thin-paperclip-adapter.md)
contains the exact board-authorized commands for enabling one local agent,
running and inspecting a live Codex task, disabling the flag, proving a fresh
legacy selection, and restoring the agent profile. Those commands intentionally
do not pass credentials to the package or model.
