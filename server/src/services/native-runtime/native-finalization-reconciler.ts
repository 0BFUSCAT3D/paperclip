import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, gt, inArray, isNotNull, isNull, lte, notInArray, or } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRuns, nativeRunFinalizations, workspaceOperations } from "@paperclipai/db";
import { finalizeNativeRun, recordNativeFinalizationFailure } from "./native-run-finalizer.js";
import { issueRecoveryActionService } from "../issue-recovery-actions.js";
import {
  arbitrateNativeStatusScenario,
  type NativeAuthoritativeIssueStatus,
  type NativeStatusAuthorityScenario,
} from "./status-arbiter.js";

const RECONCILIATION_STATUS_SCENARIOS = new Set<NativeStatusAuthorityScenario>([
  "equivalent_attention_family", "identical_result_before_ack", "reused_id_changed_material",
  "result_preserved", "decision_committed_delivery_pending", "board_cancelled_before_cas",
  "new_evidence_satisfies_contract", "new_policy_requires_review", "dependency_now_done",
  "explicit_resume_capability", "authorized_writer_incremented_version",
]);

/** Append-only recovery/reconciliation re-arbitration from durable facts. */
export function resolveNativeReconciliationStatus(input: {
  scenario: NativeStatusAuthorityScenario;
  priorIssueStatus: NativeAuthoritativeIssueStatus;
  agentId: string;
}) {
  if (!RECONCILIATION_STATUS_SCENARIOS.has(input.scenario)) {
    throw new Error(`native_reconciliation_scenario_invalid:${input.scenario}`);
  }
  return arbitrateNativeStatusScenario(input);
}

export type NativeSessionResumeClaim = { runId: string; leaseOwner: string };

export async function dispatchNativeSessionResumptions(input: {
  db: Db;
  runnerInstanceId: string;
  runIds?: string[];
  now?: Date;
  limit?: number;
  dispatch: (claim: NativeSessionResumeClaim) => void;
}) {
  const claims = await claimNativeSessionResumptions(input);
  for (const claim of claims) input.dispatch(claim);
  return claims;
}

/**
 * Claims result-less native executions for same-run recovery. Eligibility is
 * derived exclusively from persisted mode/coordinator/envelope/checkpoint
 * state; the live feature flag and legacy scheduler are intentionally absent.
 */
