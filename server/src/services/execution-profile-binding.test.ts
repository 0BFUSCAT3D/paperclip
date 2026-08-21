import { randomUUID } from "node:crypto";
import { link, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SUBSCRIPTION_AUTH_AUTHORITY_SCHEMA,
  SUBSCRIPTION_AUTH_AUTHORITY_VERSION,
  SUBSCRIPTION_ONLY_BILLING_CAPABILITY,
  type InspectSubscriptionAuthAuthority,
  type SubscriptionAuthAuthorityProofV1,
} from "@paperclipai/adapter-utils";
import type { RuntimeSecretManifestEntry } from "./secrets.js";
import {
  executionProfileBindingsMatch,
  executionProfileSha256,
  inspectExecutionProfileBinding,
  inspectedExecutionProfileBindingMatchesScope,
  instructionFileSha256,
  readInstructionFileSnapshot,
} from "./execution-profile-binding.js";

const cleanupPaths: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(cleanupPaths.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

function opaque(character: string) {
  return `decision-spec-v1.${character.repeat(64)}`;
}

function proof(input: {
  adapterType: "claude_local" | "codex_local";
  companyId: string;
  agentId: string;
}): SubscriptionAuthAuthorityProofV1 {
  const evidence = input.adapterType === "claude_local" ? "credential_bound" : "account_id_bound";
  return {
    schema: SUBSCRIPTION_AUTH_AUTHORITY_SCHEMA,
    version: SUBSCRIPTION_AUTH_AUTHORITY_VERSION,
    adapterType: input.adapterType,
    companyId: input.companyId,
    agentId: input.agentId,
    authKind: input.adapterType === "claude_local"
      ? "claude_oauth_user_secret"
      : "codex_chatgpt_managed_profile",
    sourceKind: input.adapterType === "claude_local"
      ? "user_secret_version"
      : "managed_local_profile",
    authProfile: {
      evidence,
      identityFingerprint: opaque("a"),
      revisionFingerprint: opaque("b"),
    },
    account: {
      evidence,
      identityFingerprint: opaque("c"),
      revisionFingerprint: opaque("d"),
    },
    principal: {
      evidence,
      identityFingerprint: opaque("e"),
      revisionFingerprint: opaque("f"),
    },
    credentialRevisionFingerprint: opaque("0"),
  };
}

function claudeManifest(overrides: Partial<RuntimeSecretManifestEntry> = {}): RuntimeSecretManifestEntry {
  return {
    configPath: "env.CLAUDE_CODE_OAUTH_TOKEN",
    envKey: "CLAUDE_CODE_OAUTH_TOKEN",
    secretId: randomUUID(),
    secretScope: "user",
    versionId: randomUUID(),
    bindingId: randomUUID(),
    secretKey: "CLAUDE_CODE_OAUTH_TOKEN",
    version: 7,
    provider: "local_encrypted",
    providerVersionRef: null,
    outcome: "success",
    ...overrides,
  };
}

describe("execution profile binding", () => {
  it("binds Claude to one exact owner-secret version without persisting its value", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const manifest = claudeManifest();
    const inspect = vi.fn<InspectSubscriptionAuthAuthority>(async (input) => ({
      proof: proof({ adapterType: "claude_local", companyId, agentId }),
    }));
    const binding = await inspectExecutionProfileBinding({
      mode: "inspect",
      companyId,
      agentId,
      issueId,
      adapterType: "claude_local",
      resolvedConfig: {
        billingPolicy: "subscription_only",
        engine: "cli",
        model: "claude-sonnet-4-5",
        env: { CLAUDE_CODE_OAUTH_TOKEN: "owner-secret-value", SAFE_FLAG: "1" },
      },
      secretManifest: [manifest],
      environment: { id: randomUUID(), driver: "local" },
      agentExecutionProfileRevision: 5,
      issueAssigneeProfileRevision: 9,
      instructionsSha256: executionProfileSha256({ instructions: "reviewed" }),
      subscriptionOnlyBilling: SUBSCRIPTION_ONLY_BILLING_CAPABILITY,
      inspectSubscriptionAuthAuthority: inspect,
      codexManagedHome: null,
    });
    expect(inspect).toHaveBeenCalledOnce();
    expect(inspect.mock.calls[0]?.[0].authSource).toEqual({
      kind: "resolved_user_secret_version",
      configPath: manifest.configPath,
      key: "CLAUDE_CODE_OAUTH_TOKEN",
      secretId: manifest.secretId,
      versionId: manifest.versionId,
      version: manifest.version,
      value: "owner-secret-value",
    });
    expect(binding.projection).toMatchObject({
      companyId,
      agentId,
      issueId,
      adapterType: "claude_local",
      billingPolicy: "subscription_only",
      agentExecutionProfileRevision: 5,
      issueAssigneeProfileRevision: 9,
    });
    expect(JSON.stringify(binding)).not.toContain("owner-secret-value");
    expect(executionProfileBindingsMatch({
      digest: binding.digest,
      projection: binding.projection,
      authorityIdentity: { profile: binding.authorityProof },
    }, binding)).toBe(true);
    expect(inspectedExecutionProfileBindingMatchesScope(binding, {
      companyId,
      agentId,
      issueId,
      agentExecutionProfileRevision: 5,
      issueAssigneeProfileRevision: 9,
    })).toBe(true);
    expect(inspectedExecutionProfileBindingMatchesScope({
      ...binding,
      projection: { ...binding.projection, networkScope: "unbound-extra-field" },
    }, {
      companyId,
      agentId,
      issueId,
      agentExecutionProfileRevision: 5,
      issueAssigneeProfileRevision: 9,
    })).toBe(false);
    expect(inspectedExecutionProfileBindingMatchesScope({
      ...binding,
      digest: "0".repeat(64),
    }, {
      companyId,
      agentId,
      issueId,
      agentExecutionProfileRevision: 5,
      issueAssigneeProfileRevision: 9,
    })).toBe(false);

    const rotated = await inspectExecutionProfileBinding({
      mode: "inspect",
      companyId,
      agentId,
      issueId,
      adapterType: "claude_local",
      resolvedConfig: {
        billingPolicy: "subscription_only",
        engine: "cli",
        model: "claude-sonnet-4-5",
        env: { CLAUDE_CODE_OAUTH_TOKEN: "rotated-owner-secret", SAFE_FLAG: "1" },
      },
      secretManifest: [claudeManifest({
        secretId: manifest.secretId,
        versionId: randomUUID(),
        version: manifest.version + 1,
      })],
      environment: binding.projection.environment,
      agentExecutionProfileRevision: 5,
      issueAssigneeProfileRevision: 9,
      instructionsSha256: binding.projection.instructionsSha256,
      subscriptionOnlyBilling: SUBSCRIPTION_ONLY_BILLING_CAPABILITY,
      inspectSubscriptionAuthAuthority: inspect,
      codexManagedHome: null,
    });
    expect(rotated.projection.securityConfigSha256).not.toBe(binding.projection.securityConfigSha256);
    expect(rotated.digest).not.toBe(binding.digest);

    const broadened = await inspectExecutionProfileBinding({
      mode: "inspect",
      companyId,
      agentId,
      issueId,
      adapterType: "claude_local",
      resolvedConfig: {
        billingPolicy: "subscription_only",
        engine: "cli",
        model: "claude-sonnet-4-5",
        env: { CLAUDE_CODE_OAUTH_TOKEN: "owner-secret-value", SAFE_FLAG: "1" },
        networkScope: "full",
        networkAllowlist: ["example.invalid"],
        filesystemScope: "workspace_and_extra_paths",
        filesystemExtraPaths: ["/private/extra"],
        promptTemplate: "Changed provider instructions",
      },
      secretManifest: [manifest],
      environment: binding.projection.environment,
      agentExecutionProfileRevision: 5,
      issueAssigneeProfileRevision: 9,
      instructionsSha256: binding.projection.instructionsSha256,
      subscriptionOnlyBilling: SUBSCRIPTION_ONLY_BILLING_CAPABILITY,
      inspectSubscriptionAuthAuthority: inspect,
      codexManagedHome: null,
    });
    expect(broadened.projection.securityConfigSha256)
      .not.toBe(binding.projection.securityConfigSha256);
    expect(broadened.digest).not.toBe(binding.digest);
  });

  it.each([
    { secretScope: "company" as const },
    { secretKey: "OTHER_TOKEN" },
    { envKey: "OTHER_TOKEN" },
  ])("rejects a non-owner Claude manifest at the protected path: %o", async (override) => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await expect(inspectExecutionProfileBinding({
      mode: "inspect",
      companyId,
      agentId,
      issueId: randomUUID(),
      adapterType: "claude_local",
      resolvedConfig: {
        billingPolicy: "subscription_only",
        engine: "cli",
        env: { CLAUDE_CODE_OAUTH_TOKEN: "not-owner-bound" },
      },
      secretManifest: [claudeManifest(override)],
      environment: { id: randomUUID(), driver: "local" },
      agentExecutionProfileRevision: 1,
      issueAssigneeProfileRevision: 2,
      instructionsSha256: executionProfileSha256({ kind: "none" }),
      subscriptionOnlyBilling: SUBSCRIPTION_ONLY_BILLING_CAPABILITY,
      inspectSubscriptionAuthAuthority: async () => ({
        proof: proof({ adapterType: "claude_local", companyId, agentId }),
      }),
      codexManagedHome: null,
    })).rejects.toMatchObject({
      status: 409,
      details: { code: "execution_profile_auth_authority_missing" },
    });
  });

  it("rejects an adapter that does not expose the exact subscription-only capability", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await expect(inspectExecutionProfileBinding({
      mode: "inspect",
      companyId,
      agentId,
      issueId: null,
      adapterType: "codex_local",
      resolvedConfig: { billingPolicy: "subscription_only", engine: "cli", env: {} },
      secretManifest: [],
      environment: { id: randomUUID(), driver: "local" },
      agentExecutionProfileRevision: 1,
      issueAssigneeProfileRevision: null,
      instructionsSha256: executionProfileSha256({ kind: "none" }),
      subscriptionOnlyBilling: undefined,
      inspectSubscriptionAuthAuthority: async () => ({
        proof: proof({ adapterType: "codex_local", companyId, agentId }),
      }),
      codexManagedHome: "/private/managed/codex-profile",
    })).rejects.toMatchObject({
      status: 409,
      details: { code: "execution_profile_unsupported" },
    });
  });

  it("binds Codex to the server-selected managed profile and disposes malformed prepared evidence", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const managedHome = "/private/managed/codex-profile";
    const inspect = vi.fn<InspectSubscriptionAuthAuthority>(async (input) => ({
      proof: proof({ adapterType: "codex_local", companyId, agentId }),
      prepared: {
        apply: async () => ({
          schema: "paperclip.subscription-auth-host-owned-final-env",
          version: 1,
          adapterType: "codex_local",
        }),
        dispose: async () => undefined,
      },
    }));
    const binding = await inspectExecutionProfileBinding({
      mode: "prepare",
      companyId,
      agentId,
      issueId: null,
      adapterType: "codex_local",
      resolvedConfig: { billingPolicy: "subscription_only", engine: "cli", env: {} },
      secretManifest: [],
      environment: { id: randomUUID(), driver: "local" },
      agentExecutionProfileRevision: 3,
      issueAssigneeProfileRevision: null,
      instructionsSha256: executionProfileSha256({ kind: "none" }),
      subscriptionOnlyBilling: SUBSCRIPTION_ONLY_BILLING_CAPABILITY,
      inspectSubscriptionAuthAuthority: inspect,
      codexManagedHome: managedHome,
    });
    expect(inspect.mock.calls[0]?.[0].authSource).toEqual({
      kind: "managed_local_profile",
      profile: "codex_agent_home",
      location: managedHome,
    });
    expect(binding.prepared).not.toBeNull();

    const dispose = vi.fn(async () => undefined);
    await expect(inspectExecutionProfileBinding({
      mode: "prepare",
      companyId,
      agentId,
      issueId: null,
      adapterType: "codex_local",
      resolvedConfig: { billingPolicy: "subscription_only", engine: "cli", env: {} },
      secretManifest: [],
      environment: { id: randomUUID(), driver: "local" },
      agentExecutionProfileRevision: 3,
      issueAssigneeProfileRevision: null,
      instructionsSha256: executionProfileSha256({ kind: "none" }),
      subscriptionOnlyBilling: SUBSCRIPTION_ONLY_BILLING_CAPABILITY,
      inspectSubscriptionAuthAuthority: async () => ({
        proof: { invalid: true } as unknown as SubscriptionAuthAuthorityProofV1,
        prepared: {
          apply: async () => ({
            schema: "paperclip.subscription-auth-host-owned-final-env",
            version: 1,
            adapterType: "codex_local",
          }),
          dispose,
        },
      }),
      codexManagedHome: managedHome,
    })).rejects.toMatchObject({
      status: 409,
      details: { code: "execution_profile_auth_authority_invalid" },
    });
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("hashes only a pinned bounded instruction file and refuses link substitution", async () => {
    const root = await mkdtemp(join(tmpdir(), "paperclip-execution-profile-"));
    cleanupPaths.push(root);
    const instructions = join(root, "AGENTS.md");
    await writeFile(instructions, "Review before execution.\n", { mode: 0o600 });
    const snapshot = await readInstructionFileSnapshot({ instructionsFilePath: instructions });
    const digest = snapshot.sha256;
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
    expect(snapshot.prepared).toEqual({
      sourcePath: instructions,
      contents: "Review before execution.\n",
      sha256: digest,
    });
    expect(digest).not.toBe(await instructionFileSha256({}));

    const symlinkPath = join(root, "linked-agents.md");
    await symlink(instructions, symlinkPath);
    await expect(instructionFileSha256({ instructionsFilePath: symlinkPath }))
      .rejects.toMatchObject({
        status: 409,
        details: { code: "execution_profile_instructions_unsafe" },
      });

    const hardlinkPath = join(root, "hardlinked-agents.md");
    await link(instructions, hardlinkPath);
    await expect(instructionFileSha256({ instructionsFilePath: instructions }))
      .rejects.toMatchObject({
        status: 409,
        details: { code: "execution_profile_instructions_unsafe" },
      });
  });

  it("refuses invalid UTF-8 instead of attesting bytes the adapter would decode differently", async () => {
    const root = await mkdtemp(join(tmpdir(), "paperclip-execution-profile-utf8-"));
    cleanupPaths.push(root);
    const instructions = join(root, "AGENTS.md");
    await writeFile(instructions, Buffer.from([0xc3, 0x28]), { mode: 0o600 });
    await expect(readInstructionFileSnapshot({ instructionsFilePath: instructions }))
      .rejects.toMatchObject({
        status: 409,
        details: { code: "execution_profile_instructions_invalid_utf8" },
      });
  });
});
