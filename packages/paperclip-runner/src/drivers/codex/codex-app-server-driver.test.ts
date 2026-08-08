import { describe, expect, it } from "vitest";

import {
  PHASE4_BLOCK_RESULT_OUTPUT_SCHEMA,
  PHASE4_RESULT_OUTPUT_SCHEMA,
  createPhase4TaskEnvelope,
} from "../../contracts/phase4.js";
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
  UnsupportedCodexOperationError,
  isSkilllessContext,
} from "./codex-app-server-driver.js";
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
        thread: { id: this.threadId, sessionId: this.providerSessionId, modelProvider: "openai", cwd: "/workspace", turns: [] },
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
      return { thread: { id: this.threadId, sessionId: this.providerSessionId, turns: [{ id: "turn-1", status: "inProgress", items: [] }] } };
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
    if (event.eventType === "run.terminal") break;
  }
  return collected;
}

describe("Codex app-server Phase 4 driver", () => {
  it("passes the common typed-event contract and produces exactly one terminal result", async () => {
    const transport = new FakeCodexTransport();
    const driver = makeDriver([transport]);
    const descriptor = await driver.descriptor();
    const session = await driver.openSession({ runId: "run-1", workingDirectory: "/workspace" });
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
    expect(events.filter((event) => event.eventType === "run.terminal")).toHaveLength(1);
    expect(events.map((event) => event.eventType)).toEqual(expect.arrayContaining([
      "session.started", "turn.started", "item.started", "item.delta", "item.completed", "run.result.proposed", "run.terminal",
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
      identity: { schema: "paperclip.prp.identity.v1" as const, companyId: "company-1", issueId: "issue-1", runId: "run-1", environmentLeaseId: "lease-1", runnerInstanceId: "runner-phase4", normalizedSessionId: "session:run-1" },
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
    const session = await makeDriver([transport]).openSession({ runId: "run-context", workingDirectory: "/workspace" });
    const iterator = session.events()[Symbol.asyncIterator]();
    const first = await iterator.next();
    const context = first.value?.payload.context as Parameters<typeof isSkilllessContext>[0];
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
      environmentKeys: ["CODEX_HOME", "HOME", "LANG", "PATH"],
      envelope,
    });
    expect(isSkilllessContext(context)).toBe(true);
    expect(JSON.stringify(context)).not.toContain("must-not-pass");
    expect(JSON.stringify(transport.calls)).not.toContain("RANDOM_SKILL_PATH");
    expect(transport.calls.find((call) => call.method === "thread/start")?.params).toMatchObject({
      approvalPolicy: "never",
      config: {
        "skills.include_instructions": false,
        include_apps_instructions: false,
        include_collaboration_mode_instructions: false,
      },
      dynamicTools: [{ name: "paperclip_finish" }, { name: "paperclip_block" }],
    });
    expect(PHASE4_RESULT_OUTPUT_SCHEMA.properties.schema).toEqual({
      type: "string",
      const: "paperclip.run_result.v1",
    });
    expect(PHASE4_BLOCK_RESULT_OUTPUT_SCHEMA.properties.reportedWorkDisposition).toEqual({
      type: "string",
      const: "blocked",
    });
  });

  it("steers and interrupts an active turn without replacing the session", async () => {
    const transport = new FakeCodexTransport();
    const session = await makeDriver([transport]).openSession({ runId: "run-controls", workingDirectory: "/workspace" });
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
    const session = await makeDriver([transport]).openSession({ runId: "run-result", workingDirectory: "/workspace" });
    await session.startTurn({ message: { role: "user", text: "Complete." } });
    const request = { id: 1, method: "item/tool/call", params: { threadId: "thread-1", turnId: "turn-1", callId: "call-1", tool: "paperclip_finish", arguments: result } };
    expect(await transport.invoke(request)).toMatchObject({ success: true });
    expect(await transport.invoke({ ...request, id: 2 })).toMatchObject({ success: true });
    const changed = structuredClone(result);
    changed.summary = "Changed after commit.";
    expect(await transport.invoke({ ...request, id: 3, params: { ...request.params, arguments: changed } })).toMatchObject({ success: false });
    transport.push("turn/completed", { threadId: "thread-1", turn: { id: "turn-1", status: "completed", items: [] } });
    const events = await collectUntilTerminal(session.events());
    expect(events.filter((event) => event.eventType === "run.result.proposed")).toHaveLength(1);
  });

  it("normalizes finish and block tools into one canonical result contract", async () => {
    const transport = new FakeCodexTransport();
    const session = await makeDriver([transport]).openSession({ runId: "run-tools", workingDirectory: "/workspace" });
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
    const original = await driver.openSession({ runId: "run-recover", workingDirectory: "/workspace" });
    await original.startTurn({ message: { role: "user", text: "Work." } });
    const snapshot = await original.snapshot();
    await original.close({ reason: "transport lost" });
    const recovery = await driver.recoverSession?.(snapshot);
    expect(recovery).toMatchObject({ recovered: true });
    expect(recovery?.session?.ids()).toEqual(original.ids());
    expect(await recovery?.session?.reconcile?.()).toMatchObject({ thread: { id: "thread-1" } });
    expect(second.calls.map((call) => call.method)).toEqual(["initialize", "thread/resume", "thread/read"]);
    expect((await recovery?.session?.snapshot())?.activeTurnId).toBe("turn-1");
  });

  it("degrades unsupported operations with explicit redacted diagnostics", async () => {
    const transport = new FakeCodexTransport();
    transport.rejectMethods.set("turn/steer", new Error("Bearer super-secret api_key=also-secret"));
    const session = await makeDriver([transport]).openSession({ runId: "run-degrade", workingDirectory: "/workspace" });
    const { turnId } = await session.startTurn({ message: { role: "user", text: "Start." } });
    await expect(session.steer?.({ turnId, message: { role: "user", text: "Steer." } })).rejects.toBeInstanceOf(UnsupportedCodexOperationError);
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
});
