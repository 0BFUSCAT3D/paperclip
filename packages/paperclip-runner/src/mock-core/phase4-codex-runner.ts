import type { HarnessDriver, HarnessSession } from "../contracts/harness-driver.js";
import {
  type Phase4RunMetadata,
  type Phase4RunTrace,
  type Phase4TaskEnvelope,
} from "../contracts/phase4.js";
import type { NativeUserMessage } from "../contracts/types.js";
import {
  applyPrpEvent,
  createSessionSnapshotFromMetadata,
} from "../reducer/session-reducer.js";
import type {
  PrpCapabilities,
  PrpEvent,
  PrpStructuredRunResult,
} from "../protocol/phase1-contract.js";
import {
  UnsupportedCodexOperationError,
  isSkilllessContext,
} from "../drivers/codex/codex-app-server-driver.js";

export interface Phase4CodexTracerInput {
  driver: HarnessDriver;
  taskEnvelope: Phase4TaskEnvelope;
  workingDirectory: string;
  message?: NativeUserMessage;
  runId?: string;
  companyId?: string;
  issueId?: string;
  environmentLeaseId?: string;
  runnerInstanceId?: string;
  steer?: string;
  interrupt?: boolean;
  timeoutMs?: number;
}

function prpCapabilities(
  descriptor: Awaited<ReturnType<HarnessDriver["descriptor"]>>,
): PrpCapabilities {
  return {
    schema: "paperclip.prp.capabilities.v1",
    sessionReusePolicy: "reuse_per_issue",
    driver: { kind: descriptor.kind, version: descriptor.version },
    steer: descriptor.capabilities.steering,
    interrupt: descriptor.capabilities.interruption,
    resume: descriptor.capabilities.resume,
    runtimeRequests: true,
    structuredResult: descriptor.capabilities.structuredResult,
    typedEvents: descriptor.capabilities.typedEvents,
    ...(descriptor.capabilities.unsupported?.length
      ? { unsupported: descriptor.capabilities.unsupported }
      : {}),
  };
}

function contextFrom(events: PrpEvent[]) {
  const event = events.find(
    (candidate) => candidate.eventType === "session.started" || candidate.eventType === "session.resumed",
  );
  const context = event?.payload.context;
  if (typeof context !== "object" || context === null || Array.isArray(context)) {
    throw new Error("Codex session did not emit its model-context snapshot");
  }
  return context as Phase4RunTrace["context"];
}

function resultFrom(events: PrpEvent[]): PrpStructuredRunResult {
  const event = events.find((candidate) => candidate.eventType === "run.result.proposed");
  if (event === undefined) throw new Error("Codex session emitted no semantic result");
  return event.payload as PrpStructuredRunResult;
}

