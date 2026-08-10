# Phase 7 Verification Commands

Every command here runs from the repository root, is offline and deterministic,
starts no Paperclip service, and holds no credential. All are prefixed
`pnpm --filter @paperclipai/paperclip-runner`. The observed results for the
acceptance record are in
[the Phase 7 verification evidence](../knowledge/evidence/2026-08-09-phase-07-verification.md).

| Surface | Command | Expected result |
| --- | --- | --- |
| Capability contract completeness and drift | `check:phase7-inventory` | `Phase 7 inventory completeness and generated-output checks passed.` |
| Contract validator negatives | `test:phase7-inventory` | 4 tests pass |
| Mock control plane + shared port | `exec vitest run src/conformance/control-plane-port.test.ts src/mock-core/phase7-mock-control-plane-adapter.test.ts` | 9 tests pass |
| Semantic tools + authorization/redaction | `exec vitest run src/tools/phase7-semantic-tools.test.ts` | 9 tests pass |
| 106-case conformance | `test:phase7-evals` | 1 file (all 106 cases) passes |
| Fake-agent matrix + bounded Codex + parity report | `report:phase7-evals` | `Phase 7 eval conformance passed: 106 cases across 16 groups.` |
| Scenario runtime + explorer + clean room + routes | `test:phase7` | 159 tests pass |
| Browser IA, accessibility, determinism, boundary | `test:browser:phase7` | Playwright suites pass (60 in the issue-thread/clean-room suite) |
| Screenshot acceptance set | `record:phase7` | 24 deterministic images |
| Doc links + OKF bundle | `docs:validate` | 73 files, 28 OKF concepts, 5 indexes |

## Live commands (not offline)

The clean-room chat has no fake or replay path, so its end-to-end proof needs a
Rust toolchain and a locally authenticated Codex. These are the only Phase 7
commands that start a provider.

| Surface | Command | Expected result |
| --- | --- | --- |
| Real Codex through real runnerd on a fresh mock tenant | `smoke:phase7:cleanroom` | every assertion `true`; two `MCK-` identifiers, one per chat |
| Preset issue thread against real Codex | `smoke:phase7:ui` | every assertion `true` |
| Clean-room screenshots | `record:phase7:cleanroom` | 7 images; intentionally not byte-stable |

## Notes

- **No Rust toolchain is needed** for any Phase 7 command. The full
  `verify` target still builds the Rust workspace, but nothing above does.
- **Determinism.** Fake-mode runs render fixture time only, so repeat runs and
  repeat screenshots are byte-identical.
- **The parity report is generated on demand.** `report:phase7-evals` writes
  `knowledge/evidence/phase-07/eval-parity-report.{json,md}`, which are not
  committed. Because the `.md` carries no OKF frontmatter, run `docs:validate`
  **before** generating the report, or delete the report first. This dirty-tree
  interaction is tracked for the Phase 7H QA gate (`PAP-16907`).
- **Browser libraries.** On minimal or rootless hosts, extract Playwright's
  browser libraries first; the package's `verify:rootless` target shows the
  pattern.

## Related

- [Clean-start tutorial](tutorials/phase-07-scenario-explorer.md)
- [Eval conformance](phase-07-eval-conformance.md)
- [Scenario explorer](phase-07-scenario-explorer.md)
- [Clean-room live chat](phase-07-clean-room-chat.md)
