---
type: Verification Evidence
title: Phase 7 final evidence manifest (Revision 3/4)
description: Authoritative Phase 7I evidence manifest for the final candidate build — every offline and live verification command, its observed result, the conformance and security results, the screenshot set, and the explicit historical-ineligibility record for the Revision 2 preview.
tags: [native-runner, phase-7, verification, conformance, security, evidence, manifest, final]
status: stable
generated: { by: anthropic/claude-opus-4-8, at: 2026-08-10T13:15:00Z }
entry_kind: evidence
phase: "7"
---

# Scope

This is the Phase 7I evidence manifest (PAP-16947) for the **final candidate
build `865d1a72344f36a307a4582d4b0db1fc85ef1934`** on branch
`PAP-16679-paperclip-runner`. It links each verification command to its observed
result and to the reference pages, tutorial, conformance report, security
verdict, and screenshot set that describe the final Phase 7 surfaces.

The Phase 7 default path contacts no Paperclip service, database, ACPX session,
or provider credential. The optional live path starts a real
`paperclip-runnerd` process and a real Codex app-server session but still routes
every Paperclip operation through the in-process mock `ControlPlanePort`; it
reaches no real Paperclip API. Three actors stay separate throughout — **Real
Codex**, **Real runnerd**, and **Mock Paperclip** — as described in
[execution modes and identity](../../docs/phase-07-execution-modes.md).

# Historical evidence — not eligible for final acceptance

The Revision 2 preview is historical evidence only and cannot satisfy any final
Phase 7 acceptance criterion:

- **Build `da0d32d74a`** and its Revision 2 preview URL are preview references
  only. The final try-it link is the new HTTPS URL produced by the Tailscale
  deployment track (7J), not the Revision 2 URL.
- The [Revision 2 documentation/evidence manifest](2026-08-09-phase-07-verification.md)
  (PAP-16906, gate issues PAP-16902 / PAP-16905 / PAP-16907) predates the live
  runnerd/Codex loop and the issue-thread UI; it is retained for comparison.
- Any session artifact recorded in scripted `mode=fake` cannot satisfy a live
  criterion. Deterministic fake mode remains required for the 106-case
  conformance suite and replay evidence, and nothing more.

# Environment

- Node.js 22.22.2, pnpm 9.15.4.
- vitest 4.1.10; Playwright 1.62.1 with Chromium 151.0.7922.34; axe-core 4.13.0.
- Rust toolchain and Codex CLI 0.132.0 (locally authenticated) for the optional
  live path only. `PAPERCLIP_RUNNER_CHROMIUM_PATH` may point at a preinstalled
  Chromium when the Playwright download lacks system libraries;
  `pnpm verify:rootless` is the alternative.
- No network access after `pnpm install`.

# Offline verification matrix

Commands are prefixed `pnpm --filter @paperclipai/paperclip-runner`. Results in
this section were re-run on the final tree on 2026-08-10 and observed at exit 0.

| Surface | Command | Observed result |
| --- | --- | --- |
| Capability contract completeness and drift | `check:phase7-inventory` | `Phase 7 inventory completeness and generated-output checks passed.` |
| 106-case conformance | `test:phase7-evals` | 1 file, 1 test (drives all 106 cases) pass |
| Mock port + semantic tools + issue-thread contract | `test:phase7` | 11 files, 137 tests pass |
| Fake-agent matrix + bounded Codex sample + parity report | `report:phase7-evals` | `Phase 7 eval conformance passed: 106 cases across 16 groups.` |
| Doc links + OKF bundle | `docs:validate` | `Documentation link validation passed (85 files).` and `OKF v0.2 validation passed (31 concepts, 7 indexes).` |

Results carried from the final-build track runs (7F/7G), on the same tree:

| Surface | Command | Observed result | Source |
| --- | --- | --- | --- |
| Browser IA, interactions, accessibility, determinism | `test:browser:phase7` | 50/50 Playwright tests pass; axe clean on 12 slugs × 2 viewports | [7G verification](2026-08-10-phase-07g-issue-thread-ui-verification.md) |
| Deterministic screenshot matrix | `record:phase7:ui` then `check:phase7:ui` | 24 images (12 slugs × 2 viewports); all reproduce byte-for-byte | [7G verification](2026-08-10-phase-07g-issue-thread-ui-verification.md) |
| Bounded live Codex matrix | `report:phase7-live-evals` | 16 groups covered by representative live cases | [7F eval conformance](2026-08-09-phase-07f-explorer-verification.md) |

# Conformance shape

- 106 cases across 16 groups: ap, ar, bl, cm, co, dp, er, hb, ix, mh, rf, rs,
  se, st, su, wk.
- Assertion classes: `agent_tool_contract`, `authorization_policy`,
  `combined_multi_hop`, `control_plane_invariant`, `restraint_no_call`.
- Fake-agent/Codex operations: 18/18 executed.
- Bounded Codex binding matrix: one representative case per group (16 cases),
  e.g. `ap:ap-approval-deny-01`, `hb:hb-context-01`, `ix:ix-checkbox-01`,
  `mh:mh-blocked-handoff-01`, `rs:rs-dependency-blocked-wake-01`,
  `wk:wk-ask-mode-01`.
