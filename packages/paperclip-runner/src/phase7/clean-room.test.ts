import { describe, expect, it } from "vitest";

import { PHASE7_SEMANTIC_TOOL_CATALOG } from "../semantic-tools/catalog.js";
import {
  createPhase7SemanticPolicyContext,
  exposedPhase7SemanticDescriptors,
} from "../semantic-tools/policy.js";
import { Phase7MockControlPlaneAdapter } from "../mock-core/phase7-mock-control-plane-adapter.js";
import {
  assertPhase7CleanRoomSeedIsBlank,
  createPhase7CleanRoomIdentity,
  createPhase7CleanRoomSeed,
  createPhase7CleanRoomSessionInput,
  PHASE7_CLEAN_ROOM_CLAIMS,
  PHASE7_CLEAN_ROOM_SCENARIO,
  PHASE7_CLEAN_ROOM_WITHHELD_CLAIMS,
} from "./clean-room.js";

async function exposedOperations(): Promise<Set<string>> {
  const { identity, input } = createPhase7CleanRoomSessionInput({ workingDirectory: "/tmp/none" });
  const port = new Phase7MockControlPlaneAdapter(input.seed);
  await port.start();
  const context = await port.openFixtureRun({
    identity: {
      runId: "run-clean-room",
      sessionId: "session-clean-room",
      companyId: identity.companyId,
      issueId: identity.taskId,
      agentId: identity.actorId,
    },
    backendKind: "runner",
    sourceInstanceId: "phase7-clean-room-test",
    capabilities: input.capabilities ?? [],
  });
  const policy = createPhase7SemanticPolicyContext(
    context,
    PHASE7_CLEAN_ROOM_SCENARIO,
    input.explicitClaims ?? [],
  );
  const exposed = new Set(
    exposedPhase7SemanticDescriptors(policy).map((descriptor) => descriptor.operationId),
  );
  await port.stop();
  return exposed;
}

describe("Phase 7 clean-room seed", () => {
  it("seeds only a company, an agent, and one blank work issue", () => {
    const identity = createPhase7CleanRoomIdentity({ token: "abc12345", sequence: 4242 });
    const state = createPhase7CleanRoomSeed(identity);

    expect(state.company.id).toBe("company-cleanroom-abc12345");
    expect(state.actors).toHaveLength(1);
    expect(state.tasks).toHaveLength(1);
    expect(state.tasks[0]?.identifier).toBe("MCK-4242");
    expect(state.tasks[0]?.status).toBe("todo");
    expect(state.tasks[0]?.description).toBeNull();
    expect(state.comments).toEqual([]);
    expect(state.documents).toEqual([]);
    expect(state.interactions).toEqual([]);
    expect(state.artifacts).toEqual([]);
    expect(state.approvals).toEqual([]);
    expect(state.blockers).toEqual([]);
    expect(state.audit).toEqual([]);
    expect(() => assertPhase7CleanRoomSeedIsBlank(state)).not.toThrow();
  });

  it("refuses a seed that carries a transcript or any other prior record", () => {
    const identity = createPhase7CleanRoomIdentity({ token: "abc12345", sequence: 1 });
    const seeded = createPhase7CleanRoomSeed(identity);
    seeded.comments.push({
      id: "comment-1",
      taskId: identity.taskId,
      authorActorId: identity.actorId,
      body: "a scripted opening line",
      createdAt: "2026-08-10T00:00:00.000Z",
    });

    expect(() => assertPhase7CleanRoomSeedIsBlank(seeded)).toThrow(/must be blank; seeded: comments/);
  });

  it("mints a distinct mock tenant on every open", () => {
    const identities = Array.from({ length: 8 }, () => createPhase7CleanRoomIdentity());
    expect(new Set(identities.map((identity) => identity.companyId)).size).toBe(8);
    expect(new Set(identities.map((identity) => identity.actorId)).size).toBe(8);
    expect(new Set(identities.map((identity) => identity.taskId)).size).toBe(8);
    for (const identity of identities) {
      expect(identity.identifier.startsWith("MCK-")).toBe(true);
    }
  });
});

describe("Phase 7 clean-room exposure profile", () => {
  it("is deterministic and independent of the conversation", async () => {
    expect(await exposedOperations()).toEqual(await exposedOperations());
  });

  it("exposes the read, comment, document, interaction, and delegation tools", async () => {
    const exposed = await exposedOperations();
    for (const operationId of [
      "get_task_context",
      "report_progress",
      "write_document",
      "request_human_input",
      "register_deliverable",
      "create_task",
      "search_tasks",
      "request_approval",
      "finish_task",
    ]) {
      expect(exposed, `expected ${operationId} to be exposed`).toContain(operationId);
    }
  });

  it("withholds the grants that keep a denial reachable in an unscripted chat", async () => {
    const exposed = await exposedOperations();
    for (const operationId of [
      "decide_approval",
      "control_workspace_service",
      "generic_api_request",
    ]) {
      expect(exposed, `expected ${operationId} to be withheld`).not.toContain(operationId);
    }
    for (const claim of PHASE7_CLEAN_ROOM_WITHHELD_CLAIMS) {
      expect(PHASE7_CLEAN_ROOM_CLAIMS).not.toContain(claim);
    }
  });

  it("only names claims the accepted catalog actually requires", () => {
    const catalogClaims = new Set(
      PHASE7_SEMANTIC_TOOL_CATALOG.flatMap((descriptor) => descriptor.requiredClaims),
    );
    for (const claim of [...PHASE7_CLEAN_ROOM_CLAIMS, ...PHASE7_CLEAN_ROOM_WITHHELD_CLAIMS]) {
      // `control_plane:*` claims are enforced at the mock command boundary
      // rather than by a catalog descriptor, so they are exempt.
      if (claim.startsWith("control_plane:")) continue;
      expect(catalogClaims, `unknown claim ${claim}`).toContain(claim);
    }
  });
});
