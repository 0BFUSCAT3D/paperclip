import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import type { CreateIssueThreadInteraction } from "@paperclipai/shared";
import {
  agentWakeupRequests,
  approvals,
  issueApprovals,
  issueThreadInteractions,
  issues,
  nativeRunFinalizations,
  statusDecisionEffects,
  statusDecisions,
} from "@paperclipai/db";
import type { NativeStatusDecision, NativeStatusEffect } from "./status-arbiter.js";
import { nativeSha256 } from "./canonical.js";
import { issueService } from "../issues.js";
import { issueThreadInteractionService } from "../issue-thread-interactions.js";
import { issueRecoveryActionService } from "../issue-recovery-actions.js";
import { buildIssueBlockersResolvedWakeIdempotencyKey } from "../issue-dependency-wakeups.js";
import { persistActivity, publishActivity, type ActivityPublication } from "../activity-log.js";

export class NativeStatusRaceError extends Error {
  readonly code = "native_status_race" as const;
  constructor() {
    super("native_status_race");
    this.name = "NativeStatusRaceError";
  }
}

export type NativeStatusCommitFailpoint =
  | "governance_materialization"
  | "interaction_materialization"
  | "continuation_materialization"
  | "blocker_materialization"
  | "recovery_materialization"
  | "status_projection";

type MaterializedEffect = {
  effectKind: string;
  targetType: string;
  targetId: string | null;
  payload: Record<string, unknown>;
};

function failAt(actual: NativeStatusCommitFailpoint, requested?: NativeStatusCommitFailpoint) {
  if (actual === requested) throw new Error(`native_status_failpoint:${actual}`);
}

async function enqueueWake(input: {
  tx: Db;
  companyId: string;
  issueId: string;
  agentId: string;
  reason: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
}) {
  const existing = await input.tx.select({ id: agentWakeupRequests.id })
    .from(agentWakeupRequests)
    .where(and(
      eq(agentWakeupRequests.companyId, input.companyId),
      eq(agentWakeupRequests.idempotencyKey, input.idempotencyKey),
      inArray(agentWakeupRequests.status, ["queued", "deferred_issue_execution", "claimed", "completed"]),
    )).limit(1).then((rows) => rows[0] ?? null);
  if (existing) return existing.id;
  const inserted = await input.tx.insert(agentWakeupRequests).values({
    companyId: input.companyId,
    agentId: input.agentId,
    source: "automation",
    triggerDetail: "system",
    reason: input.reason,
    payload: {
      issueId: input.issueId,
      taskId: input.issueId,
      ...input.payload,
      _paperclipWakeContext: {
        issueId: input.issueId,
        taskId: input.issueId,
        wakeReason: input.reason,
        source: "native_status_decision",
      },
    },
    requestedByActorType: "system",
    requestedByActorId: "native-status-committer",
    idempotencyKey: input.idempotencyKey,
  }).returning({ id: agentWakeupRequests.id }).then((rows) => rows[0] ?? null);
  if (!inserted) throw new Error("native_status_wake_not_persisted");
  return inserted.id;
}

async function validateGovernanceGate(tx: Db, input: {
  companyId: string;
  issueId: string;
  gate: Extract<NativeStatusEffect, { kind: "bind_governance" }>["gate"];
  executionState: unknown;
}) {
  if (input.gate.kind === "execution_stage") {
    const state = input.executionState && typeof input.executionState === "object"
      ? input.executionState as Record<string, unknown>
      : {};
    if (state.status !== "pending") throw new Error("native_governance_gate_resolved");
    return input.gate.id;
  }
  if (input.gate.kind === "interaction") {
    const interaction = await tx.select({ id: issueThreadInteractions.id })
      .from(issueThreadInteractions).where(and(
        eq(issueThreadInteractions.id, input.gate.id),
        eq(issueThreadInteractions.companyId, input.companyId),
        eq(issueThreadInteractions.issueId, input.issueId),
        eq(issueThreadInteractions.status, "pending"),
      )).limit(1).then((rows) => rows[0] ?? null);
    if (!interaction) throw new Error("native_governance_gate_resolved");
    return interaction.id;
  }
  const approval = await tx.select({ id: approvals.id }).from(issueApprovals)
    .innerJoin(approvals, eq(issueApprovals.approvalId, approvals.id))
    .where(and(
      eq(issueApprovals.companyId, input.companyId),
      eq(issueApprovals.issueId, input.issueId),
      eq(approvals.companyId, input.companyId),
      eq(approvals.id, input.gate.id),
      inArray(approvals.status, ["pending", "revision_requested"]),
    )).limit(1).then((rows) => rows[0] ?? null);
  if (!approval) throw new Error("native_governance_gate_resolved");
  return approval.id;
}

