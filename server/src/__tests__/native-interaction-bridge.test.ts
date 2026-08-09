import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueThreadInteractions,
  issues,
} from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import {
  materializeNativeInteractionResponses,
  NativeInteractionBridgeError,
} from "../services/native-runtime/native-interaction-bridge.js";

describe("P6-19 native interaction bridge", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;
  const companyId = "78000000-0000-4000-8000-000000000001";
  const agentId = "78000000-0000-4000-8000-000000000002";
  const issueId = "78000000-0000-4000-8000-000000000003";
  const runId = "78000000-0000-4000-8000-000000000004";
  const confirmationId = "78000000-0000-4000-8000-000000000005";
  const questionsId = "78000000-0000-4000-8000-000000000006";
  const governedId = "78000000-0000-4000-8000-000000000007";
  const selfApprovedId = "78000000-0000-4000-8000-000000000008";

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-native-interaction-");
    db = createDb(temporary.connectionString);
    await db.insert(companies).values({ id: companyId, name: "Native interaction", issuePrefix: "NIB" });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Native interaction agent",
      adapterType: "codex_local",
      status: "running",
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Consume an authorized interaction response",
      status: "in_progress",
      assigneeAgentId: agentId,
      workMode: "standard",
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "running",
      contextSnapshot: { issueId, interactionId: confirmationId },
    });
    await db.insert(issueThreadInteractions).values([
      {
        id: confirmationId,
        companyId,
        issueId,
        kind: "request_confirmation",
        status: "accepted",
        resolvedByUserId: "board-user",
        resolvedAt: new Date(),
        payload: { version: 1, prompt: "Continue?" },
        result: { version: 1, outcome: "accepted" },
      },
      {
        id: questionsId,
        companyId,
        issueId,
        kind: "ask_user_questions",
        status: "answered",
        resolvedByUserId: "board-user",
        resolvedAt: new Date(),
        payload: {
          version: 1,
          questions: [{
            id: "choice",
            prompt: "Which path?",
            selectionMode: "single",
            options: [{ id: "safe", label: "Safe" }],
          }],
        },
        result: { version: 1, answers: [{ questionId: "choice", optionIds: ["safe"] }] },
      },
      {
        id: governedId,
        companyId,
        issueId,
        kind: "request_confirmation",
        status: "accepted",
        resolvedByUserId: "board-user",
        resolvedAt: new Date(),
        payload: {
          version: 1,
          prompt: "Execute write?",
          toolAction: {
            version: 1,
            actionRequestId: "78000000-0000-4000-8000-000000000010",
            invocationId: "78000000-0000-4000-8000-000000000011",
            toolName: "write",
            toolDisplayName: "Write",
            connectionId: null,
            applicationId: null,
            appDisplayName: null,
            risk: "write",
            previewMarkdown: "write",
            argumentsSummaryJson: "{}",
            argumentsHash: "hash",
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          },
        },
        result: { version: 1, outcome: "accepted" },
      },
      {
        id: selfApprovedId,
        companyId,
        issueId,
        kind: "request_confirmation",
        status: "accepted",
        createdByAgentId: agentId,
        resolvedByAgentId: agentId,
        resolvedByRunId: runId,
        resolvedAt: new Date(),
        payload: { version: 1, prompt: "Self approve?" },
        result: { version: 1, outcome: "accepted" },
      },
    ]);
  }, 30_000);

  afterAll(async () => temporary?.cleanup());

  it("projects supported typed responses through the authorized interaction service", async () => {
    await expect(materializeNativeInteractionResponses({
      db,
      companyId,
      issueId,
      runId,
      agentId,
      interactionIds: [questionsId, confirmationId],
    })).resolves.toEqual([
      {
        interactionId: confirmationId,
        kind: "request_confirmation",
        response: { status: "accepted", result: { version: 1, outcome: "accepted" } },
      },
      {
        interactionId: questionsId,
        kind: "ask_user_questions",
        response: {
          status: "answered",
          result: { version: 1, answers: [{ questionId: "choice", optionIds: ["safe"] }] },
        },
      },
    ]);
  });

  it.each([
    [governedId, "native_interaction_governed_request_unsupported"],
    [selfApprovedId, "native_interaction_self_approval"],
  ])("fails closed for governed or self-approved interaction %s", async (interactionId, code) => {
    const error = await materializeNativeInteractionResponses({
      db,
      companyId,
      issueId,
      runId,
      agentId,
      interactionIds: [interactionId],
    }).catch((caught) => caught);
    expect(error).toBeInstanceOf(NativeInteractionBridgeError);
    expect(error).toMatchObject({ code });
  });
});
