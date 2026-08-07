# Phase 3 Durable Transport and Recovery

Phase 3 adds a real outbound WebSocket path to the standalone package. The
Rust `paperclip-runnerd` process is the client. The TypeScript mock core is the
remote peer. Neither side imports Paperclip server, UI, database, or shared
control-plane code.

This is a local reliability proof. The mock uses `ws://127.0.0.1` so tests do
not need certificates. A production bridge must use `wss://` and remains a
later, separately reviewed phase.

## Connection and authentication

The connection starts in this order:

1. The mock core creates a random bootstrap ticket with a five-second lifetime.
2. The ticket is passed to the runner through
   `PAPERCLIP_RUNNER_BOOTSTRAP_TICKET`. It is not a command-line argument.
3. The runner opens an outbound WebSocket and sends the ticket in the HTTP
   `Authorization` header.
4. The runner sends a PRP v1 `hello` envelope. It names the stable runner and
   environment lease, approved runner version and digest, platform,
   capabilities, and durable resume cursors.
5. The mock core consumes the ticket once and sends a `welcome` envelope. The
   welcome selects PRP v1, returns a short-lived connection lease, reports the
   cumulative committed event cursor, and carries at most one pending command.
6. Later connections authenticate with the connection lease. A real runner
   process restart receives a new one-time bootstrap ticket and loads the same
   durable state before it connects.

The runner keeps the live connection lease token in memory only. Its state file
does not contain the bootstrap ticket or connection lease token. The mock core
persists only SHA-256 digests of those capabilities. A used or expired ticket is
rejected with `401`. The mock also rejects a changed runner identity, environment
lease, runner version, or runner digest.

The daemon captures and removes the bootstrap environment variable before it
parses arguments or starts child work. Secret buffers are overwritten when they
are dropped. It resolves the destination once before sending a bearer value and
accepts only concrete loopback addresses. Userinfo, query strings, fragments,
wildcards, private-network addresses, public addresses, and mixed DNS answers
fail closed.

## WebSocket limits

The package client implements the RFC 6455 upgrade and masked client text
frames with Node-free Rust standard-library code. The mock core validates the
upgrade and parses bounded masked frames.

- Maximum HTTP upgrade headers: 16 KiB.
- Maximum PRP frame: 1 MiB.
- Unknown frame opcodes and unmasked client frames close the connection.
- Malformed JSON is recorded as a bounded diagnostic. Durable state remains
  available for reconnect.
- WebSocket ping/pong and PRP diagnostic pong state are supported.

## Durable runner state

The runner writes `runner-state.json` below its private state directory. The
directory uses mode `0700` and the file uses mode `0600` on Unix. Every update
is written to an exclusive unpredictable sibling file, synchronized, atomically
renamed, and followed by a parent-directory sync. Symlinked directories or state
files, wrong ownership, and wrong modes fail closed.

The state contains:

- stable runner, environment lease, run, session, turn, and item IDs;
- next source event sequence and cumulative acknowledged source sequence;
- unacknowledged event envelopes and their byte counts;
- a processed-command cache with a non-secret command digest and prior result;
- lifecycle, reconnect, backpressure, harness generation, and recovery facts;
- bounded, redacted diagnostics.

Authentication capabilities and arbitrary command bodies are not stored. A
command is represented by an FNV-1a comparison digest, its stable ID and
controller sequence, the redacted result, and the logical-effect count.

## Event delivery and ACKs

The runner writes an event to the outbox before it sends the event. Event IDs
and source sequence numbers do not change after reconnect or restart.

The mock core commits or deduplicates an event before it sends this cumulative
ACK:

```json
{
  "kind": "ack",
  "payload": { "ackedSourceSeq": 9 }
}
```

The ACK means that every source event through sequence 9 is committed or
deduplicated. The runner rejects an ACK that moves backward or beyond its
produced source cursor. It removes only events at or below a valid ACK.

For the lost-ACK fault, the mock commits an event, drops the ACK and socket, and
reports the prior cursor once after reconnect. The runner sends the same bytes
again. The mock increments delivery count, keeps one logical event, and sends
the committed cumulative ACK.

## Command delivery and effects

Mock-core commands are durable before delivery. Only the lowest pending
controller sequence is sent. A command result advances the queue.

The runner stores a command result before it sends the result. When a result or
socket is lost, the same command is delivered again. An equal command ID and
digest returns the stored result. It does not add events or repeat a process
effect. Reusing the ID with different bytes is rejected.

The trace records `logicalEffectCount`. Every completed command has exactly one
logical effect. A policy rejection, such as a new turn during drain or storage
pressure, has zero effects.

## Restart and reconciliation

A socket drop keeps the same Rust process and in-memory lease. The process
reconnects and reloads the mock-core command and event cursor.

A runner restart kills the real Rust process with unacknowledged work. A new
Rust process receives a fresh ticket, reads the same state file, emits a P0
`runner.reconciled` event, and continues the same runner, session, turn, item,
command, and source-event identities.

The harness-restart fault starts the real Phase 2 `fake-harness` child, waits
for its ready message, terminates its process group, and starts a second child.
The runner then emits `harness.exited`, `harness.ready`, and
`session.reconciled` events with the same normalized session, turn, and item
IDs.

If a lease expires, reconnect fails closed. The runner records
`lease_expired_requires_bootstrap` and exits with its state intact. The mock
then gives the replacement runner a fresh ticket. Recovery continues from the
same cursor.

If recovery cannot be truthful, state names the outcome. For example, failure
to reserve storage for a P0 event records `p0_storage_exhausted` and the
`unrecoverable` lifecycle. It never reports a fresh session as resumed.

## Backpressure and bounded storage

The runner has a byte limit and a reserved P0 region.

- P2 item deltas coalesce before delivery.
- P1 events cannot consume the P0 reserve.
- New turns are rejected while backpressure is active.
- A P0 `runner.backpressure` event explains the state.
- P0 events are never dropped to make room.
- The state records peak outbox bytes so the final empty outbox does not hide a
  limit violation.

The storage-pressure trace emits 250 P2 updates. They become one coalesced
event, all P0 facts reach the mock core, peak bytes remain below the configured
limit, and the next turn is rejected without an effect.

## Drain and revoke

`runner.drain` persists the `draining` lifecycle and a P0
`runner.draining` event. It rejects later `turn.start` commands but continues to
deliver the existing outbox. `runner.shutdown` stops only after the outbox is
acknowledged.

A `revoke` envelope persists the `revoked` lifecycle. The runner flushes any
existing durable events and exits. It does not accept new work or delete
unacknowledged facts.

## Diagnostics

Run a fault and print operator-safe diagnostics:

```sh
pnpm --filter @paperclipai/paperclip-runner trace:phase3 -- --fault lost-ack
```

Supported fault names are:

```text
none
socket-drop
lost-ack
duplicate-command
runner-restart
harness-restart
malformed-input
lease-expiry
storage-pressure
drain
revoke
```

Use `--json` for the complete trace or `--output <path>` to write it. The CLI
and browser show connection counts, safe lease ID and expiry, stable identities,
source and ACK cursors, outbox current/peak bytes, command delivery/effect
counts, replay counts, restart counts, outcomes, and redaction assertions.

They never show bootstrap tickets or connection lease tokens.

Regenerate the checked fault matrix and every exact per-fault trace with:

```sh
pnpm --filter @paperclipai/paperclip-runner record:phase3
```
