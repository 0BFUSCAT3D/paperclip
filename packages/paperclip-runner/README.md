# Paperclip Native Runner

This workspace is the standalone development boundary for Paperclip's native
runner protocol, harness drivers, and normalized session backends. The
production runner direction is Rust; `runner/` is its Cargo workspace. The
TypeScript surface remains a control-plane/client reference implementation.
Phase 0 runs both implementations against one language-neutral fixture without
importing or starting Paperclip's server, UI, CLI, or production database.

## Phase 0 quick start

From the repository root:

```sh
pnpm install --filter @paperclipai/paperclip-runner --lockfile=false --offline --ignore-scripts --dev
pnpm --filter @paperclipai/paperclip-runner verify
```

The verification command requires a stable Rust toolchain with `cargo` on
`PATH`, in addition to Node.js 20+ and pnpm 9+.

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
| `build` | Compile the TypeScript public surface and Rust workspace. |
| `typecheck` | Check both language surfaces without a release build. |
| `test` | Run Rust/TypeScript fixture, mock-contract, stable-output, and negative-boundary tests. |
| `check:forbidden-imports` | Reject TypeScript imports and Cargo path dependencies that cross into Paperclip core. |
| `check:phase0-parity` | Require byte-for-byte equivalent Rust and TypeScript tracer output. |
| `docs:validate` | Validate local documentation links and the OKF v0.2 bundle. |
| `trace:phase0` | Run the Rust mock-core tracer, print the stable result, and exit. |
| `trace:phase0:typescript` | Run the TypeScript reference tracer directly. |
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

Phase 0 establishes `runner-core`, not the `paperclip-runnerd` daemon. Network
transport, process supervision, browser runtime, production Paperclip adapter,
and real model harnesses remain behind later phase checkpoints in the
implementation plan.
