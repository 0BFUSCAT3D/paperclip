# Phase 6: Thin Paperclip Adapter Tutorial Outline

Status: design only; commands marked as Phase 6 commands are not implemented yet.

## What this phase is

Phase 6 connects one Paperclip task to the native runner package. The connection
is behind a flag. Paperclip still prepares and finalizes the workspace. The
runner package still owns session and protocol behavior.

## What the runnable proof will establish

The proof will run the same contract against the mock core and a real local
Paperclip service. It will store and replay native events through one canonical
sequence allocator, preserve the typed terminal result, and apply the complete
Section 18 server-owned finalization/arbitration flow. It will then turn the
flag off, prove persisted native recovery still completes as native, and prove
that a new task uses the old adapter path.

## Planned prerequisites

- an isolated local Paperclip development instance;
- Node.js 20+, pnpm 9+, Rust, and Codex already authenticated;
- a test company, `codex_local` test agent, project workspace, and test issue;
- board/operator authorization for the flag and agent-profile changes;
- `PAPERCLIP_API_URL`, `PAPERCLIP_API_KEY`, `PAPERCLIP_COMPANY_ID`,
  `PAPERCLIP_AGENT_ID`, `PAPERCLIP_TASK_ID`, and `PAPERCLIP_RUN_ID` set without
  printing their values.

## Planned procedure

### 1. Prove the package contract with the mock core

```sh
pnpm --filter @paperclipai/paperclip-runner exec vitest run \
  src/conformance/control-plane-port.test.ts \
  src/backends/harness-driver-backend.test.ts

pnpm check:runner-phase5-spec

pnpm --filter @paperclipai/paperclip-runner trace:phase6 -- \
  --target mock --scenario happy-path
```

Expected: stable identities, one semantic terminal result, contiguous source
sequence, replay parity, and no Paperclip server import.

### 2. Run the focused Paperclip integration tests

```sh
pnpm --filter @paperclipai/server exec vitest run \
  src/__tests__/native-runner-phase6.integration.test.ts \
  src/__tests__/heartbeat-native-runner-selection.test.ts \
  src/__tests__/heartbeat-native-runner-cancellation.test.ts \
  src/__tests__/heartbeat-run-event-sequencing.test.ts \
  src/__tests__/native-runner-input-boundary.test.ts \
  src/__tests__/native-run-finalizer.test.ts \
  src/__tests__/native-status-arbiter-corpus.test.ts \
  src/__tests__/native-finalization-recovery.test.ts \
  src/__tests__/native-finalization-migration.test.ts \
  src/__tests__/legacy-finalization-regression.test.ts
```

Expected: company/auth denials, workspace/finalization ordering, cancellation,
budget, audit, canonical event sequencing, terminal replay, typed input
isolation, Section 18 arbitration, and legacy regression pass.

### 3. Enable one isolated agent

Use the existing board-authorized instance-settings and agent-update APIs to
set `experimental.enableNativeRunner=true` and the test agent's
`runtimeConfig.nativeRunner.mode="native"`. The implemented tutorial will give
copyable API requests for the exact local auth mode. Do not give the runner or
harness a Paperclip API key.

### 4. Run one local native task

```sh
pnpm --filter @paperclipai/paperclip-runner trace:phase6 -- \
  --target paperclip --scenario happy-path
```

Expected stable summary fields:

```text
resolvedMode=native
runStatus=succeeded
nativeEventCount>0
highestContiguousSourceSeq=nativeEventCount
workspaceFinalizeStatus=succeeded
legacyAdapterInvocationCount=0
reportedWorkDisposition=done
authoritativeDecision=done
issueStatusBefore=in_progress
issueStatusAfter=done
statusVersionAfter=statusVersionBefore+1
```

The separate claim and decision fields prove that the runner report did not
seize issue-status authority; the server-owned arbiter applied the transition
only after the completion contract, evidence, workspace barrier, and legal
liveness effects passed.

### 5. Inspect persistence, replay, and finalization

```sh
PAPERCLIP_API_BASE="${PAPERCLIP_API_URL%/}"
PAPERCLIP_API_BASE="${PAPERCLIP_API_BASE%/api}"
curl -fsS \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  "$PAPERCLIP_API_BASE/api/heartbeat-runs/$PAPERCLIP_RUN_ID/events?after=0&limit=200" \
  | jq '[.[] | select(.sourceEventId != null)] | {count: length, events: map({sourceSeq, sourceEventId, eventType})}'
```

Repeat the read with an `after` cursor and inspect the run finalization and
issue status-decision read models. Expected: no duplicate semantic event,
stable IDs, unique canonical `seq`, increasing source sequence, a persisted
`native_run_results` digest, a committed coordinator/decision, and a workspace-
finalize barrier before assessment or clean run success.

### 6. Prove cancellation

Run the deterministic cancellation scenario through the focused server test.
Expected: one native cancel effect, one terminal run outcome, only the
server-authorized cancellation/resume scope from Section 18, and the normal
environment/runtime/scratch cleanup path. The focused concurrency case also
appends lifecycle, cancellation, native, and log events at once and proves one
unique replay-stable `(run_id, seq)` order.

### 7. Prove credential and recovery boundaries

Run the typed-input boundary test with unique canaries in the local agent JWT,
Paperclip API key, managed MCP gateway credentials, wake payload, skill
instructions, raw env, and legacy context. Expected: no canary key/value in the
package launch input, model request, event, terminal result, log, or digest.

Then persist a native terminal result, simulate process/server disconnect, and
disable the flag before reconciliation. Expected: recovery reads the persisted
`heartbeat_runs.runtime_mode`, `native_run_finalizations.result_id`, and
`native_run_results` row and completes without re-running selection or invoking
the legacy adapter.

### 8. Disable the kill switch and prove fallback

Set `experimental.enableNativeRunner=false` through the existing board-
authorized settings API, then run a fresh task:

```sh
pnpm --filter @paperclipai/paperclip-runner trace:phase6 -- \
  --target paperclip --scenario legacy-fallback

pnpm --filter @paperclipai/server exec vitest run \
  src/__tests__/native-runner-phase6.integration.test.ts \
  -t "uses the unchanged legacy path when the kill switch is off"
```

Expected:

```text
resolvedMode=legacy
nativeEventCount=0
legacyAdapterInvocationCount=1
```

### 9. Record evidence and clean up

The implementation record will save only redacted summaries and test results
under `knowledge/evidence/`. It will restore the test agent profile and leave
the global flag off. It will not delete a shared database or workspace.

## Stop conditions

Stop and fail the proof if mode changes during a run, a native failure invokes
the legacy adapter, a forbidden legacy-context field or credential reaches the
package/model, a workspace-finalization failure reports success, a PRP claim
bypasses the arbiter, a non-terminal status lacks its atomic liveness path, a
concurrent writer duplicates canonical `seq`, or replay changes canonical
event/result/effect bytes.
