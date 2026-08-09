---
type: Verification Evidence
title: Phase 6 thin Paperclip adapter verification
description: Targeted package, database-port, finalization, security-boundary, feature-selection, and legacy fallback evidence.
tags: [native-runner, phase-6, verification, paperclip, replay, finalization]
status: stable
generated: { by: openai/gpt-5.6, at: 2026-08-09T05:52:00Z }
---

# Scope

This record verifies the default-off Phase 6 tracer at the approved
`ControlPlanePort`/`NativeSessionBackend` boundary. No browser surface changed,
so Phase 6 has command/database evidence rather than screenshots.

The counts below are the PAP-16878 remediation rerun. “Internal canary” means
the selected-task database test through the public package session contract;
it does not mean that a new live Codex provider task was dispatched.

# Package contract and mock tracer

```sh
pnpm --filter @paperclipai/paperclip-runner exec vitest run \
  src/conformance/control-plane-port.test.ts \
  src/backends/harness-driver-backend.test.ts \
  src/contracts/native-execution.test.ts \
  src/native-session-runtime.test.ts

pnpm --filter @paperclipai/paperclip-runner trace:phase6 -- \
  --target mock --scenario happy-path
```

Result: four files and seven tests passed. The stable trace reported native
mode, `runStatus=succeeded`, three events, contiguous source sequence 3,
`workspaceFinalizeStatus=succeeded`, zero legacy invocations, and a server-owned
`done` decision with status version 0 -> 1. Restart recovery reused the bound
provider session checkpoint, opened no second session or turn, retained the
existing accepted result event, and appended only the missing terminal fact.

# Real Paperclip adapter and public-session task

The complete acceptance gate below passed 42 tests in thirteen files against
embedded PostgreSQL with zero skipped tests. Database-backed tests start their
own database instead of skipping when a developer `DATABASE_URL` is absent.
The same package conformance suite passed unchanged against
`PaperclipControlPlanePort`.
A selected task then ran end-to-end through `executeNativeSession`, the public
backend/port contracts, durable PRP events, immutable result ingestion,
workspace finalization, assessment, CAS status decision, and audit persistence.
The issue moved from `in_progress` version 0 to `done` version 1 only after its
criterion and verification cited an approved, issue-scoped durable work
product. A model-only result remained non-terminal and received a persisted
continuation wake.

The focused corpus also proved:

- global flag off and no agent opt-in both select legacy;
- an eligible explicit profile selects native;
- remote, non-standard, or non-Codex explicit profiles fail closed;
- company/run/agent/issue/source bindings reject mismatches;
- source gaps remain visible, identical retries deduplicate, and replay is
  exclusive and byte-stable; mutated identities, sequences, results, and
  bindings fail closed in the shared mock/real port suite;
- result-less transport loss dispatches the original persisted native run from
  its closed envelope/provider checkpoint after a database lease, including
  flag-off restart and active-turn recovery without a second run, provider
  session, or turn; the scripted provider boundary returns one result and the
  real heartbeat/finalizer path persists one assessment, decision/effect set,
  and terminal projection without invoking the legacy adapter;
- resolved confirmations and question answers enter the persisted native input
  only through the authorized issue-interaction service; governed, unresolved,
  unsupported, or self-approved paths fail closed without credentials;
- incomplete/review/yield/cancelled results receive a durable review,
  continuation, or recovery path;
- only a task-wide blocker with a named owner and action selects `blocked`;
- a completion decision writes immutable assessment/decision/effect records and
  an activity-log audit row;
- a failed workspace barrier preserves the accepted semantic result, leaves the
  issue status/version unchanged, commits the fact-based preserve decision and
  concrete recovery target, and records a leased `retryable_failure`;
- six injected failures prove governance binding, interactions, wakes, blocker
  bindings, recovery, status,
  decisions, and effects roll back together before retry ownership is recorded.

The acceptance-matrix entry points passed as one 13-file, 42-test gate:

