import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  issues,
  activityLog,
  nativeRunFinalizations,
  statusDecisionEffects,
  statusDecisions,
} from "@paperclipai/db";
import type { NativeStatusDecision } from "./status-arbiter.js";
import { nativeSha256 } from "./canonical.js";

export class NativeStatusRaceError extends Error {
  readonly code = "native_status_race" as const;
  constructor() {
    super("native_status_race");
    this.name = "NativeStatusRaceError";
  }
}

export async function commitNativeStatusDecision(input: {
  db: Db;
  companyId: string;
  issueId: string;
  runId: string;
  assessmentId: string;
  priorStatus: string;
  priorStatusVersion: number;
  decision: NativeStatusDecision;
}) {
  return input.db.transaction(async (tx) => {
    const issue = await tx.select().from(issues).where(and(
      eq(issues.id, input.issueId),
      eq(issues.companyId, input.companyId),
    )).for("update").limit(1).then((rows) => rows[0] ?? null);
    if (!issue || issue.status !== input.priorStatus || issue.statusVersion !== input.priorStatusVersion) {
      throw new NativeStatusRaceError();
    }
    const decisionJson = {
      toStatus: input.decision.toStatus,
      reasonCode: input.decision.reasonCode,
      unblockDescriptor: input.decision.unblockDescriptor,
    };
    const decisionDigest = nativeSha256({
      issueId: input.issueId,
      assessmentId: input.assessmentId,
      policyVersion: input.decision.policyVersion,
      fromStatus: issue.status,
      decision: decisionJson,
    });
    let decisionRow = await tx.select().from(statusDecisions).where(and(
      eq(statusDecisions.issueId, input.issueId),
      eq(statusDecisions.decisionDigest, decisionDigest),
    )).limit(1).then((rows) => rows[0] ?? null);
    if (!decisionRow) {
      [decisionRow] = await tx.insert(statusDecisions).values({
        companyId: input.companyId,
        issueId: input.issueId,
        assessmentId: input.assessmentId,
        decisionVersion: 1,
        policyVersion: input.decision.policyVersion,
        fromStatus: issue.status,
        toStatus: input.decision.toStatus,
        reasonCode: input.decision.reasonCode,
        decisionJson,
        decisionDigest,
        applicationState: "pending",
      }).returning();
    }
    if (!decisionRow) throw new Error("native_status_decision_not_persisted");
    const updated = await tx.update(issues).set({
      status: input.decision.toStatus,
      unblockDescriptor: input.decision.unblockDescriptor,
      lastStatusDecisionId: decisionRow.id,
      completedAt: input.decision.toStatus === "done" ? new Date() : null,
      blockedTransitionAt: input.decision.toStatus === "blocked" ? new Date() : null,
      updatedAt: new Date(),
    }).where(and(
      eq(issues.id, input.issueId),
      eq(issues.statusVersion, input.priorStatusVersion),
    )).returning().then((rows) => rows[0] ?? null);
    if (!updated) throw new NativeStatusRaceError();
    await tx.insert(statusDecisionEffects).values({
      companyId: input.companyId,
      issueId: input.issueId,
      decisionId: decisionRow.id,
      ordinal: 1,
      effectKind: "issue_status_projection",
      targetType: "issue",
      targetId: input.issueId,
      idempotencyKey: `native-status:${decisionRow.id}:1`,
      payload: {
        fromStatus: issue.status,
        toStatus: input.decision.toStatus,
        reasonCode: input.decision.reasonCode,
      },
      deliveryState: "delivered",
      attemptCount: 1,
      deliveredAt: new Date(),
    }).onConflictDoNothing();
    await tx.update(statusDecisions).set({
      applicationState: "applied",
      appliedAt: new Date(),
    }).where(eq(statusDecisions.id, decisionRow.id));
    await tx.update(nativeRunFinalizations).set({
      phase: "applied",
      assessmentId: input.assessmentId,
      decisionId: decisionRow.id,
      updatedAt: new Date(),
    }).where(eq(nativeRunFinalizations.runId, input.runId));
    await tx.insert(activityLog).values({
      companyId: input.companyId,
      actorType: "system",
      actorId: "native-status-committer",
      action: "issue.native_status_decision_applied",
      entityType: "issue",
      entityId: input.issueId,
      runId: input.runId,
      details: {
        assessmentId: input.assessmentId,
        decisionId: decisionRow.id,
        fromStatus: issue.status,
        toStatus: input.decision.toStatus,
        reasonCode: input.decision.reasonCode,
      },
    });
    return { decision: { ...decisionRow, applicationState: "applied" }, issue: updated };
  });
}
