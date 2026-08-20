import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SUBSCRIPTION_POLICY_TRANSPORT_INTERCEPTION_ENV_KEYS } from "@paperclipai/adapter-utils";

const {
  ensureAdapterExecutionTargetCommandResolvable,
  ensureAdapterExecutionTargetRuntimeCommandInstalled,
  executeClaudeAcp,
  resolveAdapterExecutionTargetCommandForLogs,
  runAdapterExecutionTargetProcess,
} = vi.hoisted(() => ({
  ensureAdapterExecutionTargetCommandResolvable: vi.fn(async () => undefined),
  ensureAdapterExecutionTargetRuntimeCommandInstalled: vi.fn(async () => undefined),
  executeClaudeAcp: vi.fn(async () => {
    throw new Error('Transform failed with 1 error: execute.ts:818:0: ERROR: Unexpected "<<"');
  }),
  resolveAdapterExecutionTargetCommandForLogs: vi.fn(async () => "claude"),
  runAdapterExecutionTargetProcess: vi.fn(async (..._args: unknown[]) => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: [
      JSON.stringify({ type: "system", subtype: "init", session_id: "claude-session-1", model: "claude-sonnet" }),
      JSON.stringify({
        type: "assistant",
        session_id: "claude-session-1",
        message: { content: [{ type: "text", text: "hello" }] },
      }),
      JSON.stringify({
        type: "result",
        session_id: "claude-session-1",
        result: "hello",
        usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1 },
      }),
    ].join("\n"),
    stderr: "",
    pid: 123,
    startedAt: new Date().toISOString(),
  })),
}));

