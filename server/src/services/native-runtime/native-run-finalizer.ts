import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  approvals,
  completionContracts,
  heartbeatRuns,
  issueApprovals,
  issueThreadInteractions,
  issues,
  nativeRunFinalizations,
  nativeRunResults,
} from "@paperclipai/db";
import { classifyNativeEvidence } from "./evidence-classifier.js";
import {
  arbitrateNativeStatus,
  arbitrateNativeStatusScenario,
  NATIVE_STATUS_ARBITER_POLICY_VERSION,
  type NativeAuthoritativeIssueStatus,
  type NativeGovernanceGate,
  type NativeStatusAuthorityScenario,
} from "./status-arbiter.js";
import { recordNativeWorkAssessment } from "./work-assessments.js";
import {
  commitNativeStatusDecision,
  NativeStatusRaceError,
  type NativeStatusCommitFailpoint,
} from "./status-decision-committer.js";
import { issueRecoveryActionService } from "../issue-recovery-actions.js";
import { nativeSha256 } from "./canonical.js";

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function authoritativeStatus(value: string): NativeAuthoritativeIssueStatus {
  if (!["backlog", "todo", "in_progress", "in_review", "blocked", "done", "cancelled"].includes(value)) {
    throw new Error("native_issue_status_invalid");
  }
  return value as NativeAuthoritativeIssueStatus;
}

/** Server-owned terminal conversion used by live finalization and read models. */
export function projectNativeTerminalRunStatus(
  terminalState: "succeeded" | "failed" | "cancelled" | "active",
) {
  return terminalState === "active" ? "running" as const : terminalState;
}

/** Finalizer-classified scenario arbitration at the production authority seam. */
export function resolveNativeFinalizerStatus(input: {
  scenario: NativeStatusAuthorityScenario;
  priorIssueStatus: NativeAuthoritativeIssueStatus;
  agentId: string;
  governanceGate?: NativeGovernanceGate | null;
  blockerAction?: string;
} | Parameters<typeof arbitrateNativeStatus>[0]) {
  return "scenario" in input
    ? arbitrateNativeStatusScenario(input)
    : arbitrateNativeStatus(input);
}

async function pendingNativeGovernance(input: {
  db: Db;
  companyId: string;
  issueId: string;
  runId: string;
  executionState: Record<string, unknown> | null;
}): Promise<NativeGovernanceGate | null> {
  // Execution policy is issue-owned state and takes priority over the two
  // durable review surfaces. Completion must mediate all three authorities.
  if (record(input.executionState).status === "pending") {
    return { kind: "execution_stage", id: input.runId };
  }
  const [pendingInteraction, pendingApproval] = await Promise.all([
    input.db.select({ id: issueThreadInteractions.id })
      .from(issueThreadInteractions)
      .where(and(
        eq(issueThreadInteractions.companyId, input.companyId),
        eq(issueThreadInteractions.issueId, input.issueId),
        eq(issueThreadInteractions.status, "pending"),
      ))
      .limit(1)
      .then((rows) => rows[0] ?? null),
    input.db.select({ id: approvals.id })
      .from(issueApprovals)
      .innerJoin(approvals, eq(issueApprovals.approvalId, approvals.id))
      .where(and(
        eq(issueApprovals.companyId, input.companyId),
        eq(issueApprovals.issueId, input.issueId),
        eq(approvals.companyId, input.companyId),
        inArray(approvals.status, ["pending", "revision_requested"]),
      ))
      .limit(1)
      .then((rows) => rows[0] ?? null),
  ]);
  if (pendingInteraction) return { kind: "interaction", id: pendingInteraction.id };
  if (pendingApproval) return { kind: "approval", id: pendingApproval.id };
  return null;
}

