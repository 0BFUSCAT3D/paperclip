import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SUBSCRIPTION_POLICY_TRANSPORT_INTERCEPTION_ENV_KEYS } from "@paperclipai/adapter-utils";
import {
  assertClaudeSubscriptionOnlyLaunchable,
  claudeSettingsHaveProviderRouting,
  executeWithClaudeSubscriptionPolicy,
  inspectClaudeSubscriptionAuthStatus,
} from "./execute.js";
import { testEnvironment } from "./test.js";

function context(config: Record<string, unknown>) {
  return {
    runId: "run-1",
    agent: { id: "agent-1", companyId: "company-1", name: "Claude", adapterType: "claude_local", adapterConfig: {} },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: { billingPolicy: "subscription_only", ...config },
    context: {},
    onLog: async () => {},
  };
}

describe("Claude subscription-only pre-spawn policy", () => {
  beforeEach(() => {
    for (const key of ["NODE_OPTIONS", "NODE_PATH", "LD_PRELOAD", "LD_LIBRARY_PATH", "DYLD_INSERT_LIBRARIES", "DYLD_LIBRARY_PATH", "BASH_ENV", "ENV", "SHELLOPTS", "CLAUDE_CONFIG_DIR", "CODEX_PERMISSION_PROFILE", ...SUBSCRIPTION_POLICY_TRANSPORT_INTERCEPTION_ENV_KEYS]) {
      vi.stubEnv(key, "");
      vi.stubEnv(key.toLowerCase(), "");
    }
  });
  afterEach(() => vi.unstubAllEnvs());
  it("rejects a merged API credential without spawning a provider process", async () => {
    await expect(assertClaudeSubscriptionOnlyLaunchable(context({ env: { ANTHROPIC_API_KEY: "test-secret" } }) as never))
      .rejects.toMatchObject({ code: "metered_credential_present" });
  });

  it("rejects remote execution before attempting target attestation", async () => {
    await expect(assertClaudeSubscriptionOnlyLaunchable({
      ...context({ env: { CLAUDE_CODE_OAUTH_TOKEN: "test-token" } }),
      executionTarget: { kind: "remote", transport: "sandbox", remoteCwd: "/workspace" },
    } as never)).rejects.toMatchObject({
      code: "subscription_environment_unsupported",
    });
  });

  it("accepts the explicit Claude OAuth token without exposing it", async () => {
    await expect(assertClaudeSubscriptionOnlyLaunchable(context({ env: { CLAUDE_CODE_OAUTH_TOKEN: "test-token" } }) as never))
      .resolves.toBeUndefined();
    await expect(assertClaudeSubscriptionOnlyLaunchable(context({ env: { CLAUDE_CODE_OAUTH_TOKEN: "test-token" } }) as never))
      .resolves.toBeUndefined();
  });

  it("rejects a wrapper command and provider-routing arguments", async () => {
    await expect(assertClaudeSubscriptionOnlyLaunchable(context({ command: "claude-wrapper", env: { CLAUDE_CODE_OAUTH_TOKEN: "test-token" } }) as never))
      .rejects.toMatchObject({ code: "metered_provider_selected" });
    await expect(assertClaudeSubscriptionOnlyLaunchable(context({ extraArgs: ["--base-url", "https://gateway.test"], env: { CLAUDE_CODE_OAUTH_TOKEN: "test-token" } }) as never))
      .rejects.toMatchObject({ code: "metered_provider_selected" });
    await expect(assertClaudeSubscriptionOnlyLaunchable(context({ agentCommand: "", acpAgentCommand: "wrapper", env: { CLAUDE_CODE_OAUTH_TOKEN: "test-token" } }) as never))
      .rejects.toMatchObject({ code: "metered_provider_selected" });
    await expect(assertClaudeSubscriptionOnlyLaunchable(context({ env: { PATH: "/tmp/fake", CLAUDE_CODE_OAUTH_TOKEN: "test-token" } }) as never))
      .rejects.toMatchObject({ code: "metered_provider_selected" });
    await expect(assertClaudeSubscriptionOnlyLaunchable(context({ extraArgs: ["--settings", "/tmp/settings.json"], env: { CLAUDE_CODE_OAUTH_TOKEN: "test-token" } }) as never))
      .rejects.toMatchObject({ code: "metered_provider_selected" });
    await expect(assertClaudeSubscriptionOnlyLaunchable(context({ filesystemSandboxCommand: "/tmp/wrapper", env: { CLAUDE_CODE_OAUTH_TOKEN: "test-token" } }) as never))
      .rejects.toMatchObject({ code: "metered_provider_selected" });
  });

  it.each([
    ["Bedrock selector", { CLAUDE_CODE_USE_BEDROCK: "true" }, "metered_provider_selected"],
    ["Bedrock credential", { AWS_ACCESS_KEY_ID: "not-a-real-key" }, "metered_credential_present"],
    ["Vertex selector", { CLAUDE_CODE_USE_VERTEX: "true" }, "metered_provider_selected"],
    ["Vertex credential", { GOOGLE_APPLICATION_CREDENTIALS: "/tmp/credential.json" }, "metered_credential_present"],
    ["custom gateway", { ANTHROPIC_BASE_URL: "https://gateway.test" }, "metered_provider_selected"],
  ])("rejects %s from the final merged env", async (_label, env, code) => {
    await expect(assertClaudeSubscriptionOnlyLaunchable(context({ env: { ...env, CLAUDE_CODE_OAUTH_TOKEN: "test-token" } }) as never))
      .rejects.toMatchObject({ code });
  });

  it("rejects host-env API credentials even with an OAuth token in config", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "host-secret");
    await expect(assertClaudeSubscriptionOnlyLaunchable(context({ env: { CLAUDE_CODE_OAUTH_TOKEN: "test-token" } }) as never))
      .rejects.toMatchObject({ code: "metered_credential_present" });
  });

  it("rejects host-inherited CLAUDE_CONFIG_DIR redirection", async () => {
    vi.stubEnv("CLAUDE_CONFIG_DIR", "/tmp/host-redirected-claude-config");
    await expect(assertClaudeSubscriptionOnlyLaunchable(context({
      env: { CLAUDE_CODE_OAUTH_TOKEN: "test-token" },
    }) as never)).rejects.toMatchObject({ code: "metered_provider_selected" });
  });

  it("accepts only an explicit native first-party, no-API-key auth-status proof", async () => {
    const native = await inspectClaudeSubscriptionAuthStatus({}, async () => ({
      stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiKeySource: "none", apiProvider: "firstParty" }), stderr: "",
    }) as never);
    const loggedOut = await inspectClaudeSubscriptionAuthStatus({}, async () => ({
      stdout: JSON.stringify({ loggedIn: false }), stderr: "",
    }) as never);
    const apiKey = await inspectClaudeSubscriptionAuthStatus({}, async () => ({
      stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiKeySource: "env", apiProvider: "firstParty" }), stderr: "",
    }) as never);
    const otherProvider = await inspectClaudeSubscriptionAuthStatus({}, async () => ({
      stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiKeySource: "none", apiProvider: "gateway" }), stderr: "",
    }) as never);
    const currentOauth = await inspectClaudeSubscriptionAuthStatus({}, async () => ({
      stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty" }), stderr: "",
    }) as never);
    const currentApiKey = await inspectClaudeSubscriptionAuthStatus({}, async () => ({
      stdout: JSON.stringify({ loggedIn: true, authMethod: "api_key", apiKeySource: "ANTHROPIC_API_KEY", apiProvider: "firstParty" }), stderr: "",
    }) as never);
    expect(native).toBe("present");
    expect(currentOauth).toBe("present");
    expect(loggedOut).toBe("missing");
    expect(apiKey).toBe("unverifiable");
    expect(currentApiKey).toBe("unverifiable");
    expect(otherProvider).toBe("unverifiable");
  });

  it("rejects user-provided custom headers as a provider-routing seam", async () => {
    await expect(assertClaudeSubscriptionOnlyLaunchable(context({
      env: {
        CLAUDE_CODE_OAUTH_TOKEN: "test-token",
        ANTHROPIC_CUSTOM_HEADERS: "X-Proxy-Route: metered",
      },
    }) as never)).rejects.toMatchObject({ code: "metered_provider_selected" });
  });

  it("rejects redirected config roots, ACP state, and custom sandbox executables", async () => {
    for (const config of [
      { env: { HOME: "/tmp/fake", CLAUDE_CODE_OAUTH_TOKEN: "token" } },
      { env: { CLAUDE_CONFIG_DIR: "/tmp/fake", CLAUDE_CODE_OAUTH_TOKEN: "token" } },
      { stateDir: "/tmp/acp", env: { CLAUDE_CODE_OAUTH_TOKEN: "token" } },
    ]) {
      await expect(assertClaudeSubscriptionOnlyLaunchable(context(config) as never))
        .rejects.toMatchObject({ code: "metered_provider_selected" });
    }
  });

  it("securely rejects provider-bearing, symlinked, and oversized Claude settings", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-settings-policy-"));
    const settingsPath = path.join(root, "settings.json");
    try {
      await fs.writeFile(settingsPath, JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://gateway.test" } }));
      await expect(claudeSettingsHaveProviderRouting(root)).resolves.toBe(true);
      await fs.writeFile(settingsPath, "x".repeat(64 * 1024 + 1));
      await expect(claudeSettingsHaveProviderRouting(root)).resolves.toBe(true);
      const target = path.join(root, "target.json");
      await fs.writeFile(target, JSON.stringify({ theme: "dark" }));
      await fs.rm(settingsPath);
      await fs.symlink(target, settingsPath);
      await expect(claudeSettingsHaveProviderRouting(root)).resolves.toBe(true);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("blocks forbidden CLI config before its executor can spawn", async () => {
    const executeInner = vi.fn();
    await expect(executeWithClaudeSubscriptionPolicy(
      context({ engine: "cli", env: { ANTHROPIC_API_KEY: "test-secret" } }) as never,
      executeInner,
    )).rejects.toMatchObject({ code: "metered_credential_present" });
    expect(executeInner).not.toHaveBeenCalled();
  });

  it.each(["https_proxy", "NODE_EXTRA_CA_CERTS", "CLAUDE_CODE_PROXY_URL"])(
    "blocks final transport interception before the Claude executor can spawn: %s",
    async (key) => {
      const executeInner = vi.fn();
      await expect(executeWithClaudeSubscriptionPolicy(
        context({ engine: "cli", env: { CLAUDE_CODE_OAUTH_TOKEN: "test-token", [key]: "configured" } }) as never,
        executeInner,
      )).rejects.toMatchObject({ code: "metered_provider_selected" });
      expect(executeInner).not.toHaveBeenCalled();
    },
  );

  it("blocks a host-inherited transport interceptor before the Claude executor can spawn", async () => {
    vi.stubEnv("SSL_CERT_FILE", "/tmp/untrusted-ca.pem");
    const executeInner = vi.fn();
    await expect(executeWithClaudeSubscriptionPolicy(
      context({ engine: "cli", env: { CLAUDE_CODE_OAUTH_TOKEN: "test-token" } }) as never,
      executeInner,
    )).rejects.toMatchObject({ code: "metered_provider_selected" });
    expect(executeInner).not.toHaveBeenCalled();
  });

  it("rejects explicit ACP before auth probing or executor creation", async () => {
    const executeInner = vi.fn();
    await expect(executeWithClaudeSubscriptionPolicy(
      context({ engine: "acp", env: {} }) as never,
      executeInner,
    )).rejects.toMatchObject({ code: "subscription_environment_unsupported" });
    expect(executeInner).not.toHaveBeenCalled();
  });

  it("rejects a non-subscription receipt after an otherwise allowed execution", async () => {
    const executeInner = vi.fn().mockResolvedValue({ billingType: "api" });
    await expect(executeWithClaudeSubscriptionPolicy(
      context({ env: { CLAUDE_CODE_OAUTH_TOKEN: "test-token" } }) as never,
      executeInner,
    )).rejects.toMatchObject({ code: "metered_provider_selected" });
    expect(executeInner).toHaveBeenCalledOnce();
  });

  it("rejects missing billing attestation and retains timeout evidence", async () => {
    for (const billingType of [undefined, null, "unknown"] as const) {
      await expect(executeWithClaudeSubscriptionPolicy(
        context({ env: { CLAUDE_CODE_OAUTH_TOKEN: "test-token" } }) as never,
        async () => ({ exitCode: null, signal: null, timedOut: true, billingType } as never),
      )).rejects.toMatchObject({
        code: "metered_provider_selected",
        evidence: { billingType: billingType ?? null, timedOut: true },
      });
    }
  });

  it.each(["cli", "acp"])("environment test blocks forbidden %s config before probing", async (engine) => {
    const result = await testEnvironment({
      companyId: "company-1", adapterType: "claude_local", config: { billingPolicy: "subscription_only", engine, env: { ANTHROPIC_API_KEY: "secret" } },
    });
    expect(result).toMatchObject({
      status: "fail",
      checks: [{ code: engine === "acp" ? "subscription_environment_unsupported" : "metered_credential_present" }],
    });
  });

  it("fails explicit ACP environment testing closed even with OAuth", async () => {
    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "claude_local",
      config: { billingPolicy: "subscription_only", engine: "acp", env: { CLAUDE_CODE_OAUTH_TOKEN: "token" } },
    });
    expect(result).toMatchObject({ status: "fail", checks: [{ code: "subscription_environment_unsupported" }] });
  });

  it("fails explicit ACP environment testing before requiring auth", async () => {
    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "claude_local",
      config: { billingPolicy: "subscription_only", engine: "acp", env: {} },
    });
    expect(result).toMatchObject({ status: "fail", checks: [{ code: "subscription_environment_unsupported" }] });
  });
});
