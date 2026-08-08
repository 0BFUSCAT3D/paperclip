import { parse, relative, resolve } from "node:path";

import type {
  HarnessDriver,
  HarnessDriverDescriptor,
  HarnessSession,
  HarnessSessionRecoveryResult,
  OpenHarnessSessionInput,
  PersistedHarnessSession,
  PersistedHarnessSemanticResult,
  PersistedHarnessTurnTerminal,
} from "../../contracts/harness-driver.js";
import {
  HarnessCapabilityUnavailableError,
  HarnessReconciliationError,
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
  type CodexAppServerTransport,
  type CodexRpcNotification,
  type CodexRpcServerRequest,
} from "./app-server-transport.js";

const DRIVER_KIND = "codex_app_server";
const DRIVER_VERSION = "phase4-v2";
const SKILLLESS_PERMISSION_PROFILE = "paperclip-runner-workspace-only";
const MAX_RETAINED_CODEX_PAYLOAD_BYTES = 64 * 1024;
const MAX_RETAINED_CODEX_STRING_CHARS = 32 * 1024;

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
  providerSessionId: string | null;
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

function boundedText(value: unknown, fallback = "unknown", maxCharacters = 1024): string {
  const candidate = text(value, fallback);
  return candidate.length <= maxCharacters
    ? candidate
    : `${candidate.slice(0, maxCharacters)}...[truncated]`;
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

function terminalState(status: string): "completed" | "failed" | "interrupted" | "cancelled" {
  if (status === "failed") return "failed";
  if (status === "interrupted") return "interrupted";
  if (status === "cancelled") return "cancelled";
  return "completed";
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

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = record(value);
  if (Object.keys(object).length > 0 || (typeof value === "object" && value !== null)) {
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
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

const SKILLLESS_BASE_CONFIG = {
  "skills.include_instructions": false,
  include_apps_instructions: false,
  include_collaboration_mode_instructions: false,
  "features.apps": false,
  "features.plugins": false,
  "features.multi_agent": false,
  "features.memories": false,
} as const;

function commandEnvironment(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const key of ["PATH", "PATHEXT", "SystemRoot", "WINDIR", "LANG", "LC_ALL"] as const) {
    const value = source[key];
    if (value !== undefined) environment[key] = value;
  }
  return environment;
}

export function createSkilllessCodexThreadConfig(
  _workingDirectory: string,
  _source: NodeJS.ProcessEnv = process.env,
): Record<string, unknown> {
  return { ...SKILLLESS_BASE_CONFIG };
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

export function createIsolatedCodexAppServerArgs(
  source: NodeJS.ProcessEnv = process.env,
): string[] {
  const deniedHostRoots = [...new Set([source.HOME, source.CODEX_HOME]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => resolve(value)))];
  const filesystemRules = [
    `\":root\"=\"none\"`,
    `\":minimal\"=\"read\"`,
    `\":tmpdir\"=\"none\"`,
    ...deniedHostRoots.map((path) => `${tomlString(path)}=\"none\"`),
    `\":workspace_roots\"={\".\"=\"write\"}`,
  ].join(",");
  const commandEnv = Object.entries(commandEnvironment(source))
    .map(([key, value]) => `${key}=${tomlString(value)}`)
    .join(",");
  return [
    "-c",
    `default_permissions=${tomlString(SKILLLESS_PERMISSION_PROFILE)}`,
    "-c",
    `permissions.${SKILLLESS_PERMISSION_PROFILE}.filesystem={${filesystemRules}}`,
    "-c",
    `permissions.${SKILLLESS_PERMISSION_PROFILE}.network.enabled=false`,
    "-c",
    `shell_environment_policy.inherit=\"none\"`,
    "-c",
    "shell_environment_policy.ignore_default_excludes=false",
    ...(commandEnv.length > 0
      ? ["-c", `shell_environment_policy.set={${commandEnv}}`]
      : []),
    "app-server",
  ];
}

function securedThreadParams(
  workingDirectory: string,
  source: NodeJS.ProcessEnv = process.env,
): Record<string, unknown> {
  return {
    cwd: workingDirectory,
    config: createSkilllessCodexThreadConfig(workingDirectory, source),
    permissions: SKILLLESS_PERMISSION_PROFILE,
    runtimeWorkspaceRoots: [workingDirectory],
  };
}

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
    const workingDirectory = validateWorkingDirectory(input.workingDirectory, this.#options.environment);
    const transport = this.#transport();
    try {
      const initialize = await this.#initialize(transport);
      const response = await transport.request("thread/start", {
        ...securedThreadParams(workingDirectory, this.#options.environment),
        approvalPolicy: "never",
        baseInstructions: PHASE4_SKILLLESS_BASE_INSTRUCTIONS,
        dynamicTools: this.#caps.dynamicTools ? [finishToolSpec(), blockToolSpec()] : [],
        experimentalRawEvents: false,
        persistExtendedHistory: false,
      });
      const opened = this.#openedThread(response, initialize, workingDirectory);
      return this.#session({
        transport,
        runId: input.runId,
        normalizedSessionId: input.normalizedSessionId,
        opened,
        resumed: false,
        sourceSequence: 0,
      });
    } catch (error) {
      await transport.close();
      throw error;
    }
  }

  async recoverSession(
    snapshot: PersistedHarnessSession,
  ): Promise<HarnessSessionRecoveryResult> {
    if (!this.#caps.resume) {
      return { recovered: false, reason: "resume capability is unavailable" };
    }
    if (!this.#caps.read) {
      return { recovered: false, reason: "read capability is required for safe resume" };
    }
    if (!snapshot.runId || !snapshot.normalizedSessionId || !snapshot.driverSessionId) {
      return { recovered: false, reason: "persisted session identity is incomplete" };
    }
    const transport = this.#transport();
    try {
      const initialize = await this.#initialize(transport);
      const existing = await transport.request("thread/read", {
        threadId: snapshot.driverSessionId,
        includeTurns: false,
      });
      const existingThread = record(existing.thread);
      if (text(existingThread.id) !== snapshot.driverSessionId) {
        await transport.close();
        return { recovered: false, reason: "provider read a different session" };
      }
      const workingDirectory = validateWorkingDirectory(
        text(existingThread.cwd),
        this.#options.environment,
      );
      const response = await transport.request("thread/resume", {
        threadId: snapshot.driverSessionId,
        ...securedThreadParams(workingDirectory, this.#options.environment),
        baseInstructions: PHASE4_SKILLLESS_BASE_INSTRUCTIONS,
        persistExtendedHistory: false,
      });
      const opened = this.#openedThread(response, initialize, workingDirectory);
      if (opened.threadId !== snapshot.driverSessionId) {
        await transport.close();
        return { recovered: false, reason: "provider resumed a different session" };
      }
      if (
        snapshot.providerSessionId &&
        opened.providerSessionId !== snapshot.providerSessionId
      ) {
        await transport.close();
        return { recovered: false, reason: "provider resumed a different provider session" };
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
          semanticResult: snapshot.semanticResult ?? null,
          terminalTurns: snapshot.terminalTurns ?? [],
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
        args: createIsolatedCodexAppServerArgs(this.#options.environment),
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
    const activePermissionProfile = record(thread.activePermissionProfile);
    const permissionProfileId = text(activePermissionProfile.id);
    if (
      permissionProfileId.length > 0 &&
      permissionProfileId !== SKILLLESS_PERMISSION_PROFILE
    ) {
      throw new Error("Codex thread did not activate the required filesystem permission profile");
    }
    const configuredPermissionProfile = {
      ...activePermissionProfile,
      id: SKILLLESS_PERMISSION_PROFILE,
    };
    const returnedWorkingDirectory = text(response.cwd, workingDirectory);
    if (resolve(returnedWorkingDirectory) !== workingDirectory) {
      throw new Error("Codex thread response changed the assigned working directory");
    }
    return {
      threadId,
      providerSessionId: text(thread.sessionId) || null,
      context: {
        protocolVersion: PHASE4_CODEX_PROTOCOL_VERSION,
        codexVersion: boundedText(initialize.userAgent),
        clientInfo: {
          name: "paperclip-runner",
          title: "Paperclip Runner",
          version: DRIVER_VERSION,
        },
        model: boundedText(response.model),
        modelProvider: boundedText(response.modelProvider, boundedText(thread.modelProvider)),
        workingDirectory,
        sandbox: {
          permissionProfile: boundedCodexValue(configuredPermissionProfile),
          legacyPolicy: boundedCodexValue(response.sandbox ?? null),
          rootAccess: "none",
          minimalRuntimeAccess: "read",
          workspaceAccess: "write",
          networkAccess: false,
        },
        approvalPolicy: boundedCodexValue(response.approvalPolicy ?? "never"),
        baseInstructions: PHASE4_SKILLLESS_BASE_INSTRUCTIONS,
        instructionSources: Array.isArray(response.instructionSources)
          ? response.instructionSources
              .filter((value): value is string => typeof value === "string")
              .slice(0, 32)
              .map((value) => boundedText(value))
          : [],
        instructionPolicy: {
          skillInstructions: false,
          appInstructions: false,
          collaborationInstructions: false,
        },
        environmentKeys: Object.keys(
          commandEnvironment(this.#options.environment),
        ).sort(),
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
    semanticResult?: PersistedHarnessSemanticResult | null;
    terminalTurns?: PersistedHarnessTurnTerminal[];
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
  #resultCallId: string | null = null;
  #resultTurnId: string | null = null;
  #turnStartPending = false;
  #protocolFailed = false;
  #protocolFailureCode: string | null = null;
  #protocolFailureMessage: string | null = null;
  #terminal = false;
  #turnStarted = false;
  readonly #terminalTurns = new Map<string, string>();

  constructor(input: {
    transport: CodexAppServerTransport;
    runId: string;
    normalizedSessionId: string;
    opened: OpenedCodexThread;
    taskEnvelope: Phase4TaskEnvelope;
    resumed: boolean;
    activeTurnId?: string | null;
    semanticResult?: PersistedHarnessSemanticResult | null;
    terminalTurns?: PersistedHarnessTurnTerminal[];
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
    if (input.semanticResult) {
      const validation = validatePrpStructuredRunResult(input.semanticResult.result);
      if (!validation.ok || canonicalJson(validation.result) !== input.semanticResult.fingerprint) {
        throw new HarnessReconciliationError("persisted semantic result fingerprint is invalid");
      }
      this.#result = structuredClone(validation.result);
      this.#resultFingerprint = input.semanticResult.fingerprint;
      this.#resultCallId = input.semanticResult.callId ?? null;
      this.#resultTurnId = input.semanticResult.turnId;
    }
    for (const terminal of input.terminalTurns ?? []) {
      if (!terminal.turnId || !terminal.fingerprint || this.#terminalTurns.has(terminal.turnId)) {
        throw new HarnessReconciliationError("persisted terminal turn fingerprints are invalid");
      }
      this.#terminalTurns.set(terminal.turnId, terminal.fingerprint);
    }
    this.#terminal = this.#terminalTurns.size > 0;
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
    if (this.#terminal || this.#protocolFailed || this.#activeTurnId !== null || this.#turnStartPending) {
      throw this.#unsupported(
        "turn start",
        this.#protocolFailureCode === null
          ? "session cannot start another turn"
          : `session failed protocol validation: ${this.#protocolFailureCode} (${this.#protocolFailureMessage ?? "no detail"})`,
      );
    }
    const taskText = JSON.stringify({ task: this.#taskEnvelope, message: input.message.text });
    this.#emit("turn.submitted", { envelopeSchema: this.#taskEnvelope.schema });
    this.#turnStartPending = true;
    let response: Record<string, unknown>;
    try {
      response = await this.#transport.request("turn/start", {
        threadId: this.#opened.threadId,
        cwd: this.#opened.context.workingDirectory,
        permissions: SKILLLESS_PERMISSION_PROFILE,
        runtimeWorkspaceRoots: [this.#opened.context.workingDirectory],
        input: [userInput({ role: "user", text: taskText })],
        outputSchema: PHASE4_RESULT_OUTPUT_SCHEMA,
      });
    } finally {
      this.#turnStartPending = false;
    }
    const turn = record(response.turn);
    const turnId = text(turn.id);
    if (turnId.length === 0) throw new Error("Codex turn response omitted turn.id");
    if (this.#activeTurnId !== null && this.#activeTurnId !== turnId) {
      this.#failProtocol("turn_start_mismatch", "turn/start response disagreed with turn/started");
      throw new Error("Codex turn identity changed during start");
    }
    this.#activeTurnId ??= turnId;
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
    if (text(thread.id) !== this.#opened.threadId) {
      throw new HarnessReconciliationError("thread/read returned a different driver session");
    }
    const providerSessionId = text(thread.sessionId);
    if (
      this.#opened.providerSessionId !== null &&
      providerSessionId !== this.#opened.providerSessionId
    ) {
      throw new HarnessReconciliationError("thread/read returned a different provider session");
    }
    const turns = Array.isArray(thread.turns) ? thread.turns.map(record) : [];
    const reconciledUsage = boundedPayload(record(thread.tokenUsage ?? snapshot.tokenUsage));
    if (Object.keys(reconciledUsage).length > 0) this.#usage = reconciledUsage;
    const activeTurns = turns.filter((turn) => text(turn.status) === "inProgress");
    const expectedTurnId = this.#activeTurnId;
    const unexpectedActive = activeTurns.find((turn) => text(turn.id) !== expectedTurnId);
    if (unexpectedActive !== undefined) {
      throw new HarnessReconciliationError(
        `thread/read exposed active turn ${text(unexpectedActive.id)} instead of persisted active turn ${expectedTurnId ?? "none"}`,
      );
    }

    let reconciledTerminalTurnId: string | null = null;
    if (expectedTurnId !== null) {
      const expectedTurn = turns.find((turn) => text(turn.id) === expectedTurnId);
      if (expectedTurn === undefined) {
        throw new HarnessReconciliationError(
          `persisted active turn ${expectedTurnId} is missing from thread/read`,
        );
      }
      const status = text(expectedTurn.status);
      if (status === "inProgress") {
        this.#activeTurnId = expectedTurnId;
      } else if (["completed", "failed", "interrupted", "cancelled"].includes(status)) {
        reconciledTerminalTurnId = expectedTurnId;
        this.#mapTerminalTurn(expectedTurn, expectedTurnId);
      } else {
        throw new HarnessReconciliationError(
          `persisted active turn ${expectedTurnId} has unreconcilable status ${status || "missing"}`,
        );
      }
    }

    for (const [turnId, fingerprint] of this.#terminalTurns) {
      const observed = turns.find((turn) => text(turn.id) === turnId);
      if (observed === undefined) continue;
      if (!["completed", "failed", "interrupted", "cancelled"].includes(text(observed.status))) {
        throw new HarnessReconciliationError(
          `previously terminal turn ${turnId} is no longer terminal in thread/read`,
        );
      }
      if (this.#terminalFingerprint(observed) !== fingerprint) {
        throw new HarnessReconciliationError(
          `previously terminal turn ${turnId} changed after recovery`,
        );
      }
    }
    this.#emit("session.reconciled", {
      providerSessionId: this.#opened.providerSessionId,
      turnCount: turns.length,
      activeTurnId: this.#activeTurnId,
      terminalTurnId: reconciledTerminalTurnId,
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
      semanticResult: this.#result === null || this.#resultFingerprint === null || this.#resultTurnId === null
        ? null
        : {
            result: structuredClone(this.#result),
            fingerprint: this.#resultFingerprint,
            callId: this.#resultCallId,
            turnId: this.#resultTurnId,
          },
      terminalTurns: [...this.#terminalTurns].map(([turnId, fingerprint]) => ({
        turnId,
        fingerprint,
      })),
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
      this.#failProtocol(
        "notification_transport_failed",
        "Provider notification transport failed closed.",
      );
    }
  }

  #mapNotification(notification: CodexRpcNotification): void {
    if (!isBoundCodexNotification(notification.method)) return;
    const params = notification.params;
    const turn = record(params.turn);
    const item = itemFromParams(params);
    const threadId = text(params.threadId);
    const turnId = text(params.turnId, text(turn.id));
    const itemId = text(item.id, text(params.itemId));
    if (notification.method === "error" || notification.method === "warning" || notification.method === "configWarning") {
      this.#emit("harness.diagnostic", {
        code: notification.method.replaceAll("/", "_"),
        message: redactCodexDiagnostic(text(params.message, JSON.stringify(boundedCodexValue(params)))),
      });
      return;
    }
    if (threadId !== this.#opened.threadId) {
      this.#failProtocol(
        "thread_binding_mismatch",
        `Provider ${notification.method} message did not name the opened thread.`,
      );
      return;
    }
    if (notification.method === "turn/started") {
      if (
        turnId.length === 0 ||
        this.#terminal ||
        this.#protocolFailed ||
        this.#turnStarted ||
        (!this.#turnStartPending && this.#activeTurnId === null) ||
        (this.#activeTurnId !== null && this.#activeTurnId !== turnId)
      ) {
        this.#failProtocol("turn_binding_mismatch", "Provider started an unexpected turn.");
        return;
      }
      this.#activeTurnId = turnId;
      this.#turnStarted = true;
      this.#emit("turn.started", { status: text(turn.status, "inProgress") }, { turnId });
      return;
    }
    if (notification.method === "turn/completed") {
      if (this.#terminalTurns.has(turnId)) {
        this.#mapTerminalTurn(turn, turnId);
        return;
      }
      if (!this.#notificationNamesActiveTurn(turnId, "turn terminal")) return;
      this.#mapTerminalTurn(turn, turnId);
      return;
    }
    if (notification.method === "item/started") {
      if (!this.#notificationNamesActiveTurn(turnId, "item start")) return;
      this.#emit("item.started", boundedPayload({
        kind: text(item.type, "unknown"),
        text: itemText(item),
        item,
      }), { turnId, itemId });
      return;
    }
    if (notification.method === "item/completed") {
      if (!this.#notificationNamesActiveTurn(turnId, "item completion")) return;
      this.#captureResultFromItem(item, turnId);
      this.#emit("item.completed", boundedPayload({
        kind: text(item.type, "unknown"),
        text: itemText(item),
        item,
      }), { turnId, itemId });
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
      if (!this.#notificationNamesActiveTurn(turnId, "item update")) return;
      this.#emit("item.delta", boundedPayload({
        kind: deltaKind,
        text: text(params.delta, text(params.patch, text(params.output))),
        update: params,
      }), { turnId, itemId: itemId || `${turnId}:${deltaKind}` });
      return;
    }
    if (notification.method === "thread/tokenUsage/updated") {
      if (!this.#notificationNamesActiveTurn(turnId, "usage update")) return;
      this.#usage = boundedPayload(record(params.tokenUsage));
      this.#emit("item.completed", { kind: "usage", usage: this.#usage }, {
        turnId,
        itemId: `${turnId}:usage:${this.#sourceSequence + 1}`,
      });
      return;
    }
  }

  async #handleServerRequest(request: CodexRpcServerRequest): Promise<Record<string, unknown>> {
    if (request.method === "item/tool/call") {
      const tool = text(request.params.tool);
      const threadId = text(request.params.threadId);
      const turnId = text(request.params.turnId);
      const callId = text(request.params.callId);
      if (
        this.#protocolFailed ||
        this.#terminal ||
        threadId !== this.#opened.threadId ||
        turnId.length === 0 ||
        turnId !== this.#activeTurnId ||
        callId.length === 0
      ) {
        this.#failProtocol("tool_binding_mismatch", "Semantic tool call did not name the active thread and turn.");
        return rejectedToolCall("Semantic tool call was outside the active thread and turn.");
      }
      if (!isSemanticTool(tool)) {
        this.#diagnoseUnsupported(`dynamic tool ${tool}`);
        return rejectedToolCall("Unsupported tool.");
      }
      if (!isRetainableCodexPayload(request.params.arguments)) {
        return rejectedToolCall("Semantic result exceeded the retained payload limit.");
      }
      const validation = validatePrpStructuredRunResult(request.params.arguments);
      if (!validation.ok) {
        return {
          success: false,
          contentItems: [{ type: "inputText", text: "Invalid semantic result." }],
        };
      }
      if (!toolAcceptsDisposition(tool, validation.result.reportedWorkDisposition)) {
        return {
          success: false,
          contentItems: [{
            type: "inputText",
            text:
              tool === PHASE4_BLOCK_TOOL_NAME
                ? "paperclip_block requires reportedWorkDisposition=blocked."
                : "paperclip_finish accepts only done or needs_review.",
          }],
        };
      }
      const fingerprint = canonicalJson(validation.result);
      if (this.#resultFingerprint !== null && this.#resultFingerprint !== fingerprint) {
        return rejectedToolCall("A different semantic result was already committed.");
      }
      if (this.#result === null) {
        this.#commitResult(validation.result, callId, turnId);
      }
      return { success: true, contentItems: [{ type: "inputText", text: "Semantic completion accepted." }] };
    }

    if (!isTurnScopedServerRequest(request.method)) return safeRequestResponse(request.method);
    const requestTurnId = text(request.params.turnId);
    if (
      text(request.params.threadId) !== this.#opened.threadId ||
      requestTurnId.length === 0 ||
      requestTurnId !== this.#activeTurnId ||
      this.#terminal ||
      this.#protocolFailed
    ) {
      this.#failProtocol("runtime_request_binding_mismatch", "Runtime request did not name the active thread and turn.");
      return safeRequestResponse(request.method);
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
        details: redactCodexValue(boundedCodexValue(request.params)),
      },
    }, {
      turnId: requestTurnId,
      itemId: text(request.params.itemId, requestId),
    });
    const response = safeRequestResponse(request.method);
    this.#emit("runtime_request.resolved", {
      requestId,
      resolution: "declined_by_skillless_driver",
    }, {
      turnId: requestTurnId,
      itemId: text(request.params.itemId, requestId),
    });
    return response;
  }

  #captureResultFromItem(item: Record<string, unknown>, turnId: string): void {
    if (text(item.type) !== "agentMessage" || this.#result !== null) return;
    if (!isRetainableCodexPayload(item.text)) return;
    const result = tryParseResult(item.text);
    if (result !== null && isRetainableCodexPayload(result)) {
      this.#commitResult(result, text(item.id), turnId);
    }
  }

  #commitResult(result: PrpStructuredRunResult, itemId: string, turnId?: string): void {
    if (this.#result !== null) return;
    this.#result = structuredClone(result);
    this.#resultFingerprint = canonicalJson(result);
    this.#resultCallId = itemId || null;
    this.#resultTurnId = turnId || this.#activeTurnId;
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
      this.#emit("harness.diagnostic", {
        code: "semantic_result_missing",
        message: `Turn ${turnStatus} without a schema-valid semantic proposal; recovery is required.`,
      });
    }
    this.#terminal = true;
  }

  #mapTerminalTurn(turn: Record<string, unknown>, fallbackTurnId: string): void {
    const turnId = text(turn.id, fallbackTurnId || this.#activeTurnId || "");
    const status = text(turn.status, "completed");
    const candidate = this.#resultFromTurn(turn) ?? this.#result;
    const fingerprint = this.#terminalFingerprint(turn, candidate);
    const previous = this.#terminalTurns.get(turnId);
    if (previous !== undefined) {
      if (previous !== fingerprint) {
        this.#failProtocol(
          "conflicting_turn_terminal",
          "Provider changed a terminal fact for an already terminal turn.",
        );
      }
      return;
    }
    this.#terminalTurns.set(turnId, fingerprint);
    if (candidate !== null && this.#result === null) {
      this.#commitResult(candidate, text(this.#resultItemFromTurn(turn)?.id), turnId);
    }
    const eventType =
      status === "failed"
        ? "turn.failed"
        : status === "interrupted"
          ? "turn.interrupted"
          : status === "cancelled"
            ? "turn.cancelled"
            : "turn.completed";
    this.#emit(eventType, boundedPayload({
      status,
      error: turn.error ?? null,
    }), { turnId });
    this.#activeTurnId = null;
    this.#finalize(status);
  }

  #terminalFingerprint(
    turn: Record<string, unknown>,
    candidate: PrpStructuredRunResult | null = this.#resultFromTurn(turn) ?? this.#result,
  ): string {
    return canonicalJson({
      terminalState: terminalState(text(turn.status, "completed")),
      error: turn.error ?? null,
      result: candidate,
    });
  }

  #resultItemFromTurn(turn: Record<string, unknown>): Record<string, unknown> | null {
    if (!Array.isArray(turn.items)) return null;
    return (
      turn.items
        .map(record)
        .reverse()
        .find((value) =>
          text(value.type) === "agentMessage" &&
          isRetainableCodexPayload(value.text) &&
          tryParseResult(value.text) !== null
        ) ??
      null
    );
  }

  #resultFromTurn(turn: Record<string, unknown>): PrpStructuredRunResult | null {
    const item = this.#resultItemFromTurn(turn);
    return item === null ? null : tryParseResult(item.text);
  }

  #requireActiveTurn(turnId: string): void {
    if (this.#activeTurnId !== turnId) {
      throw this.#unsupported("active turn operation", "turn is no longer active");
    }
  }

  #notificationNamesActiveTurn(turnId: string, kind: string): boolean {
    if (
      this.#protocolFailed ||
      this.#terminal ||
      turnId.length === 0 ||
      this.#activeTurnId === null ||
      turnId !== this.#activeTurnId
    ) {
      this.#failProtocol("turn_binding_mismatch", `Provider ${kind} did not name the active turn.`);
      return false;
    }
    return true;
  }

  #requireCapability(operation: keyof CodexCapabilities): void {
    if (!this.#capabilities[operation]) throw this.#unsupported(operation, "capability not advertised");
  }

  #unsupported(operation: string, detail: unknown): HarnessCapabilityUnavailableError {
    const error = new HarnessCapabilityUnavailableError(
      operation,
      redactCodexDiagnostic(String(detail)),
    );
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

  #failProtocol(code: string, message: string): void {
    if (this.#protocolFailed) return;
    this.#protocolFailed = true;
    this.#protocolFailureCode = code;
    this.#protocolFailureMessage = redactCodexDiagnostic(message);
    this.#emit("session.failed", {
      code,
      message: redactCodexDiagnostic(message),
      recoverable: false,
    });
    if (!this.#terminal && this.#activeTurnId !== null) {
      const turnId = this.#activeTurnId;
      this.#emit("turn.failed", { status: "failed", error: { code } }, { turnId });
      this.#terminalTurns.set(turnId, canonicalJson({ protocolFailure: code }));
      this.#activeTurnId = null;
    }
    this.#terminal = true;
    this.#events.close();
    void this.#transport.close();
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
      priority: eventType === "run.result.proposed" ? 0 : 1,
      emittedAt: this.#now().toISOString(),
      payload,
    });
  }
}

