# Phase 4: Run the Skillless Codex Driver

## What this phase is

Phase 4 connects the mock core to a real Codex app-server session.

Codex gets one small task envelope. Codex does not get the Paperclip skill.
Codex does not get a Paperclip API key or API instructions.

## What this phase proves

This phase proves that a real Codex session can create a file, stream typed
events, return one checked result, and replay the same result.

It also proves that steer, interrupt, resume, and unsupported-operation paths
keep clear session identities and safe diagnostics.

## Before you start

- Run commands from the repository root.
- Install Node.js 20+, pnpm 9+, Rust, and the `codex` CLI.
- Sign in to Codex with the normal local Codex setup.
- Do not add a Paperclip or OpenAI API key for this tutorial.

Check the installed harness:

```sh
codex --version
codex app-server --help
```

## Step 1: Run the focused conformance checks

```sh
pnpm --filter @paperclipai/paperclip-runner typecheck:typescript
pnpm --filter @paperclipai/paperclip-runner exec vitest run \
  src/drivers/codex/codex-app-server-driver.test.ts
pnpm --filter @paperclipai/paperclip-runner check:forbidden-imports
```

Confirm that the driver tests pass and the package boundary check says
`Standalone boundary check passed.`

## Step 2: Run the safe real Codex task

Choose a temporary directory and trace file:

```sh
phase4_workspace="$(mktemp -d)"
phase4_trace="$phase4_workspace/trace.json"
pnpm --filter @paperclipai/paperclip-runner trace:phase4 -- \
  --working-directory "$phase4_workspace" \
  --output "$phase4_trace"
```

Confirm:

- the result is `done`;
- every printed assertion says `PASS`;
- the file has the exact text:

```sh
test "$(cat "$phase4_workspace/hello.txt")" = "hello from phase 4"
```

## Step 3: Inspect the exact model boundary

```sh
jq '.context | {
  protocolVersion,
  codexVersion,
  model,
  modelProvider,
  workingDirectory,
  sandbox,
  approvalPolicy,
  baseInstructions,
  instructionSources,
  instructionPolicy,
  environmentKeys,
  dynamicToolNames,
  modelInputKinds,
  envelope
}' "$phase4_trace"
```

Confirm:

- `instructionSources` is empty;
- all three instruction-policy values are `false`;
- `modelInputKinds` contains only `text`;
- the semantic tools are `paperclip_finish` and `paperclip_block`;
- no environment **value** is present;
- the envelope contains only this safe task and its completion criteria.

Check that no control-plane route or bearer credential appears:

```sh
if rg -ni 'authorization: bearer|paperclip_api_key|/api/issues/' "$phase4_trace"; then
  echo "FAIL: forbidden control-plane context found"
  exit 1
fi
```

## Step 4: Inspect canonical events and replay

```sh
jq '[.events[].eventType] | group_by(.) | map({type: .[0], count: length})' \
  "$phase4_trace"
jq '.assertions' "$phase4_trace"
```

Confirm:

- session and turn lifecycle events exist;
- model, command/tool, usage, verification, result, and terminal events exist;
- `exactlyOneTerminalResult` is `true`;
- `liveReplayParity` is `true`;
- source sequence and item identity assertions are `true`.

The focused test suite supplies deterministic file-change and runtime-request
events because a real model may choose a shell command instead of a file patch
and may not need human input for this small task.

## Step 5: Try steering

Use a new directory:

```sh
phase4_steer_workspace="$(mktemp -d)"
pnpm --filter @paperclipai/paperclip-runner trace:phase4 -- \
  --working-directory "$phase4_steer_workspace" \
  --steer "Keep the answer short and verify the exact file text."
```

Confirm that the same driver and provider session IDs are printed and the task
still returns one result.

## Step 6: Try interruption

Use a new directory:

```sh
phase4_interrupt_workspace="$(mktemp -d)"
pnpm --filter @paperclipai/paperclip-runner trace:phase4 -- \
  --working-directory "$phase4_interrupt_workspace" \
  --interrupt
```

An interrupt can win before the file is created. That is expected. Confirm that
the trace still has one session identity, one semantic result, and one terminal
event. It must not create a replacement session.

## Step 7: Run the package verification path

```sh
pnpm --filter @paperclipai/paperclip-runner verify
```

This command is the package acceptance path. The real Codex example remains a
separate command because automated environments may not have a signed-in Codex
session.

## Step 8: Read the evidence

- [Phase 4 driver reference](../phase-04-skillless-codex-driver.md)
- [Phase 4 verification evidence](../../knowledge/evidence/2026-08-08-phase-04-verification.md)
- [Phase 4 journal](../../knowledge/journal/2026-08-08-phase-04.md)

Phase 5 is not part of this tutorial and remains uncreated.
