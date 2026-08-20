---
title: Codex
summary: OpenAI Codex local adapter setup and configuration
---

The `codex_local` adapter runs OpenAI's Codex CLI locally. It supports session persistence via `previous_response_id` chaining and skills injection through the global Codex skills directory.

## Prerequisites

- Codex CLI installed (`codex` command available)
- Either a host Codex login with `~/.codex/auth.json`, or a per-agent
  `OPENAI_API_KEY` configured in adapter env (Paperclip materializes this into
  `$CODEX_HOME/auth.json` for managed homes; Codex CLI reads credentials from
  `auth.json`, not directly from the process environment — for a self-managed
  external `CODEX_HOME`, write `auth.json` there directly instead)

## Configuration Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `cwd` | string | Yes | Working directory for the agent process (absolute path; created automatically if missing when permissions allow) |
| `model` | string | No | Model to use |
| `promptTemplate` | string | No | Prompt used for all runs |
| `env` | object | No | Environment variables (supports secret refs) |
| `billingPolicy` | string | No | Set exactly to `subscription_only` for the fail-closed local subscription lane described below |
| `timeoutSec` | number | No | Process timeout (0 = no timeout) |
| `graceSec` | number | No | Grace period before force-kill |
| `fastMode` | boolean | No | Enables Codex Fast mode. Currently supported on `gpt-5.4` only and burns credits faster |
| `dangerouslyBypassApprovalsAndSandbox` | boolean | No | Skip safety checks (dev only) |

## Subscription-only billing policy

`billingPolicy: "subscription_only"` is an opt-in, local-CLI-only policy. Explicit ACP and every remote, sandbox, or container target fail with `subscription_environment_unsupported`; `engine: "auto"` selects CLI. Test Environment applies the same preflight before any live hello probe.

The preflight accepts only a securely read regular `auth.json` owned by the current user, mode `0600`, at most 64 KiB, with explicit `auth_mode: "chatgpt"` and the current account/token shape. API-key auth, `OPENAI_*`/Codex auth variables, provider routing, custom commands/arguments, external or sibling-agent `CODEX_HOME`, loader/shell injection, proxy/custom-CA/TLS interception, unsafe `config.toml`, and every workspace ancestor `.codex/config.toml` are rejected. Execution seeds the current agent's canonical managed home, copies the verified credential into a private per-run `0700` home with a regular `0600` auth file, loads only Paperclip's generated config from that home, and ignores project rules.

The private run credential is always discarded at teardown and is never copied back to the authoritative host login. An agent process runs as the same OS user and can rewrite its snapshot, so Paperclip cannot authenticate a purported in-run token refresh strongly enough to install it on the host. If Codex rotates or invalidates a single-use refresh token during a run, refresh or re-authenticate the authoritative host Codex login outside the agent run before the next subscription-only execution.

Evidence is a local preflight classification plus a defensive result check, not a provider-issued billing receipt. The lane requires an administrator-controlled trusted host Codex/Node executable chain. Stable remediation codes are `subscription_auth_missing`, `metered_credential_present`, `metered_provider_selected`, `subscription_auth_unverifiable`, and `subscription_environment_unsupported`; these persist as configuration-incomplete failures and do not enter a generic retry loop. Subscription auth/session state is isolated per run, while Paperclip's immutable session fingerprint includes the active policy capability semantics so a policy-version change cannot resume stale execution state.

## Session Persistence

Codex uses `previous_response_id` for session continuity. The adapter serializes and restores this across heartbeats, allowing the agent to maintain conversation context.

## Skills Injection

The adapter symlinks Paperclip skills into the global Codex skills directory (`~/.codex/skills`). Existing user skills are not overwritten.

## Fast Mode

When `fastMode` is enabled, Paperclip adds Codex config overrides equivalent to:

```sh
-c 'service_tier="fast"' -c 'features.fast_mode=true'
```

Paperclip currently applies that only when the selected model is `gpt-5.4`. On other models, the toggle is preserved in config but ignored at execution time to avoid unsupported runs.

## Managed `CODEX_HOME`

When Paperclip is running inside a managed worktree instance (`PAPERCLIP_IN_WORKTREE=true`), the adapter instead uses a worktree-isolated `CODEX_HOME` under the Paperclip instance so Codex skills, sessions, logs, and other runtime state do not leak across checkouts. It seeds that isolated home from the user's main Codex home for shared auth/config continuity.

### Per-agent isolation and auth seeding

For `codex_local` agents the server isolation guard pins each agent to a per-agent home (`<instance>/companies/<companyId>/agents/<agentId>/codex-home`) and sets `OPENAI_API_KEY=""` so an agent can never spend against the host API key or share another agent's Codex state.

A managed home is created empty, so the adapter must provision auth into it before launching Codex — otherwise the agent runs with zero credentials and the provider returns `401 Missing bearer`. The seeding contract:

- **Managed homes** (the default home and any configured `CODEX_HOME` under the company tree) are always seeded: the ChatGPT-subscription `auth.json` is symlinked from the host Codex home, or, when a per-agent `OPENAI_API_KEY` is configured, an API-key `auth.json` is written instead.
- **Genuine external overrides** (a `CODEX_HOME` outside the Paperclip-managed company tree) are treated as self-managed and are never seeded or overwritten.
- **Fail-fast guard:** if a managed home ends up with no usable `auth.json` and no configured API key, the run fails with an explicit `adapter_failed` ("no Codex credentials provisioned for managed home …") rather than emitting an unauthenticated request.

