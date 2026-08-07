# Phase 0: Run the Standalone Tracer

## Outcome

You will install only the runner workspace's declared tools, compile it, run its
tests and static checks, start the in-memory mock core, validate the minimal
fixture, print a deterministic result, and return to the shell. Paperclip itself
does not start.

## Prerequisites

- repository checkout on the assigned runner branch;
- Node.js 20 or newer;
- pnpm 9 or newer;
- commands run from the repository root.

## 1. Install the package tools

```sh
pnpm install --filter @paperclipai/paperclip-runner --lockfile=false --offline --ignore-scripts --dev
```

`--lockfile=false` follows this repository's policy that automation owns the
root lockfile. `--offline` proves Phase 0 needs no newly downloaded package.
`--dev` makes the package tooling explicit even when the calling shell has
`NODE_ENV=production`.

## 2. Build the standalone package

```sh
pnpm --filter @paperclipai/paperclip-runner build
```

Expected result: TypeScript exits with status 0 and writes package-local `dist/`
files.

## 3. Run the behavior and boundary tests

```sh
pnpm --filter @paperclipai/paperclip-runner test
pnpm --filter @paperclipai/paperclip-runner check:forbidden-imports
```

The tests cover fixture validation, the complete mock `ControlPlanePort` path,
stable output, and a negative core-import fixture. The standalone boundary check
must print `Standalone boundary check passed.`

## 4. Validate the documentation and OKF bundle

```sh
pnpm --filter @paperclipai/paperclip-runner docs:validate
```

Expected result: both documentation-link validation and OKF v0.2 validation
pass. The OKF validator checks concept frontmatter, typed journal fields, log
dates, the root version declaration, and index coverage.

## 5. Run the tracer

```sh
pnpm --filter @paperclipai/paperclip-runner trace:phase0
```

Expected final line:

```json
{"schemaVersion":"paperclip.runner.phase0.output.v1","runIdentity":{"runId":"run_phase0_0001","sessionId":"session_phase0_0001"},"result":{"status":"succeeded","summary":"Standalone Phase 0 fixture accepted."}}
```

The command exits successfully after the mock core stops. No service remains
running.

## 6. Inspect and query the journal

```sh
sed -n '1,240p' packages/paperclip-runner/knowledge/journal/2026-08-07-phase-00.md
rg -l '^type: Engineering Journal Entry$' packages/paperclip-runner/knowledge
```

For more query and authoring examples, see the [journal guide](../journal.md).

## One-command rerun

After installation, the same checks can be repeated with:

```sh
pnpm --filter @paperclipai/paperclip-runner verify
```

Continue with the [cumulative end-to-end tutorial](end-to-end.md), which points
to this tutorial as the current complete path.