async function claimCoordinator(input: { db: Db; runId: string }) {
  const leaseOwner = `native-finalizer:${randomUUID()}`;
  const now = new Date();
  const claimed = await input.db.transaction(async (tx) => {
    const coordinator = await tx.select().from(nativeRunFinalizations)
      .where(eq(nativeRunFinalizations.runId, input.runId)).for("update").limit(1)
      .then((rows) => rows[0] ?? null);
    if (!coordinator?.resultId) throw new Error("native_finalization_missing");
    if (coordinator.phase === "committed" && coordinator.decisionId) {
      return { coordinator, leaseOwner: null };
    }
    if (coordinator.phase === "terminal_failure") throw new Error("native_finalization_terminal_failure");
    if (
      coordinator.leaseOwner
      && coordinator.leaseExpiresAt
      && coordinator.leaseExpiresAt > now
      && coordinator.leaseOwner !== leaseOwner
    ) throw new Error("native_finalization_lease_busy");
    const [updated] = await tx.update(nativeRunFinalizations).set({
      leaseOwner,
      leaseExpiresAt: new Date(now.getTime() + 5 * 60_000),
      attempt: coordinator.attempt + 1,
      phase: coordinator.phase === "retryable_failure"
        ? coordinator.assessmentId ? "arbitrating" : "workspace_finalizing"
        : coordinator.phase,
      failureCode: null,
      failureDetail: null,
      nextAttemptAt: null,
      updatedAt: now,
    }).where(eq(nativeRunFinalizations.runId, input.runId)).returning();
    if (!updated) throw new Error("native_finalization_claim_failed");
    return { coordinator: updated, leaseOwner };
  });
  return claimed;
}

async function recordRetryableFailure(input: {
  db: Db;
  run: typeof heartbeatRuns.$inferSelect;
  coordinator: typeof nativeRunFinalizations.$inferSelect;
  failureCode: string;
  message: string;
  nextAction: string;
  projectRunStatus?: boolean;
}) {
  const now = new Date();
  const exhausted = input.coordinator.attempt >= 3;
  const nextAttemptAt = new Date(now.getTime() + 30_000);
  const phase = exhausted ? "terminal_failure" : "retryable_failure";
  const failureCode = exhausted ? "native_finalization_retry_exhausted" : input.failureCode;
  await input.db.transaction(async (tx) => {
    await tx.update(nativeRunFinalizations).set({
      phase,
      leaseOwner: null,
      leaseExpiresAt: null,
      failureCode,
      failureDetail: {
        message: input.message.slice(0, 2_000),
        originalFailureCode: input.failureCode,
        recoveryOwner: { kind: "agent", agentId: input.run.agentId },
        nextAction: input.nextAction,
      },
      nextAttemptAt: exhausted ? null : nextAttemptAt,
      updatedAt: now,
    }).where(eq(nativeRunFinalizations.runId, input.run.id));
    await tx.update(heartbeatRuns).set({
      ...(input.projectRunStatus ? { status: "failed", finishedAt: now } : {}),
      nativePhase: phase,
      nativePhaseUpdatedAt: now,
      resultJson: {
        ...record(input.run.resultJson),
        finalizationPhase: phase,
        failureCode,
        originalFailureCode: input.failureCode,
        nextAttemptAt: exhausted ? null : nextAttemptAt.toISOString(),
      },
      updatedAt: now,
    }).where(eq(heartbeatRuns.id, input.run.id));
    await issueRecoveryActionService(tx as unknown as Db).upsertSourceScoped({
      companyId: input.run.companyId,
      sourceIssueId: input.coordinator.issueId,
      kind: "active_run_watchdog",
      ownerType: "agent",
      ownerAgentId: input.run.agentId,
      cause: failureCode,
      fingerprint: nativeSha256({ runId: input.run.id, failureCode }),
      evidence: {
        runId: input.run.id,
        coordinatorAttempt: input.coordinator.attempt,
        originalFailureCode: input.failureCode,
      },
      nextAction: exhausted
        ? `Finalization retry budget exhausted. ${input.nextAction}`
        : input.nextAction,
      wakePolicy: exhausted
        ? null
        : { kind: "resume_native_run", runId: input.run.id, notBefore: nextAttemptAt.toISOString() },
      maxAttempts: 3,
    });
  });
  return {
    ...input.coordinator,
    phase,
    failureCode,
    nextAttemptAt: exhausted ? null : nextAttemptAt,
  };
}

/** Converts malformed or incomplete persisted finalization state into named recovery. */
export async function recordNativeFinalizationFailure(input: {
  db: Db;
  runId: string;
  error: unknown;
  projectRunStatus?: boolean;
}) {
  const [run, coordinator] = await Promise.all([
    input.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, input.runId))
      .limit(1).then((rows) => rows[0] ?? null),
    input.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, input.runId))
      .limit(1).then((rows) => rows[0] ?? null),
  ]);
  if (!run || run.runtimeMode !== "native" || !coordinator) throw input.error;
  const message = input.error instanceof Error ? input.error.message : String(input.error);
  const failureCode = message.startsWith("native_") ? message : "native_finalization_invalid";
  return recordRetryableFailure({
    db: input.db,
    run,
    coordinator,
    failureCode,
    message,
    nextAction: "Repair the persisted native result or contract discriminator, then resume finalization from the coordinator.",
    projectRunStatus: input.projectRunStatus,
  });
}

