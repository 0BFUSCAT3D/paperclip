# Phase 6 Thin Paperclip Adapter Boundary

Status: proposed for CTO approval
Date: 2026-08-09
Decision scope: the first feature-flagged Paperclip tracer only

## Decision

Paperclip will integrate the native runner through two public package ports:

- `NativeSessionBackend` owns a normalized native session and hides the
  package's concrete `HarnessDriver` and Codex implementation.
- `ControlPlanePort` accepts validated PRP events and terminal results from the
  package and exposes durable acknowledgement and replay cursors.

The dependency direction is one way:

```text
server heartbeat orchestration
  -> PaperclipNativeRuntimeAdapter (core seam)
      -> @paperclipai/paperclip-runner public contracts
          -> NativeSessionBackend -> package-owned driver/runner logic
          -> ControlPlanePort      -> server-bound Paperclip implementation
```

`packages/paperclip-runner/` never imports `server/`, `packages/db/`,
`packages/shared/`, or a Paperclip service. The server may import the public
package. The core seam may translate company-scoped Paperclip records into the
public input types, persist protocol records, and convert one terminal native
result into the existing `AdapterExecutionResult`. It must not contain driver,
provider, reducer, outbox, reconnect, or process-supervision logic.

This decision deliberately limits Phase 6 to a tracer. It does not enable
native execution by default, migrate legacy runs, or add browser UI.

## Why the current sketches need one package-local reconciliation

The original `ControlPlanePort` and `NativeRunEvent` sketch proves the Phase 0
lifecycle, while the accepted Phase 1-5 path uses `PrpEvent`,
`PrpStructuredRunResult`, durable source sequences, and replay. Before the real
adapter is added, the package contract must be reconciled without importing
Paperclip types:

```ts
interface ControlPlanePort {
  openRun(input: OpenControlPlaneRunInput): Promise<void>;
  appendEvent(event: PrpEvent): Promise<{
    highestContiguousSourceSeq: number;
    disposition: "committed" | "duplicate";
  }>;
  replayEvents(input: {
    runId: string;
    sourceInstanceId: string;
    afterSourceSeq: number;
    limit: number;
  }): Promise<{
    events: PrpEvent[];
    highestContiguousSourceSeq: number;
  }>;
  completeRun(input: {
    result: PrpStructuredRunResult;
    terminal: PrpTerminalState;
  }): Promise<void>;
}
```

The exact exported names may stay source-compatible through overloads, but the
observable contract above is required. The Phase 0 fixture may be adapted
inside the package; no production adapter may invent a second event type.

`NativeSessionBackend` remains the control-plane-facing session contract. A
package-local backend adapts `HarnessDriver`/`HarnessSession` into it, including
the accepted semantic result stored in the harness snapshot. Paperclip core
must not construct `CodexAppServerDriver` or inspect provider notifications.

## Core branch point

The sole execution branch belongs in `server/src/services/heartbeat.ts` after
the existing environment lease and workspace realization have succeeded and
immediately before `adapter.execute(...)` today:

```ts
const mode = resolveNativeRuntimeMode({ settings, agent, run, issue, target });
await persistResolvedMode(run.id, mode);

const adapterResult = mode.kind === "native"
  ? await paperclipNativeRuntimeAdapter.execute(existingExecutionContext)
  : await adapter.execute(existingExecutionContext);
```

Everything before the branch remains Paperclip-owned preparation. Everything
after it remains Paperclip-owned finalization: workspace-finalize barrier,
usage/cost accounting, terminal run write, issue liveness evaluation, session
state, agent state, audit/live events, environment lease release, runtime
service release, and scratch cleanup.

The native adapter returns through `AdapterExecutionResult` with an additive
`nativeFinalization` discriminator. Existing adapters omit that field. Native
run terminal state is taken only from that validated discriminator; exit code
is retained as a diagnostic and is never a native fallback heuristic.

## Feature flag, selection, and kill switch

