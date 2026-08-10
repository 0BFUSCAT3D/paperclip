import { describe, expect, it } from "vitest";

import { Phase7MockControlPlaneAdapter } from "../mock-core/phase7-mock-control-plane-adapter.js";
import type { Phase7LiveSessionSnapshot } from "../phase7/live-session.js";
import {
  PHASE7_UI_SHOT_SLUGS,
  phase7IssueThreadFixture,
} from "./fixtures.js";
import { projectPhase7IssueThread } from "./live-projection.js";
import {
  PHASE7_EVIDENCE_SECTIONS,
  PHASE7_ISSUE_THREAD_VIEW_SCHEMA,
  phase7DenialCount,
  type Phase7IssueThreadSnapshot,
  type Phase7ThreadInteractionState,
  type Phase7ThreadItem,
} from "./types.js";

/** Contract §3 item taxonomy T1–T11. */
const REQUIRED_ITEM_KINDS: Array<Phase7ThreadItem["kind"]> = [
  "user_message",
  "agent_message",
  "durable_comment",
  "tool_activity",
  "interaction",
  "document",
  "deliverable",
  "disposition",
  "denial",
  "system_notice",
];

/** Contract §5 state matrix. */
const REQUIRED_INTERACTION_STATES: Phase7ThreadInteractionState[] = [
  "pending",
  "accepted",
  "answered",
  "rejected",
  "stale_target",
  "superseded_by_comment",
];

function allItems(snapshot: Phase7IssueThreadSnapshot): Phase7ThreadItem[] {
  return snapshot.turns.flatMap((turn) => turn.items);
}

function credentialLike(value: unknown): string[] {
  const serialized = JSON.stringify(value);
  const patterns = [
    /"authorization"\s*:\s*"/i,
    /bearer\s+[a-z0-9._-]+/i,
    /sk-[a-z0-9]{8,}/i,
    /"api[_-]?key"\s*:/i,
    /PAPERCLIP_API_KEY/,
  ];
  return patterns.filter((pattern) => pattern.test(serialized)).map(String);
}

describe("Phase 7 issue-thread fixtures", () => {
  it("exposes exactly the twelve screenshot slugs from the UX contract §10.2", () => {
    expect(PHASE7_UI_SHOT_SLUGS).toHaveLength(12);
    expect(new Set(PHASE7_UI_SHOT_SLUGS).size).toBe(12);
  });

  it("builds a schema-valid snapshot for every slug", () => {
    for (const slug of PHASE7_UI_SHOT_SLUGS) {
      const snapshot = phase7IssueThreadFixture(slug);
      expect(snapshot.schema).toBe(PHASE7_ISSUE_THREAD_VIEW_SCHEMA);
      expect(snapshot.turns.length).toBeGreaterThan(0);
      expect(snapshot.identity.controlPlaneLabel).toBe("Mock Paperclip");
      expect(snapshot.issue.identifier.startsWith("MCK-")).toBe(true);
      for (const section of PHASE7_EVIDENCE_SECTIONS) {
        expect(Array.isArray(snapshot.evidence[section.id])).toBe(true);
      }
    }
  });

  it("is deterministic: two builds of a slug are byte-identical", () => {
    for (const slug of PHASE7_UI_SHOT_SLUGS) {
      expect(JSON.stringify(phase7IssueThreadFixture(slug))).toBe(
        JSON.stringify(phase7IssueThreadFixture(slug)),
      );
    }
  });

  it("covers every §3 thread item type across the matrix", () => {
    const seen = new Set<Phase7ThreadItem["kind"]>();
    for (const slug of PHASE7_UI_SHOT_SLUGS) {
      for (const item of allItems(phase7IssueThreadFixture(slug))) seen.add(item.kind);
    }
    for (const kind of REQUIRED_ITEM_KINDS) {
      expect(seen, `missing thread item ${kind}`).toContain(kind);
    }
  });

  it("covers the §5 interaction state matrix", () => {
    const seen = new Set<Phase7ThreadInteractionState>();
    for (const slug of PHASE7_UI_SHOT_SLUGS) {
      for (const item of allItems(phase7IssueThreadFixture(slug))) {
        if (item.kind === "interaction") seen.add(item.state);
      }
    }
    for (const state of REQUIRED_INTERACTION_STATES) {
      expect(seen, `missing interaction state ${state}`).toContain(state);
    }
  });

  it("covers every §4 composer state", () => {
    const seen = new Set(
      PHASE7_UI_SHOT_SLUGS.map((slug) => phase7IssueThreadFixture(slug).composer.state),
    );
    for (const state of ["ready", "streaming", "waiting", "reconnecting", "disabled"]) {
      expect(seen, `missing composer state ${state}`).toContain(state);
    }
  });

  it("binds the confirmation card to an explicit revision", () => {
    const snapshot = phase7IssueThreadFixture("interaction-confirmation-pending");
    const card = allItems(snapshot).find(
      (item) => item.kind === "interaction" && item.interactionKind === "confirmation",
    );
    expect(card?.kind).toBe("interaction");
    if (card?.kind !== "interaction") return;
    expect(card.target?.label).toBe("plan · r4");
    expect(card.state).toBe("pending");
    expect(snapshot.composer.state).toBe("waiting");
    expect(snapshot.composer.pendingInteractionId).toBe(card.interactionId);
  });

  it("quotes the deny reason verbatim and counts it for the evidence badge", () => {
    const snapshot = phase7IssueThreadFixture("denial-optional-tool");
    const denial = allItems(snapshot).find((item) => item.kind === "denial");
    expect(denial?.kind).toBe("denial");
    if (denial?.kind !== "denial") return;
    const record = snapshot.evidence.authorization.find(
      (entry) => entry.id === denial.evidenceRef.recordId,
    );
    expect(record?.allowed).toBe(false);
    expect(denial.reason).toBe(record?.reason);
    expect(phase7DenialCount(snapshot.evidence, null)).toBe(1);
  });

  it("labels replay as fake-derived so replay never satisfies a live criterion", () => {
    const snapshot = phase7IssueThreadFixture("replay-mode");
    expect(snapshot.mode).toBe("replay");
    expect(snapshot.identity.replaySource).toBe("fake");
    expect(snapshot.composer.state).toBe("disabled");
    expect(snapshot.composer.reason).toBe("Replay is read-only");
  });

  it("names the control-plane operations that are withheld from the agent", () => {
    const snapshot = phase7IssueThreadFixture("thread-baseline");
    const withheld = snapshot.evidence.tools[0]?.rows.filter(
      (row) => row.disposition === "control_plane_owned",
    );
    expect(withheld?.length ?? 0).toBeGreaterThan(0);
    expect(withheld?.map((row) => row.operationId)).toContain("create_task");
  });

  it("keeps credentials out of every fixture", () => {
    for (const slug of PHASE7_UI_SHOT_SLUGS) {
      expect(credentialLike(phase7IssueThreadFixture(slug)), slug).toEqual([]);
    }
  });
});

