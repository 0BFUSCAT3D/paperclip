import { randomUUID } from "node:crypto";

import type {
  HarnessDriver,
  HarnessDriverDescriptor,
  HarnessSession,
  HarnessSessionRecoveryResult,
  OpenHarnessSessionInput,
  PersistedHarnessSession,
} from "../../contracts/harness-driver.js";
import {
  PHASE4_BLOCK_RESULT_OUTPUT_SCHEMA,
  PHASE4_BLOCK_TOOL_NAME,
  PHASE4_CODEX_PROTOCOL_VERSION,
  PHASE4_COMPLETION_TOOL_NAME,
  PHASE4_RESULT_OUTPUT_SCHEMA,
  PHASE4_SEMANTIC_TOOL_NAMES,
  PHASE4_SKILLLESS_BASE_INSTRUCTIONS,
  type Phase4ModelContextSnapshot,
  type Phase4TaskEnvelope,
} from "../../contracts/phase4.js";
import {
  validatePrpStructuredRunResult,
  type PrpEvent,
  type PrpStructuredRunResult,
} from "../../protocol/phase1-contract.js";
import type { NativeUserMessage } from "../../contracts/types.js";
import {
  ProcessCodexAppServerTransport,
  createSanitizedCodexEnvironment,
  redactCodexDiagnostic,
  sanitizedEnvironmentKeys,
  type CodexAppServerTransport,
  type CodexRpcNotification,
  type CodexRpcServerRequest,
} from "./app-server-transport.js";

const DRIVER_KIND = "codex_app_server";
const DRIVER_VERSION = "phase4-v1";

class AsyncQueue<T> implements AsyncIterable<T> {
  #values: T[] = [];
  #waiters: Array<(value: IteratorResult<T>) => void> = [];
  #closed = false;

