---
type: Engineering Journal Entry
title: Phase 6 feature-flagged Paperclip adapter implementation
description: Implementation decisions and evidence for the default-off native runner seam, durable replay/finalization, and legacy kill switch.
tags: [native-runner, phase-6, implementation, paperclip, security, replay]
status: stable
generated: { by: openai/gpt-5.6, at: 2026-08-09T03:01:00Z }
entry_kind: phase
phase: "6"
---

# Context

The approved Phase 6 design permits one narrow Paperclip integration at the
runner's public port/session boundary. The implementation must preserve all
existing server authority and keep legacy execution as the default.

# Decisions

1. Persist runtime selection and its reason before provider execution. Explicit
   ineligible opt-ins fail; the disabled flag and absent opt-in select legacy.
2. Use the existing heartbeat event timeline with one row-locked per-run
   allocator for legacy, recovery, cancellation, and native writers.
3. Bind the production port to company, issue, run, agent, completion contract,
   runner source, and control-plane source identities. Acknowledgement follows
   commit; duplicate identity with different bytes is a conflict.
4. Construct Codex and its normalized session entirely inside the package.
   Paperclip supplies only the closed native input and persistence port.
5. Persist semantic result and terminal state before workspace finalization;
   apply issue status only after the workspace barrier succeeds.
6. Treat the model disposition as evidence. A pure server arbiter and
   status-version CAS own `done`, `blocked`, and non-terminal decisions.
7. Reuse the existing cancellation/budget/resource path with a native session
   handle; never fall back to legacy inside a selected native run.
8. Keep the feature default false. Recovery reads persisted run/coordinator
   state and therefore remains correct after the flag is disabled.

# Evidence

- [Phase 6 verification](../evidence/2026-08-09-phase-06-verification.md)
- [Phase 6 reference](../../docs/phase-06-thin-paperclip-adapter.md)
- [Runnable tutorial](../../docs/tutorials/phase-06-thin-paperclip-adapter.md)
- Package conformance: three files, five tests passed.
- Database-backed port/session/finalizer corpus: three files, ten tests passed.
- Legacy heartbeat finalization/recovery/runtime corpus: three files, 106 tests
  passed.
- Runner, shared, server, and database typechecks passed; migration safety
  passed.

# Failures

- The generated migration initially failed the large-index safety check. The
  transactional uniqueness and nullable-source rationales are now recorded at
  each affected index, and clean migration replay passes.
- The first server compile exposed stale package build output and a runner
  source-identity mismatch. Building the package before server integration and
  passing the persisted runner instance into the package-owned Codex factory
  fixed the contract rather than weakening port validation.
- The historical event writer used `max(seq)+1` outside a shared transaction.
  All service writers now use the row-locked allocator; the one in-transaction
  scheduled-retry writer advances the same counter atomically.

# Known gaps

- Phase 6 supports local, standard, workspace-backed `codex_local` tasks only.
- It adds no browser UI or public runner WebSocket.
- Typed provider requests are rejected unless an existing Paperclip governance
  path can materialize an authorized response; there is no auto-approval.
- Live operator proof depends on a board-authorized local instance and an
  already authenticated Codex installation; deterministic CI uses the same
  public session contract with a scripted backend.

# Follow-up questions

- Should Phase 7 expose a one-time outbound runner lease instead of the
  in-process production port?
- Which native finalization fields should receive a dedicated operator UI after
  the tracer rollout proves stable?
