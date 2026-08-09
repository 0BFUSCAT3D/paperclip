# Phase 6: Thin Paperclip Adapter Tutorial Outline

Status: design only; commands marked as Phase 6 commands are not implemented yet.

## What this phase is

Phase 6 connects one Paperclip task to the native runner package. The connection
is behind a flag. Paperclip still prepares and finalizes the workspace. The
runner package still owns session and protocol behavior.

## What the runnable proof will establish

The proof will run the same contract against the mock core and a real local
Paperclip service. It will store and replay native events. It will then turn the
flag off and prove that a new task uses the old adapter path.

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
  src/__tests__/heartbeat-native-runner-cancellation.test.ts
```

Expected: company/auth denials, workspace/finalization ordering, cancellation,
budget, audit, event replay, status non-authority, and legacy regression pass.

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
issueStatusAfter=issueStatusBefore
```

The last equality proves that the runner report did not seize issue-status
authority.

### 5. Inspect persistence, replay, and finalization

```sh
PAPERCLIP_API_BASE="${PAPERCLIP_API_URL%/}"
PAPERCLIP_API_BASE="${PAPERCLIP_API_BASE%/api}"
curl -fsS \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  "$PAPERCLIP_API_BASE/api/heartbeat-runs/$PAPERCLIP_RUN_ID/events?after=0&limit=200" \
  | jq '[.[] | select(.sourceEventId != null)] | {count: length, events: map({sourceSeq, sourceEventId, eventType})}'
```

Repeat the read with an `after` cursor. Expected: no duplicate semantic event,
stable IDs, increasing source sequence, and a persisted workspace-finalize
barrier before clean run success.

### 6. Prove cancellation

Run the deterministic cancellation scenario through the focused server test.
Expected: one native cancel effect, one terminal run outcome, unchanged issue
status, and the normal environment/runtime/scratch cleanup path.

### 7. Disable the kill switch and prove fallback

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

### 8. Record evidence and clean up

The implementation record will save only redacted summaries and test results
under `knowledge/evidence/`. It will restore the test agent profile and leave
the global flag off. It will not delete a shared database or workspace.

## Stop conditions

Stop and fail the proof if mode changes during a run, a native failure invokes
the legacy adapter, a credential appears in output, a workspace-finalization
failure reports success, a PRP claim changes issue status, or replay changes a
canonical event.
