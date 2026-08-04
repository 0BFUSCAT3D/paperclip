import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";

const { mockRunProcess } = vi.hoisted(() => ({ mockRunProcess: vi.fn() }));

vi.mock("@paperclipai/adapter-utils/execution-target", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@paperclipai/adapter-utils/execution-target")>();
  return {
    ...actual,
    runAdapterExecutionTargetProcess: mockRunProcess,
  };
});

import { getQuotaWindows } from "./quota.js";

const SANDBOX_TARGET: AdapterExecutionTarget = {
  kind: "remote",
  transport: "sandbox",
  remoteCwd: "/workspace",
  providerKey: "test-sandbox",
};

function cannedProcess(stdout: string) {
  return { exitCode: 0, signal: null, timedOut: false, stdout, stderr: "", pid: null, startedAt: "" };
}

describe("getQuotaWindows sandbox target", () => {
  let previousBedrock: string | undefined;

  beforeEach(() => {
    mockRunProcess.mockReset();
    previousBedrock = process.env.CLAUDE_CODE_USE_BEDROCK;
  });

  afterEach(() => {
    if (previousBedrock === undefined) {
      delete process.env.CLAUDE_CODE_USE_BEDROCK;
    } else {
      process.env.CLAUDE_CODE_USE_BEDROCK = previousBedrock;
    }
  });

  it("runs the probe through the exec seam and parses stdout into a ProviderQuotaResult", async () => {
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

    expect(mockRunProcess).toHaveBeenCalledTimes(1);
    const [, target, command] = mockRunProcess.mock.calls[0];
    expect(target).toBe(SANDBOX_TARGET);
    expect(command).toBe("claude");
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
    expect(nullTargetResult).toEqual(hostResult);
    expect(hostResult).toEqual({
      provider: "anthropic",
      source: "bedrock",
      ok: true,
      windows: [],
    });
  });
});
