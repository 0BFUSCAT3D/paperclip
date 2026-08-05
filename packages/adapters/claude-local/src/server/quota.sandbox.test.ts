import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";

const { mockRunProcess, mockStage } = vi.hoisted(() => ({
  mockRunProcess: vi.fn(),
  mockStage: vi.fn(),
}));

vi.mock("@paperclipai/adapter-utils/execution-target", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@paperclipai/adapter-utils/execution-target")>();
  return {
    ...actual,
    runAdapterExecutionTargetProcess: mockRunProcess,
    stageAdapterExecutionTargetProbeScript: mockStage,
  };
});

import { getQuotaWindows } from "./quota.js";
import { getClaudeQuotaProbeSource } from "../cli/quota-probe-source.js";

const SANDBOX_TARGET: AdapterExecutionTarget = {
  kind: "remote",
  transport: "sandbox",
  remoteCwd: "/workspace",
  providerKey: "test-sandbox",
};

const STAGED_PROBE_PATH = "/workspace/.paperclip-runtime/claude/quota/quota-probe.sh";

function cannedProcess(stdout: string) {
  return { exitCode: 0, signal: null, timedOut: false, stdout, stderr: "", pid: null, startedAt: "" };
}

describe("getQuotaWindows sandbox target", () => {
  let previousBedrock: string | undefined;
  let previousConfigDir: string | undefined;
  let isolatedConfigDir: string | undefined;

  beforeEach(() => {
    mockRunProcess.mockReset();
    mockStage.mockReset();
    mockStage.mockResolvedValue(STAGED_PROBE_PATH);
    previousBedrock = process.env.CLAUDE_CODE_USE_BEDROCK;
    previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
    // Point the host token reader at an empty directory, so the sandbox path
    // injects no token by default. A test that needs a token writes one here.
    isolatedConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-claude-quota-sandbox-test-"));
    process.env.CLAUDE_CONFIG_DIR = isolatedConfigDir;
  });

  afterEach(() => {
    if (isolatedConfigDir) {
      try {
        fs.rmSync(isolatedConfigDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
      isolatedConfigDir = undefined;
    }
    if (previousBedrock === undefined) {
      delete process.env.CLAUDE_CODE_USE_BEDROCK;
    } else {
      process.env.CLAUDE_CODE_USE_BEDROCK = previousBedrock;
    }
    if (previousConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = previousConfigDir;
    }
  });

  it("stages the probe script and runs it through the exec seam (not --version)", async () => {
    const envelope = JSON.stringify({
      provider: "anthropic",
      source: "claude-cli",
      ok: true,
      windows: [
        {
          label: "Current session",
          usedPercent: 42,
          resetsAt: "2026-08-04T10:00:00.000Z",
          valueLabel: null,
          detail: "Resets soon",
        },
      ],
    });
    mockRunProcess.mockResolvedValue(cannedProcess(envelope));

    const result = await getQuotaWindows({ executionTarget: SANDBOX_TARGET });

    expect(mockStage).toHaveBeenCalledTimes(1);
    const [stageTarget, stageInput] = mockStage.mock.calls[0];
    expect(stageTarget).toBe(SANDBOX_TARGET);
    expect(stageInput.scriptName).toBe("quota-probe.sh");
    expect(stageInput.body).toBe(await getClaudeQuotaProbeSource());

    expect(mockRunProcess).toHaveBeenCalledTimes(1);
    const [, target, command, args] = mockRunProcess.mock.calls[0];
    expect(target).toBe(SANDBOX_TARGET);
    expect(command).toBe("sh");
    expect(args).toEqual([STAGED_PROBE_PATH]);
    expect(args).not.toContain("--version");

    expect(result).toEqual({
      provider: "anthropic",
      source: "claude-cli",
      ok: true,
      windows: [
        {
          label: "Current session",
          usedPercent: 42,
          resetsAt: "2026-08-04T10:00:00.000Z",
          valueLabel: null,
          detail: "Resets soon",
        },
      ],
    });
  });

  it("passes the token to the probe by env only, never in argv (C7)", async () => {
    // Write a host credential file so the token reader returns a token.
    const token = "sk-ant-oauth-test-token-value";
    fs.writeFileSync(
      path.join(isolatedConfigDir as string, ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { accessToken: token } }),
    );
    mockRunProcess.mockResolvedValue(cannedProcess(JSON.stringify({ provider: "anthropic", ok: true, windows: [] })));

    await getQuotaWindows({ executionTarget: SANDBOX_TARGET });

    const [, , command, args, options] = mockRunProcess.mock.calls[0];
    expect(options.env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: token });
    // The token never appears in the command or in the argument list.
    expect(command).not.toContain(token);
    expect(JSON.stringify(args)).not.toContain(token);
  });

  it("stages adapter-owned bytes that hold no credential, url, or header (C8)", async () => {
    fs.writeFileSync(
      path.join(isolatedConfigDir as string, ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { accessToken: "sk-ant-oauth-test-token-value" } }),
    );
    mockRunProcess.mockResolvedValue(cannedProcess(JSON.stringify({ provider: "anthropic", ok: true, windows: [] })));

    await getQuotaWindows({ executionTarget: SANDBOX_TARGET });

    const stagedBytes: string = mockStage.mock.calls[0][1].body;
    // The staged bytes are the reviewed script source, byte for byte.
    expect(stagedBytes).toBe(await getClaudeQuotaProbeSource());
    // The staged bytes carry no credential value.
    expect(stagedBytes).not.toContain("sk-ant-oauth-test-token-value");
    // The script reads its one allowlisted url from a literal, never a caller value.
    expect(stagedBytes).toContain("https://api.anthropic.com/api/oauth/usage");
    // No caller-controlled interpolation marker leaks into the staged bytes.
    expect(stagedBytes).not.toContain("${CALLER");
  });

  it("drops unknown credential-looking fields from the probe envelope (C2)", async () => {
    const envelope = JSON.stringify({
      provider: "anthropic",
      ok: true,
      accessToken: "sk-ant-secret-should-not-survive",
      windows: [
        {
          label: "Current session",
          usedPercent: 10,
          resetsAt: null,
          valueLabel: null,
          detail: null,
          secretToken: "sk-window-secret-should-not-survive",
        },
      ],
    });
    mockRunProcess.mockResolvedValue(cannedProcess(envelope));

    const result = await getQuotaWindows({ executionTarget: SANDBOX_TARGET });

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("accessToken");
    expect(serialized).not.toContain("secretToken");
    expect(serialized).not.toContain("sk-ant-secret-should-not-survive");
    expect(serialized).not.toContain("sk-window-secret-should-not-survive");
    expect(Object.keys(result.windows[0])).toEqual([
      "label",
      "usedPercent",
      "resetsAt",
      "valueLabel",
      "detail",
    ]);
  });

  it("fails closed without raw output when the probe output is not valid JSON", async () => {
    mockRunProcess.mockResolvedValue(cannedProcess("token=sk-raw-terminal-noise\nnot json"));

    const result = await getQuotaWindows({ executionTarget: SANDBOX_TARGET });

    expect(result.ok).toBe(false);
    expect(result.provider).toBe("anthropic");
    expect(result.windows).toEqual([]);
    expect(JSON.stringify(result)).not.toContain("sk-raw-terminal-noise");
  });

  it("keeps the host probe for a null target and does not touch the exec seam", async () => {
    process.env.CLAUDE_CODE_USE_BEDROCK = "1";

    const hostResult = await getQuotaWindows();
    const nullTargetResult = await getQuotaWindows({ executionTarget: null });

    expect(mockRunProcess).not.toHaveBeenCalled();
    expect(mockStage).not.toHaveBeenCalled();
    expect(nullTargetResult).toEqual(hostResult);
    expect(hostResult).toEqual({
      provider: "anthropic",
      source: "bedrock",
      ok: true,
      windows: [],
    });
  });
});