The global gate is `instance.experimental.enableNativeRunner`, default `false`.
It is server/API configurable in the first slice; there is no UI control. The
per-agent opt-in is stored in the existing company-scoped
`agents.runtime_config` JSON:

```json
{
  "nativeRunner": {
    "mode": "native",
    "backend": "codex_app_server",
    "protocolVersion": 1
  }
}
```

The resolver is pure and versioned. Its inputs are the instance flag, the
persisted agent profile, the authenticated run/agent/issue records, and the
realized execution target. It does not read model output or PRP events.

| Global flag | Agent profile | Eligibility | New run mode |
|---|---|---|---|
| off | any | any | legacy |
| on | absent or `legacy` | any | legacy |
| on | `native` | eligible | native |
| on | `native` | ineligible before selection | rejected before invocation |

Initial eligibility is intentionally narrow: an issue-bound standard run, a
same-company active `codex_local` agent, protocol version 1, and a local
execution target with an already-realized workspace. Remote environments,
unscoped timer wakes, skill tests, task bridges, low-trust review, and other
drivers remain legacy or are rejected when explicitly misconfigured as native.

The resolved mode, resolver version, and non-secret reason code are persisted
on the heartbeat run before invocation. An active run never changes modes.

Turning `enableNativeRunner` off is the kill switch:

- queued and future runs resolve to legacy;
- an already-selected native run remains native until terminal, drained, or
  cancelled through the existing run-cancellation path;
- replays and recovery use the persisted mode even while the flag is off;
- no native error may retry the same run through `adapter.execute`.

This gives rollback without dual execution or ambiguous event history.

## Company, authentication, and threat boundary

The real `ControlPlanePort` is constructed inside the server with a bound
`companyId`, `runId`, `issueId`, `agentId`, and `sourceInstanceId` loaded from
authoritative rows. Every method compares incoming identity fields with that
binding and rejects generically before persistence on any mismatch.

The runner or harness never receives:

- `PAPERCLIP_API_KEY`, a board session, or a board API key;
- authority to choose a company, issue, agent, policy, approval, or status;
- database access or a public issue-mutation endpoint;
- resolved secret values in events, snapshots, diagnostics, or digests.

The server-side port is an in-process capability for the first tracer. A future
runner WebSocket must authenticate a one-time runner lease and bind to the same
server-owned values; that transport is not part of this issue.

Threats and required responses:

| Threat | Required response |
|---|---|
| Event names another company/run/session | Generic rejection, no lookup disclosure, no write |
| Same source ID or sequence with different bytes | `native_event_replay_conflict`; fail native run closed |
| Caller supplies status, approval, or policy outcome | Preserve as untrusted payload at most; never apply |
| Event/result contains a known credential | Redact before diagnostics and reject persistence of the unsafe payload |
| Native port or event store is unavailable | Do not acknowledge; runner keeps its durable outbox; fail/recover without legacy fallback |
| Flag is disabled after a run started | Finish/cancel the persisted native mode; never splice legacy execution into it |

## Governance and status authority

PRP events and `reportedWorkDisposition` are reports, not organizational
commands. The Phase 6 tracer does not add a runner-accessible issue status API.

- Existing issue routes/services remain the only issue-status mutation path.
- Existing execution-policy participants remain the only execution-decision
  authority.
- Existing approval and interaction services remain the only materialization
  and decision paths. A native request cannot approve itself or translate an
  interaction into a formal approval.
- Existing budget checks decide whether dispatch is allowed and existing
  budget hard-stop cancellation remains authoritative.
- Existing activity logging records flag changes, runtime selection, run
  terminal state, cancellation, and any later governed mutation.

The native result is persisted with `nativeFinalization` and its reported
disposition. In the first tracer, status application is **shadow-only**: the
result can be inspected and compared, but it cannot close, block, review, or
cancel an issue. Existing liveness/recovery handling observes the unchanged
issue state. Broader rollout requires the separately specified immutable
completion contract, work assessment, status arbiter, atomic liveness effects,
and reconciliation gates in the normative spike specification. The tracer must
not implement a smaller model-authoritative shortcut.

