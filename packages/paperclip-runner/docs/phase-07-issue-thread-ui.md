# Phase 7 Paperclip-style issue-thread UI

Phase 7G renders the mock Paperclip issue as a native issue thread. A board user
reads the thread, answers typed interactions inline, and inspects the evidence
behind every mock mutation. The implementation follows the binding
[Phase 7B issue-thread UX contract](design/phase-7-issue-thread-ux-contract.md).

## Authority boundary

```text
browser  ->  package server  ->  Phase7LiveSession  ->  paperclip-runnerd -> codex
             (projection)        Phase7SemanticDispatcher -> ControlPlanePort mock
```

The browser holds no authority. It renders one shape,
`Phase7IssueThreadSnapshot` (`src/issue-thread/types.ts`), and computes no
claim, policy decision, state diff, or parity verdict. Two producers emit that
shape:

- `phase7IssueThreadFixture(slug)` — deterministic `fake` snapshots used by the
  screenshot matrix and the browser suite.
- `projectPhase7IssueThread({ snapshot })` — the live projection. It runs in the
  package server and rearranges durable records only: the live session's
  transcript, evidence entries, semantic authorization records, and the
  serialized mock state.

The one browser-initiated mock mutation is an interaction response. It posts to
`POST /api/phase7/ui/interaction`; `Phase7LiveSession.resolveInteraction` stores
the typed response in the mock control plane **before** resuming the same Codex
thread, so the card only leaves `submitting` on server acknowledgement.

No provider, runner, or control-plane credential reaches the page. Redacted
fields render as `••• redacted` with the redaction rule name, mock issues use
the reserved `MCK-` prefix, and no real Paperclip URL is ever rendered.

## Surfaces

- **Header** — three identity chips (`Real Codex` / `Fake agent` / `Replay`,
  `Real runnerd` / `In-process runner`, and `Mock Paperclip` in every mode),
  status, priority, run state, and the Scenario/Replay/Reset/Stop controls.
  `data-session-mode` carries the mode as data, never as styling.
- **Thread** — turn groups binding the contract's T1–T11 item types: user
  messages, model prose, durable progress comments marked
  `Recorded to mock thread`, collapsed tool strips, interaction cards, document
  revision cards, deliverables, delegation cards, terminal dispositions, typed
  denials, and muted system notices.
- **Composer** — six mutually exclusive states behind `data-composer-state`:
  `ready`, `sending`, `streaming` (input stays editable to steer; Stop is
  primary), `waiting`, `reconnecting`, and `disabled`. Drafts survive refresh.
- **Evidence panel** — eight accordion sections in fixed order: Tools exposed,
  Calls & results, Authorization, Control plane, Runner & events, State diff,
  Traceability, Parity. The Tools section groups `Agent tool — always`,
  `Agent tool — granted` (with its grant), and a separated
  `Control plane (not exposed to the agent)` list, because what the model
  *cannot* call is first-class evidence. Every strip, denial, and card deep-links
  into the matching record, and each record links back to its thread anchor.

The panel is collapsed by default and resizable between 320px and 640px with a
keyboard-operable splitter. Below 1100px it becomes an overlay sheet; below
768px the page switches to a `Thread` / `Evidence` segmented control, with Stop
kept outside the `⋯` menu while a turn is active.

## Routes

```text
#/issue/<fixtureProfile>?shot=<slug>&panel=<section>&rec=<id>&at=<ordinal>&seg=thread|evidence&mode=live
```

- `shot` seeds one of the twelve deterministic `fake` states.
- `mode=live` opts into the package session server; the default is `fake`.
- `capture=1` freezes animation, caret, and smooth scrolling for screenshots.
- The root element sets `data-thread-state="settled"` once hydration, fixture
  load, and auto-scroll finish. Tooling waits for that attribute, never a
  timeout.

## Commands

```sh
# Deterministic fake-mode app (no provider process)
pnpm --filter @paperclipai/paperclip-runner console:phase7

# Focused browser suite, including the axe gate on all 12 slugs × 2 viewports
pnpm --filter @paperclipai/paperclip-runner test:browser:phase7

# View-model and live-projection unit tests
pnpm --filter @paperclipai/paperclip-runner exec vitest run src/issue-thread

# Screenshot matrix (12 slugs × 2 viewports) and its byte-stability check
pnpm --filter @paperclipai/paperclip-runner record:phase7:ui
pnpm --filter @paperclipai/paperclip-runner check:phase7:ui

# Real runnerd + real Codex through the same HTTP routes the browser uses
pnpm --filter @paperclipai/paperclip-runner smoke:phase7:ui
pnpm --filter @paperclipai/paperclip-runner record:phase7:ui:live
```

Hosts without the Playwright chromium system libraries can either run
`pnpm --filter @paperclipai/paperclip-runner verify:rootless` or set
`PAPERCLIP_RUNNER_CHROMIUM_PATH` to a preinstalled Chromium.

## Accessibility

The suite enforces the contract's blocking gate: axe reports zero serious or
critical WCAG 2.1 A/AA violations on every screenshot route at both viewports.
Structure is one `h1`, `header`/`main`/`complementary` landmarks, a `form`
composer, `section` interaction cards labelled by their prompt, and tool strips
as disclosure buttons with `aria-expanded`. Focus moves to the Evidence heading
when the panel opens and to the pending card's first control from the `waiting`
composer anchor. Every state chip pairs color with a glyph and text, all
actionable controls clear 44×44 CSS px on mobile, and `prefers-reduced-motion`
disables the pulse dot, banner slide, and smooth scrolling.

## Contract deviations

One deviation is recorded against the Phase 7B contract:

- **§5 expired-family dimming.** The contract asks for a 60% opacity body on
  `stale_target` and the other expired outcomes. A literal opacity drops that
  card's text to ~3.2:1 and fails the blocking axe gate in §9.7. The dim is
  implemented as a recessed surface plus muted text that still clears 4.5:1.

## Determinism notes

Fake-mode fixtures render from authored data with a fixed clock, so two captures
of a slug from a clean checkout are byte-identical. Live sessions are not
byte-stable — a real model writes their prose — so live evidence lives in
`knowledge/evidence/phase-07/ui-live/` and is excluded from the determinism gate.
Durable comments in live mode carry the mock control plane's own deterministic
clock rather than wall time, because that is the timestamp on the mock record.
