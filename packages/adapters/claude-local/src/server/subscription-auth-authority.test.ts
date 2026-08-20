import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import type {
  SubscriptionAuthAuthorityInspectInput,
  SubscriptionAuthAuthorityOpaqueDomain,
} from "@paperclipai/adapter-utils";
import { inspectClaudeSubscriptionAuthAuthority } from "./subscription-auth-authority.js";

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const AGENT_ID = "22222222-2222-4222-8222-222222222222";
const SECRET_ID = "33333333-3333-4333-8333-333333333333";
const VERSION_ID = "44444444-4444-4444-8444-444444444444";

function signOpaque(domain: SubscriptionAuthAuthorityOpaqueDomain, material: Uint8Array) {
  return `decision-spec-v1.${createHash("sha256").update(domain).update(material).digest("hex")}`;
}

function input(overrides: Partial<SubscriptionAuthAuthorityInspectInput> = {}): SubscriptionAuthAuthorityInspectInput {
  const token = "oauth-captured-token";
  return {
    mode: "inspect",
    adapterType: "claude_local",
    companyId: COMPANY_ID,
    agentId: AGENT_ID,
    config: {
      billingPolicy: "subscription_only",
      engine: "cli",
      env: { CLAUDE_CODE_OAUTH_TOKEN: token },
    },
    env: { CLAUDE_CODE_OAUTH_TOKEN: token },
    authSource: {
      kind: "resolved_user_secret_version",
      configPath: "env.CLAUDE_CODE_OAUTH_TOKEN",
      key: "CLAUDE_CODE_OAUTH_TOKEN",
      secretId: SECRET_ID,
      versionId: VERSION_ID,
      version: 7,
      value: token,
    },
    signOpaque,
    ...overrides,
  };
}