function validateWorkingDirectory(
  workingDirectory: string,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  if (workingDirectory.trim().length === 0) {
    throw new Error("Codex working directory is required");
  }
  const resolved = resolve(workingDirectory);
  if (resolved === parse(resolved).root) {
    throw new Error("Codex working directory cannot be a filesystem root");
  }
  const hostHome = environment.HOME?.trim();
  if (hostHome && pathContains(resolved, resolve(hostHome))) {
    throw new Error("Codex working directory cannot contain the host HOME");
  }
  const codexHome = environment.CODEX_HOME?.trim();
  if (codexHome) {
    const resolvedCodexHome = resolve(codexHome);
    if (pathContains(resolved, resolvedCodexHome) || pathContains(resolvedCodexHome, resolved)) {
      throw new Error("Codex working directory cannot overlap host CODEX_HOME");
    }
  }
  const configuredRoot = environment.PAPERCLIP_WORKSPACE_CWD;
  if (configuredRoot !== undefined && configuredRoot.trim().length > 0) {
    const root = resolve(configuredRoot);
    const pathFromRoot = relative(root, resolved);
    if (pathFromRoot === ".." || pathFromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
      throw new Error("Codex working directory is outside the assigned workspace");
    }
  }
  return resolved;
}

function pathContains(parent: string, candidate: string): boolean {
  const fromParent = relative(parent, candidate);
  return fromParent === "" || (
    fromParent !== ".." &&
    !fromParent.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
    !parse(fromParent).root
  );
}

