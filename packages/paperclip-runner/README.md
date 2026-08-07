# Paperclip Native Runner

This workspace is the standalone development boundary for Paperclip's native
runner protocol, harness drivers, and normalized session backends. Phase 0
contains a deterministic tracer and an in-memory mock control plane. It does not
import or start Paperclip's server, UI, CLI, or production database packages.

## Phase 0 quick start

From the repository root:

```sh
pnpm install --filter @paperclipai/paperclip-runner --lockfile=false --offline --ignore-scripts --dev
pnpm --filter @paperclipai/paperclip-runner verify
```

The tracer's final line is stable:

```json
{"schemaVersion":"paperclip.runner.phase0.output.v1","runIdentity":{"runId":"run_phase0_0001","sessionId":"session_phase0_0001"},"result":{"status":"succeeded","summary":"Standalone Phase 0 fixture accepted."}}
```

Run only the tracer with:

```sh
pnpm --filter @paperclipai/paperclip-runner trace:phase0
```

## Package-owned commands

| Command | Purpose |
|---|---|
| `build` | Compile the TypeScript public surface to `dist/`. |
| `typecheck` | Check the public surface without emitting files. |
| `test` | Run fixture, mock-contract, stable-output, and negative-boundary tests. |
| `check:forbidden-imports` | Reject imports or dependencies that cross into Paperclip core. |
| `docs:validate` | Validate local documentation links and the OKF v0.2 bundle. |
| `trace:phase0` | Build, start the mock core, replay the fixture, print the result, and exit. |
| `verify` | Run the complete Phase 0 acceptance sequence. |

## Navigate

- [Architecture and dependency boundary](docs/architecture.md)
- [Tutorial index](docs/index.md)
- [Phase 0 hand-run tutorial](docs/tutorials/phase-00-standalone-tracer.md)
- [Cumulative end-to-end tutorial](docs/tutorials/end-to-end.md)
- [Journal guide](docs/journal.md)
- [OKF knowledge bundle](knowledge/)
- [Implementation plan](spec/paperclip-native-runner-implementation-plan.md)
- [Normative spike specification](spec/paperclip-native-runner-spike-spec.md)

Phase 0 intentionally does not include a daemon, network transport, browser
runtime, production Paperclip adapter, or real model harness. Those layers remain
behind later phase checkpoints in the implementation plan.
