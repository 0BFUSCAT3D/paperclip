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
- Sans stack resolves to Inter (probe: Inter 549px vs
  DejaVu Sans 641px for the title string). The recorder
  refuses to run when Inter does not resolve.
