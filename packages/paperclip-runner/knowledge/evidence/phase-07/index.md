# Phase 7 evidence

**Eligibility.** The deterministic `fake`-mode captures on this page — the
scenario-explorer set below and the [issue-thread UI matrix](ui/index.md) — are
byte-stable and prove the contract and replay; they are **not** eligible for a
final live acceptance criterion. The [live issue-thread frames](ui-live/index.md)
are the ones that satisfy live criteria. The scenario-explorer captures are
Revision 2 historical evidence. The authoritative command-and-result record is
the [final evidence manifest](../2026-08-10-phase-07i-final-evidence.md).

Phase 7E writes its conformance parity report into this directory as
`eval-parity-report.json` and `eval-parity-report.md`. The explorer bundles the
JSON when it is present and renders "Not run" when it is not; it never
re-judges what 7E reports.

## Screenshot acceptance set

`screenshot-manifest.json` records the twelve slugs, routes, and two viewports
fixed by [the Phase 7 interaction map](../../../docs/design/phase-7-scenario-explorer-ux.md)
§9. Regenerate every capture with:

```
node scripts/record-phase7-evidence.mjs
```

Each shot is taken only after the explorer shell reports
`data-run-state="settled"`, from a freshly loaded document, at
**1440x900** and **390x844**. Fake-mode runs render fixture time only, so two
recordings of the same route agree.

| # | Slug | Evidence the shot must show |
| --- | --- | --- |
| 1 | `explorer-home` | All 16 group facets with counts summing to 106; corpus stats; example deep links; no dead panel. |
| 2 | `picker-filtered` | Active filter chips, live counts, disabled zero-count values, Clear filters. |
| 3 | `hb-heartbeat` | Control-plane checkout entry ("no agent tool exists for this") before the first agent call. |
| 4 | `wk-planning` | Plan document revision, revision-bound confirmation, review-parked disposition. |
| 5 | `bl-blockers-diff` | Blockers and tasks domains changed; unchanged domains collapsed. |
| 6 | `ap-approval-denied` | Deny row with the missing claim, "Authorization - 1 deny" tab chip, typed denial card carrying no task data. |
| 7 | `ar-artifacts` | `register_deliverable` before `finish_task` in artifact order. |
| 8 | `ix-interaction` | Checkbox interaction call card with its options payload. |
| 9 | `rf-manager` | Manager role, optional tools with their unlocking grant, control-plane "no tool" list, traceability panel. |
| 10 | `mh-multihop` | Multi-hop assertions passing; forbidden operations section. |
| 11 | `rs-restraint` | "No further operations" note and a restraint verdict. |
| 12 | `rs-secret-redaction` | Redaction chips naming their rule; no credential anywhere in the page. |

## Issue-thread UI collections

* [Issue-thread UI matrix](ui/index.md) - Deterministic `fake`-mode captures for the 12 contract slugs at 1440×900 and 390×844; byte-stable across clean runs.
* [Issue-thread live evidence](ui-live/index.md) - Real `paperclip-runnerd` and Codex frames; intentionally not byte-stable.
* [Clean-room chat evidence](clean-room/index.md) - Real `paperclip-runnerd` and Codex frames on a freshly minted mock tenant: the entry point, the blank thread, a live turn, the on-demand evidence drawer, and the identity rotation `New chat` performs. Intentionally not byte-stable.