  push(value: T): void {
    if (this.#closed) return;
    const waiter = this.#waiters.shift();
    if (waiter === undefined) this.#values.push(value);
    else waiter({ value, done: false });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) waiter({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: async () => {
        const value = this.#values.shift();
        if (value !== undefined) return { value, done: false };
        if (this.#closed) return { value: undefined, done: true };
        return new Promise((resolve) => this.#waiters.push(resolve));
      },
    };
  }
}

export class UnsupportedCodexOperationError extends Error {
  readonly operation: string;

  constructor(operation: string, detail: string) {
    super(`${operation} is unsupported: ${redactCodexDiagnostic(detail)}`);
    this.name = "UnsupportedCodexOperationError";
    this.operation = operation;
  }
}

export interface CodexAppServerDriverOptions {
  taskEnvelope: Phase4TaskEnvelope;
  transportFactory?: () => CodexAppServerTransport;
  environment?: NodeJS.ProcessEnv;
  now?: () => Date;
  runnerInstanceId?: string;
  onDiagnostic?: (message: string) => void;
  capabilities?: Partial<{
    resume: boolean;
    read: boolean;
    steering: boolean;
    interruption: boolean;
    usage: boolean;
    reconciliation: boolean;
    dynamicTools: boolean;
  }>;
}

type CodexCapabilities = Required<
  NonNullable<CodexAppServerDriverOptions["capabilities"]>
>;

interface OpenedCodexThread {
  threadId: string;
  providerSessionId: string;
  context: Phase4ModelContextSnapshot;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function itemFromParams(params: Record<string, unknown>): Record<string, unknown> {
  return record(params.item);
}

function itemText(item: Record<string, unknown>): string {
  for (const key of ["text", "aggregatedOutput", "patch", "delta"]) {
    if (typeof item[key] === "string") return item[key];
  }
  return "";
}

function userInput(message: NativeUserMessage): Record<string, unknown> {
  return { type: "text", text: message.text, text_elements: [] };
}

function terminalState(status: string): "completed" | "failed" | "interrupted" {
  if (status === "failed") return "failed";
  if (status === "interrupted") return "interrupted";
  return "completed";
}

function dispositionRunState(
  result: PrpStructuredRunResult,
): "succeeded" | "failed" {
  return result.reportedWorkDisposition === "done" ? "succeeded" : "failed";
}

function tryParseResult(value: unknown): PrpStructuredRunResult | null {
  let candidate = value;
  if (typeof value === "string") {
    try {
      candidate = JSON.parse(value);
    } catch {
      return null;
    }
  }
  const validation = validatePrpStructuredRunResult(candidate);
  return validation.ok ? validation.result : null;
}

function finishToolSpec(): Record<string, unknown> {
  return {
    name: PHASE4_COMPLETION_TOOL_NAME,
    description: "Return the one semantic completion result for this task.",
    inputSchema: PHASE4_RESULT_OUTPUT_SCHEMA,
  };
}

function blockToolSpec(): Record<string, unknown> {
  return {
    name: PHASE4_BLOCK_TOOL_NAME,
    description: "Return the one semantic result when the task cannot continue.",
    inputSchema: PHASE4_BLOCK_RESULT_OUTPUT_SCHEMA,
  };
}

const SKILLLESS_THREAD_CONFIG = {
  "skills.include_instructions": false,
  include_apps_instructions: false,
  include_collaboration_mode_instructions: false,
  "features.apps": false,
  "features.plugins": false,
  "features.multi_agent": false,
  "features.memories": false,
} as const;

export class CodexAppServerDriver implements HarnessDriver {
  readonly #options: CodexAppServerDriverOptions;
  readonly #caps: CodexCapabilities;

  constructor(options: CodexAppServerDriverOptions) {
    this.#options = options;
    this.#caps = {
      resume: true,
      read: true,
      steering: true,
      interruption: true,
      usage: true,
      reconciliation: true,
      dynamicTools: true,
      ...options.capabilities,
    };
    if (!this.#caps.read) this.#caps.reconciliation = false;
  }

  async descriptor(): Promise<HarnessDriverDescriptor> {
    const unsupported = Object.entries(this.#caps)
      .filter(([, supported]) => !supported)
      .map(([operation]) => operation);
    return {
      kind: DRIVER_KIND,
      displayName: "Codex app-server",
      version: DRIVER_VERSION,
      protocolVersion: PHASE4_CODEX_PROTOCOL_VERSION,
      capabilities: {
        resume: this.#caps.resume,
        typedEvents: true,
        steering: this.#caps.steering,
        interruption: this.#caps.interruption,
        structuredResult: true,
        read: this.#caps.read,
        reconciliation: this.#caps.reconciliation,
        usage: this.#caps.usage,
        dynamicTools: this.#caps.dynamicTools,
        unsupported,
      },
    };
  }

  async openSession(input: OpenHarnessSessionInput): Promise<HarnessSession> {
    const transport = this.#transport();
    const initialize = await this.#initialize(transport);
    const response = await transport.request("thread/start", {
      cwd: input.workingDirectory,
      approvalPolicy: "never",
      sandbox: "workspace-write",
      config: SKILLLESS_THREAD_CONFIG,
      baseInstructions: PHASE4_SKILLLESS_BASE_INSTRUCTIONS,
      dynamicTools: this.#caps.dynamicTools ? [finishToolSpec(), blockToolSpec()] : [],
      experimentalRawEvents: false,
      persistExtendedHistory: false,
    });
    const opened = this.#openedThread(response, initialize, input.workingDirectory);
    return this.#session({
      transport,
      runId: input.runId,
      normalizedSessionId: `session:${input.runId}`,
      opened,
      resumed: false,
      sourceSequence: 0,
    });
  }

  async recoverSession(
    snapshot: PersistedHarnessSession,
  ): Promise<HarnessSessionRecoveryResult> {
    if (!this.#caps.resume) {
      return { recovered: false, reason: "resume capability is unavailable" };
    }
    if (!snapshot.runId || !snapshot.normalizedSessionId || !snapshot.driverSessionId) {
      return { recovered: false, reason: "persisted session identity is incomplete" };
    }
    const transport = this.#transport();
    try {
      const initialize = await this.#initialize(transport);
      const response = await transport.request("thread/resume", {
        threadId: snapshot.driverSessionId,
        config: SKILLLESS_THREAD_CONFIG,
        baseInstructions: PHASE4_SKILLLESS_BASE_INSTRUCTIONS,
        persistExtendedHistory: false,
      });
      const opened = this.#openedThread(response, initialize, text(record(response.thread).cwd));
      if (opened.threadId !== snapshot.driverSessionId) {
        await transport.close();
        return { recovered: false, reason: "provider resumed a different session" };
      }
      return {
        recovered: true,
        session: this.#session({
          transport,
          runId: snapshot.runId,
          normalizedSessionId: snapshot.normalizedSessionId,
          opened,
          resumed: true,
          activeTurnId: snapshot.activeTurnId ?? null,
          sourceSequence: snapshot.lastSourceSequence ?? 0,
        }),
      };
    } catch (error) {
      await transport.close();
      return { recovered: false, reason: redactCodexDiagnostic(String(error)) };
    }
  }

  #transport(): CodexAppServerTransport {
    return (
      this.#options.transportFactory?.() ??
      new ProcessCodexAppServerTransport({
        environment: createSanitizedCodexEnvironment(this.#options.environment),
        onDiagnostic: this.#options.onDiagnostic,
      })
    );
  }

  async #initialize(transport: CodexAppServerTransport): Promise<Record<string, unknown>> {
    const initialized = await transport.request("initialize", {
      clientInfo: { name: "paperclip-runner", title: "Paperclip Runner", version: DRIVER_VERSION },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    transport.notify("initialized");
    return initialized;
  }

  #openedThread(
    response: Record<string, unknown>,
    initialize: Record<string, unknown>,
    workingDirectory: string,
  ): OpenedCodexThread {
    const thread = record(response.thread);
    const threadId = text(thread.id);
    if (threadId.length === 0) throw new Error("Codex thread response omitted thread.id");
    return {
      threadId,
      providerSessionId: text(thread.sessionId, threadId),
      context: {
        protocolVersion: PHASE4_CODEX_PROTOCOL_VERSION,
        codexVersion: text(initialize.userAgent, "unknown"),
        clientInfo: {
          name: "paperclip-runner",
          title: "Paperclip Runner",
          version: DRIVER_VERSION,
        },
        model: text(response.model, "unknown"),
        modelProvider: text(response.modelProvider, text(thread.modelProvider, "unknown")),
        workingDirectory: text(response.cwd, workingDirectory),
        sandbox: response.sandbox ?? null,
        approvalPolicy: response.approvalPolicy ?? "never",
        baseInstructions: PHASE4_SKILLLESS_BASE_INSTRUCTIONS,
        instructionSources: Array.isArray(response.instructionSources)
          ? response.instructionSources.filter((value): value is string => typeof value === "string")
          : [],
        instructionPolicy: {
          skillInstructions: false,
          appInstructions: false,
          collaborationInstructions: false,
        },
        environmentKeys: sanitizedEnvironmentKeys(this.#options.environment),
        dynamicToolNames: this.#caps.dynamicTools ? [...PHASE4_SEMANTIC_TOOL_NAMES] : [],
        modelInputKinds: ["text"],
        envelope: structuredClone(this.#options.taskEnvelope),
      },
    };
  }

  #session(input: {
    transport: CodexAppServerTransport;
    runId: string;
    normalizedSessionId: string;
    opened: OpenedCodexThread;
    resumed: boolean;
    activeTurnId?: string | null;
    sourceSequence: number;
  }): CodexHarnessSession {
    return new CodexHarnessSession({
      ...input,
      taskEnvelope: this.#options.taskEnvelope,
      now: this.#options.now ?? (() => new Date()),
      runnerInstanceId: this.#options.runnerInstanceId ?? "runner-phase4",
      capabilities: this.#caps,
    });
  }
}

class CodexHarnessSession implements HarnessSession {
  readonly #transport: CodexAppServerTransport;
  readonly #runId: string;
  readonly #normalizedSessionId: string;
  readonly #opened: OpenedCodexThread;
  readonly #taskEnvelope: Phase4TaskEnvelope;
  readonly #now: () => Date;
  readonly #runnerInstanceId: string;
  readonly #capabilities: CodexCapabilities;
  readonly #events = new AsyncQueue<PrpEvent>();
  #sourceSequence: number;
  #activeTurnId: string | null;
  #usage: Record<string, unknown> | null = null;
  #result: PrpStructuredRunResult | null = null;
  #resultFingerprint: string | null = null;
  #terminal = false;