async function materializeDecisionEffect(input: {
  tx: Db;
  companyId: string;
  issue: typeof issues.$inferSelect;
  runId: string;
  decisionId: string;
  effect: NativeStatusEffect;
  failpoint?: NativeStatusCommitFailpoint;
}): Promise<MaterializedEffect> {
  const { effect } = input;
  if (effect.kind === "bind_governance") {
    failAt("governance_materialization", input.failpoint);
    const targetId = await validateGovernanceGate(input.tx, {
      companyId: input.companyId,
      issueId: input.issue.id,
      gate: effect.gate,
      executionState: input.issue.executionState,
    });
    return { effectKind: effect.kind, targetType: effect.gate.kind, targetId, payload: { gate: effect.gate } };
  }
  if (effect.kind === "create_review_interaction") {
    failAt("interaction_materialization", input.failpoint);
    const reviewInput: Extract<CreateIssueThreadInteraction, { kind: "request_confirmation" }> = {
      kind: "request_confirmation",
      idempotencyKey: `native-review:${input.decisionId}`,
      sourceRunId: input.runId,
      title: "Native completion review",
      summary: "The native runner requires authoritative review before completion.",
      continuationPolicy: "wake_assignee",
      payload: {
        version: 1,
        prompt: effect.prompt,
        acceptLabel: "Approve completion",
        rejectLabel: "Continue work",
        allowDeclineReason: true,
        rejectRequiresReason: true,
        supersedeOnUserComment: false,
      },
    };
    const interaction = await issueThreadInteractionService(input.tx).create(
      input.issue,
      reviewInput,
      { systemId: "native-status-committer", runId: input.runId },
    );
    return {
      effectKind: effect.kind,
      targetType: "issue_thread_interaction",
      targetId: interaction.id,
      payload: { interactionId: interaction.id, interactionKind: interaction.kind },
    };
  }
  if (effect.kind === "enqueue_continuation") {
    failAt("continuation_materialization", input.failpoint);
    const wakeId = await enqueueWake({
      tx: input.tx,
      companyId: input.companyId,
      issueId: input.issue.id,
      agentId: effect.agentId,
      reason: effect.continuationKind === "monitor" ? "monitor_due" : "issue_status_changed",
      idempotencyKey: `native-status:${input.decisionId}:continuation`,
      payload: {
        nativeDecisionId: input.decisionId,
        continuationKind: effect.continuationKind,
        continuationSummary: effect.summary,
        continuationIdempotencyKey: effect.idempotencyKey,
      },
    });
    return {
      effectKind: effect.kind,
      targetType: "agent_wakeup_request",
      targetId: wakeId,
      payload: { continuationKind: effect.continuationKind, summary: effect.summary },
    };
  }
  if (effect.kind === "bind_blocker") {
    failAt("blocker_materialization", input.failpoint);
    let wakeId: string | null = null;
    if (effect.owner !== "board") {
      wakeId = await enqueueWake({
        tx: input.tx,
        companyId: input.companyId,
        issueId: input.issue.id,
        agentId: effect.owner.agentId,
        reason: "issue_status_changed",
        idempotencyKey: `native-status:${input.decisionId}:blocker-owner`,
        payload: { nativeDecisionId: input.decisionId, unblockAction: effect.action },
      });
    }
    return {
      effectKind: effect.kind,
      targetType: effect.owner === "board" ? "board" : "agent_wakeup_request",
      targetId: wakeId,
      payload: { owner: effect.owner, action: effect.action },
    };
  }
  if (effect.kind === "record_recovery") {
    failAt("recovery_materialization", input.failpoint);
    const recovery = await issueRecoveryActionService(input.tx).upsertSourceScoped({
      companyId: input.companyId,
      sourceIssueId: input.issue.id,
      kind: "active_run_watchdog",
      ownerType: "agent",
      ownerAgentId: effect.agentId,
      cause: effect.cause,
      fingerprint: nativeSha256({ runId: input.runId, decisionId: input.decisionId, cause: effect.cause }),
      evidence: { runId: input.runId, decisionId: input.decisionId },
      nextAction: effect.nextAction,
      wakePolicy: { kind: "resume_native_run", runId: input.runId },
      maxAttempts: 3,
    });
    return {
      effectKind: effect.kind,
      targetType: "issue_recovery_action",
      targetId: recovery.id,
      payload: { cause: effect.cause, nextAction: effect.nextAction },
    };
  }
  return {
    effectKind: effect.kind,
    targetType: "issue_checkout",
    targetId: input.issue.id,
    payload: { checkoutRunId: input.issue.checkoutRunId, executionRunId: input.issue.executionRunId },
  };
}