This is the safest thin boundary: Phase 6 proves execution, durability, and
Paperclip lifecycle integration without smuggling the much larger status-
authority migration into an adapter.

## Existing lifecycle mapping

| Paperclip concern | Phase 6 mapping | Owner |
|---|---|---|
| Checkout and issue execution lock | Unchanged; resolved before native selection | Existing issue/heartbeat services |
| Budget and pause gate | Unchanged pre-dispatch check | Existing budget/invokability services |
| Workspace preparation | Unchanged; native receives the realized cwd/target only | Environment/workspace orchestrators |
| Session execution | `NativeSessionBackend` through package-owned runtime loop | Runner package |
| Event validation/reducer semantics | Accepted PRP schemas and reducer | Runner package |
| Event commit/ACK/replay | Bound `ControlPlanePort` implementation | Thin server adapter |
| Cancellation | Existing cancel route invokes a registered native cancel handle, then existing terminal cleanup | Heartbeat + package session |
| Workspace finalization | Existing `workspace_finalize` barrier after native execute returns | Heartbeat/workspace services |
| Run terminal state | Validated `nativeFinalization.runTerminalState` | Thin adapter + heartbeat |
| Issue status | No native mutation in tracer; existing authority remains | Existing issue/governance services |
| Approvals/interactions | Existing services only; unsupported native requests fail closed | Existing governance services |
| Usage/cost/session state | Converted to existing `AdapterExecutionResult` fields | Existing heartbeat finalizer |
| Audit/live events | Existing activity and heartbeat event publication | Existing services |
| Lease/runtime/scratch release | Existing `finally` path | Existing heartbeat/environment services |

### Cancellation seam

The heartbeat service already cancels process-backed adapters through
`runningProcesses`. Native sessions need one additional run-scoped registry of
idempotent cancel functions. `cancelRunInternal`, agent pause, budget pause, and
shutdown drain call the same registry before their current status/cleanup
writes. The package implementation performs `session.cancel`/`interrupt` and
`close`; provider process escalation remains package-owned. Registering a
cancel handle does not grant status authority.

## Native event persistence and replay

The first slice extends `heartbeat_run_events` rather than creating a parallel
operator timeline. Nullable native-source columns keep legacy rows unchanged:

```text
source_instance_id
source_event_id
source_seq
source_payload_sha256
protocol_schema_version
```

Required partial unique indexes:

```text
(company_id, run_id, source_event_id) where source_event_id is not null
(company_id, run_id, source_instance_id, source_seq)
  where source_instance_id is not null and source_seq is not null
```

Append behavior is transactional:

1. validate the PRP schema and bound identity;
2. canonicalize and hash the complete event payload;
3. insert with its server timeline sequence and native source identity;
4. on conflict, load the canonical row and accept only a byte-equivalent hash;
5. compute the highest contiguous committed source sequence;
6. acknowledge only after commit.

Replay reads the same rows by the bound run/source instance, ordered by
`source_seq`, after an exclusive cursor. A gap is reported and never hidden by
server timeline sequence. Legacy rows have null native-source fields and are
unaffected. Existing `/api/heartbeat-runs/:runId/events` remains the operator
read path; no new public mutation route is required.

## Failure behavior

1. Failures before mode persistence use the existing setup-failure path.
2. A native eligibility/configuration error never invokes a provider.
3. After native mode is persisted, every error stays native and uses a stable
   `native_*` error code; there is no legacy retry for that run.
4. Missing, inconsistent, or invalid `nativeFinalization` fails the run with
   `native_finalization_missing` or `native_finalization_invalid`.
5. Workspace-finalization failure wins over a successful reported result. The
   report remains persisted for inspection, the run is failed, and issue status
   is preserved.