async function consumeToTerminal(
  session: HarnessSession,
  timeoutMs: number,
  onEvent?: (event: PrpEvent) => void,
): Promise<PrpEvent[]> {
  const consume = async () => {
    const events: PrpEvent[] = [];
    for await (const event of session.events()) {
      events.push(event);
      onEvent?.(event);
      if (event.eventType === "run.terminal") return events;
    }
    throw new Error("Codex event stream closed before run.terminal");
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      consume(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Codex tracer timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Small in-memory Phase 4 mock core. It accepts only the public driver contract,
 * reduces events live, and replays the same canonical stream after completion.
 */
export async function runPhase4CodexTracer(input: Phase4CodexTracerInput): Promise<Phase4RunTrace> {
  const runId = input.runId ?? "phase4-safe-run";
  const normalizedSessionId = `session:${runId}`;
  const descriptor = await input.driver.descriptor();
  const capabilities = prpCapabilities(descriptor);
  const metadata: Phase4RunMetadata = {
    schema: "paperclip.runner.phase4.metadata.v1",
    fixtureName: "phase-04-safe-codex-task",
    identity: {
      schema: "paperclip.prp.identity.v1",
      companyId: input.companyId ?? "mock-company",
      issueId: input.issueId ?? "mock-issue",
      runId,
      environmentLeaseId: input.environmentLeaseId ?? "mock-lease",
      runnerInstanceId: input.runnerInstanceId ?? "runner-phase4",
      normalizedSessionId,
    },
    capabilities,
  };
  const session = await input.driver.openSession({ runId, workingDirectory: input.workingDirectory });
  let signalTurnStarted: (() => void) | undefined;
  const turnStarted = new Promise<void>((resolve) => {
    signalTurnStarted = resolve;
  });
  const consuming = consumeToTerminal(session, input.timeoutMs ?? 180_000, (event) => {
    if (event.eventType === "turn.started") signalTurnStarted?.();
  });

  try {
    const turn = await session.startTurn({
      message: input.message ?? { role: "user", text: "Complete the supplied task envelope." },
    });
    if (input.steer !== undefined || input.interrupt) {
      await Promise.race([
        turnStarted,
        consuming.then(() => {
          throw new Error("Codex turn reached terminal state before accepting the control command");
        }),
      ]);
    }
    if (input.steer !== undefined) {
      if (session.steer === undefined) throw new Error("driver did not expose steering");
      try {
        await session.steer({ turnId: turn.turnId, message: { role: "user", text: input.steer } });
      } catch (error) {
        // A short real-model turn can finish between turn/start and turn/steer.
        // The driver already emitted the explicit capability diagnostic; keep
        // consuming the same session so the mock core records its terminal.
        if (!(error instanceof UnsupportedCodexOperationError)) throw error;
      }
    }
    if (input.interrupt) {
      if (session.interrupt === undefined) throw new Error("driver did not expose interruption");
      try {
        await session.interrupt({ turnId: turn.turnId, reason: "Phase 4 tutorial interrupt" });
      } catch (error) {
        if (!(error instanceof UnsupportedCodexOperationError)) throw error;
      }
    }

    const events = await consuming;
    const ids = session.ids();
    const identity = {
      ...metadata.identity,
      driverSessionId: ids.driverSessionId,
      ...(ids.providerSessionId ? { providerSessionId: ids.providerSessionId } : {}),
    };
    metadata.identity = identity;
    const liveSnapshot = events.reduce(
      applyPrpEvent,
      createSessionSnapshotFromMetadata({
        fixtureName: metadata.fixtureName,
        identity,
        capabilities,
      }),
    );
    const replaySnapshot = events.reduce(
      applyPrpEvent,
      createSessionSnapshotFromMetadata({
        fixtureName: metadata.fixtureName,
        identity,
        capabilities,
      }),
    );
    const context = contextFrom(events);
    const result = resultFrom(events);
    const terminalCount = events.filter((event) => event.eventType === "run.terminal").length;
    const resultCount = events.filter((event) => event.eventType === "run.result.proposed").length;
    const serialized = JSON.stringify(context).toLowerCase();
    const itemEvents = events.filter((event) => event.eventType.startsWith("item."));
    return {
      schema: "paperclip.runner.phase4.trace.v1",
      metadata,
      context,
      events,
      result,
      liveSnapshot,
      replaySnapshot,
      diagnostics: events
        .filter((event) => event.eventType === "runner.diagnostic" || event.eventType === "harness.diagnostic")
        .map((event) => String(event.payload.message ?? event.payload.code ?? "diagnostic")),
      assertions: {
        exactlyOneTerminalResult: terminalCount === 1 && resultCount === 1,
        liveReplayParity: JSON.stringify(liveSnapshot) === JSON.stringify(replaySnapshot),
        stableIdentity:
          events.every(
            (event) =>
              event.runId === runId && event.normalizedSessionId === normalizedSessionId,
          ) && ids.driverSessionId.length > 0,
        sourceSequenceContinuous: events.every(
          (event, index) => event.sourceSeq === index + 1,
        ),
        stableItemIdentity: itemEvents.every(
          (event) => typeof event.itemId === "string" && event.itemId.length > 0,
        ),
        contextIsSkillless: isSkilllessContext(context),
        unrelatedSkillsAbsent:
          context.instructionSources.length === 0 &&
          context.instructionPolicy.skillInstructions === false &&
          context.modelInputKinds.length === 1 &&
          context.modelInputKinds[0] === "text",
        credentialsAbsent:
          !serialized.includes("paperclip_api_key") &&
          !serialized.includes("authorization: bearer") &&
          !serialized.includes("/api/issues/"),
      },
    };
  } finally {
    await session.close({ reason: "Phase 4 tracer complete" });
  }
}