function boundedCodexValue(value: unknown, depth = 0): unknown {
  if (depth > 8) return { truncated: true, reason: "maximum depth" };
  if (typeof value === "string") {
    return value.length <= MAX_RETAINED_CODEX_STRING_CHARS
      ? value
      : `${value.slice(0, MAX_RETAINED_CODEX_STRING_CHARS)}...[truncated]`;
  }
  if (Array.isArray(value)) {
    const bounded = value
      .slice(0, 128)
      .map((entry) => boundedCodexValue(entry, depth + 1));
    if (value.length > 128) bounded.push({ truncated: true, omittedItems: value.length - 128 });
    return bounded;
  }
  if (typeof value !== "object" || value === null) return value;
  const object = record(value);
  const bounded = Object.fromEntries(
    Object.entries(object)
      .slice(0, 128)
      .map(([key, entry]) => [key, boundedCodexValue(entry, depth + 1)]),
  );
  if (Object.keys(object).length > 128) bounded.truncatedEntries = Object.keys(object).length - 128;
  const serialized = JSON.stringify(bounded);
  return Buffer.byteLength(serialized) <= MAX_RETAINED_CODEX_PAYLOAD_BYTES
    ? bounded
    : { truncated: true, byteSize: Buffer.byteLength(serialized) };
}

