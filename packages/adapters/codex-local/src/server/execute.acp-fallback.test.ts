import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SUBSCRIPTION_POLICY_TRANSPORT_INTERCEPTION_ENV_KEYS } from "@paperclipai/adapter-utils";

const {
  ensureAdapterExecutionTargetCommandResolvable,
  ensureAdapterExecutionTargetRuntimeCommandInstalled,
  evaluateCodexCredentialReadiness,
  executeCodexAcp,
  prepareCodexRuntimeConfig,
  readPaperclipRuntimeSkillEntries,
  resolveAdapterExecutionTargetCommandForLogs,
  runAdapterExecutionTargetProcess,
  seedManagedCodexHome,
  tempCodexHome,
} = vi.hoisted(() => ({
  ensureAdapterExecutionTargetCommandResolvable: vi.fn(async () => undefined),
  ensureAdapterExecutionTargetRuntimeCommandInstalled: vi.fn(async () => undefined),
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
  prepareCodexRuntimeConfig: vi.fn(async () => ({ cleanup: vi.fn(async () => undefined), notes: [] })),
  readPaperclipRuntimeSkillEntries: vi.fn(async () => []),
  resolveAdapterExecutionTargetCommandForLogs: vi.fn(async () => "codex"),
  runAdapterExecutionTargetProcess: vi.fn(async () => ({
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
    codexHomeHasCustomProviderRouting: vi.fn(async () => false),
    codexHomeHasProvableChatGptSubscriptionAuth: vi.fn(async () => "present"),
    createCodexSubscriptionAuthSnapshot: vi.fn(async () => ({
      status: "present",
      home: `${tempCodexHome}-subscription-snapshot`,
    })),
    evaluateCodexCredentialReadiness,
    isManagedCodexHomePath: vi.fn(() => true),
    prepareManagedCodexHome: vi.fn(async () => ({ status: "seeded", home: tempCodexHome })),
    resolveManagedCodexHomeDir: vi.fn((_env, companyId?: string, agentId?: string) =>
      agentId
        ? `/tmp/paperclip/companies/${companyId}/agents/${agentId}/codex-home`
        : tempCodexHome),
    seedManagedCodexHome,
  };
});

vi.mock("./runtime-config.js", async () => {
  const actual = await vi.importActual<typeof import("./runtime-config.js")>("./runtime-config.js");
  return {
    ...actual,
    prepareCodexRuntimeConfig,
  };
});

import { execute } from "./execute.js";

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