```sh
pnpm --filter @paperclipai/server exec vitest run \
  src/__tests__/heartbeat-native-runner-cancellation.test.ts \
  src/__tests__/heartbeat-native-runner-selection.test.ts \
  src/__tests__/native-run-finalizer.test.ts \
  src/__tests__/native-runner-input-boundary.test.ts \
  src/__tests__/native-runner-phase6.integration.test.ts \
  src/__tests__/native-finalization-recovery.test.ts \
  src/__tests__/native-interaction-bridge.test.ts \
  src/__tests__/native-session-resumption.test.ts \
  src/__tests__/heartbeat-run-event-sequencing.test.ts \
  src/__tests__/legacy-finalization-regression.test.ts \
  src/__tests__/native-finalization-migration.test.ts \
  src/__tests__/native-status-arbiter-corpus.test.ts \
  src/services/native-runtime/native-session-executor.test.ts
```

This gate proves concurrent event allocation, duplicate-only migration repair,
bounded retry exhaustion, actual flag-off legacy execution, and executable
Section 18.13 fixture-to-consumer traceability. Each of the 52 fixtures creates
its own database shape and executes named production consumers. Their return
values and persisted rows supply all eleven expected fields: run status,
status/preserve action, reason, required and forbidden effects, live-path kind,
claim preservation, native-record behavior, decision count, maximum wake
count, and maximum notification count. Each of the 70 matrix rows has an
explicit responsible finalizer, terminal projection, attention, cancellation,
committer, reconciliation, compatibility, or migration consumer; the row fails
if that consumer was not executed or its returned semantics differ. A mutation
test changes every expected field for every fixture and proves comparison
failure. Every required native effect is joined to its actual target state,
each decision replay retains one identity and one delivery attempt, and an
unknown effect rolls the entire transaction back. No test-owned scenario
policy supplies an observation. The selected-task
and recovery canaries remain scripted only at the provider boundary, while the
production Paperclip persistence/finalization paths and the flag-off legacy
adapter/finalizer path execute for real.

# Compile and migration checks

```sh
pnpm --filter @paperclipai/paperclip-runner typecheck
pnpm --filter @paperclipai/shared typecheck
pnpm --filter @paperclipai/server exec tsc --noEmit
pnpm --filter @paperclipai/db typecheck
```

Result: all checks passed. Migration numbering and safety passed. Migration
0211 preserves existing unique heartbeat cursors, deterministically moves only
duplicate rows above each run's former maximum, backfills the next allocator
value, and installs issue status-version tracking.

Focused migration, allocator, recovery, and legacy rehearsal:

```sh
pnpm --filter @paperclipai/server exec vitest run \
  src/services/native-runtime/paperclip-control-plane-port.test.ts \
  src/__tests__/native-finalization-recovery.test.ts \
  src/__tests__/legacy-finalization-regression.test.ts \
  src/__tests__/native-finalization-migration.test.ts \
  src/__tests__/heartbeat-run-event-sequencing.test.ts
```

Result: five files and 11 tests passed with zero skips. The 0211 rehearsal
reconstructed a production-shaped pre-0211 schema, removed the 0211 journal
entry, seeded legacy event sequences `[1,5,5,9]`, and applied the complete
migration. It retained the
original unique cursors and first `5`, moved only the later duplicate to `10`,
seeded `next_event_seq=11`, preserved every non-sequence field byte-for-byte,
and enforced uniqueness. Thirty-two concurrent mixed event writers produced a
gap-free allocator stream. Invalid native finalization exhausted its
three-attempt budget into named recovery without touching issue status. An
actual flag-off heartbeat executed the legacy adapter/finalizer, remained
byte-equivalent across native reconciliation, and created zero native rows.

# Credential, governance, budget, and legacy boundaries

`native-execution.test.ts` rejects unknown top-level or nested launch fields and
proves the model envelope omits company/run/agent bindings and credential
references. The native branch never creates a local agent JWT, MCP gateway, raw
adapter environment, or legacy context. Runtime requests cannot auto-approve;
the native interaction bridge materializes supported typed responses through
the authorized service and rejects unsupported/governed/self-approved paths.

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

Result: native cancellation reached the active normalized session exactly once
across duplicate cancellation requests and removed the handle afterward. The
daily cost hard stop cancelled a queued run before any adapter execution.

# Deferred live-provider checkpoint

The [Phase 6 tutorial](../../docs/tutorials/phase-06-thin-paperclip-adapter.md)
contains the exact board-authorized commands for enabling one local agent,
running and inspecting a live Codex task, disabling the flag, proving a fresh
legacy selection, and restoring the agent profile. Those commands intentionally
do not pass credentials to the package or model. They were not run during this
remediation because changing live instance and agent rollout state requires
operator approval; no new live-provider evidence is claimed here.
