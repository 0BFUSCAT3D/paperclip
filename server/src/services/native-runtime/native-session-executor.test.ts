import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import type { NativeExecutionInputV1 } from "@paperclipai/paperclip-runner";

const state = vi.hoisted(() => ({
  execute: vi.fn(),
  cancel: vi.fn(),
  release: null as null | (() => void),
}));

vi.mock("@paperclipai/paperclip-runner", () => ({
  createCodexNativeSessionBackend: vi.fn(() => ({ kind: "test" })),
  executeNativeSession: state.execute,
}));

import { cancelNativeSession, executePaperclipNativeSession } from "./native-session-executor.js";

const execution = {
  binding: {
    companyId: "company",
    runId: "run-native-cancel",
    issueId: "issue",
    agentId: "agent",
  },
  completionContract: { id: "contract", sha256: "sha" },
} as NativeExecutionInputV1;

describe("native session cancellation", () => {
  beforeEach(() => {
    state.cancel.mockReset();
    state.release = null;
    state.execute.mockReset().mockImplementation(async (options) => {
      options.onSession?.({ cancel: state.cancel });
      await new Promise<void>((resolve) => { state.release = resolve; });
      options.onSession?.(null);
      return {
        result: { summary: "cancelled" },
        terminal: { runTerminalState: "cancelled" },
        turnId: "turn",
        normalizedSessionId: "session",
        providerSessionId: null,
        driverKind: "test",
        driverVersion: "1",
        nativeEventCount: 1,
        highestContiguousSourceSeq: 1,
      };
    });
  });

  it("routes control-plane cancellation to the active normalized session and removes the handle", async () => {
    const running = executePaperclipNativeSession({
      db: {} as Db,
      execution,
      runnerInstanceId: "runner",
    });
    await vi.waitFor(() => expect(state.release).toBeTypeOf("function"));

    await expect(cancelNativeSession(execution.binding.runId, "budget hard stop")).resolves.toBe(true);
    expect(state.cancel).toHaveBeenCalledWith({ reason: "budget hard stop" });

    state.release?.();
    await running;
    await expect(cancelNativeSession(execution.binding.runId, "late cancel")).resolves.toBe(false);
  });
});
