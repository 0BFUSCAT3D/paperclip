# Paperclip Native Runner

This workspace is the standalone development boundary for Paperclip's native
runner protocol, harness drivers, and normalized session backends. The
production runner direction is Rust; `runner/` is its Cargo workspace. The
TypeScript surface remains a control-plane/client reference implementation.
Phase 0 runs both implementations against one language-neutral fixture. Phase 1
adds executable PRP schemas, a cross-language conformance corpus, deterministic
static replay, and a standalone browser reference page. Neither phase imports or
starts Paperclip's server, UI, CLI, or production database.

## Phase 0–1 quick start

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

Replay the Phase 1 happy path in the CLI or open the browser devtool:

```sh
pnpm --filter @paperclipai/paperclip-runner replay:phase1
pnpm --filter @paperclipai/paperclip-runner browser:dev --host 127.0.0.1 --port 4179
```

## Package-owned commands

| Command | Purpose |
|---|---|
| `build` | Compile the TypeScript public surface, Rust workspace, and browser replay. |
| `typecheck` | Check TypeScript, Rust, generated schema sources, and browser types. |
| `test` | Run Rust/TypeScript fixture, mock-contract, stable-output, and negative-boundary tests. |
| `check:forbidden-imports` | Reject TypeScript imports and Cargo path dependencies that cross into Paperclip core. |
| `check:phase0-parity` | Require byte-for-byte equivalent Rust and TypeScript tracer output. |
| `check:phase1-goldens` | Require all reducer snapshots and cross-language summaries to match checked goldens. |
| `check:phase1-parity` | Run TypeScript and Rust against the same Phase 1 fixture summaries. |
| `check:browser-tokens` | Reject component-local visual literals and require the standalone token layer. |
| `docs:validate` | Validate local documentation links and the OKF v0.2 bundle. |
| `trace:phase0` | Run the Rust mock-core tracer, print the stable result, and exit. |
| `trace:phase0:typescript` | Run the TypeScript reference tracer directly. |
| `replay:phase1` | Validate and reduce a fixture to a final snapshot. |
| `browser:dev` | Open the editable fixture/static replay reference page. |
| `test:browser` | Build the browser page, exercise replay states, and capture the screenshot. |
| `verify` | Run the complete Phase 0 and Phase 1 acceptance sequence. |

## Navigate

- [Architecture and dependency boundary](docs/architecture.md)
- [Tutorial index](docs/index.md)
- [Phase 0 hand-run tutorial](docs/tutorials/phase-00-standalone-tracer.md)
- [Phase 1 hand-run tutorial](docs/tutorials/phase-01-static-replay.md)
- [PRP compatibility/versioning policy](docs/protocol-compatibility.md)
- [Cumulative end-to-end tutorial](docs/tutorials/end-to-end.md)
- [Journal guide](docs/journal.md)
- [OKF knowledge bundle](knowledge/)
- [Implementation plan](spec/paperclip-native-runner-implementation-plan.md)
- [Normative spike specification](spec/paperclip-native-runner-spike-spec.md)

Phase 1 remains a static replay checkpoint, not the `paperclip-runnerd` daemon.
Network transport, process supervision, live browser transport, production
Paperclip integration, and real model harnesses remain behind later phase
checkpoints in the implementation plan.