### Auth ownership and precedence

`codex_local` is host-owns-auth when Paperclip owns the effective
`CODEX_HOME`. The winning credential file is:

1. **Per-agent API key:** when adapter env contains a non-empty
   `OPENAI_API_KEY`, Paperclip writes `$CODEX_HOME/auth.json` with only
   `{ "OPENAI_API_KEY": "..." }`. This overwrites any existing file or symlink
   at that path. Codex CLI versions that Paperclip supports read the key from
   `auth.json`, not directly from the process environment.
2. **Host ChatGPT-subscription login:** when no per-agent key is configured,
   Paperclip symlinks `auth.json` from the shared host Codex home into the
   managed home. The symlink keeps rotating/single-use refresh tokens live
   instead of copying a stale token into the managed home.
3. **External `CODEX_HOME`:** if adapter env points `CODEX_HOME` outside the
   Paperclip-managed company tree, that home is self-managed. Paperclip does
   not seed or overwrite it, so its own `auth.json` wins.

For sandbox or SSH execution, Paperclip uploads the effective managed
`CODEX_HOME` and launches Codex with `CODEX_HOME` pointing at that uploaded
directory. Any `auth.json` already baked into the sandbox image is shadowed in
managed-home mode. If the host has no usable `auth.json` and no per-agent
`OPENAI_API_KEY`, the managed run fails fast instead of falling back to an
in-sandbox login.

Worked example: a worker runs in a sandbox image that already has
`$HOME/.codex/auth.json`, and the Paperclip host is logged in with a ChatGPT
subscription. For a managed `codex_local` agent, Paperclip symlinks the host
`auth.json` into the agent's managed home, uploads that home to the sandbox,
and sets `CODEX_HOME` to the uploaded path. Codex reads the host-owned
uploaded file, so the sandbox image login does not win.

For high-concurrency sandbox fleets, prefer a per-agent `OPENAI_API_KEY` over a
shared ChatGPT-subscription login. API-key mode produces a standalone
`auth.json` for each managed home and avoids many concurrent sandboxes sharing
one rotating subscription credential. The tradeoff is billing: API-key mode is
metered per token through the OpenAI API, while ChatGPT-subscription auth uses
the subscription's flat-plan economics and quota behavior. Pick the mode
deliberately for the fleet's cost and concurrency profile.

### Deferred config-validation warning spec

This section specifies a warning that is not implemented yet. The warning should
help operators notice the host-owns-auth topology before they run a sandbox
fleet with ChatGPT-subscription credentials.

- **Source fields:** resolved Codex auth mode (`api` vs `subscription`) and
  execution target kind (`local`, `remote:ssh`, or `remote:sandbox`). Infer the
  auth mode from the final managed `$CODEX_HOME/auth.json` shape after seeding:
  `{ "OPENAI_API_KEY": ... }` means API-key mode; subscription-token-shaped
  host auth, including the symlinked host file, means ChatGPT-subscription
  mode. Use top-level shape only; do not read credential values into the
  warning. The target kind comes from `AdapterExecutionTarget`.
- **Transformations:** during config preparation or home seeding for a run,
  classify `(subscription auth mode AND remote/sandbox execution target)` as a
  warning condition. This is classification only. Do not read credential values
  into the warning.
- **Sink fields:** emit a warning log line through `onLog("stderr", ...)` and,
  when the config-validation surface supports it, a surfaced validation warning.
  The sink may include only the auth-mode label and target type.
- **Retention:** warning text may appear in ephemeral run logs or validation
  results. Do not persist auth material.
- **Attacker-observable IDs:** none new. The warning must not print token
  values, email addresses, or `auth.json` contents.
- **Hook point:** wire the check at the `codex_local` execute/config-prep path
  around managed-home seeding: `execute.ts` already has `executionTarget` /
  target transport in scope, calls `seedManagedCodexHome`, and calls
  `evaluateCodexCredentialReadiness` before uploading `CODEX_HOME`. If the
  warning is factored into `codex-home.ts`, pass the resolved target
  classification in rather than making `codex-home.ts` inspect execution
  targets on its own.

Because the warning touches authentication behavior, implementation must go
through the security-review gate. Treat this docs section as the follow-up
implementation spec, not as authorization to add the warning in a docs-only
change.

## Manual Local CLI

For manual local CLI usage outside heartbeat runs (for example running as `codexcoder` directly), use:

```sh
npx paperclipai agent local-cli codexcoder --company-id <company-id>
```

This installs any missing skills, creates an agent API key, and prints shell exports to run as that agent.

## Instructions Resolution

If `instructionsFilePath` is configured, Paperclip reads that file and prepends it to the stdin prompt sent to `codex exec` on every run.

This is separate from any workspace-level instruction discovery that Codex itself performs in the run `cwd`. Paperclip does not disable Codex-native repo instruction files, so a repo-local `AGENTS.md` may still be loaded by Codex in addition to the Paperclip-managed agent instructions.

## Environment Test

The environment test checks:

- Codex CLI is installed and accessible
- Working directory is absolute and available (auto-created if missing and permitted)
- Authentication signal (`OPENAI_API_KEY` presence)
- A live hello probe (`codex exec --json -` with prompt `Respond with hello.`) to verify the CLI can actually run
