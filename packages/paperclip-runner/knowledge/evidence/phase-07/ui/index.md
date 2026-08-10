# Phase 7 issue-thread UI evidence

Recorded by `pnpm --filter @paperclipai/paperclip-runner record:phase7:ui`.
Deterministic `fake` mode; no provider, runner, or credential is involved.

- `debug-panel-open--desktop.png`
- `debug-panel-open--mobile.png`
- `deliverable-registered--desktop.png`
- `deliverable-registered--mobile.png`
- `denial-optional-tool--desktop.png`
- `denial-optional-tool--mobile.png`
- `disposition-terminal--desktop.png`
- `disposition-terminal--mobile.png`
- `document-revision--desktop.png`
- `document-revision--mobile.png`
- `interaction-confirmation-pending--desktop.png`
- `interaction-confirmation-pending--mobile.png`
- `interaction-question-pending--desktop.png`
- `interaction-question-pending--mobile.png`
- `interaction-resolved-mixed--desktop.png`
- `interaction-resolved-mixed--mobile.png`
- `reconnect-banner--desktop.png`
- `reconnect-banner--mobile.png`
- `replay-mode--desktop.png`
- `replay-mode--mobile.png`
- `thread-baseline--desktop.png`
- `thread-baseline--mobile.png`
- `turn-streaming--desktop.png`
- `turn-streaming--mobile.png`

## Recording environment

- Chromium 151.0.7922.34 — pin the exact binary with `PAPERCLIP_CHROMIUM_BIN`
  (honoured by the agent-browser wrapper) alongside
  `PAPERCLIP_RUNNER_CHROMIUM_PATH`.
- Bundled sans face: Paperclip Issue Thread Inter (weights 400/500/600/700,
  probe 531px vs generic serif 499px).
- Bundled mono face: Paperclip Issue Thread DejaVu Sans Mono (weights 400/700,
  probe 658px). Status glyphs use the bundled
  Paperclip Issue Thread Symbols subsets. The recorder refuses to run when any
  Vite-managed face is missing or fails to load.