6. Cancellation is idempotent. Late native completion cannot overwrite a
   cancelled heartbeat run because the existing conditional terminal write
   remains authoritative.
7. Event replay conflict, company mismatch, auth mismatch, unsafe payload, or
   acknowledgement ambiguity fails closed and never mutates issue governance.
8. A native runtime request that the tracer does not support is declined with
   `native_runtime_request_unsupported`; it is not auto-approved.

## Mock-versus-real conformance strategy

The package exports one table-driven `ControlPlanePort` conformance suite. It
runs unchanged against:

1. `MockControlPlaneAdapter`, with deterministic in-memory storage; and
2. `PaperclipControlPlanePort`, with a real test database, heartbeat run, issue,
   agent, and company binding.

Both adapters produce a normalized snapshot containing canonical PRP events,
source cursors, duplicate dispositions, terminal result, and failure code. The
suite compares snapshots while excluding database IDs and wall-clock fields.
The real suite adds authorization and transaction assertions that a mock cannot
prove. A separate deterministic fake backend drives both ports. Real Codex is a
smoke proof only and does not replace the deterministic matrix.

Required shared cases:

- open, append, terminal happy path;
- ordered replay after every cursor;
- identical duplicate event and terminal replay;
- conflicting duplicate ID and conflicting source sequence;
- source gap and recovery after missing event arrives;
- wrong run/session/company/agent identity;
- terminal before result and event after terminal;
- cancellation before turn, during turn, and after terminal;
- connection loss before and after commit acknowledgement.

## Test matrix

| ID | Concern | Mock | Real Paperclip | Legacy assertion |
|---|---|---:|---:|---|
| P6-01 | Default flag off | — | yes | `adapter.execute` called exactly once; no native rows |
| P6-02 | Per-agent opt-in absent | — | yes | Same as current path |
| P6-03 | Eligible native selection | yes | yes | Legacy adapter not called |
| P6-04 | Persisted mode survives flag change | yes | yes | No mid-run mode switch |
| P6-05 | Kill switch before dispatch | — | yes | New run uses legacy once |
| P6-06 | Workspace cwd/branch/identity | yes | yes | Same realized workspace and finalize barrier |
| P6-07 | Workspace finalize failure | yes | yes | Failed run; result preserved; issue unchanged |
| P6-08 | Budget blocked before dispatch | — | yes | Neither native nor legacy provider starts |
| P6-09 | Budget hard stop during native run | yes | yes | One cancel, normal lease/resource cleanup |
| P6-10 | Manual/agent-pause cancellation | yes | yes | Idempotent native cancel and terminal race guard |
| P6-11 | PRP append/ACK/replay | yes | yes | Legacy event rows unchanged |
| P6-12 | Duplicate replay | yes | yes | One semantic event, stable cursor |
| P6-13 | Conflicting replay | yes | yes | Native fails closed; no legacy fallback |
| P6-14 | Cross-company/run/agent forgery | — | yes | Generic denial, zero rows, no disclosure |
| P6-15 | Credential redaction | yes | yes | No key in model context, event, log, or digest |
| P6-16 | Reported `done` | yes | yes | Stored as claim; issue status not changed |
| P6-17 | Approval/status payload forgery | yes | yes | No approval/decision/status mutation |
| P6-18 | Unsupported runtime request | yes | yes | Declined; no auto-approval |
| P6-19 | Missing/invalid native finalization | yes | yes | Native run fails with stable code |
| P6-20 | Cost/usage/session projection | yes | yes | Existing field meanings unchanged |
| P6-21 | Activity and live events | — | yes | Selection/terminal/cancel audited once |
| P6-22 | Full legacy targeted regression | — | yes | Byte-equivalent result/events for fixture |

## Exact implementation sequence

1. Reconcile `ControlPlanePort` with accepted PRP events/results and add the
   shared mock conformance suite. No core files change in this step.
