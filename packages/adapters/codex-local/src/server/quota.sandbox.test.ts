import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";

const { mockRunProcess, mockStage, mockSpawn } = vi.hoisted(() => ({
  mockRunProcess: vi.fn(),
  mockStage: vi.fn(),
  mockSpawn: vi.fn(),
}));

vi.mock("@paperclipai/adapter-utils/execution-target", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@paperclipai/adapter-utils/execution-target")>();
  return {
    ...actual,
    runAdapterExecutionTargetProcess: mockRunProcess,
    stageAdapterExecutionTargetProbeScript: mockStage,
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
import { getCodexQuotaProbeSource } from "../cli/quota-probe-source.js";

const SANDBOX_TARGET: AdapterExecutionTarget = {
  kind: "remote",
  transport: "sandbox",
  remoteCwd: "/workspace",
  providerKey: "test-sandbox",
};

const STAGED_PROBE_PATH = "/workspace/.paperclip-runtime/codex/quota/quota-probe.sh";

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
    mockStage.mockReset();
    mockStage.mockResolvedValue(STAGED_PROBE_PATH);
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

  it("stages the probe script and runs it through the exec seam (not --version)", async () => {
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

    expect(mockStage).toHaveBeenCalledTimes(1);
    const [stageTarget, stageInput] = mockStage.mock.calls[0];
    expect(stageTarget).toBe(SANDBOX_TARGET);
    expect(stageInput.scriptName).toBe("quota-probe.sh");
    expect(stageInput.body).toBe(await getCodexQuotaProbeSource());

    expect(mockRunProcess).toHaveBeenCalledTimes(1);
    const [, target, command, args] = mockRunProcess.mock.calls[0];
    expect(target).toBe(SANDBOX_TARGET);
    expect(command).toBe("sh");
    expect(args).toEqual([STAGED_PROBE_PATH]);
    expect(args).not.toContain("--version");

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

  it("passes the token to the probe by env only, never in argv (C7)", async () => {
    const token = "codex-access-test-token-value";
    fs.writeFileSync(
      path.join(isolatedCodexHome as string, "auth.json"),
      JSON.stringify({ accessToken: token, accountId: "acct-123" }),
    );
    mockRunProcess.mockResolvedValue(cannedProcess(JSON.stringify({ provider: "openai", ok: true, windows: [] })));

    await getQuotaWindows({ executionTarget: SANDBOX_TARGET });

    const [, , command, args, options] = mockRunProcess.mock.calls[0];
    expect(options.env).toEqual({ CODEX_ACCESS_TOKEN: token });
    // The token never appears in the command or in the argument list.
    expect(command).not.toContain(token);
    expect(JSON.stringify(args)).not.toContain(token);
  });

  it("stages adapter-owned bytes that hold no credential, url, or header (C8)", async () => {
    fs.writeFileSync(
      path.join(isolatedCodexHome as string, "auth.json"),
      JSON.stringify({ accessToken: "codex-access-test-token-value", accountId: "acct-123" }),
    );
    mockRunProcess.mockResolvedValue(cannedProcess(JSON.stringify({ provider: "openai", ok: true, windows: [] })));

    await getQuotaWindows({ executionTarget: SANDBOX_TARGET });

    const stagedBytes: string = mockStage.mock.calls[0][1].body;
    // The staged bytes are the reviewed script source, byte for byte.
    expect(stagedBytes).toBe(await getCodexQuotaProbeSource());
    // The staged bytes carry no credential value.
    expect(stagedBytes).not.toContain("codex-access-test-token-value");
    expect(stagedBytes).not.toContain("acct-123");
    // The script reads its one allowlisted url from a literal, never a caller value.
    expect(stagedBytes).toContain("https://chatgpt.com/backend-api/wham/usage");
    // No caller-controlled interpolation marker leaks into the staged bytes.
    expect(stagedBytes).not.toContain("${CALLER");
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
    expect(mockStage).not.toHaveBeenCalled();
    expect(nullTargetResult).toEqual(hostResult);
    expect(hostResult.ok).toBe(false);
    expect(hostResult.provider).toBe("openai");
  });
});