export async function claimNativeSessionResumptions(input: {
  db: Db;
  runnerInstanceId: string;
  runIds?: string[];
  now?: Date;
  limit?: number;
}): Promise<NativeSessionResumeClaim[]> {
  const now = input.now ?? new Date();
  const candidates = await input.db.select({ runId: heartbeatRuns.id })
    .from(heartbeatRuns)
    .innerJoin(nativeRunFinalizations, eq(nativeRunFinalizations.runId, heartbeatRuns.id))
    .where(and(
      eq(heartbeatRuns.runtimeMode, "native"),
      isNull(nativeRunFinalizations.resultId),
      or(
        eq(nativeRunFinalizations.phase, "retryable_failure"),
        and(eq(nativeRunFinalizations.phase, "observed"), gt(nativeRunFinalizations.attempt, 0)),
      ),
      or(isNull(nativeRunFinalizations.nextAttemptAt), lte(nativeRunFinalizations.nextAttemptAt, now)),
      or(
        isNull(nativeRunFinalizations.leaseOwner),
        isNull(nativeRunFinalizations.leaseExpiresAt),
        lte(nativeRunFinalizations.leaseExpiresAt, now),
      ),
      ...(input.runIds?.length ? [inArray(heartbeatRuns.id, input.runIds)] : []),
    ))
    .limit(input.limit ?? 25);

  const claims: NativeSessionResumeClaim[] = [];
  for (const candidate of candidates) {
    const leaseOwner = `${input.runnerInstanceId}:resume:${randomUUID()}`;
    const claimed = await input.db.transaction(async (tx) => {
      const row = await tx.select({
        run: heartbeatRuns,
        coordinator: nativeRunFinalizations,
      }).from(heartbeatRuns)
        .innerJoin(nativeRunFinalizations, eq(nativeRunFinalizations.runId, heartbeatRuns.id))
        .where(eq(heartbeatRuns.id, candidate.runId))
        .for("update")
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (!row) return false;
      if (
        row.run.runtimeMode !== "native"
        || row.coordinator.resultId
        || !["observed", "retryable_failure"].includes(row.coordinator.phase)
        || (row.coordinator.phase === "observed" && row.coordinator.attempt <= 0)
        || (row.coordinator.nextAttemptAt && row.coordinator.nextAttemptAt > now)
        || (
          row.coordinator.leaseOwner
          && row.coordinator.leaseExpiresAt
          && row.coordinator.leaseExpiresAt > now
        )
        || !["running", "failed"].includes(row.run.status)
      ) return false;

      const profile = row.run.runnerProfileJson ?? {};
      const persistedInput = profile.nativeExecutionInput;
      const checkpoint = profile.sessionCheckpoint;
      if (!persistedInput || !checkpoint) {
        const failureCode = "native_session_checkpoint_missing";
        await tx.update(nativeRunFinalizations).set({
          phase: "terminal_failure",
          leaseOwner: null,
          leaseExpiresAt: null,
          failureCode,
          failureDetail: {
            recoveryOwner: { kind: "agent", agentId: row.run.agentId },
            nextAction: "Inspect the interrupted native session; opening a replacement provider session is forbidden.",
          },
          nextAttemptAt: null,
          updatedAt: now,
        }).where(eq(nativeRunFinalizations.runId, row.run.id));
        await tx.update(heartbeatRuns).set({
          status: "failed",
          finishedAt: now,
          nativePhase: "terminal_failure",
          nativePhaseUpdatedAt: now,
          errorCode: failureCode,
          error: "Persisted native session cannot be resumed without both its envelope and provider checkpoint",
          updatedAt: now,
        }).where(eq(heartbeatRuns.id, row.run.id));
        await issueRecoveryActionService(tx as unknown as Db).upsertSourceScoped({
          companyId: row.run.companyId,
          sourceIssueId: row.coordinator.issueId,
          kind: "active_run_watchdog",
          ownerType: "agent",
          ownerAgentId: row.run.agentId,
          cause: failureCode,
          fingerprint: createHash("sha256").update(`${row.run.id}:${failureCode}`).digest("hex"),
          evidence: { runId: row.run.id, hasEnvelope: !!persistedInput, hasCheckpoint: !!checkpoint },
          nextAction: "Inspect the interrupted native session and explicitly choose recovery; do not open a duplicate provider session.",
          wakePolicy: null,
          maxAttempts: 3,
        });
        return false;
      }

      const leaseExpiresAt = new Date(now.getTime() + 20 * 60_000);
      const updated = await tx.update(nativeRunFinalizations).set({
        phase: "observed",
        leaseOwner,
        leaseExpiresAt,
        failureCode: null,
        failureDetail: null,
        nextAttemptAt: null,
        updatedAt: now,
      }).where(and(
        eq(nativeRunFinalizations.runId, row.run.id),
        eq(nativeRunFinalizations.phase, row.coordinator.phase),
      )).returning({ runId: nativeRunFinalizations.runId }).then((rows) => rows[0] ?? null);
      if (!updated) return false;
      await tx.update(heartbeatRuns).set({
        status: "running",
        finishedAt: null,
        error: null,
        errorCode: null,
        nativePhase: "observed",
        nativePhaseUpdatedAt: now,
        updatedAt: now,
      }).where(eq(heartbeatRuns.id, row.run.id));
      return true;
    });
    if (claimed) claims.push({ runId: candidate.runId, leaseOwner });
  }
  return claims;
}

/** Recovery is keyed only by persisted mode/coordinator state, never the live flag. */
export async function reconcileNativeFinalizations(db: Db, runIds?: string[]) {
  const rows = await db.select({ runId: heartbeatRuns.id })
    .from(heartbeatRuns)
    .innerJoin(nativeRunFinalizations, eq(nativeRunFinalizations.runId, heartbeatRuns.id))
    .where(and(
      eq(heartbeatRuns.runtimeMode, "native"),
      isNotNull(nativeRunFinalizations.resultId),
      notInArray(nativeRunFinalizations.phase, ["terminal_failure"]),
      or(
        isNull(nativeRunFinalizations.nextAttemptAt),
        lte(nativeRunFinalizations.nextAttemptAt, new Date()),
      ),
      or(
        isNull(nativeRunFinalizations.leaseOwner),
        isNull(nativeRunFinalizations.leaseExpiresAt),
        lte(nativeRunFinalizations.leaseExpiresAt, new Date()),
      ),
      ...(runIds && runIds.length > 0 ? [inArray(heartbeatRuns.id, runIds)] : []),
    ));
  const results = [];
  for (const row of rows) {
    const barrier = await db.select({ status: workspaceOperations.status })
      .from(workspaceOperations)
      .where(and(
        eq(workspaceOperations.heartbeatRunId, row.runId),
        eq(workspaceOperations.phase, "workspace_finalize"),
      ))
      .orderBy(desc(workspaceOperations.createdAt))
      .limit(1)
      .then((entries) => entries[0] ?? null);
    if (!barrier || !["succeeded", "failed"].includes(barrier.status)) continue;
    try {
      results.push(await finalizeNativeRun({
        db,
        runId: row.runId,
        workspaceFinalizeStatus: barrier.status as "succeeded" | "failed",
        projectRunStatus: true,
      }));
    } catch (error) {
      results.push(await recordNativeFinalizationFailure({
        db,
        runId: row.runId,
        error,
        projectRunStatus: true,
      }));
    }
  }
  return results;
}
