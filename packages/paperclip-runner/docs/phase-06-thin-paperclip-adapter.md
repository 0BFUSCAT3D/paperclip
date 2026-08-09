# Phase 6 Thin Paperclip Adapter

Phase 6 adds one production integration seam without moving runner behavior
into Paperclip core. Paperclip owns workspace lifecycle, company/auth scope,
budgets, approvals, audit, cancellation, durable persistence, and issue status.
The package owns normalized sessions, provider-driver construction, PRP event
production, and semantic result production.

## Selection and rollback

Native mode requires both `experimental.enableNativeRunner=true` and an
eligible agent profile:

```json
{
  "nativeRunner": {
    "mode": "native",
    "backend": "codex_app_server",
    "protocolVersion": 1
  }
}
```

Only active local `codex_local` agents running standard, workspace-backed
issues are eligible. The default and the kill switch are legacy. An explicit
but ineligible native profile fails closed; there is no same-run fallback.
Selection, resolver version/reason, profile, runner instance, and completion
contract are persisted before provider execution.

## Public boundary

`PaperclipControlPlanePort` implements the package's `ControlPlanePort`:

- `openRun` verifies company/run/issue/agent/contract binding;
- `appendEvent` validates PRP, commits through the shared per-run allocator,
  deduplicates source identity by canonical digest, and acknowledges afterward;
- `replayEvents` uses an exclusive source cursor;
- `completeRun` validates and idempotently persists the immutable structured
  result plus terminal fact.

The package-owned `HarnessDriverBackend` is the approved
`NativeSessionBackend`. Core passes only the closed `NativeExecutionInputV1`.
The model receives the smaller `NativeModelEnvelopeV1`; bindings and credential
references do not cross that boundary.

## Persistence and authority

Migration 0211 adds immutable completion contracts/results/assessments,
restart-safe finalization coordinators, status decisions/effects, issue status
versions, native run metadata, and native source identity on heartbeat events.
All event writers allocate from the row-locked `heartbeat_runs.next_event_seq`.

Finalization runs only after result persistence and workspace finalization. The
pure arbiter marks `done` only when the terminal state succeeded, the objective
and every criterion are satisfied, verification passed, and no blocking work
remains. It marks `blocked` only for a first-class reported blocker. A failed
workspace barrier preserves the immutable native result, fails the run, and
leaves issue status unchanged. Review/yield/incomplete/failure/cancellation
remain non-terminal.
Status projection is a versioned CAS and emits an audit record.

## Recovery and safety

The finalization reconciler selects persisted `runtime_mode=native` rows; it
does not consult the current flag. Cancellation uses a run-scoped normalized
session handle before the existing process cleanup. Native execution does not
construct a Paperclip JWT, managed MCP access, legacy context, or raw adapter
environment.

See the [runnable tutorial](tutorials/phase-06-thin-paperclip-adapter.md), the
[verification record](../knowledge/evidence/2026-08-09-phase-06-verification.md),
and the [approved design](design/phase-6-thin-paperclip-adapter.md).