async function projectCommittedRun(input: {
  db: Db;
  run: typeof heartbeatRuns.$inferSelect;
  coordinator: typeof nativeRunFinalizations.$inferSelect;
}) {
  if (!input.coordinator.resultId) return;
  const resultRow = await input.db.select({ resultJson: nativeRunResults.resultJson })
    .from(nativeRunResults).where(and(
      eq(nativeRunResults.id, input.coordinator.resultId),
      eq(nativeRunResults.runId, input.run.id),
      eq(nativeRunResults.companyId, input.run.companyId),
    )).limit(1).then((rows) => rows[0] ?? null);
  const terminalState = record(record(resultRow?.resultJson).terminal).runTerminalState;
  if (!["succeeded", "failed", "cancelled"].includes(String(terminalState))) {
    throw new Error("native_finalization_invalid");
  }
  const now = new Date();
  await input.db.update(heartbeatRuns).set({
    status: projectNativeTerminalRunStatus(terminalState as "succeeded" | "failed" | "cancelled"),
    finishedAt: input.run.finishedAt ?? now,
    nativePhase: "committed",
    nativePhaseUpdatedAt: now,
    updatedAt: now,
  }).where(and(
    eq(heartbeatRuns.id, input.run.id),
    eq(heartbeatRuns.runtimeMode, "native"),
    inArray(heartbeatRuns.status, ["queued", "running", "failed"]),
  ));
}

