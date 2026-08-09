import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  completionContracts,
  createDb,
  heartbeatRuns,
  issueRecoveryActions,
  issueThreadInteractions,
  issues,
  nativeRunFinalizations,
  statusDecisionEffects,
  statusDecisions,
  workAssessments,
} from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import {
  materializeNativeInteractionResponses,
  NativeInteractionBridgeError,
} from "../services/native-runtime/native-interaction-bridge.js";
import { PaperclipControlPlanePort } from "../services/native-runtime/paperclip-control-plane-port.js";
import { finalizeNativeRun } from "../services/native-runtime/native-run-finalizer.js";

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

  it("routes accepted package-result attention through live issue and interaction owners", async () => {
    const delegateId = "78000000-0000-4000-8000-000000000020";
    const outsideCompanyId = "78000000-0000-4000-8000-000000000021";
    const outsideAgentId = "78000000-0000-4000-8000-000000000022";
    await db.insert(companies).values({ id: outsideCompanyId, name: "Outside attention", issuePrefix: "NIO" });
    await db.insert(agents).values([
      {
        id: delegateId,
        companyId,
        name: "Native attention delegate",
        adapterType: "codex_local",
        status: "idle",
      },
      {
        id: outsideAgentId,
        companyId: outsideCompanyId,
        name: "Outside attention delegate",
        adapterType: "codex_local",
        status: "idle",
      },
    ]);

    const scenarios = [
      {
        key: "agent",
        issueId: "78000000-0000-4000-8000-000000000023",
        runId: "78000000-0000-4000-8000-000000000024",
        contractId: "78000000-0000-4000-8000-000000000025",
        disposition: "yielded" as const,
        request: {
          id: "attention-agent",
          requestedCapability: "domain_expertise",
          summary: "Delegate a same-company native investigation",
          target: { ownerClass: "agent", agentId: delegateId, companyId },
        },
      },
      {
        key: "human",
        issueId: "78000000-0000-4000-8000-000000000026",
        runId: "78000000-0000-4000-8000-000000000027",
        contractId: "78000000-0000-4000-8000-000000000028",
        disposition: "needs_review" as const,
        request: {
          id: "attention-human",
          requestedCapability: "subjective_decision",
          requiredAuthority: "board",
          summary: "Choose the acceptable native result",
          target: { ownerClass: "board_user", companyId },
        },
      },
      {
        key: "cross-company",
        issueId: "78000000-0000-4000-8000-000000000029",
        runId: "78000000-0000-4000-8000-000000000030",
        contractId: "78000000-0000-4000-8000-000000000031",
        disposition: "yielded" as const,
        request: {
          id: "attention-cross-company",
          requestedCapability: "domain_expertise",
          summary: "Reject an outside-company native delegate",
          target: { ownerClass: "agent", agentId: outsideAgentId, companyId: outsideCompanyId },
        },
      },
    ];

    for (const scenario of scenarios) {
      const contractSha = `attention-contract:${scenario.key}`;
      await db.insert(issues).values({
        id: scenario.issueId,
        companyId,
        title: `Native attention ${scenario.key}`,
        status: "in_progress",
        assigneeAgentId: agentId,
        workMode: "standard",
      });
      await db.insert(completionContracts).values({
        id: scenario.contractId,
        companyId,
        issueId: scenario.issueId,
        revision: 1,
        schemaVersion: "paperclip.completion-contract.v1",
        policyVersion: "phase6-v1",
        risk: "standard",
        completionAuthority: "server_arbiter",
        incompleteCriteriaPolicy: "preserve_non_terminal",
        contractJson: { revision: "attention-v1", objective: scenario.key, criteria: [{ id: "objective" }] },
        canonicalSha256: contractSha,
        createdByActorType: "system",
        createdByActorId: "test",
      });
      await db.insert(heartbeatRuns).values({
        id: scenario.runId,
        companyId,
        agentId,
        status: "running",
        runtimeMode: "native",
        runtimeModeResolverVersion: "phase6-v1",
        runtimeModeReason: "eligible_opt_in",
        runtimeModeResolvedAt: new Date(),
        completionContractId: scenario.contractId,
        completionContractSha256: contractSha,
        contextSnapshot: { issueId: scenario.issueId },
      });
      const port = new PaperclipControlPlanePort(db, {
        companyId,
        issueId: scenario.issueId,
        runId: scenario.runId,
        agentId,
        completionContractId: scenario.contractId,
        completionContractSha256: contractSha,
        sourceInstanceId: `runner:${scenario.key}`,
        controlPlaneSourceInstanceId: `control:${scenario.key}`,
      });
      await port.completeRun({
        result: {
          schema: "paperclip.run_result.v1",
          reportedWorkDisposition: scenario.disposition,
          summary: `Native attention ${scenario.key}`,
          completionClaim: {
            contractRevision: "attention-v1",
            objectiveSatisfied: false,
            criteria: [{ criterionId: "objective", status: "unknown", evidenceRefs: [] }],
            remainingWork: [{ description: "Resolve attention", blocksCompletion: true }],
          },
          evidence: [],
          verification: [{ commandOrCheck: "attention", status: "not_run" }],
          attentionRequests: [scenario.request],
          artifacts: [],
          ...(scenario.disposition === "yielded" ? {
            continuation: {
              kind: "response_wake" as const,
              summary: "Resume after attention",
              idempotencyKey: `attention:${scenario.key}`,
            },
          } : {}),
        },
        terminal: {
          schema: "paperclip.prp.terminal.v1",
          turnTerminalState: "completed",
          runTerminalState: "succeeded",
          reportedWorkDisposition: scenario.disposition,
        },
        turnId: `turn:${scenario.key}`,
      });
      await finalizeNativeRun({
        db,
        runId: scenario.runId,
        workspaceFinalizeStatus: "succeeded",
        projectRunStatus: true,
      });
    }

    const delegated = await db.select().from(issues).where(and(
      eq(issues.parentId, scenarios[0]!.issueId),
      eq(issues.companyId, companyId),
    ));
    expect(delegated).toEqual([
      expect.objectContaining({ assigneeAgentId: delegateId, status: "todo" }),
    ]);
    const humanInteractions = await db.select().from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.issueId, scenarios[1]!.issueId));
    expect(humanInteractions).toEqual([
      expect.objectContaining({ kind: "ask_user_questions", status: "pending", sourceRunId: scenarios[1]!.runId }),
    ]);
    await expect(db.select().from(issues).where(eq(issues.id, scenarios[1]!.issueId))).resolves.toEqual([
      expect.objectContaining({ status: "in_review" }),
    ]);
    await expect(db.select().from(issues).where(eq(issues.parentId, scenarios[2]!.issueId))).resolves.toHaveLength(0);
    await expect(db.select().from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, scenarios[2]!.issueId))).resolves.toEqual([
      expect.objectContaining({ cause: "result_schema_rejected", ownerAgentId: agentId }),
    ]);
    await expect(db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, scenarios[2]!.runId))).resolves.toEqual([
      expect.objectContaining({ status: "failed", nativePhase: "retryable_failure" }),
    ]);

    for (const scenario of scenarios) {
      const assessments = await db.select().from(workAssessments)
        .where(eq(workAssessments.issueId, scenario.issueId));
      expect(assessments.map((row) => row.triggerKind)).toEqual(expect.arrayContaining(["native_result", "native_attention"]));
      const decisions = await db.select().from(statusDecisions)
        .where(eq(statusDecisions.issueId, scenario.issueId));
      expect(decisions).toHaveLength(1);
      const effects = await db.select().from(statusDecisionEffects)
        .where(eq(statusDecisionEffects.decisionId, decisions[0]!.id));
      expect(effects.length).toBeGreaterThan(0);
      await expect(db.select().from(activityLog).where(and(
        eq(activityLog.entityId, scenario.issueId),
        eq(activityLog.runId, scenario.runId),
      ))).resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({ actorId: "native-status-committer" }),
      ]));
      await expect(db.select().from(nativeRunFinalizations)
        .where(eq(nativeRunFinalizations.runId, scenario.runId))).resolves.toEqual([
        expect.objectContaining({ assessmentId: decisions[0]!.assessmentId, decisionId: decisions[0]!.id }),
      ]);
    }
  }, 30_000);
});
