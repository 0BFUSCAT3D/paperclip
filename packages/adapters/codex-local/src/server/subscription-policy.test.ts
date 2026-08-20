import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SUBSCRIPTION_POLICY_TRANSPORT_INTERCEPTION_ENV_KEYS } from "@paperclipai/adapter-utils";
import {
  assertCodexSubscriptionOnlyLaunchable,
  executeWithCodexSubscriptionPolicy,
  finalizeCodexSubscriptionAuthSnapshot,
} from "./execute.js";
import { createCodexSubscriptionAuthSnapshot } from "./codex-home.js";
import { testEnvironment } from "./test.js";

async function writeSecureChatGptAuth(home: string) {
  const authPath = path.join(home, "auth.json");
  await fs.writeFile(authPath, JSON.stringify({
    auth_mode: "chatgpt",
    tokens: { account_id: "acct-test", id_token: "id", access_token: "access", refresh_token: "refresh" },
  }), { mode: 0o600 });
  await fs.chmod(authPath, 0o600);
}

function refreshedChatGptAuth(marker: string, lastRefresh: string) {
  return JSON.stringify({
    auth_mode: "chatgpt",
    tokens: {
      account_id: "acct-copyback",
      id_token: `id-${marker}`,
      access_token: `access-${marker}`,
      refresh_token: `refresh-${marker}`,
    },
    last_refresh: lastRefresh,
  });
}

function context(config: Record<string, unknown>) {
  return {
    runId: "run-1",
    agent: { id: "agent-1", companyId: "company-1", name: "Codex", adapterType: "codex_local", adapterConfig: {} },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: { billingPolicy: "subscription_only", ...config },
    context: {},
    onLog: async () => {},
  };
}