2. Add the package-local `HarnessDriver` to `NativeSessionBackend` adapter and a
   deterministic fake-backend executor. Keep provider/process logic packaged.
3. Add nullable native-source columns and partial unique indexes to
   `heartbeat_run_events`; generate the migration and prove legacy reads.
4. Implement the server-bound `PaperclipControlPlanePort` with constructor
   binding, transaction-safe append/ACK, replay, and terminal idempotency.
5. Add the default-off instance flag, parse the per-agent profile, and test the
   pure resolver/kill-switch precedence.
6. Add `nativeFinalization` to `AdapterExecutionResult` and the thin native
   executor/converter service.
7. Add the one heartbeat branch, persisted mode, native cancel registry, and
   existing-finalizer mapping. Do not rearrange preparation or cleanup.
8. Run mock/real conformance, governance/security, workspace/finalization,
   budget/cancellation, and legacy regression tests.
9. Add the package-local tracer/tutorial/evidence and run one safe local Codex
   task only after deterministic tests pass.
10. Stop for Security and CTO implementation review before QA or wider opt-in.

## Exact files that may change

### Package-owned contract, implementation, tests, and evidence

```text
packages/paperclip-runner/package.json
packages/paperclip-runner/src/index.ts
packages/paperclip-runner/src/contracts/control-plane-port.ts
packages/paperclip-runner/src/contracts/native-session-backend.ts
packages/paperclip-runner/src/contracts/types.ts
packages/paperclip-runner/src/mock-core/mock-control-plane-adapter.ts
packages/paperclip-runner/src/mock-core/mock-control-plane-adapter.test.ts
packages/paperclip-runner/src/backends/harness-driver-backend.ts              (new)
packages/paperclip-runner/src/backends/harness-driver-backend.test.ts         (new)
packages/paperclip-runner/src/conformance/control-plane-port.ts               (new)
packages/paperclip-runner/src/conformance/control-plane-port.test.ts          (new)
packages/paperclip-runner/src/cli/phase6-paperclip.ts                          (new)
packages/paperclip-runner/protocol/fixtures/phase-06/*                         (new)
packages/paperclip-runner/docs/phase-06-thin-paperclip-adapter.md              (new)
packages/paperclip-runner/docs/tutorials/phase-06-thin-paperclip-adapter.md
packages/paperclip-runner/docs/tutorials/end-to-end.md
packages/paperclip-runner/docs/index.md
packages/paperclip-runner/docs/architecture.md
packages/paperclip-runner/knowledge/evidence/2026-08-09-phase-06-verification.md (new)
packages/paperclip-runner/knowledge/journal/2026-08-09-phase-06*.md
packages/paperclip-runner/knowledge/journal/index.md
packages/paperclip-runner/knowledge/evidence/index.md
packages/paperclip-runner/knowledge/log.md
```

### Minimal Paperclip adapter seam

```text
server/package.json
packages/adapter-utils/src/types.ts
packages/shared/src/types/instance.ts
packages/shared/src/validators/instance.ts
packages/shared/src/feature-catalog.ts
packages/db/src/schema/heartbeat_run_events.ts
packages/db/src/schema/index.ts                  (only if a new export is required)
packages/db/src/migrations/<generated>.sql
packages/db/src/migrations/meta/*                (generated only)
server/src/services/instance-settings.ts
server/src/services/native-runtime/runtime-mode.ts                    (new)
server/src/services/native-runtime/paperclip-control-plane-port.ts     (new)
server/src/services/native-runtime/paperclip-native-runtime-adapter.ts (new)
server/src/services/native-runtime/index.ts                            (new)
server/src/services/heartbeat.ts
server/src/__tests__/native-runner-phase6.integration.test.ts          (new)
server/src/__tests__/heartbeat-native-runner-selection.test.ts         (new)
server/src/__tests__/heartbeat-native-runner-cancellation.test.ts      (new)
```

