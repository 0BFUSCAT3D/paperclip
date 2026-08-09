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
| Scenario runtime + explorer + routes | `test:phase7` | 45 tests pass |
| Browser IA, accessibility, determinism, boundary | `test:browser:phase7` | 19 Playwright tests pass |
| Screenshot acceptance set | `record:phase7` | 24 deterministic images |
| Doc links + OKF bundle | `docs:validate` | 62 files, 26 OKF concepts, 5 indexes |

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
</content>