  constructor(input: {
    transport: CodexAppServerTransport;
    runId: string;
    normalizedSessionId: string;
    opened: OpenedCodexThread;
    taskEnvelope: Phase4TaskEnvelope;
    resumed: boolean;
    activeTurnId?: string | null;
    sourceSequence: number;
    now: () => Date;
    runnerInstanceId: string;
    capabilities: CodexCapabilities;
  }) {
    this.#transport = input.transport;
    this.#runId = input.runId;
    this.#normalizedSessionId = input.normalizedSessionId;
    this.#opened = input.opened;
    this.#taskEnvelope = input.taskEnvelope;
    this.#activeTurnId = input.activeTurnId ?? null;
    this.#sourceSequence = input.sourceSequence;
    this.#now = input.now;
    this.#runnerInstanceId = input.runnerInstanceId;
    this.#capabilities = input.capabilities;
    this.#transport.setServerRequestHandler((request) => this.#handleServerRequest(request));
    this.#emit(input.resumed ? "session.resumed" : "session.started", {
      driverSessionId: input.opened.threadId,
      providerSessionId: input.opened.providerSessionId,
      context: input.opened.context,
    });
    this.#emit("item.completed", {
      kind: "model",
      text: `${input.opened.context.model} (${input.opened.context.modelProvider})`,
      model: {
        name: input.opened.context.model,
        provider: input.opened.context.modelProvider,
        codexVersion: input.opened.context.codexVersion,
      },
    }, { itemId: `${input.opened.threadId}:model` });
    void this.#pumpNotifications();
  }

  ids(): ReturnType<HarnessSession["ids"]> {
    return {
      driverSessionId: this.#opened.threadId,
      providerSessionId: this.#opened.providerSessionId,
      displayId: this.#opened.threadId,
    };
  }

  contextSnapshot(): Phase4ModelContextSnapshot {
    return structuredClone(this.#opened.context);
  }

  events(): AsyncIterable<PrpEvent> {
    return this.#events;
  }

  async startTurn(input: { message: NativeUserMessage }): Promise<{ turnId: string }> {
    const taskText = JSON.stringify({ task: this.#taskEnvelope, message: input.message.text });
    this.#emit("turn.submitted", { envelopeSchema: this.#taskEnvelope.schema });
    const response = await this.#transport.request("turn/start", {
      threadId: this.#opened.threadId,
      input: [userInput({ role: "user", text: taskText })],
      outputSchema: PHASE4_RESULT_OUTPUT_SCHEMA,
    });
    const turn = record(response.turn);
    const turnId = text(turn.id);
    if (turnId.length === 0) throw new Error("Codex turn response omitted turn.id");
    this.#activeTurnId = turnId;
    this.#emit("turn.accepted", { turnId }, { turnId });
    return { turnId };
  }

  async steer(input: { turnId: string; message: NativeUserMessage }): Promise<void> {
    this.#requireCapability("steering");
    this.#requireActiveTurn(input.turnId);
    try {
      await this.#transport.request("turn/steer", {
        threadId: this.#opened.threadId,
        input: [userInput(input.message)],
        expectedTurnId: input.turnId,
      });
    } catch (error) {
      throw this.#unsupported("steering", error);
    }
  }

  async interrupt(input: { turnId: string; reason?: string }): Promise<void> {
    this.#requireCapability("interruption");
    this.#requireActiveTurn(input.turnId);
    try {
      await this.#transport.request("turn/interrupt", {
        threadId: this.#opened.threadId,
        turnId: input.turnId,
      });
    } catch (error) {
      throw this.#unsupported("interruption", error);
    }
  }

  async read(): Promise<Record<string, unknown>> {
    this.#requireCapability("read");
    try {
      return await this.#transport.request("thread/read", {
        threadId: this.#opened.threadId,
        includeTurns: true,
      });
    } catch (error) {
      throw this.#unsupported("read", error);
    }
  }

  async reconcile(): Promise<Record<string, unknown>> {
    this.#requireCapability("reconciliation");
    const snapshot = await this.read();
    const thread = record(snapshot.thread);
    const turns = Array.isArray(thread.turns) ? thread.turns.map(record) : [];
    const active = turns.find((turn) => text(turn.status) === "inProgress");
    this.#activeTurnId = active === undefined ? null : text(active.id);
    this.#emit("session.reconciled", {
      providerSessionId: this.#opened.providerSessionId,
      turnCount: turns.length,
      activeTurnId: this.#activeTurnId,
    });
    return snapshot;
  }

  async usage(): Promise<Record<string, unknown> | null> {
    this.#requireCapability("usage");
    return this.#usage === null ? null : structuredClone(this.#usage);
  }

  async snapshot(): Promise<PersistedHarnessSession> {
    return {
      driverKind: DRIVER_KIND,
      driverSessionId: this.#opened.threadId,
      providerSessionId: this.#opened.providerSessionId,
      runId: this.#runId,
      normalizedSessionId: this.#normalizedSessionId,
      activeTurnId: this.#activeTurnId,
      lastSourceSequence: this.#sourceSequence,
    };
  }

  async close(): Promise<void> {
    this.#events.close();
    await this.#transport.close();
  }

  async #pumpNotifications(): Promise<void> {
    try {
      for await (const notification of this.#transport.notifications()) {
        this.#mapNotification(notification);
      }
    } catch (error) {
      this.#emit("harness.diagnostic", {
        code: "notification_transport_failed",
        message: redactCodexDiagnostic(String(error)),
      });
    }
  }

  #mapNotification(notification: CodexRpcNotification): void {
    const params = notification.params;
    const turn = record(params.turn);
    const item = itemFromParams(params);
    const turnId = text(params.turnId, text(turn.id, this.#activeTurnId ?? ""));
    const itemId = text(item.id, text(params.itemId));
    if (notification.method === "turn/started") {
      this.#activeTurnId = turnId;
      this.#emit("turn.started", { status: text(turn.status, "inProgress") }, { turnId });
      return;
    }
    if (notification.method === "turn/completed") {
      const status = text(turn.status, "completed");
      const eventType = status === "failed" ? "turn.failed" : status === "interrupted" ? "turn.interrupted" : "turn.completed";
      this.#captureResultFromTurn(turn);
      this.#emit(eventType, { status, error: turn.error ?? null }, { turnId });
      this.#activeTurnId = null;
      this.#finalize(status);
      return;
    }
    if (notification.method === "item/started") {
      this.#emit("item.started", { kind: text(item.type, "unknown"), text: itemText(item), item }, { turnId, itemId });
      return;
    }
    if (notification.method === "item/completed") {
      this.#captureResultFromItem(item);
      this.#emit("item.completed", { kind: text(item.type, "unknown"), text: itemText(item), item }, { turnId, itemId });
      return;
    }
    const deltaKinds: Record<string, string> = {
      "item/agentMessage/delta": "agentMessage",
      "item/plan/delta": "plan",
      "item/reasoning/summaryTextDelta": "reasoning",
      "item/reasoning/textDelta": "reasoning",
      "item/commandExecution/outputDelta": "commandExecution",
      "item/fileChange/outputDelta": "fileChange",
      "item/fileChange/patchUpdated": "fileChange",
      "turn/diff/updated": "diff",
      "turn/plan/updated": "plan",
    };
    const deltaKind = deltaKinds[notification.method];
    if (deltaKind !== undefined) {
      this.#emit("item.delta", {
        kind: deltaKind,
        text: text(params.delta, text(params.patch, text(params.output))),
        update: params,
      }, { turnId, itemId: itemId || `${turnId}:${deltaKind}` });
      return;
    }
    if (notification.method === "thread/tokenUsage/updated") {
      this.#usage = record(params.tokenUsage);
      this.#emit("item.completed", { kind: "usage", usage: this.#usage }, {
        turnId,
        itemId: `${turnId}:usage:${this.#sourceSequence + 1}`,
      });
      return;
    }
    if (notification.method === "error" || notification.method === "warning" || notification.method === "configWarning") {
      this.#emit("harness.diagnostic", {
        code: notification.method.replaceAll("/", "_"),
        message: redactCodexDiagnostic(text(params.message, JSON.stringify(params))),
      }, turnId ? { turnId } : {});
    }
  }

  async #handleServerRequest(request: CodexRpcServerRequest): Promise<Record<string, unknown>> {
    if (request.method === "item/tool/call") {
      const tool = text(request.params.tool);
      if (!isSemanticTool(tool)) {
        this.#diagnoseUnsupported(`dynamic tool ${tool}`);
        return { success: false, contentItems: [{ type: "inputText", text: "Unsupported tool." }] };
      }
      const validation = validatePrpStructuredRunResult(request.params.arguments);
      if (!validation.ok) {
        return {
          success: false,
          contentItems: [{ type: "inputText", text: `Invalid semantic result: ${validation.issues.map((issue) => issue.message).join("; ")}` }],
        };
      }
      if (!toolAcceptsDisposition(tool, validation.result.reportedWorkDisposition)) {
        return {
          success: false,
          contentItems: [{
            type: "inputText",
            text:
              tool === PHASE4_BLOCK_TOOL_NAME || tool === "paperclip.block"
                ? "paperclip_block requires reportedWorkDisposition=blocked."
                : "paperclip_finish accepts only done or needs_review.",
          }],
        };
      }
      const fingerprint = JSON.stringify(validation.result);
      if (this.#resultFingerprint !== null && this.#resultFingerprint !== fingerprint) {
        return { success: false, contentItems: [{ type: "inputText", text: "A different semantic result was already committed." }] };
      }
      if (this.#result === null) {
        this.#commitResult(
          validation.result,
          text(request.params.callId, randomUUID()),
          text(request.params.turnId, this.#activeTurnId ?? ""),
        );
      }
      return { success: true, contentItems: [{ type: "inputText", text: "Semantic completion accepted." }] };
    }

    const requestKind = request.method.includes("requestApproval") ? "approval" : "user_input";
    const requestId = String(request.id);
    this.#emit("runtime_request.created", {
      request: {
        requestId,
        requestKind,
        type: request.method,
        status: "pending",
        prompt: "Codex requires an external runtime decision.",
        details: redactCodexValue(request.params),
      },
    }, {
      turnId: text(request.params.turnId, this.#activeTurnId ?? ""),
      itemId: text(request.params.itemId, requestId),
    });
    const response = safeRequestResponse(request.method);
    this.#emit("runtime_request.resolved", {
      requestId,
      resolution: "declined_by_skillless_driver",
    }, {
      turnId: text(request.params.turnId, this.#activeTurnId ?? ""),
      itemId: text(request.params.itemId, requestId),
    });
    return response;
  }

  #captureResultFromItem(item: Record<string, unknown>): void {
    if (text(item.type) !== "agentMessage" || this.#result !== null) return;
    const result = tryParseResult(item.text);
    if (result !== null) this.#commitResult(result, text(item.id));
  }

  #captureResultFromTurn(turn: Record<string, unknown>): void {
    if (this.#result !== null || !Array.isArray(turn.items)) return;
    for (const value of turn.items.map(record).reverse()) {
      if (text(value.type) !== "agentMessage") continue;
      const result = tryParseResult(value.text);
      if (result !== null) {
        this.#commitResult(result, text(value.id));
        return;
      }
    }
  }

  #commitResult(result: PrpStructuredRunResult, itemId: string, turnId?: string): void {
    if (this.#result !== null) return;
    this.#result = structuredClone(result);
    this.#resultFingerprint = JSON.stringify(result);
    result.verification.forEach((verification, index) => {
      this.#emit("item.completed", {
        kind: "verification",
        text: `${verification.status}: ${verification.commandOrCheck}`,
        verification,
      }, {
        turnId: turnId || this.#activeTurnId || undefined,
        itemId: `${itemId || "semantic-result"}:verification:${index + 1}`,
      });
    });
    this.#emit("run.result.proposed", result, {
      turnId: turnId || this.#activeTurnId || undefined,
      itemId: itemId || undefined,
    });
  }

  #finalize(turnStatus: string): void {
    if (this.#terminal) return;
    if (this.#result === null) {
      this.#commitResult({
        schema: "paperclip.run_result.v1",
        reportedWorkDisposition: "needs_review",
        summary: "Codex ended without a valid semantic completion.",
        completionClaim: {
          contractRevision: this.#taskEnvelope.completionContract.revision,
          objectiveSatisfied: false,
          criteria: this.#taskEnvelope.completionContract.criteria.map((criterion) => ({
            criterionId: criterion.id,
            status: "unknown",
            evidenceRefs: [],
          })),
          remainingWork: [{ description: "Review the incomplete Codex turn.", blocksCompletion: true }],
        },
        evidence: [],
        verification: [],
        attentionRequests: [],
        artifacts: [],
      }, "missing-semantic-result");
    }
    const result = this.#result;
    if (result === null) throw new Error("semantic result finalization invariant failed");
    this.#terminal = true;
    this.#emit("run.terminal", {
      schema: "paperclip.prp.terminal.v1",
      turnTerminalState: terminalState(turnStatus),
      runTerminalState: dispositionRunState(result),
      reportedWorkDisposition: result.reportedWorkDisposition,
    });
  }

  #requireActiveTurn(turnId: string): void {
    if (this.#activeTurnId !== turnId) {
      throw this.#unsupported("active turn operation", "turn is no longer active");
    }
  }

  #requireCapability(operation: keyof CodexCapabilities): void {
    if (!this.#capabilities[operation]) throw this.#unsupported(operation, "capability not advertised");
  }

  #unsupported(operation: string, detail: unknown): UnsupportedCodexOperationError {
    const error = new UnsupportedCodexOperationError(operation, String(detail));
    this.#diagnoseUnsupported(operation, error.message);
    return error;
  }

  #diagnoseUnsupported(operation: string, detail = "operation is not available"): void {
    this.#emit("harness.diagnostic", {
      code: "unsupported_operation",
      operation,
      message: redactCodexDiagnostic(detail),
    });
  }

  #emit(
    eventType: PrpEvent["eventType"],
    payload: Record<string, unknown>,
    refs: { turnId?: string; itemId?: string } = {},
  ): void {
    const sourceSeq = ++this.#sourceSequence;
    this.#events.push({
      schema: "paperclip.prp.event.v1",
      sourceEventId: `${this.#runnerInstanceId}:${this.#runId}:${sourceSeq}`,
      sourceSeq,
      sourceInstanceId: this.#runnerInstanceId,
      sourceKind: "runner",
      runId: this.#runId,
      normalizedSessionId: this.#normalizedSessionId,
      ...(refs.turnId ? { turnId: refs.turnId } : {}),
      ...(refs.itemId ? { itemId: refs.itemId } : {}),
      eventType,
      schemaVersion: 1,
      priority: eventType === "run.terminal" || eventType === "run.result.proposed" ? 0 : 1,
      emittedAt: this.#now().toISOString(),
      payload,
    });
  }
}