vi.mock("./acp.js", () => ({
  createClaudeAcpExecutor: () => executeClaudeAcp,
  formatClaudeAcpFallbackMessage: (reason: string) =>
    `[paperclip] Claude ACP default unavailable; falling back to Claude CLI. ${reason} Set engine=acp to require ACP or engine=cli to silence this fallback.\n`,
  resolveClaudeExecutionEngineForRun: async (ctx: { config: Record<string, unknown> }) =>
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

import { execute } from "./execute.js";
import { inspectClaudeSubscriptionAuthAuthority } from "./subscription-auth-authority.js";

function buildContext(config: Record<string, unknown> = {}) {
  return {
    runId: "run-1",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "Claude Coder",
      adapterType: "claude_local",
      adapterConfig: {},
    },
    runtime: {
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: null,
    },
    config,
    context: {},
    onLog: vi.fn(async () => {}),
  };
}

describe("claude_local ACP startup fallback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const key of ["NODE_OPTIONS", "NODE_PATH", "LD_PRELOAD", "LD_LIBRARY_PATH", "DYLD_INSERT_LIBRARIES", "DYLD_LIBRARY_PATH", "BASH_ENV", "ENV", "SHELLOPTS", "CLAUDE_CONFIG_DIR", ...SUBSCRIPTION_POLICY_TRANSPORT_INTERCEPTION_ENV_KEYS]) {
      vi.stubEnv(key, "");
      vi.stubEnv(key.toLowerCase(), "");
    }
  });

  it("blocks auto fallback before ACP or CLI provider creation", async () => {
    await expect(execute(buildContext({
      billingPolicy: "subscription_only",
      engine: "auto",
      env: { ANTHROPIC_API_KEY: "secret" },
    }) as never)).rejects.toMatchObject({ code: "metered_credential_present" });
    expect(executeClaudeAcp).not.toHaveBeenCalled();
    expect(runAdapterExecutionTargetProcess).not.toHaveBeenCalled();
  });

  it("routes subscription-only auto to isolated CLI argv without attempting ACP", async () => {
    const ctx = buildContext({
      billingPolicy: "subscription_only",
      engine: "auto",
      env: { CLAUDE_CODE_OAUTH_TOKEN: "oauth-token" },
    });
    const result = await execute(ctx as never);
    expect(result.billingType).toBe("subscription");
    expect(executeClaudeAcp).not.toHaveBeenCalled();
    expect(runAdapterExecutionTargetProcess).toHaveBeenCalledWith(
      expect.any(String),
      null,
      "claude",
      expect.arrayContaining(["--setting-sources", ""]),
      expect.any(Object),
    );
  });

  it("uses invalid captured OAuth in an isolated home and cannot fall back to a valid host login", async () => {
    vi.stubEnv("PAPERCLIP_DECISION_SIGNING_SECRET", "host-decision-secret");
    const hostHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-host-login-"));
    const hostConfig = path.join(hostHome, ".claude");
    await fs.mkdir(hostConfig, { recursive: true });
    await fs.writeFile(path.join(hostConfig, "settings.json"), JSON.stringify({ apiProvider: "firstParty" }));
    vi.stubEnv("HOME", hostHome);
    vi.stubEnv("CLAUDE_CONFIG_DIR", hostConfig);
    const token = "invalid-captured-oauth";
    const prepared = await inspectClaudeSubscriptionAuthAuthority({
      mode: "prepare",
      adapterType: "claude_local",
      companyId: "11111111-1111-4111-8111-111111111111",
      agentId: "22222222-2222-4222-8222-222222222222",
      config: { billingPolicy: "subscription_only", engine: "cli", env: { CLAUDE_CODE_OAUTH_TOKEN: token } },
      env: { CLAUDE_CODE_OAUTH_TOKEN: token },
      authSource: {
        kind: "resolved_user_secret_version",
        configPath: "env.CLAUDE_CODE_OAUTH_TOKEN",
        key: "CLAUDE_CODE_OAUTH_TOKEN",
        secretId: "33333333-3333-4333-8333-333333333333",
        versionId: "44444444-4444-4444-8444-444444444444",
        version: 1,
        value: token,
      },
      signOpaque: (domain, bytes) => `decision-spec-v1.${createHash("sha256").update(domain).update(bytes).digest("hex")}`,
    });
    let seenEnv: Record<string, string> = {};
    runAdapterExecutionTargetProcess.mockImplementationOnce(async (...args: unknown[]) => {
      const options = args[4] as { env?: Record<string, string> };
      seenEnv = { ...(options.env ?? {}) };
      return {
        exitCode: 1,
        signal: null,
        timedOut: false,
        stdout: JSON.stringify({
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          result: "Failed to authenticate. Invalid bearer token",
          total_cost_usd: 0,
        }),
        stderr: "",
        pid: 123,
        startedAt: new Date().toISOString(),
      };
    });
    const ctx = buildContext({
      billingPolicy: "subscription_only",
      engine: "cli",
      env: { CLAUDE_CODE_OAUTH_TOKEN: token },
    });
    Object.assign(ctx, { preparedSubscriptionAuthAuthority: prepared.prepared, authToken: "run-scoped-paperclip-token" });
    const result = await execute(ctx as never);
    expect(result.exitCode).toBe(1);
    expect(runAdapterExecutionTargetProcess).toHaveBeenCalledOnce();
    expect((runAdapterExecutionTargetProcess.mock.calls[0]?.[4] as { exactEnvironment?: boolean }).exactEnvironment).toBe(true);
    expect(seenEnv.CLAUDE_CODE_OAUTH_TOKEN).toBe(token);
    expect(seenEnv.HOME).not.toBe(hostHome);
    expect(seenEnv.CLAUDE_CONFIG_DIR).not.toBe(hostConfig);
    expect(seenEnv.CLAUDE_CONFIG_DIR).toContain("paperclip-claude-auth-authority-");
    expect(seenEnv.ANTHROPIC_API_KEY).toBeUndefined();
    expect(seenEnv.PAPERCLIP_DECISION_SIGNING_SECRET).toBeUndefined();
    expect(seenEnv.PAPERCLIP_API_KEY).toBe("run-scoped-paperclip-token");
    expect(seenEnv.PAPERCLIP_RUN_ID).toBe("run-1");
    await fs.rm(hostHome, { recursive: true, force: true });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("falls back to Claude CLI when auto-selected ACP fails before execution starts", async () => {
    const ctx = buildContext();

    const result = await execute(ctx as never);

    expect(result.exitCode).toBe(0);
    expect(executeClaudeAcp).toHaveBeenCalledTimes(1);
    expect(runAdapterExecutionTargetProcess).toHaveBeenCalledTimes(1);
    expect(ctx.onLog).toHaveBeenCalledWith(
      "stderr",
      expect.stringContaining("Claude ACP startup failed"),
    );
    expect(ctx.onLog).toHaveBeenCalledWith(
      "stderr",
      expect.stringContaining('Unexpected "<<"'),
    );
  });

  it("trusts the Paperclip API URL when network access is allowlisted", async () => {
    const paperclipApiUrl = "http://127.0.0.1:4310";
    vi.stubEnv("PAPERCLIP_RUNTIME_API_URL", paperclipApiUrl);
    const ctx = buildContext({ networkScope: "allowlist" });

    await execute(ctx as never);

    expect(runAdapterExecutionTargetProcess).toHaveBeenCalledTimes(1);
    expect(runAdapterExecutionTargetProcess).toHaveBeenCalledWith(
      expect.any(String),
      null,
      expect.any(String),
      expect.any(Array),
      expect.objectContaining({
        localProcessSandbox: expect.objectContaining({
          networkScope: "allowlist",
          networkTrustedUrls: [paperclipApiUrl],
        }),
      }),
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
import os from "node:os";
import path from "node:path";
