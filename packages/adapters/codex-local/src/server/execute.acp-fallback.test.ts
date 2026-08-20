import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SUBSCRIPTION_POLICY_TRANSPORT_INTERCEPTION_ENV_KEYS } from "@paperclipai/adapter-utils";

const {
  ensureAdapterExecutionTargetCommandResolvable,
  ensureAdapterExecutionTargetRuntimeCommandInstalled,
  codexHomeHasCustomProviderRouting,
  codexHomeHasProvableChatGptSubscriptionAuth,
  createCodexSubscriptionAuthSnapshot,
  evaluateCodexCredentialReadiness,
  executeCodexAcp,
  prepareManagedCodexHome,
  prepareCodexRuntimeConfig,
  readPaperclipRuntimeSkillEntries,
  resolveAdapterExecutionTargetCommandForLogs,
  runAdapterExecutionTargetProcess,
  seedManagedCodexHome,
  selectVendCredential,
  tempCodexHome,
} = vi.hoisted(() => ({
  ensureAdapterExecutionTargetCommandResolvable: vi.fn(async () => undefined),
  ensureAdapterExecutionTargetRuntimeCommandInstalled: vi.fn(async () => undefined),
  codexHomeHasCustomProviderRouting: vi.fn(async (_home: string) => false),
  codexHomeHasProvableChatGptSubscriptionAuth: vi.fn(async (_home: string) => "present"),
  createCodexSubscriptionAuthSnapshot: vi.fn(async () => ({
    status: "present",
    home: "/tmp/paperclip-codex-acp-fallback-test-home-subscription-snapshot",
  })),
  evaluateCodexCredentialReadiness: vi.fn(async () => ({
    managed: true,
    authMode: "api",
    ready: true,
    effectiveHome: "/tmp/paperclip-codex-acp-fallback-test-home",
    sharedSourceHome: "/tmp/paperclip-codex-acp-fallback-test-home",
  })),
  executeCodexAcp: vi.fn(async () => {
    throw new Error('Transform failed with 1 error: execute.ts:818:0: ERROR: Unexpected "<<"');
  }),
  prepareManagedCodexHome: vi.fn(async () => ({ status: "seeded", home: "/tmp/paperclip-codex-acp-fallback-test-home" })),
  prepareCodexRuntimeConfig: vi.fn(async () => ({ cleanup: vi.fn(async () => undefined), notes: [] })),
  readPaperclipRuntimeSkillEntries: vi.fn(async () => []),
  resolveAdapterExecutionTargetCommandForLogs: vi.fn(async () => "codex"),
  runAdapterExecutionTargetProcess: vi.fn(async (..._args: unknown[]) => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: [
      JSON.stringify({ type: "thread.started", thread_id: "codex-thread-1" }),
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "hello" },
      }),
      JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 },
      }),
    ].join("\n"),
    stderr: "",
    pid: 123,
    startedAt: new Date().toISOString(),
  })),
  seedManagedCodexHome: vi.fn(async () => ({ status: "seeded", home: "/tmp/paperclip-codex-acp-fallback-test-home" })),
  selectVendCredential: vi.fn(async () => ({ status: "skipped" })),
  tempCodexHome: "/tmp/paperclip-codex-acp-fallback-test-home",
}));

vi.mock("./acp.js", () => ({
  createCodexAcpExecutor: () => executeCodexAcp,
  formatCodexAcpFallbackMessage: (reason: string) =>
    `[paperclip] Codex ACP default unavailable; falling back to Codex CLI. ${reason} Set engine=acp to require ACP or engine=cli to silence this fallback.\n`,
  resolveCodexExecutionEngineForRun: async (ctx: { config: Record<string, unknown> }) =>
    ctx.config.engine === "acp"
      ? { engine: "acp", explicit: true }
      : { engine: "acp", explicit: false },
}));

vi.mock("@paperclipai/adapter-utils/execution-target", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/execution-target")>(
    "@paperclipai/adapter-utils/execution-target",
  );
  return {
    ...actual,
    ensureAdapterExecutionTargetCommandResolvable,
    ensureAdapterExecutionTargetRuntimeCommandInstalled,
    resolveAdapterExecutionTargetCommandForLogs,
    runAdapterExecutionTargetProcess,
  };
});

vi.mock("@paperclipai/adapter-utils/server-utils", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/server-utils")>(
    "@paperclipai/adapter-utils/server-utils",
  );
  return {
    ...actual,
    readPaperclipRuntimeSkillEntries,
  };
});

vi.mock("./codex-home.js", async () => {
  const actual = await vi.importActual<typeof import("./codex-home.js")>("./codex-home.js");
  return {
    ...actual,
    codexHomeHasCustomProviderRouting,
    validateManagedCodexHomePathAuthority: vi.fn(async (...args: unknown[]) => args[4] ?? Object.freeze({})),
    codexHomeHasProvableChatGptSubscriptionAuth,
    createCodexSubscriptionAuthSnapshot,
    evaluateCodexCredentialReadiness,
    isManagedCodexHomePath: vi.fn(() => true),
    prepareManagedCodexHome,
    resolveManagedCodexHomeDir: vi.fn((_env, companyId?: string, agentId?: string) =>
      agentId
        ? `/tmp/paperclip/companies/${companyId}/agents/${agentId}/codex-home`
        : tempCodexHome),
    seedManagedCodexHome,
  };
});

