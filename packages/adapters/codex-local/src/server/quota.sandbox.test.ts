import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";

const { mockRunProcess, mockSpawn } = vi.hoisted(() => ({
  mockRunProcess: vi.fn(),
  mockSpawn: vi.fn(),
}));

vi.mock("@paperclipai/adapter-utils/execution-target", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@paperclipai/adapter-utils/execution-target")>();
  return {
    ...actual,
    runAdapterExecutionTargetProcess: mockRunProcess,
  };
});

vi.mock("node:child_process", async (importOriginal) => {
  const cp = await importOriginal<typeof import("node:child_process")>();
  return {
    ...cp,
    spawn: (...args: Parameters<typeof cp.spawn>) => mockSpawn(...args) as ReturnType<typeof cp.spawn>,
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

function createChildThatErrorsOnMicrotask(err: Error): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  const stream = Object.assign(new EventEmitter(), { setEncoding: () => {} });
  Object.assign(child, {
    stdout: stream,
    stderr: Object.assign(new EventEmitter(), { setEncoding: () => {} }),
    stdin: { write: vi.fn(), end: vi.fn() },
    kill: vi.fn(),
  });
  queueMicrotask(() => {
    child.emit("error", err);
  });
  return child;
}

describe("getQuotaWindows sandbox target", () => {
  let previousCodexHome: string | undefined;
  let isolatedCodexHome: string | undefined;

  beforeEach(() => {
    mockRunProcess.mockReset();
    mockSpawn.mockReset();
    // Keep the host path offline and deterministic. The app-server spawn errors
    // and CODEX_HOME points at an empty directory, so there is no auth token.
    mockSpawn.mockImplementation(() =>
      createChildThatErrorsOnMicrotask(new Error("spawn codex ENOENT")),
    );
    previousCodexHome = process.env.CODEX_HOME;
    isolatedCodexHome = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-codex-quota-sandbox-test-"));
    process.env.CODEX_HOME = isolatedCodexHome;
  });

  afterEach(() => {
    if (isolatedCodexHome) {
      try {
        fs.rmSync(isolatedCodexHome, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
      isolatedCodexHome = undefined;
    }
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
  });

  it("runs the probe through the exec seam and parses stdout into a ProviderQuotaResult", async () => {
    const envelope = JSON.stringify({
      provider: "openai",
      source: "codex-rpc",
      ok: true,
      windows: [
        {
          label: "5h limit",
          usedPercent: 30,
          resetsAt: "2026-08-04T10:00:00.000Z",
          valueLabel: null,
          detail: null,
        },
      ],
    });
    mockRunProcess.mockResolvedValue(cannedProcess(envelope));

    const result = await getQuotaWindows({ executionTarget: SANDBOX_TARGET });

    expect(mockRunProcess).toHaveBeenCalledTimes(1);
    const [, target, command] = mockRunProcess.mock.calls[0];
    expect(target).toBe(SANDBOX_TARGET);
    expect(command).toBe("codex");
    expect(result).toEqual({
      provider: "openai",
      source: "codex-rpc",
      ok: true,
      windows: [
        {
          label: "5h limit",
          usedPercent: 30,
          resetsAt: "2026-08-04T10:00:00.000Z",
          valueLabel: null,
          detail: null,
        },
      ],
    });
  });

  it("drops unknown credential-looking fields from the probe envelope (C2)", async () => {
    const envelope = JSON.stringify({
      provider: "openai",
      ok: true,
      accessToken: "sk-codex-secret-should-not-survive",
      windows: [
        {
          label: "5h limit",
          usedPercent: 10,
          resetsAt: null,
          valueLabel: null,
          detail: null,
          refreshToken: "rt-window-secret-should-not-survive",
        },
      ],
    });
    mockRunProcess.mockResolvedValue(cannedProcess(envelope));

    const result = await getQuotaWindows({ executionTarget: SANDBOX_TARGET });

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("accessToken");
    expect(serialized).not.toContain("refreshToken");
    expect(serialized).not.toContain("sk-codex-secret-should-not-survive");
    expect(serialized).not.toContain("rt-window-secret-should-not-survive");
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
    expect(result.provider).toBe("openai");
    expect(result.windows).toEqual([]);
    expect(JSON.stringify(result)).not.toContain("sk-raw-terminal-noise");
  });

  it("keeps the host probe for a null target and does not touch the exec seam", async () => {
    const hostResult = await getQuotaWindows();
    const nullTargetResult = await getQuotaWindows({ executionTarget: null });

    expect(mockRunProcess).not.toHaveBeenCalled();
    expect(nullTargetResult).toEqual(hostResult);
    expect(hostResult.ok).toBe(false);
    expect(hostResult.provider).toBe("openai");
  });
});