describe("Codex subscription-only pre-spawn policy", () => {
  beforeEach(() => {
    for (const key of ["NODE_OPTIONS", "NODE_PATH", "LD_PRELOAD", "LD_LIBRARY_PATH", "DYLD_INSERT_LIBRARIES", "DYLD_LIBRARY_PATH", "BASH_ENV", "ENV", "SHELLOPTS", "CLAUDE_CONFIG_DIR", "CODEX_PERMISSION_PROFILE", ...SUBSCRIPTION_POLICY_TRANSPORT_INTERCEPTION_ENV_KEYS]) {
      vi.stubEnv(key, "");
      vi.stubEnv(key.toLowerCase(), "");
    }
  });
  afterEach(() => vi.unstubAllEnvs());

  it("rejects API-key and external-home configuration before process creation", async () => {
    await expect(assertCodexSubscriptionOnlyLaunchable(context({ env: { OPENAI_API_KEY: "test-secret" } }) as never))
      .rejects.toMatchObject({ code: "metered_credential_present" });
    await expect(assertCodexSubscriptionOnlyLaunchable(context({ env: { CODEX_HOME: "/external/codex" } }) as never))
      .rejects.toMatchObject({ code: "subscription_auth_unverifiable" });
  });

  it("rejects remote execution before attempting target attestation", async () => {
    await expect(assertCodexSubscriptionOnlyLaunchable({
      ...context({}), executionTarget: { kind: "remote", transport: "sandbox", remoteCwd: "/workspace" },
    } as never)).rejects.toMatchObject({
      code: "subscription_environment_unsupported",
    });
  });

  it("accepts the repo-proven current ChatGPT auth shape", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-subscription-codex-"));
    const sharedHome = path.join(root, "shared");
    try {
      await fs.mkdir(sharedHome, { recursive: true });
      await writeSecureChatGptAuth(sharedHome);
      vi.stubEnv("PAPERCLIP_HOME", path.join(root, "paperclip"));
      vi.stubEnv("PAPERCLIP_INSTANCE_ID", "test");
      vi.stubEnv("CODEX_HOME", sharedHome);
      await expect(assertCodexSubscriptionOnlyLaunchable(context({}) as never)).resolves.toBeUndefined();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("rejects wrapper commands and provider-routing arguments", async () => {
    await expect(assertCodexSubscriptionOnlyLaunchable(context({ command: "codex-wrapper" }) as never))
      .rejects.toMatchObject({ code: "metered_provider_selected" });
    await expect(assertCodexSubscriptionOnlyLaunchable(context({ args: ["-c", "model_provider=proxy"] }) as never))
      .rejects.toMatchObject({ code: "metered_provider_selected" });
    await expect(assertCodexSubscriptionOnlyLaunchable(context({ agentCommand: "", acpAgentCommand: "wrapper" }) as never))
      .rejects.toMatchObject({ code: "metered_provider_selected" });
    await expect(assertCodexSubscriptionOnlyLaunchable(context({ env: { PATH: "/tmp/fake" } }) as never))
      .rejects.toMatchObject({ code: "metered_provider_selected" });
    await expect(assertCodexSubscriptionOnlyLaunchable(context({ args: ["--profile", "metered"] }) as never))
      .rejects.toMatchObject({ code: "metered_provider_selected" });
    await expect(assertCodexSubscriptionOnlyLaunchable(context({ filesystemSandboxCommand: "/tmp/wrapper" }) as never))
      .rejects.toMatchObject({ code: "metered_provider_selected" });
    await expect(assertCodexSubscriptionOnlyLaunchable(context({ env: { HOME: "/tmp/fake" } }) as never))
      .rejects.toMatchObject({ code: "metered_provider_selected" });
    await expect(assertCodexSubscriptionOnlyLaunchable(context({ acpStateDir: "/tmp/acp" }) as never))
      .rejects.toMatchObject({ code: "metered_provider_selected" });
  });

  it("rejects host-env API credentials and custom provider routing", async () => {
    vi.stubEnv("OPENAI_API_KEY", "host-secret");
    await expect(assertCodexSubscriptionOnlyLaunchable(context({}) as never))
      .rejects.toMatchObject({ code: "metered_credential_present" });
    vi.stubEnv("OPENAI_API_KEY", "");
    await expect(assertCodexSubscriptionOnlyLaunchable(context({ env: { PAPERCLIP_CODEX_PROVIDERS: "{}" } }) as never))
      .rejects.toMatchObject({ code: "metered_provider_selected" });
  });

  it("rejects API-key auth.json and provider-routing config.toml", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-subscription-codex-reject-"));
    const sharedHome = path.join(root, "shared");
    try {
      await fs.mkdir(sharedHome, { recursive: true });
      vi.stubEnv("PAPERCLIP_HOME", path.join(root, "paperclip"));
      vi.stubEnv("PAPERCLIP_INSTANCE_ID", "test");
      vi.stubEnv("CODEX_HOME", sharedHome);
      await fs.writeFile(path.join(sharedHome, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "file-secret" }), { mode: 0o600 });
      await fs.chmod(path.join(sharedHome, "auth.json"), 0o600);
      await expect(assertCodexSubscriptionOnlyLaunchable(context({}) as never))
        .rejects.toMatchObject({ code: "metered_credential_present" });
      await fs.writeFile(path.join(sharedHome, "config.toml"), '"model_provider" = "gateway"\n', { mode: 0o600 });
      await fs.chmod(path.join(sharedHome, "config.toml"), 0o600);
      await expect(assertCodexSubscriptionOnlyLaunchable(context({}) as never))
        .rejects.toMatchObject({ code: "metered_provider_selected" });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("rejects provider routing from an ancestor workspace .codex/config.toml", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-subscription-codex-project-"));
    const sharedHome = path.join(root, "shared");
    const projectRoot = path.join(root, "project");
    const nestedCwd = path.join(projectRoot, "packages", "app");
    try {
      await fs.mkdir(sharedHome, { recursive: true });
      await writeSecureChatGptAuth(sharedHome);
      await fs.mkdir(path.join(projectRoot, ".git"), { recursive: true });
      await fs.mkdir(path.join(projectRoot, ".codex"), { recursive: true });
      await fs.mkdir(nestedCwd, { recursive: true });
      const projectConfig = path.join(projectRoot, ".codex", "config.toml");
      vi.stubEnv("PAPERCLIP_HOME", path.join(root, "paperclip"));
      vi.stubEnv("PAPERCLIP_INSTANCE_ID", "test");
      vi.stubEnv("CODEX_HOME", sharedHome);

      for (const source of [
        'model_provider = "metered"\n',
        'openai_base_url = "https://metered.test"\n',
        'chatgpt_base_url = "https://metered.test"\n',
        'profile = "metered"\n',
        '[profiles."metered"]\nmodel_provider = "proxy"\n',
        '# even a currently benign project config is rejected fail-closed\n',
      ]) {
        await fs.writeFile(projectConfig, source, { mode: 0o600 });
        await fs.chmod(projectConfig, 0o600);
        await expect(assertCodexSubscriptionOnlyLaunchable(context({ cwd: nestedCwd }) as never))
          .rejects.toMatchObject({ code: "metered_provider_selected" });
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a sibling agent CODEX_HOME instead of accepting any company descendant", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-subscription-codex-sibling-"));
    const paperclipHome = path.join(root, "paperclip");
    const siblingHome = path.join(
      paperclipHome,
      "instances",
      "test",
      "companies",
      "company-1",
      "agents",
      "agent-2",
      "codex-home",
    );
    try {
      await fs.mkdir(siblingHome, { recursive: true });
      await writeSecureChatGptAuth(siblingHome);
      vi.stubEnv("PAPERCLIP_HOME", paperclipHome);
      vi.stubEnv("PAPERCLIP_INSTANCE_ID", "test");
      await expect(assertCodexSubscriptionOnlyLaunchable(context({ env: { CODEX_HOME: siblingHome } }) as never))
        .rejects.toMatchObject({ code: "subscription_auth_unverifiable" });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("blocks forbidden CLI config before its executor can spawn", async () => {
    const executeInner = vi.fn();
    await expect(executeWithCodexSubscriptionPolicy(
      context({ engine: "cli", env: { OPENAI_API_KEY: "test-secret" } }) as never,
      executeInner,
    )).rejects.toMatchObject({ code: "metered_credential_present" });
    expect(executeInner).not.toHaveBeenCalled();
  });

  it.each(["http_proxy", "NODE_TLS_REJECT_UNAUTHORIZED", "CODEX_CA_CERTIFICATE"])(
    "blocks final transport interception before the Codex executor can spawn: %s",
    async (key) => {
      const executeInner = vi.fn();
      await expect(executeWithCodexSubscriptionPolicy(
        context({ engine: "cli", env: { [key]: "configured" } }) as never,
        executeInner,
      )).rejects.toMatchObject({ code: "metered_provider_selected" });
      expect(executeInner).not.toHaveBeenCalled();
    },
  );

  it("blocks a host-inherited transport interceptor before the Codex executor can spawn", async () => {
    vi.stubEnv("SSL_CERT_DIR", "/tmp/untrusted-ca");
    const executeInner = vi.fn();
    await expect(executeWithCodexSubscriptionPolicy(
      context({ engine: "cli" }) as never,
      executeInner,
    )).rejects.toMatchObject({ code: "metered_provider_selected" });
    expect(executeInner).not.toHaveBeenCalled();
  });

  it("rejects explicit ACP before auth probing or executor creation", async () => {
    const executeInner = vi.fn();
    await expect(executeWithCodexSubscriptionPolicy(
      context({ engine: "acp", env: {} }) as never,
      executeInner,
    )).rejects.toMatchObject({ code: "subscription_environment_unsupported" });
    expect(executeInner).not.toHaveBeenCalled();
  });

  it("rejects a non-subscription receipt after an otherwise allowed execution", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-subscription-codex-receipt-"));
    const sharedHome = path.join(root, "shared");
    try {
      await fs.mkdir(sharedHome, { recursive: true });
      await writeSecureChatGptAuth(sharedHome);
      vi.stubEnv("PAPERCLIP_HOME", path.join(root, "paperclip"));
      vi.stubEnv("PAPERCLIP_INSTANCE_ID", "test");
      vi.stubEnv("CODEX_HOME", sharedHome);
      const executeInner = vi.fn().mockResolvedValue({ billingType: "api" });
      await expect(executeWithCodexSubscriptionPolicy(context({}) as never, executeInner))
        .rejects.toMatchObject({ code: "metered_provider_selected" });
      expect(executeInner).toHaveBeenCalledOnce();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("rejects missing billing attestation and retains timeout evidence", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-subscription-codex-missing-receipt-"));
    const sharedHome = path.join(root, "shared");
    try {
      await fs.mkdir(sharedHome, { recursive: true });
      await writeSecureChatGptAuth(sharedHome);
      vi.stubEnv("PAPERCLIP_HOME", path.join(root, "paperclip"));
      vi.stubEnv("PAPERCLIP_INSTANCE_ID", "test");
      vi.stubEnv("CODEX_HOME", sharedHome);
      for (const billingType of [undefined, null, "unknown"] as const) {
        await expect(executeWithCodexSubscriptionPolicy(context({}) as never, async () => ({
          exitCode: null, signal: null, timedOut: true, billingType,
        } as never))).rejects.toMatchObject({
          code: "metered_provider_selected",
          evidence: { billingType: billingType ?? null, timedOut: true },
        });
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("rejects symlinked, permissive, and oversized auth files plus unsafe config symlinks", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-subscription-codex-secure-read-"));
    const sharedHome = path.join(root, "shared");
    const authPath = path.join(sharedHome, "auth.json");
    try {
      await fs.mkdir(sharedHome, { recursive: true });
      vi.stubEnv("PAPERCLIP_HOME", path.join(root, "paperclip"));
      vi.stubEnv("PAPERCLIP_INSTANCE_ID", "test");
      vi.stubEnv("CODEX_HOME", sharedHome);

      await writeSecureChatGptAuth(sharedHome);
      await fs.chmod(authPath, 0o666);
      await expect(assertCodexSubscriptionOnlyLaunchable(context({}) as never))
        .rejects.toMatchObject({ code: "subscription_auth_unverifiable" });

      await fs.writeFile(authPath, "x".repeat(64 * 1024 + 1), { mode: 0o600 });
      await fs.chmod(authPath, 0o600);
      await expect(assertCodexSubscriptionOnlyLaunchable(context({}) as never))
        .rejects.toMatchObject({ code: "subscription_auth_unverifiable" });

      const target = path.join(root, "auth-target.json");
      await fs.writeFile(target, JSON.stringify({ auth_mode: "chatgpt" }), { mode: 0o600 });
      await fs.rm(authPath);
      await fs.symlink(target, authPath);
      await expect(assertCodexSubscriptionOnlyLaunchable(context({}) as never))
        .rejects.toMatchObject({ code: "subscription_auth_unverifiable" });

      await fs.rm(authPath);
      await writeSecureChatGptAuth(sharedHome);
      const configPath = path.join(sharedHome, "config.toml");
      await fs.writeFile(configPath, "# benign\n", { mode: 0o666 });
      await fs.chmod(configPath, 0o666);
      await expect(assertCodexSubscriptionOnlyLaunchable(context({}) as never))
        .rejects.toMatchObject({ code: "metered_provider_selected" });

      await fs.writeFile(configPath, "x".repeat(64 * 1024 + 1), { mode: 0o600 });
      await fs.chmod(configPath, 0o600);
      await expect(assertCodexSubscriptionOnlyLaunchable(context({}) as never))
        .rejects.toMatchObject({ code: "metered_provider_selected" });

      await fs.rm(configPath);
      const configTarget = path.join(root, "benign.toml");
      await fs.writeFile(configTarget, "# benign\n", { mode: 0o600 });
      await fs.symlink(configTarget, configPath);
      await expect(assertCodexSubscriptionOnlyLaunchable(context({}) as never))
        .rejects.toMatchObject({ code: "metered_provider_selected" });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("copies verified auth into a private regular-file per-run snapshot", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-subscription-codex-snapshot-source-"));
    try {
      await writeSecureChatGptAuth(root);
      const snapshot = await createCodexSubscriptionAuthSnapshot([root]);
      expect(snapshot.status).toBe("present");
      if (snapshot.status !== "present") throw new Error("expected snapshot");
      const [homeStat, authStat] = await Promise.all([
        fs.lstat(snapshot.home),
        fs.lstat(path.join(snapshot.home, "auth.json")),
      ]);
      expect(homeStat.isDirectory()).toBe(true);
      expect(homeStat.mode & 0o077).toBe(0);
      expect(authStat.isFile()).toBe(true);
      expect(authStat.isSymbolicLink()).toBe(false);
      expect(authStat.mode & 0o077).toBe(0);
      await fs.writeFile(path.join(root, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "swapped" }), { mode: 0o600 });
      const snapshotted = JSON.parse(await fs.readFile(path.join(snapshot.home, "auth.json"), "utf8"));
      expect(snapshotted.auth_mode).toBe("chatgpt");
      expect(snapshotted.OPENAI_API_KEY).toBeUndefined();
      await fs.rm(snapshot.home, { recursive: true, force: true });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("discards a forged newer snapshot without changing authoritative host auth", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-subscription-codex-snapshot-finalize-"));
    const sharedHome = path.join(root, "shared");
    const logs = vi.fn(async () => {});
    try {
      await fs.mkdir(sharedHome, { recursive: true });
      const hostOlder = refreshedChatGptAuth("host-older", "2026-08-19T01:00:00Z");
      const snapshotNewer = refreshedChatGptAuth("forged-newer", "2099-08-19T02:00:00Z");
      await fs.writeFile(path.join(sharedHome, "auth.json"), hostOlder, { mode: 0o600 });

      const refreshedHome = await fs.mkdtemp(path.join(root, "refreshed-"));
      await fs.writeFile(path.join(refreshedHome, "auth.json"), snapshotNewer, { mode: 0o600 });
      await finalizeCodexSubscriptionAuthSnapshot({ snapshotHome: refreshedHome, onLog: logs });
      expect(await fs.readFile(path.join(sharedHome, "auth.json"), "utf8")).toBe(hostOlder);
      await expect(fs.lstat(refreshedHome)).rejects.toMatchObject({ code: "ENOENT" });
      expect(logs).toHaveBeenCalledWith(
        "stdout",
        expect.stringContaining("refresh or re-auth must be completed in the authoritative host login"),
      );
      expect(JSON.stringify(logs.mock.calls)).not.toContain("forged-newer");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("removes a symlinked snapshot auth without following it or changing host auth", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-subscription-codex-snapshot-symlink-"));
    const sharedHome = path.join(root, "shared");
    const snapshotHome = path.join(root, "snapshot");
    const hostAuth = refreshedChatGptAuth("host", "2026-08-19T01:00:00Z");
    try {
      await fs.mkdir(sharedHome, { recursive: true });
      await fs.mkdir(snapshotHome, { mode: 0o700 });
      await fs.writeFile(path.join(sharedHome, "auth.json"), hostAuth, { mode: 0o600 });
      await fs.symlink(path.join(sharedHome, "auth.json"), path.join(snapshotHome, "auth.json"));

      await finalizeCodexSubscriptionAuthSnapshot({ snapshotHome, onLog: async () => {} });

      expect(await fs.readFile(path.join(sharedHome, "auth.json"), "utf8")).toBe(hostAuth);
      await expect(fs.lstat(snapshotHome)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("discards an auth file swapped after snapshot creation without host copyback", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-subscription-codex-snapshot-swap-"));
    const sharedHome = path.join(root, "shared");
    const snapshotHome = path.join(root, "snapshot");
    const hostAuth = refreshedChatGptAuth("host", "2026-08-19T01:00:00Z");
    try {
      await fs.mkdir(sharedHome, { recursive: true });
      await fs.mkdir(snapshotHome, { mode: 0o700 });
      await fs.writeFile(path.join(sharedHome, "auth.json"), hostAuth, { mode: 0o600 });
      await fs.writeFile(
        path.join(snapshotHome, "auth.json"),
        refreshedChatGptAuth("original", "2026-08-19T01:30:00Z"),
        { mode: 0o600 },
      );
      await fs.rename(path.join(snapshotHome, "auth.json"), path.join(snapshotHome, "auth.original.json"));
      await fs.writeFile(
        path.join(snapshotHome, "auth.json"),
        refreshedChatGptAuth("swapped-forgery", "2099-08-19T02:00:00Z"),
        { mode: 0o600 },
      );

      await finalizeCodexSubscriptionAuthSnapshot({ snapshotHome, onLog: async () => {} });

      expect(await fs.readFile(path.join(sharedHome, "auth.json"), "utf8")).toBe(hostAuth);
      await expect(fs.lstat(snapshotHome)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it.each(["cli", "acp"])("environment test blocks forbidden %s config before probing", async (engine) => {
    const result = await testEnvironment({
      companyId: "company-1", adapterType: "codex_local", config: { billingPolicy: "subscription_only", engine, env: { OPENAI_API_KEY: "secret" } },
    });
    expect(result).toMatchObject({
      status: "fail",
      checks: [{ code: engine === "acp" ? "subscription_environment_unsupported" : "metered_credential_present" }],
    });
  });

  it("fails explicit ACP environment testing closed with securely inspected ChatGPT auth", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-subscription-codex-acp-test-"));
    const sharedHome = path.join(root, "shared");
    try {
      await fs.mkdir(sharedHome, { recursive: true });
      await writeSecureChatGptAuth(sharedHome);
      vi.stubEnv("PAPERCLIP_HOME", path.join(root, "paperclip"));
      vi.stubEnv("PAPERCLIP_INSTANCE_ID", "test");
      vi.stubEnv("CODEX_HOME", sharedHome);
      const result = await testEnvironment({
        companyId: "company-1",
        adapterType: "codex_local",
        config: { billingPolicy: "subscription_only", engine: "acp" },
      });
      expect(result).toMatchObject({ status: "fail", checks: [{ code: "subscription_environment_unsupported" }] });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("fails explicit ACP environment testing before requiring auth", async () => {
    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "codex_local",
      config: { billingPolicy: "subscription_only", engine: "acp", env: {} },
    });
    expect(result).toMatchObject({ status: "fail", checks: [{ code: "subscription_environment_unsupported" }] });
  });
});