export async function commitNativeStatusDecision(input: {
  db: Db;
  companyId: string;
  issueId: string;
  runId: string;
  assessmentId: string;
  priorStatus: string;
  priorStatusVersion: number;
  priorDecisionId: string | null;
  decision: NativeStatusDecision;
  failpoint?: NativeStatusCommitFailpoint;
}) {
  const publications: ActivityPublication[] = [];
  const committed = await input.db.transaction(async (tx) => {
    const coordinator = await tx.select().from(nativeRunFinalizations).where(and(
      eq(nativeRunFinalizations.runId, input.runId),
      eq(nativeRunFinalizations.companyId, input.companyId),
      eq(nativeRunFinalizations.issueId, input.issueId),
    )).for("update").limit(1).then((rows) => rows[0] ?? null);
    if (!coordinator) throw new Error("native_finalization_coordinator_missing");
    const issue = await tx.select().from(issues).where(and(
      eq(issues.id, input.issueId),
      eq(issues.companyId, input.companyId),
    )).for("update").limit(1).then((rows) => rows[0] ?? null);
    if (
      !issue
      || issue.status !== input.priorStatus
      || Number(issue.statusVersion) !== input.priorStatusVersion
      || issue.lastStatusDecisionId !== input.priorDecisionId
    ) {
      throw new NativeStatusRaceError();
    }
    const decisionJson = {
      toStatus: input.decision.toStatus,
      reasonCode: input.decision.reasonCode,
      unblockDescriptor: input.decision.unblockDescriptor,
      effects: input.decision.effects,
    };
    const decisionDigest = nativeSha256({
      issueId: input.issueId,
      assessmentId: input.assessmentId,
      policyVersion: input.decision.policyVersion,
      fromStatus: issue.status,
      priorStatusVersion: input.priorStatusVersion,
      priorDecisionId: input.priorDecisionId,
      decision: decisionJson,
    });
    let decisionRow = await tx.select().from(statusDecisions).where(and(
      eq(statusDecisions.issueId, input.issueId),
      eq(statusDecisions.decisionDigest, decisionDigest),
    )).limit(1).then((rows) => rows[0] ?? null);
    if (decisionRow?.applicationState === "applied") {
      return { decision: decisionRow, issue, replayed: true };
    }
    if (!decisionRow) {
      [decisionRow] = await tx.insert(statusDecisions).values({
        companyId: input.companyId,
        issueId: input.issueId,
        assessmentId: input.assessmentId,
        decisionVersion: input.priorStatusVersion + 1,
        policyVersion: input.decision.policyVersion,
        fromStatus: issue.status,
        toStatus: input.decision.toStatus,
        reasonCode: input.decision.reasonCode,
        decisionJson,
        decisionDigest,
        applicationState: "proposed",
      }).returning();
    }
    if (!decisionRow) throw new Error("native_status_decision_not_persisted");

    const materialized: MaterializedEffect[] = [];
    for (const effect of input.decision.effects) {
      materialized.push(await materializeDecisionEffect({
        tx: tx as unknown as Db,
        companyId: input.companyId,
        issue,
        runId: input.runId,
        decisionId: decisionRow.id,
        effect,
        failpoint: input.failpoint,
      }));
    }

    failAt("status_projection", input.failpoint);
    const updated = await issueService(tx as unknown as Db).update(input.issueId, {
      status: input.decision.toStatus,
      statusVersion: input.priorStatusVersion + 1,
      lastStatusDecisionId: decisionRow.id,
      unblockDescriptor: input.decision.unblockDescriptor,
      actorAgentId: null,
      actorUserId: null,
    }, tx, publications);
    if (!updated) throw new NativeStatusRaceError();
    materialized.unshift({
      effectKind: "issue_status_projection",
      targetType: "issue",
      targetId: input.issueId,
      payload: { fromStatus: issue.status, toStatus: input.decision.toStatus, reasonCode: input.decision.reasonCode },
    });

    if (input.decision.toStatus === "done" && issue.status !== "done") {
      const issueSvc = issueService(tx as unknown as Db);
      const dependents = await issueSvc.listWakeableBlockedDependents(input.issueId);
      for (const dependent of dependents) {
        const idempotencyKey = buildIssueBlockersResolvedWakeIdempotencyKey({
          dependentIssueId: dependent.id,
          resolvedBlockerIssueId: input.issueId,
        });
        const wakeId = await enqueueWake({
          tx: tx as unknown as Db,
          companyId: input.companyId,
          issueId: dependent.id,
          agentId: dependent.assigneeAgentId,
          reason: "issue_blockers_resolved",
          idempotencyKey,
          payload: { resolvedBlockerIssueId: input.issueId, blockerIssueIds: dependent.blockerIssueIds },
        });
        materialized.push({
          effectKind: "dependency_wake",
          targetType: "agent_wakeup_request",
          targetId: wakeId,
          payload: { dependentIssueId: dependent.id, resolvedBlockerIssueId: input.issueId },
        });
      }
      if (issue.parentId) {
        const parent = await issueSvc.getWakeableParentAfterChildCompletion(issue.parentId);
        if (parent) {
          const wakeId = await enqueueWake({
            tx: tx as unknown as Db,
            companyId: input.companyId,
            issueId: parent.id,
            agentId: parent.assigneeAgentId,
            reason: "issue_children_completed",
            idempotencyKey: `issue_children_completed:${parent.id}:${input.issueId}`,
            payload: { completedChildIssueId: input.issueId, childIssueIds: parent.childIssueIds },
          });
          materialized.push({
            effectKind: "parent_wake",
            targetType: "agent_wakeup_request",
            targetId: wakeId,
            payload: { parentIssueId: parent.id, completedChildIssueId: input.issueId },
          });
        }
      }
    }

    for (const [index, effect] of materialized.entries()) {
      await tx.insert(statusDecisionEffects).values({
        companyId: input.companyId,
        issueId: input.issueId,
        decisionId: decisionRow.id,
        ordinal: index + 1,
        effectKind: effect.effectKind,
        targetType: effect.targetType,
        targetId: effect.targetId,
        idempotencyKey: `native-status:${decisionRow.id}:${index + 1}`,
        payload: effect.payload,
        deliveryState: "delivered",
        attemptCount: 1,
        deliveredAt: new Date(),
      }).onConflictDoNothing();
    }
    await tx.update(statusDecisions).set({ applicationState: "applied", appliedAt: new Date() })
      .where(eq(statusDecisions.id, decisionRow.id));
    await tx.update(nativeRunFinalizations).set({
      phase: "committed",
      assessmentId: input.assessmentId,
      decisionId: decisionRow.id,
      leaseOwner: null,
      leaseExpiresAt: null,
      failureCode: null,
      failureDetail: null,
      nextAttemptAt: null,
      updatedAt: new Date(),
    }).where(eq(nativeRunFinalizations.runId, input.runId));
    const { publication } = await persistActivity(tx as unknown as Db, {
      companyId: input.companyId,
      actorType: "system",
      actorId: "native-status-committer",
      action: "issue.updated",
      entityType: "issue",
      entityId: input.issueId,
      issueId: input.issueId,
      runId: input.runId,
      details: {
        source: "native_status_decision",
        assessmentId: input.assessmentId,
        decisionId: decisionRow.id,
        fromStatus: issue.status,
        toStatus: input.decision.toStatus,
        reasonCode: input.decision.reasonCode,
        effectCount: materialized.length,
      },
    });
    publications.push(publication);
    return {
      decision: { ...decisionRow, applicationState: "applied" },
      issue: updated,
      replayed: false,
    };
  });

  for (const publication of publications) publishActivity(publication);
  return committed;
}