describe("Phase 7 live projection", () => {
  async function liveSnapshot(): Promise<Phase7LiveSessionSnapshot> {
    const adapter = new Phase7MockControlPlaneAdapter({
      epochMs: Date.UTC(2026, 7, 9, 9, 0, 0),
      tasks: [
        {
          id: "task-31",
          companyId: "company-1",
          identifier: "MCK-31",
          title: "Wire the runner spike to the mock control plane",
          description: null,
          status: "todo",
          priority: "high",
          workMode: "standard",
          parentId: null,
          assigneeActorId: "actor-1",
          checkoutRunId: null,
          executionRunId: null,
          startedAt: null,
          completedAt: null,
        },
      ],
    });
    await adapter.start();
    await adapter.openFixtureRun({
      identity: {
        runId: "run-7g-1",
        sessionId: "session-7g-1",
        companyId: "company-1",
        issueId: "task-31",
        agentId: "actor-1",
      },
      backendKind: "mock",
      sourceInstanceId: "phase7-ui",
    });
    const applied = await adapter.applyCommand({
      runId: "run-7g-1",
      idempotencyKey: "progress-1",
      command: { kind: "report_progress", taskId: "task-31", body: "Read the mock task." },
    });

    return {
      schema: "paperclip.phase7.live-session.v1",
      revision: 1,
      sessionId: "session-7g-1",
      providerThreadId: "thr-mock",
      providerSessionId: "provider-1",
      status: "idle",
      activeTurnId: null,
      createdAt: "2026-08-09T09:00:00.000Z",
      updatedAt: "2026-08-09T09:01:00.000Z",
      authority: {
        active: true,
        runId: "run-7g-1",
        companyId: "company-1",
        actorId: "actor-1",
        taskId: "task-31",
        sessionId: "session-7g-1",
        scenarioId: "hb-baseline",
        capabilities: [],
        explicitClaims: [],
      },
      config: {
        workingDirectory: "/mock/workspace",
        scenario: { id: "hb-baseline" },
        capabilities: [],
        explicitClaims: [],
        seedState: adapter.serialize(),
        turnTimeoutMs: 60_000,
      },
      mockState: adapter.serialize(),
      transcript: [
        {
          id: "t1",
          role: "user",
          text: "Pick up MCK-31.",
          turnId: "turn-1",
          at: "2026-08-09T09:00:05.000Z",
        },
        {
          id: "t2",
          role: "assistant",
          text: "Reading the checked-out task first.",
          turnId: "turn-1",
          at: "2026-08-09T09:00:18.000Z",
        },
        {
          id: "t3",
          role: "user",
          text: JSON.stringify({
            schema: "paperclip.semantic-interaction-result.v1",
            interactionId: "ix-1",
          }),
          turnId: "turn-1",
          at: "2026-08-09T09:00:40.000Z",
        },
      ],
      evidence: [
        {
          id: "evidence-000001",
          kind: "tool_exposure",
          at: "2026-08-09T09:00:00.000Z",
          turnId: null,
          data: {
            operationIds: ["get_task_context", "report_progress", "search_tasks"],
            scenarioId: "hb-baseline",
          },
        },
        {
          id: "evidence-000002",
          kind: "tool_call",
          at: "2026-08-09T09:00:30.000Z",
          turnId: "turn-1",
          data: {
            callId: "call-1",
            operationId: "report_progress",
            input: { body: "Read the mock task." },
            beforeRevision: 1,
          },
        },
        {
          id: "evidence-000003",
          kind: "tool_result",
          at: "2026-08-09T09:00:31.000Z",
          turnId: "turn-1",
          data: {
            callId: "call-1",
            operationId: "report_progress",
            result: {
              ok: true,
              operationId: "report_progress",
              callId: "call-1",
              result: applied as unknown as Record<string, never>,
              stateRevision: applied.stateRevision,
            },
            beforeRevision: 1,
            afterRevision: applied.stateRevision,
          },
        },
      ],
      authorizationRecords: [
        {
          schema: "paperclip.semantic-authorization-record.v1",
          id: "authz-1",
          runId: "run-7g-1",
          scenarioId: "hb-baseline",
          actorId: "actor-1",
          taskId: "task-31",
          callId: "call-1",
          input: null,
          result: null,
          allowed: true,
          phase: "invocation",
          operationId: "report_progress",
          code: "allowed",
          reason: "Assignee actor owns the checked-out task.",
          effectiveClaims: ["task:read"],
        },
      ],
      process: null,
      networkEvidence: { realPaperclipRequests: 0, childPaperclipEnvironmentKeys: [] },
    } as Phase7LiveSessionSnapshot;
  }

  it("projects mock records into the same view contract the fixtures use", async () => {
    const view = projectPhase7IssueThread({ snapshot: await liveSnapshot() });

    expect(view.schema).toBe(PHASE7_ISSUE_THREAD_VIEW_SCHEMA);
    expect(view.mode).toBe("live");
    expect(view.identity.agentLabel).toBe("Real Codex");
    expect(view.identity.runnerLabel).toBe("Real runnerd");
    expect(view.issue.identifier).toBe("MCK-31");

    const items = allItems(view);
    expect(items.filter((item) => item.kind === "user_message")).toHaveLength(1);
    expect(items.some((item) => item.kind === "agent_message")).toBe(true);
    expect(items.some((item) => item.kind === "tool_activity")).toBe(true);

    // The durable comment comes from the mock record the command created,
    // not from the model's prose.
    const durable = items.find((item) => item.kind === "durable_comment");
    expect(durable?.kind).toBe("durable_comment");
    if (durable?.kind === "durable_comment") {
      expect(durable.body).toBe("Read the mock task.");
      expect(durable.operationId).toBe("report_progress");
    }
  });

  it("hides the synthetic interaction-result message from the thread", async () => {
    const view = projectPhase7IssueThread({ snapshot: await liveSnapshot() });
    const bodies = allItems(view)
      .filter((item) => item.kind === "user_message")
      .map((item) => item.body);
    expect(bodies.some((body) => body.includes("semantic-interaction-result"))).toBe(false);
  });

  it("separates exposed agent tools from withheld control-plane operations", async () => {
    const view = projectPhase7IssueThread({ snapshot: await liveSnapshot() });
    const rows = view.evidence.tools[0]?.rows ?? [];
    const always = rows.filter((row) => row.disposition === "always_agent_tool");
    const granted = rows.filter((row) => row.disposition === "optional_agent_tool");
    const withheld = rows.filter((row) => row.disposition === "control_plane_owned");
    expect(always.map((row) => row.operationId)).toContain("report_progress");
    expect(granted.map((row) => row.operationId)).toContain("search_tasks");
    expect(withheld.map((row) => row.operationId)).toContain("create_task");
  });

  it("derives composer state from server records rather than browser guesses", async () => {
    const snapshot = await liveSnapshot();
    expect(projectPhase7IssueThread({ snapshot }).composer.state).toBe("ready");
    expect(
      projectPhase7IssueThread({
        snapshot: { ...snapshot, activeTurnId: "turn-1" },
      }).composer.state,
    ).toBe("streaming");
    expect(
      projectPhase7IssueThread({
        snapshot,
        connection: { state: "reconnecting", attempt: 2 },
      }).composer.state,
    ).toBe("reconnecting");
    expect(
      projectPhase7IssueThread({ snapshot, mode: "replay" }).composer.state,
    ).toBe("disabled");
  });

  it("keeps credentials out of the projected view", async () => {
    const view = projectPhase7IssueThread({ snapshot: await liveSnapshot() });
    expect(credentialLike(view)).toEqual([]);
  });
});
