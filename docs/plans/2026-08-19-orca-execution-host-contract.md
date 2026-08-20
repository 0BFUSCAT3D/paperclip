# Orca execution-host contract

Status: **blocked pending an upstream Orca host protocol**

Paperclip audit base: `699c94c3d187c2b5056403ea6af45a60ba69a7dc`

Orca audit base: [`a76a95d111a2b32ae14a455e27d9701725d7c559`](https://github.com/stablyai/orca/tree/a76a95d111a2b32ae14a455e27d9701725d7c559)

## Decision

Orca is not currently a selectable Paperclip execution host. Paperclip must not
register an Orca adapter, expose an Orca profile or capability, invoke Orca's
terminal or orchestration commands, or mutate an Orca workspace until the host
contract below exists and passes the acceptance matrix.

Claude and Codex remain the provider adapters. Orca may later sit underneath
their execution target as an orthogonal process host. Paperclip remains the sole
authority for issues, routing, assignment, review, approval, retries, workspace
lifecycle, run state, and reconciliation.

An unavailable Orca host must fail before workspace acquisition, filesystem or
network mutation, credential access, or child creation as:

```text
ConfigurationIncomplete
subscription_environment_unsupported
retry: false
```

## Why the current Orca surface is insufficient

The public terminal-create command exposes a worktree, command, title, and
presentation options, but not the exact argument vector, environment additions
and deletions, immutable profile fingerprint, or subscription-auth attestation
Paperclip must bind to a run. See Orca's
[`terminal create` handler](https://github.com/stablyai/orca/blob/a76a95d111a2b32ae14a455e27d9701725d7c559/src/cli/handlers/terminal.ts#L152-L174)
and [CLI help](https://github.com/stablyai/orca/blob/a76a95d111a2b32ae14a455e27d9701725d7c559/src/cli/help.ts#L236-L255).

Orca's private runtime RPC contains additional launch fields, but it is not a
versioned public host boundary. Its create request also lacks Paperclip company,
agent, run, attempt, profile, and billing-policy identities. See
[`RuntimeCreateAgentSessionRequest`](https://github.com/stablyai/orca/blob/a76a95d111a2b32ae14a455e27d9701725d7c559/src/shared/agent-session-host-authority.ts#L122-L140)
and the private
[`terminal.createAgentSession` registration](https://github.com/stablyai/orca/blob/a76a95d111a2b32ae14a455e27d9701725d7c559/src/main/runtime/rpc/methods/agent-session.ts#L236-L256)
and
[`createAgentSession` implementation](https://github.com/stablyai/orca/blob/a76a95d111a2b32ae14a455e27d9701725d7c559/src/main/runtime/orca-runtime.ts#L27770-L27993).

The runtime uses a user-wide control credential for a broad RPC surface that
also owns Orca task and dispatch state. A child running as the same operating
system user can recover that credential, so adapter-side method allowlisting is
not a tenant or lifecycle boundary. See Orca's
[`runtime-rpc` authentication](https://github.com/stablyai/orca/blob/a76a95d111a2b32ae14a455e27d9701725d7c559/src/main/runtime/runtime-rpc.ts#L1586-L1607)
and
[`orchestration` mutation methods](https://github.com/stablyai/orca/blob/a76a95d111a2b32ae14a455e27d9701725d7c559/src/main/runtime/rpc/methods/orchestration.ts#L1475-L1517).

Provider launches also incorporate mutable Orca-wide command, argument,
environment, and account defaults after Paperclip would have frozen its agent
profile. Claude and Codex account selection may fall back to host-global state,
and Orca's readiness checks are credential-presence checks rather than
Paperclip's final merged-environment subscription classification. See
[`orca-runtime` launch resolution](https://github.com/stablyai/orca/blob/a76a95d111a2b32ae14a455e27d9701725d7c559/src/main/runtime/orca-runtime.ts#L27873-L27905),
[`runtime-auth-service`](https://github.com/stablyai/orca/blob/a76a95d111a2b32ae14a455e27d9701725d7c559/src/main/claude-accounts/runtime-auth-service.ts#L604-L671),
and
[`runtime-home-service`](https://github.com/stablyai/orca/blob/a76a95d111a2b32ae14a455e27d9701725d7c559/src/main/codex-accounts/runtime-home-service.ts#L237-L278).

Finally, Orca permits startup directories outside its worktree and keeps create
idempotency in process memory. A lost response followed by a runtime restart can
therefore duplicate a provider process, while terminal output and status are not
an authenticated Paperclip run receipt. See
[`terminal-startup-cwd`](https://github.com/stablyai/orca/blob/a76a95d111a2b32ae14a455e27d9701725d7c559/src/shared/terminal-startup-cwd.ts#L13-L40)
and the runtime's
[`agentSessionCreateOperations` ledger](https://github.com/stablyai/orca/blob/a76a95d111a2b32ae14a455e27d9701725d7c559/src/main/runtime/orca-runtime.ts#L3628-L3634)
and
[`createAgentSession` replay behavior](https://github.com/stablyai/orca/blob/a76a95d111a2b32ae14a455e27d9701725d7c559/src/main/runtime/orca-runtime.ts#L27785-L27989).

These constraints are stricter than general CLI usability because Paperclip's
subscription policy is intentionally local-only, pre-spawn, and fail-closed.
See [`subscription-billing-policy.ts`](../../packages/adapter-utils/src/subscription-billing-policy.ts)
and the [Claude](../adapters/claude-local.md) and
[Codex](../adapters/codex-local.md) adapter contracts.

## Required upstream protocol

Orca must expose a versioned, fail-closed host protocol with only these methods:

```text
execution.start
execution.status
execution.events
execution.cancel
```

Raw terminal creation, terminal keystrokes, Orca orchestration, automation,
mailbox, task, approval, and workspace-creation fallbacks are forbidden.

### Immutable lease

Every request and receipt must bind:

```text
companyId
 agentId
 issueId
 paperclipRunId
 attempt
 adapterType
 profileId
 profileRevision
 providerAccountId
 authPrincipalFingerprint
 credentialLeaseRevision
 billingPolicy = subscription_only
 executionWorkspaceId
 workspaceLeaseRevision
 canonicalWorkspaceRoot
 promptDigest
 resolvedModel
 deadline
 executionHostId
 hostPublicKeyFingerprint
 transportSecurityVersion
 expectedHostIncarnation
 dispatchFingerprint
 hostCapabilityFingerprint
```

Changed replay data must conflict. Exact replay data must return the same
durable execution identity without spawning again.

### Authority and isolation

- The host credential must authorize only the bound execution methods and
  lease. Its audience must bind the exact execution host, public key or
  certificate fingerprint, transport-security version, and host incarnation.
  It must not list, read, send to, cancel, or mutate other executions.
- The credential and Orca's administrative token must be unavailable to the
  provider child.
- Status, event, cancellation, and receipt frames must be authenticated by the
  pinned host identity. Ambient `ORCA_*`, saved environment, pairing, route,
  host, or fallback selection must not redirect a lease.
- Isolation must be at least per company operating-system identity or container;
  per-run/profile isolation is preferred.
- Paperclip alone changes task, issue, review, approval, and lifecycle state.
- The host must adopt the exact Paperclip-issued workspace. It must not create
  another worktree, run setup hooks, or delete/finalize the workspace.
- The immutable workspace ID and lease revision must still identify the same
  worktree at the canonical root; path reuse or replacement is a conflict.
- `realpath` confinement, symlink checks, and the exact Paperclip workspace
  grant must be revalidated immediately before spawn.

### Subscription and launch boundary

Immediately before provider spawn, the execution host must:

- use the immutable executable, argument vector, working directory, environment
  map, environment-deletion set, stdin framing, timeout, and profile revision
  supplied by Paperclip;
- disable Orca command, argument, environment, model, and account substitution;
- enforce the same final-environment/provider/config/executable subscription
  policy as the authoritative Claude or Codex adapter;
- securely resolve the exact bound provider account and auth principal, then
  copy the checked credential material into a private per-run auth root whose
  non-secret snapshot fingerprint and revision are bound to the lease;
- make every other system, ambient, shared, or profile auth root inaccessible
  to the child and fail if credentials changed after admission;
- discard the run auth snapshot without copying child-writable credentials back
  into the shared host profile. Any refresh must be a separate broker operation
  using compare-and-swap on exact profile, account, and expected credential
  revision; otherwise it fails closed;
- forbid API-key, custom-provider, custom-command, system-account, ACP, SSH,
  sandbox, paired-runtime, and remote fallback;
- pass the prompt through a private framed stdin or file descriptor, never
  process arguments or PTY keystrokes.

### Durable reconciliation

- Spawn intent and the execution identity must commit atomically.
- Idempotency and replay tombstones must survive Orca restart.
- Host identity, signing key, transport version, and incarnation are immutable
  for a running lease. Key rotation or a different incarnation requires an
  explicit reconciliation result; it must not transparently adopt the run.
- Events must have monotonically increasing sequence numbers, resumable cursors,
  bounded payloads, and heartbeats.
- Cancel must match company, run, attempt, host incarnation, and execution
  identity; stale or cross-tenant cancellation must fail.
- Unknown or mismatched state must reconcile or quarantine. It must never
  dispatch another process as a recovery shortcut.

### Structured receipt

The signed final receipt must contain at least:

- protocol and host capability versions;
- host/runtime incarnation and durable execution identity;
- execution-host identity, signing-key fingerprint, and transport-security
  version;
- company, agent, issue, run, and attempt binding;
- dispatch, executable, profile, provider-account, auth-principal,
  credential-lease, and subscription-policy fingerprints;
- execution-workspace ID, lease revision, and canonical workspace identity;
- resolved provider, model, and non-secret subscription evidence;
- start/end timestamps, exit/cancel/timeout state, signal, and output digest.

PTY text, OSC control data, or a terminal status flag cannot manufacture or
replace this receipt.

## Acceptance matrix

No Paperclip consumer may ship until tests prove all of the following:

- cross-company and cross-run list/read/send/cancel requests are denied;
- the provider child cannot recover an Orca control credential or invoke
  orchestration/settings/worktree APIs;
- missing, stale, switched, or unsupported profiles fail before spawn;
- account switches after admission, credential replacement without a profile
  revision, stale refreshes, and cross-profile/run auth access or writeback fail;
- API-key, provider, proxy, custom-CA, TLS, loader, shell, command, and account
  injections fail at the final host boundary;
- absolute, parent-relative, symlink, and post-check workspace escapes fail;
- workspace path reuse, worktree replacement, or lease-revision drift conflicts
  instead of being adopted;
- lost response plus host restart results in exactly one provider process;
- exact replay returns the original execution and changed replay conflicts;
- wrong company, attempt, host incarnation, or execution cancellation fails;
- wrong-host/same-capability routing, unapproved key rotation, route drift,
  replay, and reconnect to a different host incarnation fail;
- reconnect to the exact pinned host resumes the event cursor without duplicate
  dispatch;
- spoofed PTY output and OSC status cannot create a completion receipt;
- unregister and cancellation never delete or finalize Paperclip's workspace.

## Paperclip consumer sequence

Only after the upstream protocol is versioned and frozen may Paperclip add:

1. A typed execution-host capability and stable capability fingerprint.
2. An immutable execution-host binding on the Paperclip run/profile snapshot.
3. A local host client with fake-host contract tests.
4. Heartbeat preflight, start, event, cancellation, and reconciliation support.
5. Fail-closed availability for missing or mismatched Orca versions.

An Orca adapter registration, agent field, route, database migration, UI
selector, executable probe, or workspace mutation before that sequence would
advertise a guarantee the current runtime cannot provide.
