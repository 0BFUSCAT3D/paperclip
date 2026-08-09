import { randomUUID } from "node:crypto";

import type { ControlPlanePort } from "./contracts/control-plane-port.js";
import type { NativeExecutionInputV1, NativeSessionExecutionResult } from "./contracts/native-execution.js";
import { buildNativeModelEnvelope, parseNativeExecutionInput } from "./contracts/native-execution.js";
import type { NativeSession, NativeSessionBackend } from "./contracts/native-session-backend.js";
import type { PrpEvent, PrpTerminalState } from "./protocol/phase1-contract.js";

export interface ExecuteNativeSessionOptions {
  input: NativeExecutionInputV1;
  backend: NativeSessionBackend;
  controlPlane: ControlPlanePort;
  runnerInstanceId: string;
  controlPlaneInstanceId: string;
  timeoutMs?: number;
  onSession?: (session: NativeSession | null) => void;
}

function isTurnTerminal(event: PrpEvent): boolean {
  return ["turn.completed", "turn.failed", "turn.interrupted", "turn.cancelled"].includes(event.eventType);
}

function terminalFromEvent(event: PrpEvent, disposition: PrpTerminalState["reportedWorkDisposition"]): PrpTerminalState {
  const states = event.eventType === "turn.completed"
    ? { turnTerminalState: "completed" as const, runTerminalState: "succeeded" as const }
    : event.eventType === "turn.failed"
      ? { turnTerminalState: "failed" as const, runTerminalState: "failed" as const }
      : event.eventType === "turn.interrupted"
        ? { turnTerminalState: "interrupted" as const, runTerminalState: "cancelled" as const }
        : { turnTerminalState: "cancelled" as const, runTerminalState: "cancelled" as const };
  return { schema: "paperclip.prp.terminal.v1", ...states, reportedWorkDisposition: disposition };
}

async function consumeTurn(session: NativeSession, controlPlane: ControlPlanePort, timeoutMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        let eventCount = 0;
        let highestContiguousSourceSeq = 0;
        for await (const event of session.events()) {
          const receipt = await controlPlane.appendEvent(event);
          eventCount += receipt.disposition === "committed" ? 1 : 0;
          highestContiguousSourceSeq = Math.max(highestContiguousSourceSeq, receipt.highestContiguousSourceSeq);
          if (isTurnTerminal(event)) return { event, eventCount, highestContiguousSourceSeq };
        }
        throw new Error("native event stream closed before a turn terminal fact");
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`native session timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Package-owned normalized session loop. Paperclip supplies persistence and
 * authority through ControlPlanePort; provider/session behavior stays here.
 */
export async function executeNativeSession(options: ExecuteNativeSessionOptions): Promise<NativeSessionExecutionResult> {
  const input = parseNativeExecutionInput(options.input);
  const descriptor = await options.backend.descriptor();
  const normalizedSessionId = input.session.normalizedSessionId ?? randomUUID();
  await options.controlPlane.openRun({
    identity: {
      runId: input.binding.runId,
      sessionId: normalizedSessionId,
      companyId: input.binding.companyId,
      issueId: input.binding.issueId,
      agentId: input.binding.agentId,
    },
    backendKind: descriptor.kind,
    sourceInstanceId: options.runnerInstanceId,
  });

  const session = await options.backend.openSession({
    identity: {
      runId: input.binding.runId,
      sessionId: normalizedSessionId,
      companyId: input.binding.companyId,
      issueId: input.binding.issueId,
      agentId: input.binding.agentId,
    },
    workingDirectory: input.workspace.cwd,
  });
  options.onSession?.(session);
  try {
    const consuming = consumeTurn(session, options.controlPlane, options.timeoutMs ?? 900_000);
    await session.startTurn({
      message: { role: "user", text: JSON.stringify(buildNativeModelEnvelope(input)) },
    });
    const consumed = await consuming;
    const completed = await session.result();
    if (completed === null) throw new Error("native_finalization_missing: session returned no semantic result");
    const terminal = terminalFromEvent(consumed.event, completed.result.reportedWorkDisposition);
    let controlSeq = 0;
    const controlEvent = (eventType: PrpEvent["eventType"], payload: Record<string, unknown>): PrpEvent => ({
      schema: "paperclip.prp.event.v1",
      sourceEventId: `${options.controlPlaneInstanceId}:${input.binding.runId}:${++controlSeq}`,
      sourceSeq: controlSeq,
      sourceInstanceId: options.controlPlaneInstanceId,
      sourceKind: "control_plane",
      runId: input.binding.runId,
      normalizedSessionId,
      turnId: completed.turnId ?? consumed.event.turnId,
      eventType,
      schemaVersion: 1,
      priority: 0,
      emittedAt: new Date().toISOString(),
      payload,
    });
    for (const event of [
      controlEvent("run.result.accepted", { result: completed.result }),
      controlEvent("run.terminal", terminal as unknown as Record<string, unknown>),
    ]) {
      const receipt = await options.controlPlane.appendEvent(event);
      consumed.eventCount += receipt.disposition === "committed" ? 1 : 0;
      consumed.highestContiguousSourceSeq = Math.max(consumed.highestContiguousSourceSeq, receipt.highestContiguousSourceSeq);
    }
    await options.controlPlane.completeRun({
      result: completed.result,
      terminal,
      turnId: completed.turnId,
      callerResultId: `${options.runnerInstanceId}:${input.binding.runId}:result`,
      callerDedupeKey: `${input.binding.runId}:${input.completionContract.sha256}`,
    });
    const snapshot = await session.snapshot();
    return {
      result: completed.result,
      terminal,
      turnId: completed.turnId,
      normalizedSessionId,
      providerSessionId: snapshot.providerSessionId ?? null,
      driverKind: descriptor.name,
      driverVersion: descriptor.version,
      nativeEventCount: consumed.eventCount,
      highestContiguousSourceSeq: consumed.highestContiguousSourceSeq,
      usage: null,
    };
  } finally {
    options.onSession?.(null);
    await session.close({ reason: "native session execution complete" });
  }
}
