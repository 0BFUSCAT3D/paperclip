---
type: Engineering Journal Entry
title: Phase 7G Paperclip-style issue-thread web UI
description: Implementation decisions, deviations, and evidence for the package-local issue thread, interaction cards, composer, and Evidence panel.
tags: [native-runner, phase-7, ui, accessibility, evidence, mock-control-plane]
status: stable
generated: { by: anthropic/claude-opus-5, at: 2026-08-10T04:05:00Z }
entry_kind: phase
phase: "7"
---

# Context

Track 7G implements the browser surface named by the binding Phase 7B
issue-thread UX contract. The demo it has to support is a real Codex session,
driven by a real `paperclip-runnerd`, rendered as a native Paperclip issue
thread over deterministic mock control-plane records. The contract's §12
handoff checklist is the acceptance list.

# Decisions

1. **One view contract, two producers.** `Phase7IssueThreadSnapshot`
   (`src/issue-thread/types.ts`) is the only shape the browser renders. The
   deterministic `fake` fixtures and the live projection both emit it. That is
   what makes the screenshot matrix hermetic while the live path stays honest:
   the page cannot render anything the projection did not put in the snapshot.
2. **Projection runs server-side and decides nothing.** `projectPhase7IssueThread`
   reads the live snapshot's transcript, evidence entries, semantic
   authorization records, and serialized mock state, then regroups them. Every
   allow/deny, revision, and state change already exists in its input, so §11's
   "UI-side state math is a defect" holds structurally rather than by review.
3. **Fake mode owns the acceptance matrix.** The twelve §10.2 slugs render from
   authored records with a fixed clock and no server, so two captures from a
   clean checkout are byte-identical. `record:phase7:ui --check` re-records into
   scratch and compares bytes rather than trusting a re-run.
4. **Package-local tokens, no product `ui/` import.** A separate OKLCH dark
   token set (`--pit-*`) implements the Paperclip visual language.
   `check:browser-tokens` — which the `verify` script already referenced but
   which did not exist in the restored baseline — now enforces "no raw color in
   component source, and stylesheet rules paint with custom properties only".
5. **The Evidence badge counts invocation denials only.** Exposure-phase denials
   are the normal path — they are exactly what the `Control plane — not exposed`
   list renders — so badging them would cry wolf on every turn. A badge means
   the model was actually refused.

# Evidence

Tool versions: Node 22.22.2, pnpm workspace package `@paperclipai/paperclip-runner`,
Playwright 1.62.1, axe-core 4.13.0, Codex CLI 0.132.0, Chromium 151.0.7922.34.

* `pnpm typecheck:typescript` — passed.
* `pnpm typecheck:browser` — passed.
* `pnpm exec vitest run src/issue-thread/issue-thread.test.ts` — 16/16 passed
  (fixture schema, slug determinism, §3 item coverage, §5 state coverage, §4
  composer coverage, verbatim deny text, replay labelling, live projection of
  real `Phase7MockControlPlaneAdapter` records, credential scan).
* `pnpm exec playwright test --config devtools/issue-thread/playwright.config.ts`
  — 46/46 passed, including the axe gate on 12 slugs × 2 viewports with zero
  serious or critical violations.
* `node scripts/record-phase7-ui-evidence.mjs` then `--check` — 24 PNGs
  recorded, all 24 reproduce byte-for-byte; each mobile capture asserts
  `scrollWidth <= clientWidth` at 390×844.
* `node scripts/phase7-issue-thread-smoke.mjs --json` — real runnerd and real
  Codex through the browser's own HTTP routes: 2 turns, 2 tool calls, 30
  authorization records, all 13 assertions true including
  `durableCommentRendered`, `controlPlaneWithheld`, and `noCredentialInView`.
* `node scripts/record-phase7-ui-live-evidence.mjs` — three live PNGs captured
  from a real browser session; identity chips read `Real Codex` / `Real runnerd`
  / `Mock Paperclip`, and the mobile frame has no horizontal page scroll.
* `pnpm check:browser-tokens` — passed. `pnpm docs:validate` — passed.

# Failures

* **`html { font-size }` broke every touch target.** Setting the type scale on
  the root element redefined `rem` as 14px, so the 2.75rem touch-target token
  resolved to 38.5px and sixteen controls failed the 44px assertion. The scale
  now lives on `body`.
* **Blanket opacity failed the accessibility gate.** The contract's 60% dim for
  expired-family interaction cards measured 3.16:1 against the card surface.
  Replaced with a recessed surface plus muted text; recorded as a deviation in
  the reference doc and reported back to the contract owner.
* **`--pit-faint-foreground` measured 4.49:1.** One notch below the 4.5:1 bar on
  the run-state line; lightness raised to `oklch(0.64 …)`.
* **Evidence records had no thread anchors.** `Show in thread` resolved nothing
  until each rendered thread item carried its record `id`, which is what makes
  the §7 cross-link bidirectional rather than one-way.
* **A duplicated `data-composer-state` on the app root** made the contract's
  screenshot hook ambiguous; the attribute now lives only on the composer form.

# Known gaps

- Live mode resolves interactions and turns over request/response. A push
  transport for token-level streaming is not implemented; the `streaming`
  composer state and the streaming indicator render from fixtures and from the
  live snapshot's active turn, not from a token stream.
- `?at=<ordinal>` steps the replay strip and deep-links, but replay renders the
  recorded fake fixture rather than a per-ordinal reconstruction of canonical
  events.
- Traceability and parity records are passed through the projection verbatim;
  wiring them to the 7F conformance run belongs to that track.

# Follow-up questions

- Does the board want live evidence PNGs treated as acceptance artifacts, given
  they cannot be byte-stable?
- Should `check:phase7:ui` join `verify`, or stay a separate gate so `verify`
  does not depend on a browser recorder?
