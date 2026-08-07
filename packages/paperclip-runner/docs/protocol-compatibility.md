# PRP Compatibility and Versioning Policy

## Authority

The JSON Schema files in [`protocol/schemas/`](../protocol/schemas/) are the
language-neutral source of truth for the Phase 1 executable contract. The
generated TypeScript schema module is checked against those files before every
TypeScript typecheck. Rust consumes the same fixtures and must produce the same
golden parity summaries.

The broader normative protocol remains the
[native-runner spike specification](../spec/paperclip-native-runner-spike-spec.md).
Phase 1 intentionally implements only validation and static replay; it does not
add transport, persistence, or live control-plane behavior.

## Version fields

| Field | Phase 1 support | Compatibility rule |
|---|---:|---|
| `protocolVersion` | `1` | Required. Negotiate the highest overlapping version; no overlap fails closed. |
| `fixtureVersion` | `1` | Required by the conformance corpus. Unknown values fail closed. |
| `event.schemaVersion` | `1` | Required on every event. Unknown values fail closed before reduction. |
| Typed `schema` discriminators | `*.v1` | Required. Unknown required schema identities fail JSON Schema validation. |

Wire protocol versions and fixture-corpus versions are independent. A fixture
format can evolve without changing PRP, and a future PRP version can be
represented only after the consumer advertises support for it.

## Forward compatibility

- Unknown object properties are accepted and preserved by validation. Reducers
  ignore fields they do not understand until a later schema version gives those
  fields defined behavior.
- Unknown required versions, schema discriminators, enum values, and required
  fields fail closed. A consumer must never guess at their semantics.
- Scripted fixtures bind every event to the fixture run/session, require
  contiguous controller command order, exactly one unique proposed result, and
  exactly one unique terminal event.
- The top-level fixture result must equal the `run.result.proposed` payload after
  canonical key ordering. Repeated `sourceEventId` deliveries must be
  byte-equivalent after the same normalization.

The forward-compatibility fixture proves that optional fields survive validation
without changing the v1 snapshot. The unsupported-version fixture proves that a
required v2 protocol cannot be replayed by this consumer.

## Replay semantics

- Events are applied in fixture order and ordered independently by
  `(sourceKind, sourceInstanceId, sourceSeq)`.
- A repeated source event ID has no second projection effect.
- A forward source-sequence gap is recorded explicitly; the reducer never
  invents a missing event.
- An event at or behind the committed source cursor is ignored and recorded as
  out of order.
- Replaying an already-applied batch leaves the snapshot unchanged.

The CLI and browser import the same `replayPhase1FixtureText` function, so
validation, compatibility errors, and final snapshots cannot drift between the
two surfaces.

## Change policy

1. Change JSON Schema first.
2. Regenerate the TypeScript schema module.
3. Add or revise a shared fixture and its golden snapshot/summary.
4. Prove TypeScript and Rust parity.
5. Update this policy and the normative spike specification when behavior
   changes.

Breaking changes require a new required version. Additive optional fields may
remain in v1 only when old consumers can safely ignore them.
