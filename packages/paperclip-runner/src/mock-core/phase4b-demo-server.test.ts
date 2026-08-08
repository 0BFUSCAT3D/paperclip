import { afterEach, describe, expect, it } from "vitest";

import type {
  HarnessDriver,
  HarnessDriverDescriptor,
  HarnessGoalOperation,
  HarnessRuntimeRequest,
  HarnessRuntimeRequestResolution,
  HarnessSession,
  HarnessSessionRecoveryResult,
  OpenHarnessSessionInput,
  PersistedHarnessSession,
} from "../contracts/harness-driver.js";
import type { PrpEvent } from "../protocol/phase1-contract.js";
import { Phase4bDemoServer } from "./phase4b-demo-server.js";

class Queue<T> implements AsyncIterable<T> {
  #values: T[] = [];
  #waiters: Array<(value: IteratorResult<T>) => void> = [];
  #closed = false;

  push(value: T): void {
    const waiter = this.#waiters.shift();
    if (waiter) waiter({ value, done: false });
    else this.#values.push(value);
  }

  close(): void {
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

class StubSession implements HarnessSession {
  readonly queue = new Queue<PrpEvent>();
  readonly runId: string;
  readonly normalizedSessionId: string;
  sourceSequence: number;
  activeTurnId: string | null;
  pending: HarnessRuntimeRequest[];
  currentGoal: PersistedHarnessSession["goal"];

  constructor(input: {
    runId: string;
    normalizedSessionId: string;
    sourceSequence?: number;
    activeTurnId?: string | null;
    pending?: HarnessRuntimeRequest[];
    goal?: PersistedHarnessSession["goal"];
    resumed?: boolean;
  }) {
    this.runId = input.runId;
    this.normalizedSessionId = input.normalizedSessionId;
    this.sourceSequence = input.sourceSequence ?? 0;
    this.activeTurnId = input.activeTurnId ?? null;
    this.pending = structuredClone(input.pending ?? []);
    this.currentGoal = input.goal ?? null;
    this.emit(input.resumed ? "session.resumed" : "session.started", {
      driverSessionId: "thread-demo",
      providerSessionId: "provider-demo",
      diagnostic: "Bearer server-only-secret",
      sandbox: {
        writableRoots: [
          "/srv/paperclip/home/.paperclip/instances/company/codex-home/memories",
        ],
      },
    });
  }

  ids() {
    return {
      driverSessionId: "thread-demo",
      providerSessionId: "provider-demo",
      displayId: "thread-demo",
    };
  }

  events(): AsyncIterable<PrpEvent> {
    return this.queue;
  }

  async startTurn(): Promise<{ turnId: string }> {
    this.activeTurnId = "turn-demo";
    this.emit("turn.submitted", {});
    this.emit("turn.accepted", { turnId: "turn-demo" }, { turnId: "turn-demo" });
    this.emit("turn.started", { status: "inProgress" }, { turnId: "turn-demo" });
    const request: HarnessRuntimeRequest = {
      requestId: "request-demo",
      requestKind: "command_approval",
      method: "item/commandExecution/requestApproval",
      turnId: "turn-demo",
      itemId: "command-demo",
      status: "pending",
      prompt: "Approve the deterministic command.",
      details: { authorization: "Bearer browser-must-not-see" },
    };
    this.pending = [request];
    this.emit("runtime_request.created", {
      request: { ...request, type: request.method },
    }, { turnId: request.turnId, itemId: request.itemId });
    return { turnId: "turn-demo" };
  }

  async steer(input: { turnId: string }): Promise<void> {
    this.emit("item.completed", {
      kind: "steering_acknowledgement",
      status: "acknowledged",
      text: "Steering acknowledged.",
    }, { turnId: input.turnId, itemId: "steer-demo" });
  }

  async interrupt(input: { turnId?: string }): Promise<void> {
    this.emit("item.completed", {
      kind: "interrupt_acknowledgement",
      status: "acknowledged",
      text: "Interrupt acknowledged.",
    }, { turnId: input.turnId, itemId: "interrupt-demo" });
  }

  pendingRuntimeRequests(): HarnessRuntimeRequest[] {
    return structuredClone(this.pending);
  }

  async resolveRuntimeRequest(input: {
    requestId: string;
    turnId: string;
    resolution: HarnessRuntimeRequestResolution;
  }): Promise<void> {
    this.pending = this.pending.filter(({ requestId }) => requestId !== input.requestId);
    this.emit("runtime_request.resolved", {
      requestId: input.requestId,
      resolution: input.resolution.action,
    }, { turnId: input.turnId, itemId: "command-demo" });
  }

  async goal(input: HarnessGoalOperation) {
    if (input.action === "clear") this.currentGoal = null;
    else if (input.action === "set") {
      this.currentGoal = {
        threadId: "thread-demo",
        objective: input.objective,
        status: "active",
        tokenBudget: input.tokenBudget ?? null,
        tokensUsed: 0,
        timeUsedSeconds: 0,
        createdAt: 1,
        updatedAt: 2,
      };
    }
    return this.currentGoal ?? null;
  }

  lineage() {
    return [{
      threadId: "thread-demo",
      providerSessionId: "provider-demo",
      parentThreadId: null,
      depth: 0,
      nickname: null,
      role: null,
      status: "active",
    }];
  }

  async snapshot(): Promise<PersistedHarnessSession> {
    return {
      driverKind: "stub",
      driverSessionId: "thread-demo",
      providerSessionId: "provider-demo",
      runId: this.runId,
      normalizedSessionId: this.normalizedSessionId,
      activeTurnId: this.activeTurnId,
      pendingRuntimeRequests: this.pendingRuntimeRequests(),
      goal: this.currentGoal ?? null,
      lineage: this.lineage(),
      lastSourceSequence: this.sourceSequence,
    };
  }

  async close(): Promise<void> {
    this.queue.close();
  }

  private emit(
    eventType: PrpEvent["eventType"],
    payload: Record<string, unknown>,
    refs: { turnId?: string; itemId?: string } = {},
  ): void {
    const sourceSeq = ++this.sourceSequence;
    this.queue.push({
      schema: "paperclip.prp.event.v1",
      sourceEventId: `stub:${this.runId}:${sourceSeq}`,
      sourceSeq,
      sourceInstanceId: "stub",
      sourceKind: "runner",
      runId: this.runId,
      normalizedSessionId: this.normalizedSessionId,
      ...refs,
      eventType,
      schemaVersion: 1,
      priority: 1,
      emittedAt: "2026-08-08T12:00:00.000Z",
      payload,
    });
  }
}

class StubDriver implements HarnessDriver {
  openInputs: OpenHarnessSessionInput[] = [];

  async descriptor(): Promise<HarnessDriverDescriptor> {
    return {
      kind: "stub",
      displayName: "Stub",
      version: "1",
      capabilities: {
        resume: true,
        typedEvents: true,
        steering: true,
        interruption: true,
        structuredResult: true,
        runtimeRequestResolution: true,
        goals: true,
        threadLineage: true,
      },
    };
  }

  async openSession(input: OpenHarnessSessionInput): Promise<HarnessSession> {
    this.openInputs.push(structuredClone(input));
    return new StubSession(input);
  }

  async recoverSession(snapshot: PersistedHarnessSession): Promise<HarnessSessionRecoveryResult> {
    return {
      recovered: true,
      session: new StubSession({
        runId: snapshot.runId!,
        normalizedSessionId: snapshot.normalizedSessionId!,
        sourceSequence: snapshot.lastSourceSequence,
        activeTurnId: snapshot.activeTurnId,
        pending: snapshot.pendingRuntimeRequests,
        goal: snapshot.goal,
        resumed: true,
      }),
    };
  }
}

const servers: Phase4bDemoServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("Phase 4b package-local demo server", () => {
  it("keeps credentials and workspace selection server-side across replay and reconnect", async () => {
    const driver = new StubDriver();
    const server = new Phase4bDemoServer({
      workingDirectory: "/safe/server-owned-workspace",
      driverFactory: () => driver,
    });
    servers.push(server);
    const { url } = await server.start();

    const health = await fetch(`${url}/api/phase4b/health`).then((response) => response.json());
    expect(health).toEqual(expect.objectContaining({
      status: "ok",
      providerAuthentication: "server-side",
      credentialsExposed: false,
    }));

    const created = await fetch(`${url}/api/phase4b/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        objective: "Exercise the server boundary.",
        workingDirectory: "/browser/chosen-path",
        authorization: "Bearer browser-secret",
      }),
    }).then((response) => response.json()) as Record<string, unknown>;
    expect(driver.openInputs[0]?.workingDirectory).toBe("/safe/server-owned-workspace");
    expect(created).toMatchObject({
      providerAuthentication: "server-side",
      credentialsExposed: false,
      activeTurnId: "turn-demo",
      pendingRequests: [{ requestId: "request-demo" }],
    });
    expect(JSON.stringify(created)).not.toContain("browser-secret");
    expect(JSON.stringify(created)).not.toContain("browser-must-not-see");
    expect(JSON.stringify(created)).not.toContain("server-only-secret");
    expect(JSON.stringify(created)).not.toContain("/srv/paperclip/home");

    const sessionId = String(created.sessionId);
    const replay = await fetch(`${url}/api/phase4b/sessions/${sessionId}/events?after=0`)
      .then((response) => response.json()) as { events: PrpEvent[]; cursor: number; replay: boolean };
    expect(replay.replay).toBe(true);
    expect(replay.events.length).toBeGreaterThanOrEqual(5);
    expect(replay.events.every((event, index) => event.sourceSeq === index + 1)).toBe(true);
    expect(JSON.stringify(replay)).not.toContain("/srv/paperclip/home");
    expect(JSON.stringify(replay)).toContain("<server-path>");

    const resolved = await fetch(
      `${url}/api/phase4b/sessions/${sessionId}/requests/request-demo/resolve`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          turnId: "turn-demo",
          resolution: { action: "accept_for_session" },
        }),
      },
    ).then((response) => response.json()) as Record<string, unknown>;
    expect(resolved.pendingRequests).toEqual([]);

    const withGoal = await fetch(`${url}/api/phase4b/sessions/${sessionId}/goal/set`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ objective: "Keep the goal durable.", tokenBudget: 1024 }),
    }).then((response) => response.json()) as Record<string, unknown>;
    expect(withGoal.goal).toMatchObject({
      objective: "Keep the goal durable.",
      status: "active",
      tokenBudget: 1024,
    });

    const reconnected = await fetch(`${url}/api/phase4b/sessions/${sessionId}/reconnect`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }).then((response) => response.json()) as Record<string, unknown>;
    expect(reconnected).toMatchObject({
      sessionId,
      runId: created.runId,
      normalizedSessionId: created.normalizedSessionId,
      driverSession: created.driverSession,
      goal: withGoal.goal,
    });
    const afterReconnect = await fetch(
      `${url}/api/phase4b/sessions/${sessionId}/events?after=${replay.cursor}`,
    ).then((response) => response.json()) as { events: PrpEvent[] };
    expect(afterReconnect.events.some(({ eventType }) => eventType === "session.resumed")).toBe(true);
  });
});
