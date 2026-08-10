---
type: Engineering Journal Entry
title: Phase 7I documentation and evidence
description: Documentation and evidence decisions for the final Phase 7 build — the live process topology, the execution-modes reference, the clean-start issue-thread tutorial, the final evidence manifest, and the Revision 2 ineligibility record.
tags: [native-runner, phase-7, documentation, evidence, manifest, live-codex, mock-control-plane]
status: stable
generated: { by: anthropic/claude-opus-4-8, at: 2026-08-10T13:20:00Z }
entry_kind: phase
phase: "7"
---

# Context

Track 7I (PAP-16947) is the documentation and evidence half of the final Phase 7
package. Its three blockers — 7F eval conformance (PAP-16944), 7G issue-thread
web UI (PAP-16945), and 7H final security gate (PAP-16946) — were all `done`
before this work started. The task is to make the package index, reference,
architecture, process topology, tutorial, evidence manifest, screenshot index,
and OKF journal current for the final candidate build
`865d1a72344f36a307a4582d4b0db1fc85ef1934`, and to mark the Revision 2 preview
as historical.

# Decisions

- **Documented the final build, not a rewrite of the tracks.** The 7E, 7F, and
  7G tracks already shipped strong reference pages
  (`phase-07-live-runnerd-codex.md`, `phase-07-issue-thread-ui.md`) and
  verification records. 7I adds the connective tissue rather than restating them:
  a live process-topology section in `architecture.md`, an
  `phase-07-execution-modes.md` reference that names Real Codex / Real runnerd /
  Mock Paperclip and states the fake-vs-live eligibility rules in one place, and
  a canonical clean-start tutorial for the issue-thread surface.
- **Kept the Revision 2 manifest as historical.** The
  `2026-08-09-phase-07-verification.md` manifest describes the preview build
  `da0d32d74a` and the old gate issues; rather than overwrite it, the new
  `2026-08-10-phase-07i-final-evidence.md` supersedes it and opens with an
  explicit "not eligible for final acceptance" section. The final try-it link is
  the 7J deployment URL, never the Revision 2 URL.
- **Re-ran the offline deterministic commands on the final tree** so the manifest
  reports observed results, not claimed ones: `check:phase7-inventory`,
  `test:phase7-evals` (106 cases), `test:phase7` (137 tests), `report:phase7-evals`
  (106 cases across 16 groups), and `docs:validate` (85 files, 31 OKF concepts).
  The 50/50 browser suite, the byte-stable 24-image matrix, the bounded live
  Codex matrix, and the live smokes are attributed to the 7F/7G track records
  that produced them on the same build.
- **Named the security result precisely.** The manifest records the PAP-16946
  APPROVE against `865d1a72…`, that it supersedes the earlier `REQUEST CHANGES`
  and the historical PAP-16915 review, and that PAP-16970 remediation is closed.

# Failures and fixes

- The generated eval and live-matrix reports (`eval-parity-report.*`,
  `live-codex-matrix.*`) sit in the knowledge bundle without OKF frontmatter and
  are not linked from `evidence/phase-07/index.md`, so `docs:validate` fails
  while they are present. They were moved out of the bundle before validating and
  are recorded as a known gap in both the manifest and here. A clean checkout
  does not contain them.
- This is a shared execution workspace with in-flight sibling changes across
  Phase 5/6 and the consolidated Phase 7 tracks. Staging used a surgical,
  path-scoped add of only the 7I files so no sibling's uncommitted work was swept
  into the commit.

# Known gaps and next questions

- The final try-it URL and clean-room QA reports are produced by Tracks 7J and
  7K against this same build; 7I supplies the package-local half of the 7L final
  package.
- Live evidence requires a locally authenticated Codex; the offline fake path is
  the only self-contained one.
- Real Paperclip binding remains Phase 8 (ACPX) and requires separate approval.

# Evidence

- Final manifest:
  [Phase 7 final evidence manifest](../evidence/2026-08-10-phase-07i-final-evidence.md).
- Tutorial:
  [Phase 7 issue-thread clean-start tutorial](../../docs/tutorials/phase-07-issue-thread.md).
- Reference: [execution modes and identity](../../docs/phase-07-execution-modes.md).
- Topology: [architecture](../../docs/architecture.md#phase-7-live-process-topology).