- Semantic execution counts include `checkout_task=31`, `list_agents=22`,
  `request_human_input=9`, `create_task=8`, `finish_task=8`, `report_progress=6`,
  `request_approval=6`, `block_task=5`, `register_deliverable=4`,
  `search_tasks=4`, `write_document=3`.
- Capability contract baseline: 152 skill/reference headings, 106 eval cases,
  258 normative rows, 41 legacy MCP aliases folded one-to-one into normative
  rows. See [the generated contract](../../docs/phase-07-capability-contract.md).

# Live runnerd and Codex evidence

Real provider turns on the final build, attributed to the tracks that produced
them; the frames and traces are not byte-stable by construction.

- `smoke:phase7:ui` — session created, multi-turn thread, real tool calls with
  30 authorization records; every assertion true, including `liveIdentity`
  (`Real Codex` / `Real runnerd` / `Mock Paperclip`), `mockIdentifier` (`MCK-`),
  `controlPlaneWithheld`, and `noCredentialInView`.
- `record:phase7:ui:live` — a real browser driving a real Codex turn through the
  package server; frames under `phase-07/ui-live/`. Excluded from the
  determinism gate.
- `trace:phase7 -- --json` — twelve assertions pass, including
  `noRealPaperclipRequest`, `noPaperclipAuthorityInChild`, `authorityCleared`,
  and `runnerExited`.

# Security result

The Security Engineer **approved** the exact final candidate
`865d1a72344f36a307a4582d4b0db1fc85ef1934` in issue **PAP-16946** (Phase 7H —
Final security gate). This verdict supersedes the earlier `REQUEST CHANGES`
record and closes the findings remediated by **PAP-16970**. It also supersedes
the historical **PAP-16915** review.

- 23/23 targeted semantic and socket-level HTTP tests pass: trusted-proxy
  authority, Origin and Fetch Metadata, exact JSON shape, indistinguishable-404
  authority failures, capability-plus-identity binding, two-session isolation,
  reset rotation/invalidation, concurrent-turn denial, bounded
  prompt/body/session/rate resources, stable redacted errors, and security
  headers.
- Provider credentials remain server-side under the child-process environment
  allowlist; the deployment root directly constructs the mock adapter, and
  ambient provider/control-plane credential names fail startup.
- The governed transition order holds and duplicate review transitions stay
  denied; authorization was not widened.

# Screenshots

- Deterministic fake-mode matrix: [issue-thread UI matrix](phase-07/ui/index.md)
  — 24 images, byte-stable across clean runs. Eligible for contract/replay
  acceptance.
- Live frames: [issue-thread live evidence](phase-07/ui-live/index.md) — real
  runnerd and Codex; intentionally not byte-stable. Eligible for live
  acceptance.
- Revision 2 scenario-explorer captures under [phase-07/](phase-07/index.md)
  remain for historical comparison.

# Documentation delivered

- Tutorial: [Phase 7 issue-thread clean-start tutorial](../../docs/tutorials/phase-07-issue-thread.md).
- Companion tutorial: [scenario explorer and capability contract](../../docs/tutorials/phase-07-scenario-explorer.md).
- Reference pages: [execution modes and identity](../../docs/phase-07-execution-modes.md),
  [issue-thread UI](../../docs/phase-07-issue-thread-ui.md),
  [live runnerd/Codex loop](../../docs/phase-07-live-runnerd-codex.md),
  [semantic catalog and authorization](../../docs/phase-07-semantic-catalog.md),
  [authorization and exposure](../../docs/phase-07-authorization-and-exposure.md),
  [mock ControlPlanePort](../../docs/phase-07-mock-control-plane-port.md),
  [eval conformance](../../docs/phase-07-eval-conformance.md),
  [future binding boundary](../../docs/phase-07-future-binding-boundary.md),
  [verification commands](../../docs/phase-07-verification-commands.md).
- Architecture and process topology: [architecture](../../docs/architecture.md#phase-7-live-process-topology).
- OKF journal: [Phase 7I documentation and evidence](../journal/2026-08-10-phase-07i-documentation-and-evidence.md).

# Handoff

This manifest, the clean-start tutorial, and the OKF journal are the
package-local half of the Track 7L final package. The remaining items — the new
HTTPS URL and final build identifier, the clean-room QA reports and responsive
screenshots — are produced by Track 7J (deployment) and Track 7K (QA) against
this same build.

# Known gaps

- `report:phase7-evals` and `report:phase7-live-evals` write generated reports
  (`eval-parity-report.*`, `live-codex-matrix.*`) into the knowledge bundle
  without OKF frontmatter, and `evidence/phase-07/index.md` does not link them,
  so `docs:validate` fails while they are present. Delete them before validating,
  or run validation first. A clean checkout does not contain them.
- Live evidence depends on a locally authenticated Codex. Without it, the live
  steps are unavailable and only the offline fake path runs.
- No Paperclip control plane, database, or provider is contacted anywhere in
  Phase 7. Real integration is Phase 8 (ACPX) and requires separate approval.