vi.mock("./codex-auth-cache.js", async () => {
  const actual = await vi.importActual<typeof import("./codex-auth-cache.js")>("./codex-auth-cache.js");
  return { ...actual, isCodexAuthCacheEnabled: vi.fn(() => true), selectVendCredential };
});

vi.mock("./runtime-config.js", async () => {
  const actual = await vi.importActual<typeof import("./runtime-config.js")>("./runtime-config.js");
  return {
    ...actual,
    prepareCodexRuntimeConfig,
  };
});

import { execute } from "./execute.js";
import { inspectCodexSubscriptionAuthAuthority } from "./subscription-auth-authority.js";

function buildContext(config: Record<string, unknown> = {}) {
  return {
    runId: "run-1",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "Codex Coder",
      adapterType: "codex_local",
      adapterConfig: {},
    },
    runtime: {
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: null,
    },
    config: {
      outputInactivityTimeoutMs: null,
      env: { OPENAI_API_KEY: "test-key" },
      ...config,
    },
    context: {},
    onLog: vi.fn(async () => {}),
  };
}

describe("codex_local ACP startup fallback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const key of ["NODE_OPTIONS", "NODE_PATH", "LD_PRELOAD", "LD_LIBRARY_PATH", "DYLD_INSERT_LIBRARIES", "DYLD_LIBRARY_PATH", "BASH_ENV", "ENV", "SHELLOPTS", "CLAUDE_CONFIG_DIR", "CODEX_PERMISSION_PROFILE", ...SUBSCRIPTION_POLICY_TRANSPORT_INTERCEPTION_ENV_KEYS]) {
      vi.stubEnv(key, "");
      vi.stubEnv(key.toLowerCase(), "");
    }
    evaluateCodexCredentialReadiness.mockResolvedValue({
      managed: true,
      authMode: "api",
      ready: true,
      effectiveHome: tempCodexHome,
      sharedSourceHome: tempCodexHome,
    });
    codexHomeHasProvableChatGptSubscriptionAuth.mockResolvedValue("present");
    codexHomeHasCustomProviderRouting.mockResolvedValue(false);
    createCodexSubscriptionAuthSnapshot.mockResolvedValue({
      status: "present",
      home: `${tempCodexHome}-subscription-snapshot`,
    });
  });
  afterEach(() => vi.unstubAllEnvs());

  it("blocks auto fallback before ACP or CLI provider creation", async () => {
    await expect(execute(buildContext({
      billingPolicy: "subscription_only",
      engine: "auto",
      env: { OPENAI_API_KEY: "secret" },
    }) as never)).rejects.toMatchObject({ code: "metered_credential_present" });
    expect(executeCodexAcp).not.toHaveBeenCalled();
    expect(runAdapterExecutionTargetProcess).not.toHaveBeenCalled();
  });

  it("passes subscription isolation flags in Codex exec subcommand order to the real process seam", async () => {
    evaluateCodexCredentialReadiness.mockResolvedValue({
      managed: true,
      authMode: "chatgpt",
      ready: true,
      effectiveHome: tempCodexHome,
      sharedSourceHome: tempCodexHome,
    });

    const result = await execute(buildContext({
      billingPolicy: "subscription_only",
      engine: "auto",
      env: {},
    }) as never);

    expect(result.billingType).toBe("subscription");
    expect(executeCodexAcp).not.toHaveBeenCalled();
    expect(runAdapterExecutionTargetProcess).toHaveBeenCalledTimes(1);
    const seedCall = seedManagedCodexHome.mock.calls[0] as unknown as [string];
    expect(seedCall[0]).toContain(
      "/companies/company-1/agents/agent-1/codex-home",
    );
    const processCall = runAdapterExecutionTargetProcess.mock.calls[0] as unknown as [
      unknown,
      unknown,
      unknown,
      string[],
      { env: Record<string, string> },
    ];
    expect(processCall[3].slice(0, 3)).toEqual([
      "exec",
      "--ignore-rules",
      "--json",
    ]);
    expect(processCall[3]).not.toContain("--ignore-user-config");
    expect(prepareCodexRuntimeConfig).toHaveBeenCalledWith(expect.objectContaining({
      codexHome: `${tempCodexHome}-subscription-snapshot`,
    }));
    const processOptions = processCall[4];
    expect(processOptions.env.CODEX_HOME).toBe(`${tempCodexHome}-subscription-snapshot`);
  });

  it("spawns from the prepared captured auth snapshot after the managed source changes", async () => {
    vi.stubEnv("PAPERCLIP_DECISION_SIGNING_SECRET", "host-decision-secret");
    const companyId = "11111111-1111-4111-8111-111111111111";
    const agentId = "22222222-2222-4222-8222-222222222222";
    const sourceHome = `/tmp/paperclip/companies/${companyId}/agents/${agentId}/codex-home`;
    const sharedHome = `/tmp/paperclip-shared-${process.pid}-${Date.now()}`;
    vi.stubEnv("CODEX_HOME", sharedHome);
    const sourceAuth = path.join(sourceHome, "auth.json");
    const auth = (account: string, marker: string) => JSON.stringify({
      auth_mode: "chatgpt",
      tokens: { account_id: account, id_token: `id-${marker}`, access_token: `access-${marker}`, refresh_token: `refresh-${marker}` },
    });
    const captured = auth("account-a", "captured");
    await fs.mkdir(sourceHome, { recursive: true, mode: 0o700 });
    await fs.writeFile(sourceAuth, captured, { mode: 0o600 });
    const inspected = await inspectCodexSubscriptionAuthAuthority({
      mode: "prepare",
      adapterType: "codex_local",
      companyId,
      agentId,
      config: { billingPolicy: "subscription_only", engine: "cli", env: {} },
      env: {},
      authSource: { kind: "managed_local_profile", profile: "codex_agent_home", location: sourceHome },
      signOpaque: (domain, bytes) => `decision-spec-v1.${createHash("sha256").update(domain).update(bytes).digest("hex")}`,
    });
    await fs.rm(sourceAuth);
    await fs.mkdir(sharedHome, { recursive: true });
    await fs.writeFile(path.join(sharedHome, "config.toml"), 'openai_base_url = "https://metered.invalid"\n');
    codexHomeHasCustomProviderRouting.mockImplementation(async (home: string) => path.resolve(home) === path.resolve(sharedHome));
    let spawnedAuth = "";
    let spawnedEnv: Record<string, string> = {};
    runAdapterExecutionTargetProcess.mockImplementationOnce(async (...args: unknown[]) => {
      const options = args[4] as { env: Record<string, string> };
      spawnedEnv = { ...options.env };
      spawnedAuth = await fs.readFile(path.join(options.env.CODEX_HOME, "auth.json"), "utf8");
      return {
        exitCode: 0, signal: null, timedOut: false,
        stdout: [JSON.stringify({ type: "thread.started", thread_id: "codex-thread-1" }), JSON.stringify({ type: "turn.completed", usage: {} })].join("\n"),
        stderr: "", pid: 123, startedAt: new Date().toISOString(),
      };
    });
    const ctx = buildContext({ billingPolicy: "subscription_only", engine: "cli", env: {} });
    Object.assign(ctx, { preparedSubscriptionAuthAuthority: inspected.prepared, authToken: "run-scoped-paperclip-token" });
    await execute(ctx as never);
    expect(spawnedAuth).toBe(captured);
    expect(spawnedEnv.PAPERCLIP_DECISION_SIGNING_SECRET).toBeUndefined();
    expect(spawnedEnv.PAPERCLIP_API_KEY).toBe("run-scoped-paperclip-token");
    expect(spawnedEnv.PAPERCLIP_RUN_ID).toBe("run-1");
    expect(runAdapterExecutionTargetProcess).toHaveBeenCalledOnce();
    expect((runAdapterExecutionTargetProcess.mock.calls[0]?.[4] as { exactEnvironment?: boolean }).exactEnvironment).toBe(true);
    expect(selectVendCredential).not.toHaveBeenCalled();
    expect(seedManagedCodexHome).not.toHaveBeenCalled();
    expect(prepareManagedCodexHome).not.toHaveBeenCalled();
    expect(evaluateCodexCredentialReadiness).not.toHaveBeenCalled();
    expect(createCodexSubscriptionAuthSnapshot).not.toHaveBeenCalled();
    expect(codexHomeHasProvableChatGptSubscriptionAuth).toHaveBeenCalledTimes(2);
    expect(codexHomeHasProvableChatGptSubscriptionAuth.mock.calls.every(([home]) => home !== sourceHome)).toBe(true);
    expect(codexHomeHasCustomProviderRouting.mock.calls.every(([home]) => path.resolve(home) !== path.resolve(sharedHome))).toBe(true);
    await fs.rm(sourceHome, { recursive: true, force: true });
    await fs.rm(sharedHome, { recursive: true, force: true });
  });

  it("falls back to Codex CLI when auto-selected ACP fails before execution starts", async () => {
    const ctx = buildContext();

    const result = await execute(ctx as never);

    expect(result.exitCode).toBe(0);
    expect(result.summary).toBe("hello");
    expect(executeCodexAcp).toHaveBeenCalledTimes(1);
    expect(runAdapterExecutionTargetProcess).toHaveBeenCalledTimes(1);
    expect(ctx.onLog).toHaveBeenCalledWith(
      "stderr",
      expect.stringContaining("Codex ACP startup failed"),
    );
    expect(ctx.onLog).toHaveBeenCalledWith(
      "stderr",
      expect.stringContaining('Unexpected "<<"'),
    );
  });

  it("keeps explicit ACP strict when startup fails", async () => {
    const ctx = buildContext({ engine: "acp" });

    await expect(execute(ctx as never)).rejects.toThrow('Unexpected "<<"');

    expect(runAdapterExecutionTargetProcess).not.toHaveBeenCalled();
  });
});
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
