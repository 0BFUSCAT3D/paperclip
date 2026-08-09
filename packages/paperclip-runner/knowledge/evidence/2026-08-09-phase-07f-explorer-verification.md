---
type: Verification Evidence
title: Phase 7F browser scenario explorer verification
description: Scenario index, run artifact, exposure, authorization, diff, parity, route determinism, accessibility, and screenshot evidence for the package-local Phase 7 explorer.
tags: [native-runner, phase-7, verification, browser, explorer, parity]
status: stable
generated: { by: anthropic/claude-opus-5, at: 2026-08-09T13:30:00Z }
---

# Scope

This record verifies the standalone Phase 7 browser scenario explorer
(PAP-16904) against the approved interaction map,
[Phase 7 Interaction Map](../../docs/design/phase-7-scenario-explorer-ux.md).
It covers the package-local scenario runtime that produces run artifacts, the
explorer that renders them, and the acceptance screenshot set.

No Paperclip service, ACPX session, database, or provider credential is
contacted or held at any point. Fake mode runs entirely in the page against
checked-in fixtures.

# What was verified

## Scenario coverage

All 106 eval cases across the 16 groups build a scenario index entry, execute
against the Phase 7C mock control plane through the Phase 7D semantic tool
runtime, and produce a run artifact carrying tool exposure, control-plane
actions, authorization records, an immutable state diff over the ten entity
domains, and a parity verdict. Every scenario passes parity.

* `pnpm run test:phase7` - 45 tests, 3 files, all passing.
  * `src/phase7/scenario-explorer.test.ts` - index completeness (106 cases, 16
    groups, profile declared for every fixture), plan legality (no plan invokes
    an operation outside the catalog; no plan invokes a control-plane-owned
    capability as a tool), all-scenario execution, all-scenario parity,
    byte-identical repeat runs, fixture-time-only assertions, checkout as a
    control-plane action, optional tools carrying their unlocking grant, typed
    denial with no protected state, no raw secret in any artifact, restraint
    legibility, artifact ordering, first-class blocker edges, and the Phase 7E
    carry-through.
  * `examples/phase7-explorer/src/explorer.test.tsx` - picker listbox and
    facets, zero-count values disabled, empty-result recovery, both transcript
    channels, denial rendering, restraint note, redaction chip, escape-hatch
    warning, the four inspector panels, designed empty states, run header
    verdict and disabled Codex mode, harness-failure rendering, and the
    credential/disposition boundary.
  * `examples/phase7-explorer/src/route.test.ts` - every route shape in the
    interaction map §7, round-trips, and rejection of unknown values.

## Browser acceptance

* `pnpm run test:browser:phase7` - 19 Playwright tests, all passing.
  * Information architecture: 16 group facets summing to 106, three landmarks,
    a single `h1`, no dead panel.
  * Determinism: two loads of `#/case/ap-mcp-gate-01?run=fake&view=authorization`
    produce identical settled DOM; a fake run contains no wall-clock instant.
  * Evidence routes: deny row plus tab deny count, optional tools with their
    unlocking grant, collapsed unchanged diff domains, restraint note, and
    redaction chips.
  * Boundary: no network request leaves the explorer's own origin,
    `localStorage` is empty, and Codex mode is disabled with a stated reason.
  * Accessibility: listbox arrow-key navigation with `aria-activedescendant`,
    WAI-ARIA tabs arrow-key activation with exactly one tablist on the page,
    every interactive control named, and a polite live region announcing the
    settled verdict.
  * Responsive: one segment at a time at 390px with zero horizontal overflow,
    and inspector routes opening the Inspect segment.

## Screenshots

`node scripts/record-phase7-evidence.mjs` records the 24-image acceptance set
(12 routes x 2 viewports) into `evidence/phase-07/`, with
`screenshot-manifest.json` naming the routes. See
[Phase 7 evidence](phase-07/index.md).

## Defects found and fixed during this work

1. **Horizontal overflow at 390px.** SDK badges inside a disclosure summary
   inherit `min-width: 0` from the sheet while setting `white-space: nowrap`,
   so they overflowed their own box and pushed the page 4px wide. Corrected
   with a scoped `.pcr7-shell` override; recorded as an SDK defect in the
   interaction map revision list.
2. **SDK badge capitalisation broke the label vocabulary.** `Optional tool` and
   `Not run` rendered as `Optional Tool` and `Not Run`. Same scoped override.
3. **Deep links arriving by hash change left the wrong mobile segment.** A
   route naming an inspector view still showed the picker because the segment
   was only derived at mount. The segment now follows the route.
4. **Screenshot capture leaked state between shots.** Hash-only navigation kept
   the previous scenario's run in memory, so its parity dot appeared in the
   next shot's picker. Every capture now starts from a clean document.
5. **Full-page captures were clipped by inner scroll containers.** The rails
   now scroll with the page; only the 106-row case list keeps a bounded height.

## Deliberately not done here

* The explorer never re-judges parity. It renders the runtime's verdict and
  carries Phase 7E's per-case result through in a separately labelled block.
* No SDK export was added and the `0.1.2` surface is unchanged. The scenario
  runtime is reached through the package-local `@paperclip-runner-local/phase7`
  alias, which is deliberately not the published package name.
* Codex mode renders as a disabled option with its reason. Wiring it to the
  Phase 5 relay is a later step; the browser holds no provider credential
  either way.
