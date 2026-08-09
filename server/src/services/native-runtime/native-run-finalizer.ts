import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  approvals,
  heartbeatRuns,
  issueApprovals,
  issues,
  nativeRunFinalizations,
  nativeRunResults,
} from "@paperclipai/db";
import { classifyNativeEvidence } from "./evidence-classifier.js";
import { arbitrateNativeStatus, NATIVE_STATUS_ARBITER_POLICY_VERSION } from "./status-arbiter.js";
import { recordNativeWorkAssessment } from "./work-assessments.js";
import { commitNativeStatusDecision, NativeStatusRaceError } from "./status-decision-committer.js";

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export async function finalizeNativeRun(input: {
  db: Db;
  runId: string;
  workspaceFinalizeStatus: "succeeded" | "failed";
  /** Reconciliation owns terminal run projection; the live heartbeat does it afterward. */
  projectRunStatus?: boolean;
}) {
  const run = await input.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, input.runId))
    .limit(1).then((rows) => rows[0] ?? null);
  if (!run || run.runtimeMode !== "native") throw new Error("native_finalization_run_missing");
  const coordinator = await input.db.select().from(nativeRunFinalizations)
    .where(eq(nativeRunFinalizations.runId, input.runId)).limit(1)
    .then((rows) => rows[0] ?? null);
  if (!coordinator?.resultId) throw new Error("native_finalization_missing");
  if (coordinator.phase === "applied" && coordinator.decisionId) return coordinator;
  if (input.workspaceFinalizeStatus === "failed") {
    const now = new Date();
    await input.db.update(nativeRunFinalizations).set({
      phase: "workspace_failed",
      failureCode: "workspace_finalization_failed",
      failureDetail: "Native result preserved; issue status intentionally unchanged.",
      updatedAt: now,
    }).where(eq(nativeRunFinalizations.runId, input.runId));
    await input.db.update(heartbeatRuns).set({
      ...(input.projectRunStatus ? { status: "failed", finishedAt: now } : {}),
      nativePhase: "workspace_failed",
      nativePhaseUpdatedAt: now,
      resultJson: {
        ...record(run.resultJson),
        finalizationPhase: "workspace_failed",
        workspaceFinalizeStatus: "failed",
      },
      updatedAt: now,
    }).where(eq(heartbeatRuns.id, run.id));
    return { ...coordinator, phase: "workspace_failed" };
  }
  const resultRow = await input.db.select().from(nativeRunResults)
    .where(eq(nativeRunResults.id, coordinator.resultId)).limit(1)
    .then((rows) => rows[0] ?? null);
  if (!resultRow) throw new Error("native_result_missing");
  const envelope = record(resultRow.resultJson);
  const result = record(envelope.result);
  const terminal = record(envelope.terminal);
  const terminalState = terminal.runTerminalState;
  if (!["succeeded", "failed", "cancelled"].includes(String(terminalState))) {
    throw new Error("native_finalization_invalid");
  }
  const assessment = classifyNativeEvidence(result);

  let supersedesAssessmentId: string | null = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const issue = await input.db.select().from(issues).where(eq(issues.id, coordinator.issueId))
      .limit(1).then((rows) => rows[0] ?? null);
    const authoritativeIssue = issue ?? await input.db.select().from(issues)
      .where(eq(issues.id, coordinator.issueId)).limit(1).then((rows) => rows[0] ?? null);
    if (!authoritativeIssue || authoritativeIssue.companyId !== run.companyId) {
      throw new Error("native_finalization_issue_missing");
    }
    const decision = arbitrateNativeStatus({
      assessment,
      terminalState: terminalState as "succeeded" | "failed" | "cancelled",
      workspaceFinalizeStatus: input.workspaceFinalizeStatus,
      approvalGateSatisfied: !await input.db.select({ id: approvals.id })
        .from(issueApprovals)
        .innerJoin(approvals, eq(issueApprovals.approvalId, approvals.id))
        .where(and(
          eq(issueApprovals.companyId, run.companyId),
          eq(issueApprovals.issueId, authoritativeIssue.id),
          eq(approvals.companyId, run.companyId),
          inArray(approvals.status, ["pending", "revision_requested"]),
        ))
        .limit(1)
        .then((rows) => rows.length > 0),
      agentId: run.agentId,
    });
    const assessmentRow = await recordNativeWorkAssessment({
      db: input.db,
      companyId: run.companyId,
      issueId: authoritativeIssue.id,
      runId: run.id,
      turnId: resultRow.turnId,
      contractId: resultRow.completionContractId,
      resultId: resultRow.id,
      priorIssueStatus: authoritativeIssue.status,
      priorStatusVersion: Number(authoritativeIssue.statusVersion),
      priorDecisionId: authoritativeIssue.lastStatusDecisionId,
      policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
      assessment,
      supersedesAssessmentId,
    });
    try {
      const committed = await commitNativeStatusDecision({
        db: input.db,
        companyId: run.companyId,
        issueId: authoritativeIssue.id,
        runId: run.id,
        assessmentId: assessmentRow.id,
        priorStatus: authoritativeIssue.status,
        priorStatusVersion: Number(authoritativeIssue.statusVersion),
        decision,
      });
      await input.db.update(heartbeatRuns).set({
        ...(input.projectRunStatus ? {
          status: terminalState === "succeeded" ? "succeeded" : terminalState === "cancelled" ? "cancelled" : "failed",
          finishedAt: new Date(),
        } : {}),
        nativePhase: "applied",
        nativePhaseUpdatedAt: new Date(),
        resultJson: {
          ...record(run.resultJson),
          finalizationPhase: "applied",
          assessmentId: assessmentRow.id,
          decisionId: committed.decision.id,
          authoritativeDecision: decision.toStatus,
          issueStatusBefore: authoritativeIssue.status,
          issueStatusAfter: committed.issue.status,
          statusVersionBefore: Number(authoritativeIssue.statusVersion),
          statusVersionAfter: Number(committed.issue.statusVersion),
          workspaceFinalizeStatus: input.workspaceFinalizeStatus,
        },
        updatedAt: new Date(),
      }).where(eq(heartbeatRuns.id, run.id));
      return {
        ...coordinator,
        phase: "applied",
        assessmentId: assessmentRow.id,
        decisionId: committed.decision.id,
      };
    } catch (error) {
      if (!(error instanceof NativeStatusRaceError) || attempt === 1) throw error;
      supersedesAssessmentId = assessmentRow.id;
    }
  }
  throw new Error("native_finalization_status_race");
}