export async function finalizeNativeRun(input: {
  db: Db;
  runId: string;
  workspaceFinalizeStatus: "succeeded" | "failed";
  /** Reconciliation owns terminal run projection; the live heartbeat does it afterward. */
  projectRunStatus?: boolean;
  failpoint?: NativeStatusCommitFailpoint;
}) {
  const run = await input.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, input.runId))
    .limit(1).then((rows) => rows[0] ?? null);
  if (!run || run.runtimeMode !== "native") throw new Error("native_finalization_run_missing");
  const claim = await claimCoordinator({ db: input.db, runId: input.runId });
  const coordinator = claim.coordinator;
  if (!claim.leaseOwner && coordinator.phase === "committed") {
    if (input.projectRunStatus) await projectCommittedRun({ db: input.db, run, coordinator });
    return coordinator;
  }
  if (input.workspaceFinalizeStatus === "failed") {
    return recordRetryableFailure({
      db: input.db,
      run,
      coordinator,
      failureCode: "workspace_finalization_failed",
      message: "Native result preserved; issue status intentionally unchanged.",
      nextAction: "Repair and re-run workspace finalization for the persisted native result.",
      projectRunStatus: input.projectRunStatus,
    });
  }

  const [resultRow, contractRow] = await Promise.all([
    input.db.select().from(nativeRunResults)
      .where(and(
        eq(nativeRunResults.id, coordinator.resultId!),
        eq(nativeRunResults.companyId, run.companyId),
      )).limit(1).then((rows) => rows[0] ?? null),
    input.db.select().from(completionContracts)
      .where(and(
        eq(completionContracts.id, run.completionContractId!),
        eq(completionContracts.companyId, run.companyId),
        eq(completionContracts.issueId, coordinator.issueId),
      )).limit(1).then((rows) => rows[0] ?? null),
  ]);
  if (!resultRow) throw new Error("native_result_missing");
  if (!contractRow) throw new Error("native_completion_contract_missing");
  const envelope = record(resultRow.resultJson);
  const result = record(envelope.result);
  const terminal = record(envelope.terminal);
  const terminalState = terminal.runTerminalState;
  if (!["succeeded", "failed", "cancelled"].includes(String(terminalState))) {
    throw new Error("native_finalization_invalid");
  }

  await input.db.update(nativeRunFinalizations).set({ phase: "ready_for_assessment", updatedAt: new Date() })
    .where(and(
      eq(nativeRunFinalizations.runId, input.runId),
      eq(nativeRunFinalizations.leaseOwner, claim.leaseOwner!),
    ));
  const assessment = await classifyNativeEvidence({
    db: input.db,
    companyId: run.companyId,
    issueId: coordinator.issueId,
    runId: run.id,
    contract: record(contractRow.contractJson),
    result,
  });

  let supersedesAssessmentId: string | null = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const authoritativeIssue = await input.db.select().from(issues).where(and(
      eq(issues.id, coordinator.issueId),
      eq(issues.companyId, run.companyId),
    )).limit(1).then((rows) => rows[0] ?? null);
    if (!authoritativeIssue) throw new Error("native_finalization_issue_missing");
    const governanceGate = await pendingNativeGovernance({
      db: input.db,
      companyId: run.companyId,
      issueId: authoritativeIssue.id,
      runId: run.id,
      executionState: record(authoritativeIssue.executionState),
    });
    const decision = resolveNativeFinalizerStatus({
      assessment,
      terminalState: terminalState as "succeeded" | "failed" | "cancelled",
      workspaceFinalizeStatus: input.workspaceFinalizeStatus,
      governanceGate,
      completionClaimPolicyAccepted:
        contractRow.risk === "low" && contractRow.completionAuthority === "agent_claim_policy",
      agentId: run.agentId,
      priorIssueStatus: authoritativeStatus(authoritativeIssue.status),
    });
    const assessmentRow = await recordNativeWorkAssessment({
      db: input.db,
      companyId: run.companyId,
      issueId: authoritativeIssue.id,
      runId: run.id,
      turnId: resultRow.turnId,
      contractId: resultRow.completionContractId,
      contractCanonicalSha256: contractRow.canonicalSha256,
      resultId: resultRow.id,
      resultCanonicalSha256: resultRow.canonicalSha256,
      priorIssueStatus: authoritativeIssue.status,
      priorStatusVersion: Number(authoritativeIssue.statusVersion),
      priorDecisionId: authoritativeIssue.lastStatusDecisionId,
      policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
      assessment,
      supersedesAssessmentId,
    });
    await input.db.update(nativeRunFinalizations).set({
      phase: "arbitrating",
      assessmentId: assessmentRow.id,
      updatedAt: new Date(),
    }).where(and(
      eq(nativeRunFinalizations.runId, input.runId),
      eq(nativeRunFinalizations.leaseOwner, claim.leaseOwner!),
    ));
    try {
      const committed = await commitNativeStatusDecision({
        db: input.db,
        companyId: run.companyId,
        issueId: authoritativeIssue.id,
        runId: run.id,
        assessmentId: assessmentRow.id,
        priorStatus: authoritativeIssue.status,
        priorStatusVersion: Number(authoritativeIssue.statusVersion),
        priorDecisionId: authoritativeIssue.lastStatusDecisionId,
        decision,
        failpoint: input.failpoint,
      });
      const now = new Date();
      await input.db.update(heartbeatRuns).set({
        ...(input.projectRunStatus ? {
          status: terminalState === "succeeded" ? "succeeded" : terminalState === "cancelled" ? "cancelled" : "failed",
          finishedAt: now,
        } : {}),
        nativePhase: "committed",
        nativePhaseUpdatedAt: now,
        resultJson: {
          ...record(run.resultJson),
          finalizationPhase: "committed",
          assessmentId: assessmentRow.id,
          decisionId: committed.decision.id,
          authoritativeDecision: decision.toStatus,
          issueStatusBefore: authoritativeIssue.status,
          issueStatusAfter: committed.issue.status,
          statusVersionBefore: Number(authoritativeIssue.statusVersion),
          statusVersionAfter: Number(committed.issue.statusVersion),
          workspaceFinalizeStatus: input.workspaceFinalizeStatus,
        },
        updatedAt: now,
      }).where(eq(heartbeatRuns.id, run.id));
      return { ...coordinator, phase: "committed", assessmentId: assessmentRow.id, decisionId: committed.decision.id };
    } catch (error) {
      if (error instanceof NativeStatusRaceError && attempt < 2) {
        supersedesAssessmentId = assessmentRow.id;
        continue;
      }
      return recordRetryableFailure({
        db: input.db,
        run,
        coordinator,
        failureCode: error instanceof NativeStatusRaceError ? "status_cas_exhausted" : "side_effect_planning_failed",
        message: error instanceof Error ? error.message : String(error),
        nextAction: error instanceof NativeStatusRaceError
          ? "Reassess against the latest authoritative issue status version."
          : "Retry atomic status and liveness materialization from the persisted assessment.",
        projectRunStatus: input.projectRunStatus,
      });
    }
  }
  throw new Error("native_finalization_status_race");
}