No other file is pre-approved. In particular, Phase 6 must not change a
concrete legacy adapter, issue status route, approval route, UI file, workspace
service, budget service, or activity-log implementation merely to make the
tracer pass. A discovered need outside this list returns to CTO review.

## Commands the implementation must make runnable

These commands are the acceptance contract for the implementation issue. They
do not exist yet in this design-only task.

Deterministic package/mock proof:

```sh
pnpm --filter @paperclipai/paperclip-runner exec vitest run \
  src/conformance/control-plane-port.test.ts \
  src/backends/harness-driver-backend.test.ts

pnpm --filter @paperclipai/paperclip-runner trace:phase6 -- \
  --target mock --scenario happy-path
```

First real Paperclip tracer and inspection (against an isolated local dev
instance with the five `PAPERCLIP_*` identifiers/auth variables already set):

```sh
pnpm --filter @paperclipai/paperclip-runner trace:phase6 -- \
  --target paperclip --scenario happy-path

PAPERCLIP_API_BASE="${PAPERCLIP_API_URL%/}"
PAPERCLIP_API_BASE="${PAPERCLIP_API_BASE%/api}"
curl -fsS \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  "$PAPERCLIP_API_BASE/api/heartbeat-runs/$PAPERCLIP_RUN_ID/events?after=0&limit=200" \
  | jq '[.[] | select(.sourceEventId != null)] | {count: length, events: map({sourceSeq, sourceEventId, eventType})}'
```

Targeted real integration proof:

```sh
pnpm --filter @paperclipai/server exec vitest run \
  src/__tests__/native-runner-phase6.integration.test.ts \
  src/__tests__/heartbeat-native-runner-selection.test.ts \
  src/__tests__/heartbeat-native-runner-cancellation.test.ts
```

Legacy fallback proof after disabling the flag:

```sh
pnpm --filter @paperclipai/paperclip-runner trace:phase6 -- \
  --target paperclip --scenario legacy-fallback

pnpm --filter @paperclipai/server exec vitest run \
  src/__tests__/native-runner-phase6.integration.test.ts \
  -t "uses the unchanged legacy path when the kill switch is off"
```

The tracer must print a stable JSON summary containing `resolvedMode`,
`runStatus`, `reportedWorkDisposition`, `issueStatusBefore`,
`issueStatusAfter`, `nativeEventCount`, `highestContiguousSourceSeq`,
`workspaceFinalizeStatus`, and `legacyAdapterInvocationCount`. It must never
print a bearer token, secret value, raw environment, or private host path.

## Tutorial outline

The implementation fills in the package-local
[Phase 6 tutorial](../tutorials/phase-06-thin-paperclip-adapter.md) with:

1. prerequisites and an isolated local instance;
2. mock conformance first;
3. flag and one-agent opt-in;
4. one safe local native task;
5. event replay and finalization inspection;
6. cancellation and workspace-finalization checks;
7. kill-switch disablement;
8. a new legacy task proving fallback;
9. cleanup and expected stable summaries.

No production credentials or destructive cleanup command belongs in the
tutorial.

## Browser UI decision

No browser UI changes are required for the Phase 6 tracer. Existing run and
issue APIs plus the package tracer provide inspectable evidence. The flag is
server/API-only and default off. Any later request to expose native mode,
reported disposition, replay cursors, or status-arbitration state in the board
UI requires a separate UX review task before implementation.

## Approval questions

The CTO can approve or reject this record by deciding these five points:

1. Is the one-way package dependency and single heartbeat branch narrow enough?
2. Is the default-off instance flag plus per-agent opt-in an acceptable first
   rollout and kill-switch contract?
3. Is extending `heartbeat_run_events` preferable to a second event store for
   the tracer?
4. Is shadow-only issue-status handling the correct Phase 6 limit, with full
   native arbitration remaining separately gated?
5. Are the allowed files, conformance matrix, and exact tracer/fallback commands
   sufficient to begin implementation?