function boundedPayload(value: Record<string, unknown>): Record<string, unknown> {
  return record(boundedCodexValue(value));
}

function isRetainableCodexPayload(value: unknown): boolean {
  try {
    return Buffer.byteLength(JSON.stringify(value)) <= MAX_RETAINED_CODEX_PAYLOAD_BYTES;
  } catch {
    return false;
  }
}

function isSemanticTool(tool: string): boolean {
  return tool === PHASE4_COMPLETION_TOOL_NAME || tool === PHASE4_BLOCK_TOOL_NAME;
}

function toolAcceptsDisposition(
  tool: string,
  disposition: PrpStructuredRunResult["reportedWorkDisposition"],
): boolean {
  if (tool === PHASE4_BLOCK_TOOL_NAME) {
    return disposition === "blocked";
  }
  return disposition === "done" || disposition === "needs_review";
}

function redactCodexValue(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[TRUNCATED]";
  if (typeof value === "string") return redactCodexDiagnostic(value);
  if (Array.isArray(value)) {
    return value.slice(0, 128).map((entry) => redactCodexValue(entry, depth + 1));
  }
  const object = record(value);
  return Object.fromEntries(
    Object.entries(object).slice(0, 128).map(([key, entry]) => [
      key,
      /(?:api[_-]?key|token|secret|password|authorization)/i.test(key)
        ? "[REDACTED]"
        : redactCodexValue(entry, depth + 1),
    ]),
  );
}

function rejectedToolCall(message: string): Record<string, unknown> {
  return { success: false, contentItems: [{ type: "inputText", text: message }] };
}

function isTurnScopedServerRequest(method: string): boolean {
  return method.startsWith("item/") || method.startsWith("tool/") || method === "mcpServer/elicitation/request";
}

function isBoundCodexNotification(method: string): boolean {
  return (
    method === "turn/started" ||
    method === "turn/completed" ||
    method === "thread/tokenUsage/updated" ||
    method === "error" ||
    method === "warning" ||
    method === "configWarning" ||
    method.startsWith("item/") ||
    method === "turn/diff/updated" ||
    method === "turn/plan/updated"
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
