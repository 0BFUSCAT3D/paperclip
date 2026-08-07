# Architecture and Standalone Boundary

## Dependency direction

```text
protocol fixture
      |
      v
fixture validator --> runner contracts <-- mock control-plane adapter
                              |
                              v
                       Phase 0 tracer

Paperclip core (later) --> implements ControlPlanePort / NativeSessionBackend
```

The dependency arrow always points from an implementation toward a contract.
The standalone package does not reach backward into a Paperclip implementation.

## Initial contracts

- `ControlPlanePort` is the narrow surface through which a runner opens a run,
  appends ordered events, and submits a terminal structured result.
- `HarnessDriver` owns a local harness session and its provider-specific
  identity, event, turn, snapshot, and close behavior.
- `NativeSessionBackend` normalizes local runner and hosted-provider sessions for
  a future control-plane consumer. Environment placement is not implied by the
  backend type.

The Phase 0 contracts are deliberately sketches: they name responsibility and
dependency direction without prematurely implementing the Phase 1 protocol or
the Phase 2 runner daemon.

## Allowed dependencies

- Node.js standard-library modules.
- Third-party packages declared by this workspace when a later phase needs them.
- Files within `packages/paperclip-runner/`.
- A future explicit generated-schema package only after architecture review and
  an allowlist change in the boundary checker.

## Forbidden dependencies

The following imports and package dependencies are rejected:

- `server/`, `ui/`, and `cli/` implementation paths;
- `@paperclipai/db` and production database schema or client modules;
- `@paperclipai/shared`, adapter utilities, and other Paperclip workspace
  internals unless a later boundary review explicitly allows a public contract;
- relative or absolute imports that escape `packages/paperclip-runner/`.

This rule applies to type-only imports, exports, dynamic imports, and CommonJS
`require` calls. The negative fixture at
`test-fixtures/forbidden-import/core-import.ts` intentionally imports a server
module and must fail the checker.

## Enforcement

```sh
pnpm --filter @paperclipai/paperclip-runner check:forbidden-imports
pnpm --filter @paperclipai/paperclip-runner test
```

The first command scans the package source, scripts, and manifest. The test
command additionally asserts that the negative fixture is rejected. The normal
scan excludes that fixture so a deliberate proof does not make the package fail.

## Phase 0 process boundary

The mock core is an in-memory adapter, not a Paperclip server. Starting it only
changes local object state. The tracer performs this sequence:

1. load and validate `protocol/fixtures/phase-00-minimal-run.json`;
2. start the mock adapter;
3. open the fixture run through `ControlPlanePort`;
4. append contiguous typed events;
5. submit the matching terminal result;
6. print a stable JSON identity/result and stop the adapter.

No socket, database, browser, Paperclip process, or model process is started.

## Future integration rule

The [implementation plan](../spec/paperclip-native-runner-implementation-plan.md)
keeps production integration in a separately reviewed phase. Paperclip core may
implement these contracts later, but this package must remain independently
buildable, testable, and runnable against the mock adapter.