export function isSkilllessContext(context: Phase4ModelContextSnapshot): boolean {
  const serialized = JSON.stringify(context).toLowerCase();
  return (
    context.instructionSources.length === 0 &&
    context.baseInstructions === PHASE4_SKILLLESS_BASE_INSTRUCTIONS &&
    context.modelInputKinds.length === 1 &&
    context.modelInputKinds[0] === "text" &&
    context.dynamicToolNames.length === PHASE4_SEMANTIC_TOOL_NAMES.length &&
    context.dynamicToolNames.every((name) =>
      PHASE4_SEMANTIC_TOOL_NAMES.includes(
        name as (typeof PHASE4_SEMANTIC_TOOL_NAMES)[number],
      ),
    ) &&
    context.instructionPolicy.skillInstructions === false &&
    context.instructionPolicy.appInstructions === false &&
    context.instructionPolicy.collaborationInstructions === false &&
    !serialized.includes("paperclip_api_key") &&
    !serialized.includes("authorization: bearer") &&
    !serialized.includes("/api/issues/") &&
    !serialized.includes('"type":"skill"')
  );
}

function isSemanticTool(tool: string): boolean {
  return (
    tool === PHASE4_COMPLETION_TOOL_NAME ||
    tool === PHASE4_BLOCK_TOOL_NAME ||
    tool === "paperclip.finish" ||
    tool === "paperclip.block"
  );
}

function toolAcceptsDisposition(
  tool: string,
  disposition: PrpStructuredRunResult["reportedWorkDisposition"],
): boolean {
  if (tool === PHASE4_BLOCK_TOOL_NAME || tool === "paperclip.block") {
    return disposition === "blocked";
  }
  return disposition === "done" || disposition === "needs_review";
}

function redactCodexValue(value: unknown): unknown {
  if (typeof value === "string") return redactCodexDiagnostic(value);
  if (Array.isArray(value)) return value.map(redactCodexValue);
  const object = record(value);
  return Object.fromEntries(
    Object.entries(object).map(([key, entry]) => [
      key,
      /(?:api[_-]?key|token|secret|password|authorization)/i.test(key)
        ? "[REDACTED]"
        : redactCodexValue(entry),
    ]),
  );
}

function safeRequestResponse(method: string): Record<string, unknown> {
  if (method === "item/permissions/requestApproval") {
    return { permissions: {} };
  }
  if (method === "mcpServer/elicitation/request") {
    return { action: "decline", content: null };
  }
  if (method === "item/tool/requestUserInput" || method === "tool/requestUserInput") {
    return { answers: {} };
  }
  if (method.includes("requestApproval")) {
    return { decision: "decline" };
  }
  return {};
}
