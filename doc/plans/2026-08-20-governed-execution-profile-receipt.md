# Governed execution profile receipt

## Goal

Paperclip must bind a governed issue activation to the exact subscription-only execution profile that it queues. The server must reject profile drift before it starts a provider process. The activation receipt must give clients non-secret evidence for the run, agent revision, issue assignee revision, adapter policy, instruction digest, and opaque authentication authority.

Version 1 remains available for existing clients. Version 2 uses separate request schemas and endpoints. A client may claim immutable execution evidence only after it negotiates version 2 and validates the complete receipt.

## Phase 0: existing server contracts

The implementation uses these checked-in APIs and storage contracts:

- `packages/shared/src/validators/issue.ts` owns the strict governed reservation and activation request schemas.
- `server/src/services/governed-issue-contract.ts` writes the issue compare-and-set, wake request, heartbeat run, and activation receipt references in one database transaction.
- `packages/db/src/schema/agents.ts` exposes `executionProfileRevision`. Migration 0228 increments it when execution-relevant agent fields change.
- `packages/db/src/schema/issues.ts` exposes `assigneeProfileRevision`. Migration 0228 increments it when the assignee or assignee overrides change.
- `packages/db/src/schema/heartbeat_run_execution_profiles.ts` stores one append-only execution profile per heartbeat run. Migration 0228 checks current revisions for fresh bindings and preserves authority for bounded recovery transitions.
- `server/src/services/heartbeat.ts` resolves the final adapter configuration and secret manifest before adapter execution.
- `ServerAdapterModule.inspectSubscriptionAuthAuthority` supports `inspect` and `prepare` modes. The server registry supplies the opaque signer and rejects malformed proof shapes.
- Claude accepts only an exact resolved owner user-secret version. Codex accepts only the current per-agent managed ChatGPT profile.
- `PreparedSubscriptionAuthAuthority` gives an adapter opaque launch material through `apply` and `dispose`. Server code must not inspect the material.

The server must not invent a second billing classifier, expose secret values, accept a host Claude login as immutable authority, or treat the agent revision alone as authentication evidence.

## Phase 1: version 2 request and capability contracts

Add strict version 2 schemas for reservation and activation. The reservation request carries the builder and every agent execution-policy participant as an exact `{agentId, executionProfileRevision}` set. The activation request repeats that set and the builder revision.

Add version 2 routes under `/api/v2/companies/{companyId}/governed-issue-reservations`. Keep the version 1 routes and response unchanged.

Advertise version 2 only after the routes, transaction, sidecar, and pre-spawn verification are live. The capability descriptor must state:

- exact participant revision compare-and-set;
- one immutable run sidecar written in the activation transaction;
- subscription-only built-in local CLI adapters;
- opaque authentication authority;
- instruction content digest binding;
- pre-spawn proof and profile revalidation;
- no support for native host Claude login.

Verification:

- strict schema tests reject missing, duplicate, unordered, unsafe, or cross-intent participant revisions;
- capability and OpenAPI tests expose only implemented fields;
- version 1 contract tests remain unchanged.

## Phase 2: queue-time binding service

Create a server-owned execution profile service. For a fresh governed run it must:

1. lock the agent, issue, and governed reservation rows;
2. compare the requested builder and participant revisions to current agent revisions;
3. perform the issue assignment and capture the new `assigneeProfileRevision`;
4. construct a non-secret execution projection from the exact built-in adapter identity, subscription billing capability, normalized agent profile, issue overrides, selected local environment, project environment policy, and instruction file digest;
5. resolve the selected authentication source and call the active built-in adapter inspector in `inspect` mode;
6. insert the heartbeat run and its immutable sidecar in the same transaction;
7. include the sidecar digest and opaque authority proof in the durable activation receipt.

The activation intent hash must include the contract version, builder revision, complete participant revision set, projection digest, authority fingerprint, and issue envelope digest. A replay with any different value must return a conflict.

For Claude, extend the runtime secret manifest with the concrete secret-version row ID. The binding service must select the fixed OAuth user-secret entry by exact config path and version. For Codex, select the canonical per-agent managed profile path.

Verification:

- activation rejects stale builder and reviewer revisions before issue assignment;
- adapter override, non-local environment, project credential overlay, external adapter override, or missing authority rejects with zero runnable run;
- one transaction contains the issue change, wake, run, sidecar, and receipt pointers;
- replay returns the same run and sidecar receipt;
- the receipt contains no secret value, path, token, or account identifier.

## Phase 3: pre-spawn authority preparation

Before `adapter.execute`, load the run sidecar and recompute the bound projection from current rows and instruction bytes. Seal the exact validated UTF-8 instruction bytes in memory so the adapter cannot reopen a replaced pathname after verification. Resolve the exact authentication source and call the adapter inspector in `prepare` mode. Compare the returned proof to the stored authority proof and compare every profile revision and digest.

Pass the prepared authority object to `adapter.execute`. Dispose it on every success or failure path. A mismatch must fail the run before `onSpawn` and before the provider process exists.

Runs for subscription-only adapters must fail closed when they lack a sidecar. Version 1 governed runs remain usable only as the existing non-attested contract and cannot satisfy the version 2 receipt capability.

Verification:

- agent profile, issue override, instruction bytes, project environment, managed Codex identity, and Claude secret-version changes all stop before spawn;
- replacing the instruction pathname after preparation does not change the bytes launched by Claude or Codex;
- an exact match starts once and uses the prepared authority;
- adapter failure and setup failure dispose prepared material;
- terminal and replay reads return the original immutable receipt.

## Phase 4: later policy stages and recovery

Route reviewer and other agent-stage wakes through the same fresh binding service. A new stage captures the assigned agent's current revision and fresh authority. Process-loss and deferred-promotion retries copy the parent sidecar through the database-preserve contract. Other retries create a fresh binding and must pass current policy checks.

The scheduler must refuse to start any subscription-only run without the required sidecar. Crash recovery may finish a durable queue transaction or mark the run blocked, but it must not create authority after a provider process has started.

Verification:

- builder completion followed by reviewer assignment creates a new sidecar for the reviewer run;
- preserved retries retain the exact parent authority fingerprint and projection digest;
- fresh retries bind current revisions;
- a missing or conflicting sidecar never spawns.

## Phase 5: Reeve client adoption

Reeve must parse positive safe agent revisions. Its native execution profile preparation returns the exact builder and reviewer revisions instead of `void`.

Work filing sends the participant revision set in the version 2 reservation and activation requests. Reeve validates the version 2 capability and the complete receipt, including the builder revision, issue assignee revision, run ID, sidecar digest, adapter policy, instruction digest, and opaque authority fields. The local idempotency intent includes those revisions.

Reeve keeps its compatibility gateway and the version 1 native parser separate. It must not treat either path as immutable subscription execution evidence.

Verification:

- revision drift between prepare, reserve, and activation fails closed;
- lost responses replay the same version 2 intent and receipt;
- capability downgrade cannot redirect a stored version 2 intent;
- strict parsers reject extra, missing, cross-company, or non-finite receipt fields;
- a real local Codex run proves queue receipt, pre-spawn authority match, and one provider process.

## Final release gate

Run database migration tests, server route and heartbeat tests, adapter authority tests, Reeve focused tests, both repositories' type checks, and both full verification suites. Pin Reeve to the merged Paperclip commit only after the Paperclip PR passes review and CI.

The public documentation may call the lane immutable only when the live capability response and receipt prove version 2. Any older engine or missing sidecar must produce a fixed unsupported or held state.
