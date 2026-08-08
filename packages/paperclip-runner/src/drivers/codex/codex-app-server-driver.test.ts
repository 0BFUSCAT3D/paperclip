import { describe, expect, it } from "vitest";

import {
  PHASE4_BLOCK_RESULT_OUTPUT_SCHEMA,
  PHASE4_RESULT_OUTPUT_SCHEMA,
  createPhase4TaskEnvelope,
  isSkilllessPhase4Context,
} from "../../contracts/phase4.js";
import {
  HarnessCapabilityUnavailableError,
  HarnessReconciliationError,
} from "../../contracts/harness-driver.js";
import {
  applyPrpEvent,
  createSessionSnapshotFromMetadata,
} from "../../reducer/session-reducer.js";
import {
  validatePrpEvent,
  type PrpCapabilities,
  type PrpEvent,
  type PrpStructuredRunResult,
} from "../../protocol/phase1-contract.js";
import {
  CodexAppServerDriver,
  createIsolatedCodexAppServerArgs,
} from "./codex-app-server-driver.js";
import {
  runPhase4CodexTracer,
  replayPersistedPhase4Events,
  validatePhase4ResultProposal,
} from "../../mock-core/phase4-codex-runner.js";
import type {
  CodexAppServerTransport,
  CodexRpcNotification,
  CodexRpcServerRequest,
  CodexServerRequestHandler,
} from "./app-server-transport.js";

class TestQueue<T> implements AsyncIterable<T> {
  values: T[] = [];
  waiters: Array<(value: IteratorResult<T>) => void> = [];
  closed = false;

  push(value: T): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value, done: false });
    else this.values.push(value);
  }

  close(): void {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: async () => {
        const value = this.values.shift();
        if (value) return { value, done: false };
        if (this.closed) return { value: undefined, done: true };
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

class FakeCodexTransport implements CodexAppServerTransport {
  readonly calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  readonly sentNotifications: Array<{ method: string; params?: Record<string, unknown> }> = [];
  readonly queue = new TestQueue<CodexRpcNotification>();
  handler: CodexServerRequestHandler = async () => ({});
  rejectMethods = new Map<string, Error>();
  readResponse: Record<string, unknown> | null = null;

  constructor(
    readonly threadId = "thread-1",
    readonly providerSessionId = "provider-session-1",
  ) {}

  async request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.calls.push({ method, params: structuredClone(params) });
    const rejection = this.rejectMethods.get(method);
    if (rejection) throw rejection;
    if (method === "initialize") {
      return { userAgent: "codex-cli/0.132.0", codexHome: "/isolated/codex", platformFamily: "unix", platformOs: "linux" };
    }
    if (method === "thread/start" || method === "thread/resume") {
      return {
        thread: {
          id: this.threadId,
          sessionId: this.providerSessionId,
          modelProvider: "openai",
          cwd: "/workspace",
          turns: [],
          activePermissionProfile: { id: "paperclip-runner-workspace-only" },
        },
        model: "gpt-test",
        modelProvider: "openai",
        cwd: "/workspace",
        sandbox: { type: "workspaceWrite" },
        approvalPolicy: "never",
        instructionSources: [],
      };
    }
    if (method === "turn/start") return { turn: { id: "turn-1", status: "inProgress", items: [] } };
    if (method === "thread/read") {
      return this.readResponse ?? { thread: { id: this.threadId, sessionId: this.providerSessionId, cwd: "/workspace", turns: [{ id: "turn-1", status: "inProgress", items: [] }] } };
    }
    return {};
  }

  notify(method: string, params?: Record<string, unknown>): void {
    this.sentNotifications.push(params === undefined ? { method } : { method, params });
  }

  notifications(): AsyncIterable<CodexRpcNotification> {
    return this.queue;
  }

  setServerRequestHandler(handler: CodexServerRequestHandler): void {
    this.handler = handler;
  }

  async close(): Promise<void> {
    this.queue.close();
  }

  push(method: string, params: Record<string, unknown>): void {
    this.queue.push({ method, params });
  }

  invoke(request: CodexRpcServerRequest): Promise<Record<string, unknown>> {
    return this.handler(request);
  }
}

const envelope = createPhase4TaskEnvelope({
  objective: "Create hello.txt with the text hello.",
  criteria: [{ id: "file", requirement: "hello.txt contains hello" }],
});

const result: PrpStructuredRunResult = {
  schema: "paperclip.run_result.v1",
  reportedWorkDisposition: "done",
  summary: "Created hello.txt.",
  completionClaim: {
    contractRevision: "phase4-demo-v1",
    objectiveSatisfied: true,
    criteria: [{ criterionId: "file", status: "satisfied", evidenceRefs: ["hello.txt"] }],
    remainingWork: [],
  },
  evidence: [{ ref: "hello.txt" }],
  verification: [{ commandOrCheck: "read hello.txt", status: "passed" }],
  attentionRequests: [],
  artifacts: [{ kind: "file", ref: "hello.txt" }],
};

function makeDriver(transports: FakeCodexTransport[], options: Record<string, unknown> = {}) {
  let index = 0;
  return new CodexAppServerDriver({
    taskEnvelope: envelope,
    environment: {
      PATH: "/bin",
      HOME: "/isolated/home",
      CODEX_HOME: "/isolated/codex",
      LANG: "C.UTF-8",
      PAPERCLIP_API_KEY: "must-not-pass",
      RANDOM_SKILL_PATH: "/skills/unrelated",
    },
    now: () => new Date("2026-08-08T12:00:00.000Z"),
    transportFactory: () => transports[index++]!,
    ...options,
  });
}

async function collectUntilTerminal(events: AsyncIterable<PrpEvent>): Promise<PrpEvent[]> {
  const collected: PrpEvent[] = [];
  for await (const event of events) {
    collected.push(event);
    if (["turn.completed", "turn.failed", "turn.interrupted", "turn.cancelled"].includes(event.eventType)) break;
  }
  return collected;
}

function reverseObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseObjectKeys);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .reverse()
      .map(([key, entry]) => [key, reverseObjectKeys(entry)]),
  );
}

