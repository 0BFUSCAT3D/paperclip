import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  activityLog,
  agents,
  companies,
  completionContracts,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issues,
  nativeRunFinalizations,
  nativeRunResults,
  statusDecisionEffects,
  statusDecisions,
  workAssessments,
} from "@paperclipai/db";
import {
  CONTROL_PLANE_CONFORMANCE_RESULT,
  CONTROL_PLANE_CONFORMANCE_TERMINAL,
  CONTROL_PLANE_CONFORMANCE_OPEN,
  executeNativeSession,
  runControlPlanePortConformance,
  type NativeSessionBackend,
  type PrpEvent,
} from "@paperclipai/paperclip-runner";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";
import { PaperclipControlPlanePort } from "./paperclip-control-plane-port.js";
import { finalizeNativeRun } from "./native-run-finalizer.js";
import { buildNativeExecutionInput } from "./native-execution-input.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDatabase = support.supported ? describe : describe.skip;

describeDatabase("PaperclipControlPlanePort conformance", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;
  const contractId = "00000000-0000-4000-8000-000000000004";
  const contractSha = "phase6-conformance-contract";
  const taskIssueId = "00000000-0000-4000-8000-000000000008";
  const taskContractId = "00000000-0000-4000-8000-000000000009";
  const taskRunId = "00000000-0000-4000-8000-000000000010";
  const workspaceFailureIssueId = "00000000-0000-4000-8000-000000000011";
  const workspaceFailureContractId = "00000000-0000-4000-8000-000000000012";
  const workspaceFailureRunId = "00000000-0000-4000-8000-000000000013";

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-native-port-");
    db = createDb(temporary.connectionString);
    const identity = CONTROL_PLANE_CONFORMANCE_OPEN.identity;
    await db.insert(companies).values({ id: identity.companyId, name: "Phase 6", issuePrefix: "P6C" });
    await db.insert(agents).values({
      id: identity.agentId,
      companyId: identity.companyId,
      name: "Native conformance",
      adapterType: "codex_local",
      status: "running",
    });
    await db.insert(issues).values({
      id: identity.issueId,
      companyId: identity.companyId,
      title: "Native conformance",
      status: "in_progress",
      workMode: "standard",
    });
    await db.insert(completionContracts).values({
      id: contractId,
      companyId: identity.companyId,
      issueId: identity.issueId,
      revision: 1,
      schemaVersion: "paperclip.completion-contract.v1",
      policyVersion: "phase6-v1",
      risk: "standard",
      completionAuthority: "server_arbiter",
      incompleteCriteriaPolicy: "preserve_non_terminal",
      contractJson: { objective: "Conformance" },
      canonicalSha256: contractSha,
      createdByActorType: "system",
      createdByActorId: "test",
    });
    await db.insert(heartbeatRuns).values({
      id: identity.runId,
      companyId: identity.companyId,
      agentId: identity.agentId,
      status: "running",
      runtimeMode: "native",
      completionContractId: contractId,
      completionContractSha256: contractSha,
      contextSnapshot: { issueId: identity.issueId },
    });
    await db.insert(issues).values({
      id: taskIssueId,
      companyId: identity.companyId,
      title: "Complete one native task",
      status: "in_progress",
      workMode: "standard",
    });
    await db.insert(completionContracts).values({
      id: taskContractId,
      companyId: identity.companyId,
      issueId: taskIssueId,
      revision: 1,
      schemaVersion: "paperclip.completion-contract.v1",
      policyVersion: "phase6-v1",
      risk: "standard",
      completionAuthority: "server_arbiter",
      incompleteCriteriaPolicy: "preserve_non_terminal",
      contractJson: { objective: "Complete one native task" },
      canonicalSha256: "phase6-task-contract",
      createdByActorType: "system",
      createdByActorId: "test",
    });
    await db.insert(heartbeatRuns).values({
      id: taskRunId,
      companyId: identity.companyId,
      agentId: identity.agentId,
      status: "running",
      runtimeMode: "native",
      runtimeModeResolverVersion: "phase6-v1",
      runtimeModeReason: "eligible_opt_in",
      completionContractId: taskContractId,
      completionContractSha256: "phase6-task-contract",
      contextSnapshot: { issueId: taskIssueId },
    });
    await db.insert(issues).values({
      id: workspaceFailureIssueId,
      companyId: identity.companyId,
      title: "Preserve status after workspace failure",
      status: "in_progress",
      workMode: "standard",
    });
    await db.insert(completionContracts).values({
      id: workspaceFailureContractId,
      companyId: identity.companyId,
      issueId: workspaceFailureIssueId,
      revision: 1,
      schemaVersion: "paperclip.completion-contract.v1",
      policyVersion: "phase6-v1",
      risk: "standard",
      completionAuthority: "server_arbiter",
      incompleteCriteriaPolicy: "preserve_non_terminal",
      contractJson: { objective: "Preserve status after workspace failure" },
      canonicalSha256: "phase6-workspace-failure-contract",
      createdByActorType: "system",
      createdByActorId: "test",
    });
    await db.insert(heartbeatRuns).values({
      id: workspaceFailureRunId,
      companyId: identity.companyId,
      agentId: identity.agentId,
      status: "running",
      runtimeMode: "native",
      completionContractId: workspaceFailureContractId,
      completionContractSha256: "phase6-workspace-failure-contract",
      contextSnapshot: { issueId: workspaceFailureIssueId },
    });
  }, 30_000);

  afterAll(async () => {
    if (temporary) {
      await db.delete(activityLog);
      await db.delete(statusDecisionEffects);
      await db.delete(statusDecisions);
      await db.delete(workAssessments);
      await db.delete(nativeRunFinalizations);
      await db.delete(nativeRunResults);
      await db.delete(heartbeatRunEvents);
      await db.delete(heartbeatRuns);
      await db.delete(completionContracts);
      await db.delete(issues);
      await db.delete(agents);
      await db.delete(companies);
      await temporary.cleanup();
    }
  });

  it("runs the unchanged package conformance suite against Paperclip persistence", async () => {
    const identity = CONTROL_PLANE_CONFORMANCE_OPEN.identity;
    const port = new PaperclipControlPlanePort(db, {
      companyId: identity.companyId,
      issueId: identity.issueId,
      runId: identity.runId,
      agentId: identity.agentId,
      completionContractId: contractId,
      completionContractSha256: contractSha,
      sourceInstanceId: "runner-phase6-conformance",
      controlPlaneSourceInstanceId: "control-phase6-conformance",
    });
    await expect(runControlPlanePortConformance({ port })).resolves.toEqual({
      eventCount: 3,
      highestContiguousSourceSeq: 3,
      duplicateDisposition: "duplicate",
      terminalReplayIdempotent: true,
    });
    await expect(db.select().from(nativeRunResults).where(eq(nativeRunResults.runId, identity.runId))).resolves.toHaveLength(1);
    await finalizeNativeRun({ db, runId: identity.runId, workspaceFinalizeStatus: "succeeded" });
    await expect(db.select().from(issues).where(eq(issues.id, identity.issueId))).resolves.toEqual([
      expect.objectContaining({ status: "done", statusVersion: 1 }),
    ]);
    await expect(db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, identity.runId))).resolves.toEqual([
      expect.objectContaining({ phase: "applied" }),
    ]);
    await expect(db.select().from(statusDecisions).where(eq(statusDecisions.issueId, identity.issueId))).resolves.toEqual([
      expect.objectContaining({ toStatus: "done", applicationState: "applied" }),
    ]);
    await expect(db.select().from(activityLog).where(eq(activityLog.entityId, identity.issueId))).resolves.toEqual([
      expect.objectContaining({ action: "issue.native_status_decision_applied" }),
    ]);
  });

  it("completes one selected Paperclip task through the public package session contract", async () => {
    const identity = CONTROL_PLANE_CONFORMANCE_OPEN.identity;
    const sessionId = "session-phase6-paperclip-task";
    const event = (sourceSeq: number, eventType: PrpEvent["eventType"], payload: Record<string, unknown>): PrpEvent => ({
      schema: "paperclip.prp.event.v1",
      sourceEventId: `phase6-task:${sourceSeq}`,
      sourceSeq,
      sourceInstanceId: "phase6-scripted-runner",
      sourceKind: "runner",
      runId: taskRunId,
      normalizedSessionId: sessionId,
      turnId: "turn-phase6-paperclip-task",
      eventType,
      schemaVersion: 1,
      priority: 0,
      emittedAt: `2026-08-09T02:59:0${sourceSeq}.000Z`,
      payload,
    });
    const events = [
      event(1, "run.result.proposed", CONTROL_PLANE_CONFORMANCE_RESULT),
      event(2, "turn.completed", {}),
    ];
    const backend: NativeSessionBackend = {
      async descriptor() {
        return {
          kind: "mock",
          name: "phase6-scripted",
          version: "1",
          capabilities: { resume: false, typedEvents: true, steering: false, interruption: true, structuredResult: true },
        };
      },
      async openSession(input) {
        return {
          identity: () => input.identity,
          async capabilities() { return { resume: false, typedEvents: true, steering: false, interruption: true, structuredResult: true }; },
          async *events() { yield* events; },
          async startTurn() { return { turnId: "turn-phase6-paperclip-task" }; },
          async cancel() {},
          async result() { return { result: CONTROL_PLANE_CONFORMANCE_RESULT, terminal: CONTROL_PLANE_CONFORMANCE_TERMINAL, turnId: "turn-phase6-paperclip-task" }; },
          async snapshot() { return { backendKind: "mock", sessionId, identity: input.identity, providerSessionId: "provider-phase6-paperclip-task" }; },
          async close() {},
        };
      },
    };
    const execution = buildNativeExecutionInput({
      companyId: identity.companyId,
      runId: taskRunId,
      issue: { id: taskIssueId, identifier: "P6C-2", title: "Complete one native task", description: null, workMode: "standard" },
      agentId: identity.agentId,
      workspace: { id: "workspace-phase6", cwd: process.cwd(), repoUrl: null, repoRef: null, branchName: null },
      normalizedSessionId: sessionId,
      completionContract: {
        id: taskContractId,
        sha256: "phase6-task-contract",
        schemaVersion: "paperclip.completion-contract.v1",
        contract: { revision: "phase6-v1", objective: "Complete one native task", criteria: [{ id: "objective", requirement: "Complete the task" }] },
      },
    });
    const port = new PaperclipControlPlanePort(db, {
      companyId: identity.companyId,
      issueId: taskIssueId,
      runId: taskRunId,
      agentId: identity.agentId,
      completionContractId: taskContractId,
      completionContractSha256: "phase6-task-contract",
      sourceInstanceId: "phase6-scripted-runner",
      controlPlaneSourceInstanceId: "phase6-control-plane",
    });
    const completed = await executeNativeSession({
      input: execution,
      backend,
      controlPlane: port,
      runnerInstanceId: "phase6-scripted-runner",
      controlPlaneInstanceId: "phase6-control-plane",
    });
    expect(completed.terminal.runTerminalState).toBe("succeeded");
    await finalizeNativeRun({ db, runId: taskRunId, workspaceFinalizeStatus: "succeeded" });
    await expect(db.select().from(issues).where(eq(issues.id, taskIssueId))).resolves.toEqual([
      expect.objectContaining({ status: "done", statusVersion: 1 }),
    ]);
  });

  it("fails closed when the bound company does not own the run", async () => {
    const identity = CONTROL_PLANE_CONFORMANCE_OPEN.identity;
    const port = new PaperclipControlPlanePort(db, {
      companyId: "00000000-0000-4000-8000-000000000099",
      issueId: identity.issueId,
      runId: identity.runId,
      agentId: identity.agentId,
      completionContractId: contractId,
      completionContractSha256: contractSha,
      sourceInstanceId: "runner-phase6-conformance",
      controlPlaneSourceInstanceId: "control-phase6-conformance",
    });
    await expect(port.openRun(CONTROL_PLANE_CONFORMANCE_OPEN)).rejects.toThrow("binding_mismatch");
  });

  it("preserves the result and issue status when workspace finalization fails", async () => {
    const identity = CONTROL_PLANE_CONFORMANCE_OPEN.identity;
    const port = new PaperclipControlPlanePort(db, {
      companyId: identity.companyId,
      issueId: workspaceFailureIssueId,
      runId: workspaceFailureRunId,
      agentId: identity.agentId,
      completionContractId: workspaceFailureContractId,
      completionContractSha256: "phase6-workspace-failure-contract",
      sourceInstanceId: "runner-phase6-workspace-failure",
      controlPlaneSourceInstanceId: "control-phase6-workspace-failure",
    });
    await port.openRun({
      identity: { ...identity, runId: workspaceFailureRunId, issueId: workspaceFailureIssueId },
      backendKind: "mock",
      sourceInstanceId: "runner-phase6-workspace-failure",
    });
    await port.completeRun({
      result: CONTROL_PLANE_CONFORMANCE_RESULT,
      terminal: CONTROL_PLANE_CONFORMANCE_TERMINAL,
      callerResultId: "phase6-workspace-failure-result",
    });
    await finalizeNativeRun({
      db,
      runId: workspaceFailureRunId,
      workspaceFinalizeStatus: "failed",
      projectRunStatus: true,
    });
    await expect(db.select().from(issues).where(eq(issues.id, workspaceFailureIssueId))).resolves.toEqual([
      expect.objectContaining({ status: "in_progress", statusVersion: 0, lastStatusDecisionId: null }),
    ]);
    await expect(db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, workspaceFailureRunId))).resolves.toEqual([
      expect.objectContaining({ status: "failed", nativePhase: "workspace_failed" }),
    ]);
    await expect(db.select().from(nativeRunResults).where(eq(nativeRunResults.runId, workspaceFailureRunId))).resolves.toHaveLength(1);
  });
});
