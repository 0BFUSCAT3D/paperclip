---
type: Engineering Journal Entry
title: Phase 6 thin Paperclip adapter design
description: Decision-ready boundary, rollout, threat model, conformance matrix, and tutorial contract for the first Paperclip integration tracer.
tags: [native-runner, phase-6, architecture, integration, security, replay, feature-flag]
status: draft
generated: { by: openai/codex-local, at: 2026-08-09T03:00:00Z }
entry_kind: phase
phase: "6"
---

# Context

Phases 0-5 proved the package in isolation. Phase 6 is the first permitted
Paperclip control-plane integration. The design must preserve the package
boundary and every current control-plane authority while enabling one useful,
reversible tracer.

# Decisions

1. Paperclip depends only on the public `ControlPlanePort` and
   `NativeSessionBackend`; concrete drivers and session loops remain packaged.
2. The single core branch occurs after existing environment/workspace
   realization and before legacy `adapter.execute`. Existing preparation and
   finalization remain in place.
3. A default-off instance flag plus a company-scoped per-agent profile selects
   native mode. The resolved mode is persisted and never changes mid-run.
4. Disabling the instance flag is the new-run kill switch. A selected native
   run fails or recovers as native and never silently retries through legacy.
5. Native events extend the existing heartbeat event timeline with nullable
   source identity, sequence, digest, and schema fields plus partial unique
   indexes. Acknowledgement occurs only after commit; conflicting replay fails
   closed.
6. Runner/model data has no company, approval, interaction, budget, or issue-
   status authority. The tracer stores reported disposition in shadow-only
   form; full automatic status arbitration remains separately gated.
7. A package-exported conformance suite runs unchanged against the mock and
   database-backed real ports. Real Codex is a smoke proof, not the deterministic
   authority.
8. No browser UI is required. A later native-status UI needs a separate UX
   review before implementation.

The complete decision record is
[Phase 6 Thin Paperclip Adapter Boundary](../../docs/design/phase-6-thin-paperclip-adapter.md).

# Evidence

- Read the accepted package contracts, PRP schemas, Phase 0-5 architecture,
  implementation plan, and normative native-finalization/status-authority
  sections.
- Traced the current heartbeat execution sequence through workspace
  realization, adapter invocation, workspace-finalize barrier, terminal write,
  liveness handling, cancellation, budget cancellation, and resource release.
- Confirmed `heartbeat_run_events` is the existing company/run-scoped operator
  timeline and identified the missing source identity/dedup columns required for
  durable PRP acknowledgement and replay.
- Recorded the proposed files, 22-case test matrix, exact tracer commands,
  legacy fallback proof, and tutorial outline in package-local documentation.
- Design-only verification command:
  `pnpm --filter @paperclipai/paperclip-runner docs:validate`.

# Failures

No implementation was attempted. The design discovery found two contract gaps
that implementation must resolve explicitly rather than hide:

- the original `ControlPlanePort` still consumes the narrow Phase 0 event
  sketch instead of the accepted PRP event/result types;
- the current cancellation registry only knows process-backed legacy adapters
  and needs a run-scoped native cancel handle.

# Known gaps

- The Phase 6 tracer does not expose a public runner WebSocket.
- It supports only an issue-bound local `codex_local` native profile.
- It declines unsupported native runtime requests and cannot approve governance
  actions.
- It does not apply model-reported issue status. Full completion-contract and
  status-arbiter rollout remains subject to its existing migration gates.
- Exact API request examples for toggling the flag depend on the local instance
  auth mode and will be filled in after implementation proves both modes.

# Follow-up questions

- CTO: approve extending `heartbeat_run_events` for the tracer, or require a
  dedicated native event table now?
- CTO: approve shadow-only issue status for the thin tracer, or expand Phase 6
  into the separately specified status-authority implementation?
- Security: is the in-process, server-bound port sufficient for Phase 6 before
  a one-time runner lease and outbound WebSocket are introduced?