async function traceCompletedProposal(
  proposal: PrpStructuredRunResult | null,
  options: {
    runId?: string;
    normalizedSessionId?: string;
    capabilities?: Record<string, boolean>;
    steer?: string;
    interrupt?: boolean;
  } = {},
) {
  const transport = new FakeCodexTransport();
  const driver = makeDriver([transport], { capabilities: options.capabilities });
  const traced = runPhase4CodexTracer({
    driver,
    taskEnvelope: envelope,
    workingDirectory: "/workspace",
    runId: options.runId,
    normalizedSessionId: options.normalizedSessionId,
    steer: options.steer,
    interrupt: options.interrupt,
  });
  while (!transport.calls.some((call) => call.method === "turn/start")) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  transport.push("turn/started", {
    threadId: "thread-1",
    turn: { id: "turn-1", status: "inProgress" },
  });
  if (proposal !== null) {
    transport.push("item/completed", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: { id: "answer-1", type: "agentMessage", text: JSON.stringify(proposal) },
    });
  }
  transport.push("turn/completed", {
    threadId: "thread-1",
    turn: { id: "turn-1", status: "completed", items: [] },
  });
  return { trace: await traced, transport };
}

describe("Codex app-server Phase 4 driver", () => {
  it("passes the common typed-event contract and reports one provider turn terminal", async () => {
    const transport = new FakeCodexTransport();
    const driver = makeDriver([transport]);
    const descriptor = await driver.descriptor();
    const session = await driver.openSession({ runId: "run-1", normalizedSessionId: "normalized-1", workingDirectory: "/workspace" });
    const turn = await session.startTurn({ message: { role: "user", text: "Do the safe task." } });

    transport.push("turn/started", { threadId: "thread-1", turn: { id: turn.turnId, status: "inProgress" } });
    transport.push("item/started", { threadId: "thread-1", turnId: turn.turnId, item: { id: "cmd-1", type: "commandExecution", command: "printf hello" } });
    transport.push("item/commandExecution/outputDelta", { threadId: "thread-1", turnId: turn.turnId, itemId: "cmd-1", delta: "hello" });
    transport.push("item/completed", { threadId: "thread-1", turnId: turn.turnId, item: { id: "file-1", type: "fileChange", changes: [{ path: "hello.txt" }] } });
    expect(await transport.invoke({
      id: "request-1",
      method: "item/tool/requestUserInput",
      params: { threadId: "thread-1", turnId: turn.turnId, itemId: "question-1" },
    })).toEqual({ answers: {} });
    transport.push("thread/tokenUsage/updated", { threadId: "thread-1", turnId: turn.turnId, tokenUsage: { total: { inputTokens: 10, outputTokens: 4 }, modelContextWindow: 128000 } });
    transport.push("item/completed", { threadId: "thread-1", turnId: turn.turnId, item: { id: "answer-1", type: "agentMessage", text: JSON.stringify(result) } });
    transport.push("turn/completed", { threadId: "thread-1", turn: { id: turn.turnId, status: "completed", items: [] } });

    const events = await collectUntilTerminal(session.events());
    expect(events.every((event) => validatePrpEvent(event).ok)).toBe(true);
    expect(events.filter((event) => event.eventType === "run.result.proposed")).toHaveLength(1);
    expect(events.filter((event) => event.eventType === "turn.completed")).toHaveLength(1);
    expect(events.filter((event) => event.eventType === "run.terminal")).toHaveLength(0);
    expect(events.map((event) => event.eventType)).toEqual(expect.arrayContaining([
      "session.started", "turn.started", "item.started", "item.delta", "item.completed", "run.result.proposed", "turn.completed",
      "runtime_request.created", "runtime_request.resolved",
    ]));

    const capabilities: PrpCapabilities = {
      schema: "paperclip.prp.capabilities.v1",
      sessionReusePolicy: "reuse_per_issue",
      driver: { kind: descriptor.kind, version: descriptor.version },
      steer: true,
      interrupt: true,
      resume: true,
      runtimeRequests: true,
      structuredResult: true,
      typedEvents: true,
    };
    const metadata = {
      fixtureName: "phase4-conformance",
      identity: { schema: "paperclip.prp.identity.v1" as const, companyId: "company-1", issueId: "issue-1", runId: "run-1", environmentLeaseId: "lease-1", runnerInstanceId: "runner-phase4", normalizedSessionId: "normalized-1" },
      capabilities,
    };
    const live = events.reduce(applyPrpEvent, createSessionSnapshotFromMetadata(metadata));
    const replay = events.reduce(applyPrpEvent, createSessionSnapshotFromMetadata(metadata));
    expect(live).toEqual(replay);
    expect(live.integrity).toBe("complete");
    expect(await session.usage?.()).toMatchObject({ modelContextWindow: 128000 });
  });

  it("captures an exact skillless model/environment snapshot with credentials absent", async () => {
    const transport = new FakeCodexTransport();
    const session = await makeDriver([transport]).openSession({ runId: "run-context", normalizedSessionId: "normalized-context", workingDirectory: "/workspace" });
    const iterator = session.events()[Symbol.asyncIterator]();
    const first = await iterator.next();
    const context = first.value?.payload.context as Parameters<typeof isSkilllessPhase4Context>[0];
    expect(context).toMatchObject({
      codexVersion: "codex-cli/0.132.0",
      model: "gpt-test",
      modelProvider: "openai",
      workingDirectory: "/workspace",
      approvalPolicy: "never",
      instructionSources: [],
      instructionPolicy: {
        skillInstructions: false,
        appInstructions: false,
        collaborationInstructions: false,
      },
      environmentKeys: ["LANG", "PATH"],
      envelope,
    });
    expect(isSkilllessPhase4Context(context)).toBe(true);
    expect(JSON.stringify(context)).not.toContain("must-not-pass");
    expect(JSON.stringify(transport.calls)).not.toContain("RANDOM_SKILL_PATH");
    expect(transport.calls.find((call) => call.method === "thread/start")?.params).toMatchObject({
      approvalPolicy: "never",
      config: {
        "skills.include_instructions": false,
        include_apps_instructions: false,
        include_collaboration_mode_instructions: false,
      },
      permissions: "paperclip-runner-workspace-only",
      runtimeWorkspaceRoots: ["/workspace"],
      dynamicTools: [{ name: "paperclip_finish" }, { name: "paperclip_block" }],
    });
    const commandPolicy = transport.calls.find((call) => call.method === "thread/start")
      ?.params.config as Record<string, unknown>;
    expect(JSON.stringify(commandPolicy)).not.toContain("/isolated/home");
    expect(JSON.stringify(commandPolicy)).not.toContain("/isolated/codex");
    expect(JSON.stringify(commandPolicy)).not.toContain("CODEX_HOME");
    const appServerArgs = createIsolatedCodexAppServerArgs({
      PATH: "/bin",
      LANG: "C.UTF-8",
      HOME: "/isolated/home",
      CODEX_HOME: "/isolated/codex",
    });
    expect(appServerArgs).toEqual(expect.arrayContaining([
      expect.stringContaining('default_permissions="paperclip-runner-workspace-only"'),
      expect.stringContaining('permissions.paperclip-runner-workspace-only.filesystem='),
      "permissions.paperclip-runner-workspace-only.network.enabled=false",
      'shell_environment_policy.inherit="none"',
      expect.stringContaining('shell_environment_policy.set={PATH="/bin",LANG="C.UTF-8"}'),
    ]));
    expect(appServerArgs.find((arg) => arg.startsWith("permissions."))).toContain(
      '"/isolated/home"="none"',
    );
    expect(appServerArgs.find((arg) => arg.startsWith("permissions."))).toContain(
      '"/isolated/codex"="none"',
    );
    expect(JSON.stringify(appServerArgs)).not.toContain("HOME=");
    expect(PHASE4_RESULT_OUTPUT_SCHEMA.properties.schema).toEqual({
      type: "string",
      const: "paperclip.run_result.v1",
    });
    expect(PHASE4_BLOCK_RESULT_OUTPUT_SCHEMA.properties.reportedWorkDisposition).toEqual({
      type: "string",
      const: "blocked",
    });
  });

  it("refuses to turn host credential roots into model-writable workspaces", async () => {
    await expect(makeDriver([]).openSession({
      runId: "run-codex-home",
      normalizedSessionId: "normalized-codex-home",
      workingDirectory: "/isolated/codex",
    })).rejects.toThrow("cannot overlap host CODEX_HOME");
    await expect(makeDriver([]).openSession({
      runId: "run-host-home",
      normalizedSessionId: "normalized-host-home",
      workingDirectory: "/isolated",
    })).rejects.toThrow("cannot contain the host HOME");
    await expect(makeDriver([]).openSession({
      runId: "run-root",
      normalizedSessionId: "normalized-root",
      workingDirectory: "/",
    })).rejects.toThrow("cannot be a filesystem root");
  });

  it("steers and interrupts an active turn without replacing the session", async () => {
    const transport = new FakeCodexTransport();
    const session = await makeDriver([transport]).openSession({ runId: "run-controls", normalizedSessionId: "normalized-controls", workingDirectory: "/workspace" });
    const { turnId } = await session.startTurn({ message: { role: "user", text: "Start." } });
    await session.steer?.({ turnId, message: { role: "user", text: "Use a shorter answer." } });
    await session.interrupt?.({ turnId, reason: "operator requested" });
    expect(transport.calls.map((call) => call.method)).toEqual([
      "initialize", "thread/start", "turn/start", "turn/steer", "turn/interrupt",
    ]);
    expect(session.ids()).toEqual({ driverSessionId: "thread-1", providerSessionId: "provider-session-1", displayId: "thread-1" });
  });

  it("makes duplicate semantic completion idempotent and rejects changed payloads", async () => {
    const transport = new FakeCodexTransport();
    const session = await makeDriver([transport]).openSession({ runId: "run-result", normalizedSessionId: "normalized-result", workingDirectory: "/workspace" });
    await session.startTurn({ message: { role: "user", text: "Complete." } });
    const request = { id: 1, method: "item/tool/call", params: { threadId: "thread-1", turnId: "turn-1", callId: "call-1", tool: "paperclip_finish", arguments: result } };
    expect(await transport.invoke(request)).toMatchObject({ success: true });
    expect(await transport.invoke({
      ...request,
      id: 2,
      params: { ...request.params, callId: "call-2", arguments: reverseObjectKeys(result) },
    })).toMatchObject({ success: true });
    expect((await session.snapshot()).semanticResult?.callId).toBe("call-1");
    const changed = structuredClone(result);
    changed.summary = "Changed after commit.";
    expect(await transport.invoke({ ...request, id: 3, params: { ...request.params, arguments: changed } })).toMatchObject({ success: false });
    transport.push("turn/completed", { threadId: "thread-1", turn: { id: "turn-1", status: "completed", items: [] } });
    transport.push("turn/completed", { threadId: "thread-1", turn: { id: "turn-1", status: "completed", items: [] } });
    const events = await collectUntilTerminal(session.events());
    expect(events.filter((event) => event.eventType === "run.result.proposed")).toHaveLength(1);
    expect(events.filter((event) => event.eventType === "turn.completed")).toHaveLength(1);
  });

  it("fails closed when an agent message changes a tool-committed result", async () => {
    const transport = new FakeCodexTransport();
    const session = await makeDriver([transport]).openSession({
      runId: "run-tool-then-message-conflict",
      normalizedSessionId: "normalized-tool-then-message-conflict",
      workingDirectory: "/workspace",
    });
    await session.startTurn({ message: { role: "user", text: "Complete." } });
    expect(await transport.invoke({
      id: "tool-result",
      method: "item/tool/call",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "tool-result",
        tool: "paperclip_finish",
        arguments: result,
      },
    })).toMatchObject({ success: true });
    const changed = structuredClone(result);
    changed.summary = "Conflicting agent-message result.";
    transport.push("item/completed", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: { id: "message-result", type: "agentMessage", text: JSON.stringify(changed) },
    });

    const events: PrpEvent[] = [];
    for await (const event of session.events()) events.push(event);
    expect(events.filter((event) => event.eventType === "run.result.proposed")).toHaveLength(1);
    expect(events.find((event) => event.eventType === "session.failed")?.payload)
      .toMatchObject({ code: "conflicting_semantic_result", recoverable: false });
    expect((await session.snapshot()).semanticResult?.result).toEqual(result);
  });

  it("rejects a tool result that changes an agent-message commitment", async () => {
    const transport = new FakeCodexTransport();
    const session = await makeDriver([transport]).openSession({
      runId: "run-message-then-tool-conflict",
      normalizedSessionId: "normalized-message-then-tool-conflict",
      workingDirectory: "/workspace",
    });
    await session.startTurn({ message: { role: "user", text: "Complete." } });
    transport.push("item/completed", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: { id: "message-result", type: "agentMessage", text: JSON.stringify(result) },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const changed = structuredClone(result);
    changed.summary = "Conflicting tool result.";
    expect(await transport.invoke({
      id: "tool-result",
      method: "item/tool/call",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "tool-result",
        tool: "paperclip_finish",
        arguments: changed,
      },
    })).toMatchObject({ success: false });
    transport.push("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed", items: [] },
    });

    const events = await collectUntilTerminal(session.events());
    expect(events.filter((event) => event.eventType === "run.result.proposed")).toHaveLength(1);
    expect(events.some((event) => event.eventType === "session.failed")).toBe(false);
    expect((await session.snapshot()).semanticResult).toMatchObject({
      callId: "message-result",
      result,
    });
  });

  it("treats a canonically identical cross-channel result as a no-op", async () => {
    const transport = new FakeCodexTransport();
    const session = await makeDriver([transport]).openSession({
      runId: "run-identical-cross-channel",
      normalizedSessionId: "normalized-identical-cross-channel",
      workingDirectory: "/workspace",
    });
    await session.startTurn({ message: { role: "user", text: "Complete." } });
    expect(await transport.invoke({
      id: "tool-result",
      method: "item/tool/call",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "tool-result",
        tool: "paperclip_finish",
        arguments: result,
      },
    })).toMatchObject({ success: true });
    transport.push("item/completed", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        id: "message-result",
        type: "agentMessage",
        text: JSON.stringify(reverseObjectKeys(result)),
      },
    });
    transport.push("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed", items: [] },
    });

    const events = await collectUntilTerminal(session.events());
    expect(events.filter((event) => event.eventType === "run.result.proposed")).toHaveLength(1);
    expect((await session.snapshot()).semanticResult?.callId).toBe("tool-result");
  });

  it("fails closed when a live terminal embeds a changed semantic result", async () => {
    const transport = new FakeCodexTransport();
    const session = await makeDriver([transport]).openSession({
      runId: "run-terminal-result-conflict",
      normalizedSessionId: "normalized-terminal-result-conflict",
      workingDirectory: "/workspace",
    });
    await session.startTurn({ message: { role: "user", text: "Complete." } });
    expect(await transport.invoke({
      id: "tool-result",
      method: "item/tool/call",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "tool-result",
        tool: "paperclip_finish",
        arguments: result,
      },
    })).toMatchObject({ success: true });
    const changed = structuredClone(result);
    changed.summary = "Conflicting terminal result.";
    transport.push("turn/completed", {
      threadId: "thread-1",
      turn: {
        id: "turn-1",
        status: "completed",
        items: [{ id: "terminal-result", type: "agentMessage", text: JSON.stringify(changed) }],
      },
    });

    const events: PrpEvent[] = [];
    for await (const event of session.events()) events.push(event);
    expect(events.find((event) => event.eventType === "session.failed")?.payload)
      .toMatchObject({ code: "conflicting_semantic_result", recoverable: false });
    expect(events.some((event) => event.eventType === "turn.completed")).toBe(false);
    expect((await session.snapshot()).semanticResult?.result).toEqual(result);
  });

  it.each([
    { threadId: "other-thread", turnId: "turn-1", label: "another thread" },
    { threadId: "thread-1", turnId: "other-turn", label: "another turn" },
  ])("rejects a semantic result for $label without committing it", async ({ threadId, turnId }) => {
    const transport = new FakeCodexTransport();
    const session = await makeDriver([transport]).openSession({
      runId: "run-hostile-tool",
      normalizedSessionId: "normalized-hostile-tool",
      workingDirectory: "/workspace",
    });
    await session.startTurn({ message: { role: "user", text: "Complete." } });
    expect(await transport.invoke({
      id: "hostile-call",
      method: "item/tool/call",
      params: { threadId, turnId, callId: "hostile-call", tool: "paperclip_finish", arguments: result },
    })).toMatchObject({ success: false });
    const events = await collectUntilTerminal(session.events());
    expect(events.some((event) => event.eventType === "run.result.proposed")).toBe(false);
    expect(events.find((event) => event.eventType === "session.failed")?.payload)
      .toMatchObject({ code: "tool_binding_mismatch", recoverable: false });
    expect(events.find((event) => event.eventType === "turn.failed")?.turnId).toBe("turn-1");
  });

  it("rejects pre-turn, cross-thread, and post-terminal notifications", async () => {
    const preTurnTransport = new FakeCodexTransport();
    const preTurn = await makeDriver([preTurnTransport]).openSession({
      runId: "run-pre-turn",
      normalizedSessionId: "normalized-pre-turn",
      workingDirectory: "/workspace",
    });
    preTurnTransport.push("item/completed", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: { id: "answer-pre", type: "agentMessage", text: JSON.stringify(result) },
    });
    const preTurnEvents: PrpEvent[] = [];
    for await (const event of preTurn.events()) preTurnEvents.push(event);
    expect(preTurnEvents.some((event) => event.eventType === "run.result.proposed")).toBe(false);
    expect(preTurnEvents.find((event) => event.eventType === "session.failed")?.payload)
      .toMatchObject({ code: "turn_binding_mismatch" });

    const crossThreadTransport = new FakeCodexTransport();
    const crossThread = await makeDriver([crossThreadTransport]).openSession({
      runId: "run-cross-thread",
      normalizedSessionId: "normalized-cross-thread",
      workingDirectory: "/workspace",
    });
    await crossThread.startTurn({ message: { role: "user", text: "Complete." } });
    crossThreadTransport.push("item/completed", {
      threadId: "other-thread",
      turnId: "turn-1",
      item: { id: "answer-other", type: "agentMessage", text: JSON.stringify(result) },
    });
    const crossThreadEvents = await collectUntilTerminal(crossThread.events());
    expect(crossThreadEvents.some((event) => event.eventType === "run.result.proposed")).toBe(false);
    expect(crossThreadEvents.find((event) => event.eventType === "session.failed")?.payload)
      .toMatchObject({ code: "thread_binding_mismatch" });

    const postTerminalTransport = new FakeCodexTransport();
    const postTerminal = await makeDriver([postTerminalTransport]).openSession({
      runId: "run-post-terminal",
      normalizedSessionId: "normalized-post-terminal",
      workingDirectory: "/workspace",
    });
    await postTerminal.startTurn({ message: { role: "user", text: "Complete." } });
    postTerminalTransport.push("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed", items: [] },
    });
    await collectUntilTerminal(postTerminal.events());
    expect(await postTerminalTransport.invoke({
      id: "late-call",
      method: "item/tool/call",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "late-call",
        tool: "paperclip_finish",
        arguments: result,
      },
    })).toMatchObject({ success: false });
  });

  it("rejects duplicate and conflicting terminal facts", async () => {
    const transport = new FakeCodexTransport();
    const session = await makeDriver([transport]).openSession({
      runId: "run-terminal-replay",
      normalizedSessionId: "normalized-terminal-replay",
      workingDirectory: "/workspace",
    });
    await session.startTurn({ message: { role: "user", text: "Complete." } });
    transport.push("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed", items: [] },
    });
    transport.push("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "failed", error: { message: "changed" }, items: [] },
    });
    const events: PrpEvent[] = [];
    for await (const event of session.events()) events.push(event);
    expect(events.filter((event) => event.eventType === "turn.completed")).toHaveLength(1);
    expect(events.filter((event) => event.eventType === "turn.failed")).toHaveLength(0);
    expect(events.find((event) => event.eventType === "session.failed")?.payload)
      .toMatchObject({ code: "conflicting_turn_terminal", recoverable: false });
  });

  it("rejects oversized semantic results without retaining provider payloads", async () => {
    const transport = new FakeCodexTransport();
    const session = await makeDriver([transport]).openSession({
      runId: "run-large-result",
      normalizedSessionId: "normalized-large-result",
      workingDirectory: "/workspace",
    });
    await session.startTurn({ message: { role: "user", text: "Complete." } });
    expect(await transport.invoke({
      id: "large-call",
      method: "item/tool/call",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "large-call",
        tool: "paperclip_finish",
        arguments: { ...result, summary: "x".repeat(70 * 1024) },
      },
    })).toEqual({
      success: false,
      contentItems: [{ type: "inputText", text: "Semantic result exceeded the retained payload limit." }],
    });
    transport.push("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed", items: [] },
    });
    const events = await collectUntilTerminal(session.events());
    expect(events.some((event) => JSON.stringify(event).includes("x".repeat(1024)))).toBe(false);
    expect(events.some((event) => event.eventType === "run.result.proposed")).toBe(false);
  });

  it("normalizes finish and block tools into one canonical result contract", async () => {
    const transport = new FakeCodexTransport();
    const session = await makeDriver([transport]).openSession({ runId: "run-tools", normalizedSessionId: "normalized-tools", workingDirectory: "/workspace" });
    await session.startTurn({ message: { role: "user", text: "Complete or block." } });
    const blocked: PrpStructuredRunResult = {
      ...structuredClone(result),
      reportedWorkDisposition: "blocked",
      summary: "Waiting on a fixture owner.",
      completionClaim: {
        ...structuredClone(result.completionClaim),
        objectiveSatisfied: false,
        criteria: [{ criterionId: "file", status: "not_satisfied", evidenceRefs: [] }],
        remainingWork: [{ description: "Fixture owner must provide input.", blocksCompletion: true }],
      },
      blocker: {
        reasonCode: "fixture_input_missing",
        owner: { kind: "external", name: "fixture owner" },
        unblockAction: "Provide the fixture input.",
        scope: "task_wide",
      },
      artifacts: [],
    };
    const request = {
      id: 10,
      method: "item/tool/call",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "call-block",
        tool: "paperclip_block",
        arguments: blocked,
      },
    };
    expect(await transport.invoke({
      ...request,
      id: 9,
      params: { ...request.params, tool: "paperclip_finish" },
    })).toMatchObject({ success: false });
    expect(await transport.invoke(request)).toMatchObject({ success: true });
    expect(await transport.invoke({ ...request, id: 11 })).toMatchObject({ success: true });
    transport.push("turn/completed", { threadId: "thread-1", turn: { id: "turn-1", status: "completed", items: [] } });
    const events = await collectUntilTerminal(session.events());
    expect(events.filter((event) => event.eventType === "run.result.proposed")).toHaveLength(1);
    expect(events.find((event) => event.eventType === "run.result.proposed")?.payload)
      .toMatchObject({ reportedWorkDisposition: "blocked" });
  });

  it("resumes and reconciles the exact provider thread after transport loss", async () => {
    const first = new FakeCodexTransport();
    const second = new FakeCodexTransport();
    const driver = makeDriver([first, second]);
    const original = await driver.openSession({ runId: "run-recover", normalizedSessionId: "normalized-recover", workingDirectory: "/workspace" });
    await original.startTurn({ message: { role: "user", text: "Work." } });
    const snapshot = await original.snapshot();
    await original.close({ reason: "transport lost" });
    const recovery = await driver.recoverSession?.(snapshot);
    expect(recovery).toMatchObject({ recovered: true });
    expect(recovery?.session?.ids()).toEqual(original.ids());
    expect(await recovery?.session?.reconcile?.()).toMatchObject({ thread: { id: "thread-1" } });
    expect(second.calls.map((call) => call.method)).toEqual(["initialize", "thread/read", "thread/resume", "thread/read"]);
    expect((await recovery?.session?.snapshot())?.activeTurnId).toBe("turn-1");
  });

  it("ignores an old terminal turn when the persisted active turn is still running", async () => {
    const first = new FakeCodexTransport();
    const second = new FakeCodexTransport();
    second.readResponse = {
      thread: {
        id: "thread-1",
        sessionId: "provider-session-1",
        cwd: "/workspace",
        turns: [
          { id: "turn-old", status: "completed", items: [] },
          { id: "turn-1", status: "inProgress", items: [] },
        ],
      },
    };
    const driver = makeDriver([first, second]);
    const original = await driver.openSession({
      runId: "run-history",
      normalizedSessionId: "normalized-history",
      workingDirectory: "/workspace",
    });
    await original.startTurn({ message: { role: "user", text: "Keep working." } });
    const snapshot = await original.snapshot();
    await original.close({ reason: "transport lost" });

    const recovery = await driver.recoverSession?.(snapshot);
    const recovered = recovery?.session;
    expect(recovered).toBeDefined();
    await recovered!.reconcile?.();
    expect(await recovered!.snapshot()).toMatchObject({ activeTurnId: "turn-1" });
    await recovered!.close({ reason: "test complete" });
    const events: PrpEvent[] = [];
    for await (const event of recovered!.events()) events.push(event);
    expect(events.some((event) => event.eventType === "turn.completed")).toBe(false);
  });

  it("preserves proposal idempotency and rejects a changed result after transport loss", async () => {
    const first = new FakeCodexTransport();
    const second = new FakeCodexTransport();
    const driver = makeDriver([first, second]);
    const original = await driver.openSession({
      runId: "run-proposal-loss",
      normalizedSessionId: "normalized-proposal-loss",
      workingDirectory: "/workspace",
    });
    await original.startTurn({ message: { role: "user", text: "Complete." } });
    expect(await first.invoke({
      id: "call-before-loss",
      method: "item/tool/call",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "call-before-loss",
        tool: "paperclip_finish",
        arguments: result,
      },
    })).toMatchObject({ success: true });
    const snapshot = await original.snapshot();
    expect(snapshot.semanticResult).toMatchObject({
      callId: "call-before-loss",
      turnId: "turn-1",
      result,
    });
    await original.close({ reason: "transport lost after proposal" });
    const originalEvents: PrpEvent[] = [];
    for await (const event of original.events()) originalEvents.push(event);
    expect(originalEvents.filter((event) => event.eventType === "run.result.proposed")).toHaveLength(1);

    const recovery = await driver.recoverSession?.(snapshot);
    const recovered = recovery?.session;
    expect(recovered).toBeDefined();
    const collecting = collectUntilTerminal(recovered!.events());
    await recovered!.reconcile?.();
    expect(await second.invoke({
      id: "call-after-loss",
      method: "item/tool/call",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "call-after-loss",
        tool: "paperclip_finish",
        arguments: reverseObjectKeys(result),
      },
    })).toMatchObject({ success: true });
    const changed = structuredClone(result);
    changed.summary = "Changed after transport loss.";
    expect(await second.invoke({
      id: "changed-after-loss",
      method: "item/tool/call",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "changed-after-loss",
        tool: "paperclip_finish",
        arguments: changed,
      },
    })).toMatchObject({ success: false });
    second.push("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed", items: [] },
    });
    const events = await collecting;
    expect(events.filter((event) => event.eventType === "run.result.proposed")).toHaveLength(0);
    expect(events.filter((event) => event.eventType === "turn.completed")).toHaveLength(1);
  });

  it("rejects changed terminal result content discovered during recovery", async () => {
    const first = new FakeCodexTransport();
    const second = new FakeCodexTransport();
    const changed = structuredClone(result);
    changed.summary = "Conflicting recovered terminal result.";
    second.readResponse = {
      thread: {
        id: "thread-1",
        sessionId: "provider-session-1",
        cwd: "/workspace",
        turns: [{
          id: "turn-1",
          status: "completed",
          items: [{ id: "terminal-result", type: "agentMessage", text: JSON.stringify(changed) }],
        }],
      },
    };
    const driver = makeDriver([first, second]);
    const original = await driver.openSession({
      runId: "run-recovered-result-conflict",
      normalizedSessionId: "normalized-recovered-result-conflict",
      workingDirectory: "/workspace",
    });
    await original.startTurn({ message: { role: "user", text: "Complete." } });
    expect(await first.invoke({
      id: "tool-result",
      method: "item/tool/call",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "tool-result",
        tool: "paperclip_finish",
        arguments: result,
      },
    })).toMatchObject({ success: true });
    first.push("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed", items: [] },
    });
    await collectUntilTerminal(original.events());
    const snapshot = await original.snapshot();
    expect(snapshot.terminalTurns).toHaveLength(1);
    await original.close({ reason: "transport lost after terminal" });

    const recovery = await driver.recoverSession?.(snapshot);
    expect(recovery).toMatchObject({ recovered: true });
    await expect(recovery!.session!.reconcile!())
      .rejects.toMatchObject<HarnessReconciliationError>({
        name: "HarnessReconciliationError",
        recoverable: true,
        message: expect.stringContaining("contains a conflicting semantic result"),
      });
    expect((await recovery!.session!.snapshot()).semanticResult?.result).toEqual(result);
    await recovery!.session!.close({ reason: "test complete" });
  });

  it("does not re-emit an already observed terminal after recovery", async () => {
    const first = new FakeCodexTransport();
    const second = new FakeCodexTransport();
    second.readResponse = {
      thread: {
        id: "thread-1",
        sessionId: "provider-session-1",
        cwd: "/workspace",
        turns: [{ id: "turn-1", status: "completed", items: [] }],
      },
    };
    const driver = makeDriver([first, second]);
    const original = await driver.openSession({
      runId: "run-terminal-loss",
      normalizedSessionId: "normalized-terminal-loss",
      workingDirectory: "/workspace",
    });
    await original.startTurn({ message: { role: "user", text: "Complete." } });
    expect(await first.invoke({
      id: "terminal-call",
      method: "item/tool/call",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "terminal-call",
        tool: "paperclip_finish",
        arguments: result,
      },
    })).toMatchObject({ success: true });
    first.push("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed", items: [] },
    });
    await collectUntilTerminal(original.events());
    const snapshot = await original.snapshot();
    expect(snapshot.terminalTurns).toHaveLength(1);
    await original.close({ reason: "transport lost after terminal" });

    const recovery = await driver.recoverSession?.(snapshot);
    const recovered = recovery?.session;
    expect(recovered).toBeDefined();
    await recovered!.reconcile?.();
    await recovered!.close({ reason: "test complete" });
    const events: PrpEvent[] = [];
    for await (const event of recovered!.events()) events.push(event);
    expect(events.some((event) => event.eventType.startsWith("turn."))).toBe(false);
    expect(events.some((event) => event.eventType === "run.result.proposed")).toBe(false);
  });

  it("fails recovery explicitly when the persisted active turn is missing or replaced", async () => {
    for (const testCase of [
      {
        label: "missing",
        turns: [{ id: "turn-old", status: "completed", items: [] }],
        message: "persisted active turn turn-1 is missing",
      },
      {
        label: "replaced",
        turns: [{ id: "turn-2", status: "inProgress", items: [] }],
        message: "active turn turn-2 instead of persisted active turn turn-1",
      },
    ]) {
      const first = new FakeCodexTransport();
      const second = new FakeCodexTransport();
      second.readResponse = {
        thread: {
          id: "thread-1",
          sessionId: "provider-session-1",
          cwd: "/workspace",
          turns: testCase.turns,
        },
      };
      const driver = makeDriver([first, second]);
      const original = await driver.openSession({
        runId: `run-${testCase.label}-turn`,
        normalizedSessionId: `normalized-${testCase.label}-turn`,
        workingDirectory: "/workspace",
      });
      await original.startTurn({ message: { role: "user", text: "Work." } });
      const snapshot = await original.snapshot();
      await original.close({ reason: "transport lost" });
      const recovery = await driver.recoverSession?.(snapshot);
      expect(recovery?.session).toBeDefined();
      await expect(recovery!.session!.reconcile!())
        .rejects.toMatchObject<HarnessReconciliationError>({
          name: "HarnessReconciliationError",
          recoverable: true,
          message: expect.stringContaining(testCase.message),
        });
      await recovery!.session!.close({ reason: "test complete" });
    }
  });

  it("reconciles a turn completed during transport loss without replacing either session identity", async () => {
    const first = new FakeCodexTransport("driver-thread-loss", "provider-session-loss");
    const second = new FakeCodexTransport("driver-thread-loss", "provider-session-loss");
    second.readResponse = {
      thread: {
        id: "driver-thread-loss",
        sessionId: "provider-session-loss",
        cwd: "/workspace",
        tokenUsage: { total: { inputTokens: 21, outputTokens: 8 } },
        turns: [{
          id: "turn-1",
          status: "completed",
          items: [{ id: "answer-loss", type: "agentMessage", text: JSON.stringify(result) }],
        }],
      },
    };
    const driver = makeDriver([first, second]);
    const original = await driver.openSession({
      runId: "runtime-run-loss",
      normalizedSessionId: "controller-session-loss",
      workingDirectory: "/workspace",
    });
    await original.startTurn({ message: { role: "user", text: "Work through loss." } });
    const snapshot = await original.snapshot();
    await original.close({ reason: "transport lost before terminal delivery" });

    const recovery = await driver.recoverSession?.(snapshot);
    expect(recovery).toMatchObject({ recovered: true });
    const recovered = recovery?.session;
    expect(recovered).toBeDefined();
    const collecting = collectUntilTerminal(recovered!.events());
    await recovered!.reconcile?.();
    const events = await collecting;

    expect(recovered!.ids()).toEqual({
      driverSessionId: "driver-thread-loss",
      providerSessionId: "provider-session-loss",
      displayId: "driver-thread-loss",
    });
    expect(await recovered!.snapshot()).toMatchObject({
      runId: "runtime-run-loss",
      normalizedSessionId: "controller-session-loss",
      driverSessionId: "driver-thread-loss",
      providerSessionId: "provider-session-loss",
    });
    expect(events.filter((event) => event.eventType === "turn.completed")).toHaveLength(1);
    expect(events.filter((event) => event.eventType === "run.result.proposed")).toHaveLength(1);
    expect(events.every((event, index) => event.sourceSeq === snapshot.lastSourceSequence! + index + 1)).toBe(true);
    expect(await recovered!.usage?.()).toEqual({ total: { inputTokens: 21, outputTokens: 8 } });
  });

  it("degrades unsupported operations with explicit redacted diagnostics", async () => {
    const transport = new FakeCodexTransport();
    transport.rejectMethods.set("turn/steer", new Error("Bearer super-secret api_key=also-secret"));
    const session = await makeDriver([transport]).openSession({ runId: "run-degrade", normalizedSessionId: "normalized-degrade", workingDirectory: "/workspace" });
    const { turnId } = await session.startTurn({ message: { role: "user", text: "Start." } });
    await expect(session.steer?.({ turnId, message: { role: "user", text: "Steer." } })).rejects.toBeInstanceOf(HarnessCapabilityUnavailableError);
    const iterator = session.events()[Symbol.asyncIterator]();
    const events: PrpEvent[] = [];
    for (let index = 0; index < 5; index += 1) {
      const next = await iterator.next();
      if (next.value) events.push(next.value);
    }
    const diagnostic = events.find((event) => event.eventType === "harness.diagnostic");
    expect(diagnostic?.payload).toMatchObject({ code: "unsupported_operation", operation: "steering" });
    expect(JSON.stringify(diagnostic)).not.toContain("super-secret");
    expect(JSON.stringify(diagnostic)).not.toContain("also-secret");
  });

  it("rejects proposals that do not match the exact task envelope", () => {
    const wrongRevision = structuredClone(result);
    wrongRevision.completionClaim.contractRevision = "phase4-demo-v0";
    expect(validatePhase4ResultProposal(wrongRevision, envelope)).toMatchObject({
      status: "rejected",
      issues: [{ code: "contract_revision_mismatch" }],
    });

    const unknownCriterion = structuredClone(result);
    unknownCriterion.completionClaim.criteria = [{
      criterionId: "not-in-envelope",
      status: "satisfied",
      evidenceRefs: [],
    }];
    const criterionDecision = validatePhase4ResultProposal(unknownCriterion, envelope);
    expect(criterionDecision).toMatchObject({ status: "rejected" });
    if (criterionDecision.status === "rejected") {
      expect(criterionDecision.issues.map((issue) => issue.code)).toEqual(
        expect.arrayContaining(["unknown_criterion", "missing_criterion"]),
      );
    }

    const invalidDone = structuredClone(result);
    invalidDone.completionClaim.objectiveSatisfied = false;
    expect(validatePhase4ResultProposal(invalidDone, envelope)).toMatchObject({
      status: "rejected",
      issues: [{ code: "invalid_disposition" }],
    });
  });

  it.each(["needs_review", "blocked"] as const)(
    "keeps a completed runtime successful for an accepted %s advisory proposal",
    async (disposition) => {
      const proposal: PrpStructuredRunResult = disposition === "needs_review"
        ? {
            ...structuredClone(result),
            reportedWorkDisposition: "needs_review",
            attentionRequests: [{ kind: "review", summary: "Review the completed artifact." }],
          }
        : {
            ...structuredClone(result),
            reportedWorkDisposition: "blocked",
            summary: "Waiting on fixture input.",
            completionClaim: {
              ...structuredClone(result.completionClaim),
              objectiveSatisfied: false,
              criteria: [{ criterionId: "file", status: "not_satisfied", evidenceRefs: [] }],
              remainingWork: [{ description: "Provide fixture input.", blocksCompletion: true }],
            },
            blocker: {
              reasonCode: "fixture_input_missing",
              owner: { kind: "external", name: "fixture owner" },
              unblockAction: "Provide fixture input.",
              scope: "task_wide",
            },
            artifacts: [],
          };
      const { trace } = await traceCompletedProposal(proposal);
      expect(trace.resultDecision.status).toBe("accepted");
      expect(trace.events.find((event) => event.eventType === "run.terminal")?.payload)
        .toMatchObject({
          turnTerminalState: "completed",
          runTerminalState: "succeeded",
          reportedWorkDisposition: disposition,
        });
    },
  );

  it("records rejected and missing proposals as recovery evidence instead of review status", async () => {
    const wrongRevision = structuredClone(result);
    wrongRevision.completionClaim.contractRevision = "wrong-revision";
    const rejected = await traceCompletedProposal(wrongRevision);
    expect(rejected.trace.result).toBeNull();
    expect(rejected.trace.proposedResult).toMatchObject({ reportedWorkDisposition: "done" });
    expect(rejected.trace.events.find((event) => event.eventType === "run.result.rejected")?.payload)
      .toMatchObject({ recovery: { required: true, recoverable: true } });
    expect(rejected.trace.events.find((event) => event.eventType === "run.terminal")?.payload)
      .toMatchObject({ runTerminalState: "succeeded", reportedWorkDisposition: "yielded" });

    const missing = await traceCompletedProposal(null);
    expect(missing.trace.resultDecision).toMatchObject({ status: "rejected" });
    expect(missing.trace.events.some((event) =>
      event.eventType === "run.result.proposed" &&
      event.payload.reportedWorkDisposition === "needs_review"
    )).toBe(false);
  });

  it("preserves four independent stable identities under controller ownership", async () => {
    const { trace } = await traceCompletedProposal(result, {
      runId: "runtime-run-identity",
      normalizedSessionId: "controller-session-identity",
    });
    expect(trace.assertions.stableIdentity).toBe(true);
    expect(trace.metadata.identity).toMatchObject({
      runId: "runtime-run-identity",
      normalizedSessionId: "controller-session-identity",
      driverSessionId: "thread-1",
      providerSessionId: "provider-session-1",
    });
    expect(trace.events.every((event) =>
      event.runId === "runtime-run-identity" &&
      event.normalizedSessionId === "controller-session-identity"
    )).toBe(true);
  });

  it("validates persisted identity, uniqueness, terminals, and line bounds before replay", async () => {
    const { trace } = await traceCompletedProposal(result, {
      runId: "runtime-run-persisted",
      normalizedSessionId: "controller-session-persisted",
    });
    const serialize = (events: PrpEvent[]) => `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
    expect(replayPersistedPhase4Events(serialize(trace.events), trace.metadata))
      .toEqual(trace.replaySnapshot);

    const mismatched = structuredClone(trace.events);
    mismatched[0]!.normalizedSessionId = "another-session";
    expect(() => replayPersistedPhase4Events(serialize(mismatched), trace.metadata))
      .toThrow("identity did not match");

    const terminalIndex = trace.events.findIndex((event) => event.eventType === "run.terminal");
    const duplicated = trace.events.toSpliced(terminalIndex, 0, structuredClone(trace.events[0]!));
    expect(() => replayPersistedPhase4Events(serialize(duplicated), trace.metadata))
      .toThrow("event id was duplicated");

    const terminal = structuredClone(trace.events[terminalIndex]!);
    terminal.sourceEventId = `${terminal.sourceEventId}:conflict`;
    terminal.sourceSeq += 1;
    expect(() => replayPersistedPhase4Events(serialize([...trace.events, terminal]), trace.metadata))
      .toThrow("after the run terminal");
    expect(() => replayPersistedPhase4Events(`{\"payload\":\"${"x".repeat(300 * 1024)}\"}\n`, trace.metadata))
      .toThrow("line was empty or oversized");
    expect(() => replayPersistedPhase4Events("{not-json}\n", trace.metadata))
      .toThrow("malformed JSON");
  });

  it("degrades declared unsupported capabilities without Codex-specific core branches", async () => {
    const capabilities = {
      resume: false,
      read: false,
      steering: false,
      interruption: false,
      usage: false,
      reconciliation: false,
      dynamicTools: false,
    };
    const { trace, transport } = await traceCompletedProposal(result, {
      capabilities,
      steer: "Do not call this unsupported path.",
      interrupt: true,
    });
    expect(trace.resultDecision.status).toBe("accepted");
    expect(trace.assertions.contextIsSkillless).toBe(true);
    expect(trace.diagnostics).toEqual(expect.arrayContaining([
      expect.stringContaining("steering is unavailable"),
      expect.stringContaining("interruption is unavailable"),
    ]));
    expect(transport.calls.map((call) => call.method)).not.toEqual(
      expect.arrayContaining(["turn/steer", "turn/interrupt", "thread/read"]),
    );
    expect(transport.calls.find((call) => call.method === "thread/start")?.params.dynamicTools)
      .toEqual([]);

    const directTransport = new FakeCodexTransport();
    const driver = makeDriver([directTransport], { capabilities });
    const session = await driver.openSession({
      runId: "run-no-capabilities",
      normalizedSessionId: "normalized-no-capabilities",
      workingDirectory: "/workspace",
    });
    await expect(session.read?.()).rejects.toBeInstanceOf(HarnessCapabilityUnavailableError);
    await expect(session.usage?.()).rejects.toBeInstanceOf(HarnessCapabilityUnavailableError);
    const snapshot = await session.snapshot();
    expect(await driver.recoverSession?.(snapshot)).toMatchObject({
      recovered: false,
      reason: "resume capability is unavailable",
    });
  });
});
