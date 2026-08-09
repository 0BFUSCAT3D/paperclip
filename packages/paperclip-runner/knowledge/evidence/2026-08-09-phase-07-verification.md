---
type: Verification Evidence
title: Phase 7 documentation, tutorial, and evidence manifest
description: Package-local acceptance manifest cross-linking every focused Phase 7 verification command, its observed result, the parity/screenshot artifacts, and the security, UX, and QA gate issues.
tags: [native-runner, phase-7, verification, conformance, evidence, manifest]
status: stable
generated: { by: anthropic/claude-opus-4-8, at: 2026-08-09T13:42:50Z }
---

# Scope

This record is the Phase 7G evidence manifest (PAP-16906). It links each
package-local, offline, deterministic verification command to the result
observed on 2026-08-09, and to the reference pages, tutorial, parity report,
and screenshot set that describe the Phase 7 surfaces.

Phase 7 contacts no Paperclip service, ACPX session, database, or provider
credential. Every command below runs from the repository root against
checked-in fixtures and the in-process mock control plane.

# Environment

- Node.js 22.22.2, pnpm 9.15.4. No Rust toolchain is required for any Phase 7
  focused command.
- vitest 4.1.10; Playwright with its bundled Chromium.
- No network access after `pnpm install`.

# Verification matrix

All commands are prefixed `pnpm --filter @paperclipai/paperclip-runner`.
Results were captured on 2026-08-09 between 13:37Z and 13:39Z.

| Surface | Command | Observed result |
| --- | --- | --- |
| Capability contract completeness and drift | `check:phase7-inventory` | `Phase 7 inventory completeness and generated-output checks passed.` (exit 0) |
| Contract validator negatives | `test:phase7-inventory` | 4 tests, 4 pass, 0 fail |
| Mock control plane + shared port | `exec vitest run src/conformance/control-plane-port.test.ts src/mock-core/phase7-mock-control-plane-adapter.test.ts` | 2 files, 9 tests pass |
| Semantic tools + authorization/redaction | `exec vitest run src/tools/phase7-semantic-tools.test.ts` | 1 file, 9 tests pass |
| 106-case conformance | `test:phase7-evals` | 1 file, 1 test (drives all 106 cases) pass |
| Fake-agent matrix + bounded Codex sample + parity report | `report:phase7-evals` | `Phase 7 eval conformance passed: 106 cases across 16 groups.` |
| Scenario runtime + explorer components + routes | `test:phase7` | 3 files, 49 tests pass |
| Browser IA, accessibility, determinism, boundary | `test:browser:phase7` | 25 Playwright tests pass (6.8s) |
| Screenshot acceptance set | `record:phase7` | 24 deterministic images (12 routes × 2 viewports) |
| Doc links + OKF bundle | `docs:validate` | `Documentation link validation passed (73 files).` and `OKF v0.2 validation passed (28 concepts, 5 indexes).` |

# Conformance shape

- 106 cases across 16 groups: hb 5, co 6, st 8, cm 6, se 4, su 4, bl 5, dp 3,
  ix 9, ap 6, ar 4, er 9, rf 22, mh 4, rs 3, wk 8.
- Assertion classes: `agent_tool_contract`, `authorization_policy`,
  `combined_multi_hop`, `control_plane_invariant`, `restraint_no_call`.
- Fake-agent/Codex operations: 18/18 executed.
- Capability contract baseline: 152 skill/reference headings, 106 eval cases,
  258 normative rows, 41 legacy MCP aliases folded one-to-one into normative
  rows. See [the generated contract](../../docs/phase-07-capability-contract.md).

# Artifacts

- Parity report: generated on demand by `report:phase7-evals` into
  `knowledge/evidence/phase-07/eval-parity-report.{json,md}`. It is not a
  committed file; a clean checkout does not contain it, and the explorer renders
  "Not run" when it is absent.
- Screenshots: the committed 24-image acceptance set and its manifest are under
  [Phase 7 evidence](phase-07/index.md).
- Prior surface evidence:
  [Phase 7F browser scenario explorer verification](2026-08-09-phase-07f-explorer-verification.md).

# Documentation delivered

- Tutorial: [Phase 7 clean-start tutorial](../../docs/tutorials/phase-07-scenario-explorer.md).
- Reference pages:
  [capability disposition](../../docs/phase-07-capability-disposition.md),
  [mock ControlPlanePort](../../docs/phase-07-mock-control-plane-port.md),
  [semantic tools](../../docs/phase-07-semantic-tools.md),
  [authorization and exposure](../../docs/phase-07-authorization-and-exposure.md),
  [eval conformance](../../docs/phase-07-eval-conformance.md),
  [scenario explorer](../../docs/phase-07-scenario-explorer.md),
  [future binding boundary](../../docs/phase-07-future-binding-boundary.md),
  [verification commands](../../docs/phase-07-verification-commands.md).

# Gate issues

- Security gate: `PAP-16902` (authorization and credential isolation review),
  with remediation `PAP-16909` (redact secret invocation results before trace
  or browser exposure). The `rs-secret-redaction` case and the
  `src/tools/phase7-semantic-tools.test.ts` redaction assertions exercise the
  remediated path.
- UX gate: `PAP-16905` (explorer acceptance and screenshots), against the
  approved interaction map §9 twelve-route matrix.
- QA gate: `PAP-16907` (clean-room QA and human checkpoint), which consumes this
  manifest and the tutorial from a clean checkout.

# Known gaps

- `report:phase7-evals` writes `eval-parity-report.md` into the knowledge bundle
  without OKF frontmatter, and `evidence/phase-07/index.md` does not link it, so
  `docs:validate` fails while the generated report is present. Delete the report
  before validating, or run validation first. Recorded for the Phase 7H QA gate
  as a candidate to relocate the generated report outside the bundle or exclude
  it from the OKF scan.
- Codex mode in the explorer is disabled with a stated reason; the only real
  provider exercise is the bounded binding sample in `report:phase7-evals`.
- No Paperclip control plane, database, or provider is contacted anywhere in
  Phase 7. Real integration is Phase 8 (ACPX) and requires separate approval.
