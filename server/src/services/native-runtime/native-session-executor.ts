import type { AdapterExecutionResult } from "../../adapters/index.js";
import type { NativeFinalizationResult } from "@paperclipai/shared";
import type { NativeExecutionInputV1, NativeSession } from "@paperclipai/paperclip-runner";
import {
  createCodexNativeSessionBackend,
  executeNativeSession,
} from "@paperclipai/paperclip-runner";
import type { Db } from "@paperclipai/db";
import { PaperclipControlPlanePort } from "./paperclip-control-plane-port.js";

const activeNativeSessions = new Map<string, NativeSession>();

export async function cancelNativeSession(runId: string, reason: string): Promise<boolean> {
  const session = activeNativeSessions.get(runId);
  if (!session) return false;
  if (session.cancel) await session.cancel({ reason });
  else if (session.interrupt) await session.interrupt({ reason });
  return true;
}

export async function executePaperclipNativeSession(input: {
  db: Db;
  execution: NativeExecutionInputV1;
  runnerInstanceId: string;
}): Promise<AdapterExecutionResult> {
  const controlPlaneInstanceId = `${input.runnerInstanceId}:control`;
  const controlPlane = new PaperclipControlPlanePort(input.db, {
    companyId: input.execution.binding.companyId,
    issueId: input.execution.binding.issueId,
    runId: input.execution.binding.runId,
    agentId: input.execution.binding.agentId,
    completionContractId: input.execution.completionContract.id,
    completionContractSha256: input.execution.completionContract.sha256,
    sourceInstanceId: input.runnerInstanceId,
    controlPlaneSourceInstanceId: controlPlaneInstanceId,
  });
  const native = await executeNativeSession({
    input: input.execution,
    backend: createCodexNativeSessionBackend(input.execution, { runnerInstanceId: input.runnerInstanceId }),
    controlPlane,
    runnerInstanceId: input.runnerInstanceId,
    controlPlaneInstanceId,
    onSession: (session) => {
      if (session) activeNativeSessions.set(input.execution.binding.runId, session);
      else activeNativeSessions.delete(input.execution.binding.runId);
    },
  });
  const finalization: NativeFinalizationResult = {
    schema: "paperclip.native-finalization.v1",
    runtimeMode: "native",
    runId: input.execution.binding.runId,
    issueId: input.execution.binding.issueId,
    companyId: input.execution.binding.companyId,
    result: native.result as unknown as Record<string, unknown>,
    terminal: native.terminal,
    turnId: native.turnId,
    sourceInstanceId: input.runnerInstanceId,
    normalizedSessionId: native.normalizedSessionId,
    providerSessionId: native.providerSessionId,
    driverKind: native.driverKind,
    driverVersion: native.driverVersion,
    nativeEventCount: native.nativeEventCount,
    highestContiguousSourceSeq: native.highestContiguousSourceSeq,
    workspaceFinalizeStatus: "pending",
  };
  return {
    exitCode: native.terminal.runTerminalState === "succeeded" ? 0 : 1,
    signal: null,
    timedOut: false,
    errorMessage: native.terminal.runTerminalState === "succeeded"
      ? null
      : `Native session ${native.terminal.runTerminalState}`,
    resultJson: {
      nativeResult: native.result as unknown as Record<string, unknown>,
      nativeTerminal: native.terminal as unknown as Record<string, unknown>,
    },
    summary: native.result.summary,
    sessionId: native.normalizedSessionId,
    sessionDisplayId: native.providerSessionId ?? native.normalizedSessionId,
    provider: "openai",
    usageBasis: "per_run",
    nativeFinalization: finalization,
  };
}
