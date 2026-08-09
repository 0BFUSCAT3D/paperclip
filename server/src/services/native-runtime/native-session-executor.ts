import { randomUUID } from "node:crypto";
import type { AdapterExecutionResult } from "../../adapters/index.js";
import type { NativeFinalizationResult } from "@paperclipai/shared";
import type { NativeExecutionInputV1, NativeSession } from "@paperclipai/paperclip-runner";
import {
  createCodexNativeSessionBackend,
  executeNativeSession,
} from "@paperclipai/paperclip-runner";
import type { Db } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import { heartbeatRuns, nativeRunFinalizations } from "@paperclipai/db";
import { PaperclipControlPlanePort } from "./paperclip-control-plane-port.js";

type ActiveNativeSession = {
  session: NativeSession;
  cancelRequested: boolean;
};

const activeNativeSessions = new Map<string, ActiveNativeSession>();

export async function cancelNativeSession(runId: string, reason: string): Promise<boolean> {
  const active = activeNativeSessions.get(runId);
  if (!active) return false;
  if (active.cancelRequested) return true;
  active.cancelRequested = true;
  try {
    if (active.session.cancel) await active.session.cancel({ reason });
    else if (active.session.interrupt) await active.session.interrupt({ reason });
  } catch (error) {
    active.cancelRequested = false;
    throw error;
  }
  return true;
}

export async function executePaperclipNativeSession(input: {
  db: Db;
  execution: NativeExecutionInputV1;
  runnerInstanceId: string;
}): Promise<AdapterExecutionResult> {
  const leaseOwner = `${input.runnerInstanceId}:${randomUUID()}`;
  const leaseNow = new Date();
  const leaseExpiresAt = new Date(leaseNow.getTime() + 20 * 60_000);
  await input.db.transaction(async (tx) => {
    const coordinator = await tx.select().from(nativeRunFinalizations)
      .where(and(
        eq(nativeRunFinalizations.runId, input.execution.binding.runId),
        eq(nativeRunFinalizations.companyId, input.execution.binding.companyId),
        eq(nativeRunFinalizations.issueId, input.execution.binding.issueId),
      )).for("update").limit(1).then((rows) => rows[0] ?? null);
    if (!coordinator) throw new Error("native_finalization_coordinator_missing");
    if (["committed", "applied"].includes(coordinator.phase)) throw new Error("native_run_already_committed");
    if (
      coordinator.leaseOwner
      && coordinator.leaseOwner !== leaseOwner
      && coordinator.leaseExpiresAt
      && coordinator.leaseExpiresAt > leaseNow
    ) throw new Error("native_finalization_lease_busy");
    await tx.update(nativeRunFinalizations).set({
      phase: coordinator.resultId ? coordinator.phase : "observed",
      attempt: coordinator.attempt + 1,
      leaseOwner,
      leaseExpiresAt,
      failureCode: null,
      failureDetail: null,
      nextAttemptAt: null,
      updatedAt: leaseNow,
    }).where(eq(nativeRunFinalizations.runId, coordinator.runId));
    await tx.update(heartbeatRuns).set({
      nativePhase: coordinator.resultId ? coordinator.phase : "observed",
      nativePhaseUpdatedAt: leaseNow,
      updatedAt: leaseNow,
    }).where(eq(heartbeatRuns.id, coordinator.runId));
  });
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
  let native: Awaited<ReturnType<typeof executeNativeSession>>;
  try {
    native = await executeNativeSession({
      input: input.execution,
      backend: createCodexNativeSessionBackend(input.execution, { runnerInstanceId: input.runnerInstanceId }),
      controlPlane,
      runnerInstanceId: input.runnerInstanceId,
      controlPlaneInstanceId,
      onSession: (session) => {
        if (session) activeNativeSessions.set(input.execution.binding.runId, {
          session,
          cancelRequested: false,
        });
        else activeNativeSessions.delete(input.execution.binding.runId);
      },
    });
  } catch (error) {
    const now = new Date();
    await input.db.update(nativeRunFinalizations).set({
      phase: "retryable_failure",
      leaseOwner: null,
      leaseExpiresAt: null,
      failureCode: "native_session_interrupted",
      failureDetail: {
        message: error instanceof Error ? error.message.slice(0, 2_000) : String(error).slice(0, 2_000),
        recoveryOwner: { kind: "agent", agentId: input.execution.binding.agentId },
        nextAction: "Resume the persisted native provider session after the retry delay.",
      },
      nextAttemptAt: new Date(now.getTime() + 30_000),
      updatedAt: now,
    }).where(and(
      eq(nativeRunFinalizations.runId, input.execution.binding.runId),
      eq(nativeRunFinalizations.leaseOwner, leaseOwner),
    ));
    throw error;
  }
  await input.db.update(nativeRunFinalizations).set({
    leaseOwner: null,
    leaseExpiresAt: null,
    updatedAt: new Date(),
  }).where(and(
    eq(nativeRunFinalizations.runId, input.execution.binding.runId),
    eq(nativeRunFinalizations.leaseOwner, leaseOwner),
  ));
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