describe("Claude subscription auth authority", () => {
  it("is deterministic and binds credential identity and exact version without exposing them", async () => {
    const first = await inspectClaudeSubscriptionAuthAuthority(input());
    const second = await inspectClaudeSubscriptionAuthAuthority(input());
    expect(first).toEqual(second);
    expect(first.prepared).toBeUndefined();
    expect(first.proof.account.evidence).toBe("credential_bound");
    const serialized = JSON.stringify(first.proof);
    expect(serialized).not.toContain("oauth-captured-token");
    expect(serialized).not.toContain(SECRET_ID);
    expect(serialized).not.toContain(VERSION_ID);

    const changedToken = await inspectClaudeSubscriptionAuthAuthority(input({
      config: { billingPolicy: "subscription_only", engine: "cli", env: { CLAUDE_CODE_OAUTH_TOKEN: "oauth-new-token" } },
      env: { CLAUDE_CODE_OAUTH_TOKEN: "oauth-new-token" },
      authSource: {
        kind: "resolved_user_secret_version",
        configPath: "env.CLAUDE_CODE_OAUTH_TOKEN",
        key: "CLAUDE_CODE_OAUTH_TOKEN",
        secretId: SECRET_ID,
        versionId: VERSION_ID,
        version: 7,
        value: "oauth-new-token",
      },
    }));
    expect(changedToken.proof.authProfile.identityFingerprint).toBe(first.proof.authProfile.identityFingerprint);
    expect(changedToken.proof.account.identityFingerprint).not.toBe(first.proof.account.identityFingerprint);
    expect(changedToken.proof.credentialRevisionFingerprint).not.toBe(first.proof.credentialRevisionFingerprint);

    const changedVersion = await inspectClaudeSubscriptionAuthAuthority(input({
      authSource: {
        kind: "resolved_user_secret_version",
        configPath: "env.CLAUDE_CODE_OAUTH_TOKEN",
        key: "CLAUDE_CODE_OAUTH_TOKEN",
        secretId: SECRET_ID,
        versionId: "55555555-5555-4555-8555-555555555555",
        version: 8,
        value: "oauth-captured-token",
      },
    }));
    expect(changedVersion.proof.account.identityFingerprint).toBe(first.proof.account.identityFingerprint);
    expect(changedVersion.proof.credentialRevisionFingerprint).not.toBe(first.proof.credentialRevisionFingerprint);
  });

  it("fails closed for native login and any source other than the exact fixed user secret", async () => {
    await expect(inspectClaudeSubscriptionAuthAuthority(input({
      authSource: { kind: "native_host_login", provider: "claude" },
    }))).rejects.toMatchObject({ code: "subscription_auth_unverifiable" });
    await expect(inspectClaudeSubscriptionAuthAuthority(input({
      authSource: {
        kind: "resolved_user_secret_version",
        configPath: "env.CLAUDE_CODE_OAUTH_TOKEN",
        key: "OTHER_SECRET",
        secretId: SECRET_ID,
        versionId: VERSION_ID,
        version: 7,
        value: "oauth-captured-token",
      },
    }))).rejects.toMatchObject({ code: "subscription_auth_unverifiable" });
    await expect(inspectClaudeSubscriptionAuthAuthority(input({
      authSource: {
        kind: "resolved_company_secret_version",
        configPath: "env.CLAUDE_CODE_OAUTH_TOKEN",
        secretId: SECRET_ID,
        versionId: VERSION_ID,
        version: 7,
        value: "oauth-captured-token",
      },
    }))).rejects.toMatchObject({ code: "subscription_auth_unverifiable" });
  });

  it("prepare applies the captured token after source mutation and dispose clears it", async () => {
    const source = input({ mode: "prepare" });
    const result = await inspectClaudeSubscriptionAuthAuthority(source);
    expect(result.prepared).toBeDefined();
    if (source.authSource.kind === "resolved_user_secret_version") source.authSource.value = "mutated-after-capture";
    source.env.CLAUDE_CODE_OAUTH_TOKEN = "mutated-after-capture";
    const appliedEnv: Record<string, string> = {
      ANTHROPIC_API_KEY: "must-clear",
      CLAUDE_CODE_MANAGED_SETTINGS_PATH: "/host/settings",
      HTTP_PROXY: "http://proxy.invalid",
    };
    const evidence = await result.prepared!.apply({ env: appliedEnv });
    expect(appliedEnv.CLAUDE_CODE_OAUTH_TOKEN).toBe("oauth-captured-token");
    expect(appliedEnv.ANTHROPIC_API_KEY).toBeUndefined();
    expect(appliedEnv.CLAUDE_CODE_MANAGED_SETTINGS_PATH).toBeUndefined();
    expect(appliedEnv.HTTP_PROXY).toBeUndefined();
    expect(evidence).toEqual({
      schema: "paperclip.subscription-auth-host-owned-final-env",
      version: 1,
      adapterType: "claude_local",
    });
    expect(appliedEnv.CLAUDE_CONFIG_DIR).toContain("paperclip-claude-auth-authority-");
    if (process.platform !== "win32") {
      expect((await fs.stat(appliedEnv.HOME)).mode & 0o777).toBe(0o700);
      expect((await fs.stat(appliedEnv.CLAUDE_CONFIG_DIR)).mode & 0o777).toBe(0o700);
    }
    const privateHome = appliedEnv.HOME;
    await result.prepared!.dispose();
    expect(appliedEnv.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(await fs.lstat(privateHome).catch(() => null)).toBeNull();
    await expect(result.prepared!.apply({ env: appliedEnv })).rejects.toMatchObject({
      code: "subscription_auth_unverifiable",
    });
  });

  it("retries private-home cleanup after an injected failure", async () => {
    const result = await inspectClaudeSubscriptionAuthAuthority(input({ mode: "prepare" }));
    const env: Record<string, string> = {};
    await result.prepared!.apply({ env });
    const privateHome = env.HOME;
    const originalRm = fs.rm.bind(fs);
    const rmSpy = vi.spyOn(fs, "rm").mockRejectedValueOnce(new Error("injected cleanup failure"));
    await expect(result.prepared!.dispose()).rejects.toThrow("injected cleanup failure");
    rmSpy.mockImplementation(originalRm);
    await result.prepared!.dispose();
    expect(await fs.lstat(privateHome).catch(() => null)).toBeNull();
    rmSpy.mockRestore();
  });
});
