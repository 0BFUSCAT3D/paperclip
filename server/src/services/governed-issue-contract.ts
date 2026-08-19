import { createHash } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agentWakeupRequests,
  governedIssueReservations,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  governedIssueLifecycleIssueV1Schema,
  type GovernedIssueEnvelope,
  type GovernedIssueLifecycleIssueV1,
} from "@paperclipai/shared";
import { conflict, notFound, preconditionFailed } from "../errors.js";
import { assertIssueExecutionPolicyParticipants } from "./issue-execution-policy-participants.js";
import { normalizeIssueExecutionPolicy, parseIssueExecutionState } from "./issue-execution-policy.js";

export const GOVERNED_ISSUE_LIFECYCLE_VERSION = 1 as const;

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, child]) => child !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalJsonValue(child)]),
    );
  }
  return value;
}

export function canonicalGovernedIssueEnvelope(envelope: GovernedIssueEnvelope): Record<string, unknown> {
  return canonicalJsonValue(envelope) as Record<string, unknown>;
}

export function governedIssueSha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalJsonValue(value))).digest("hex");
}

export function governedIssueEnvelopeSha256(envelope: GovernedIssueEnvelope): string {
  return governedIssueSha256(canonicalGovernedIssueEnvelope(envelope));
}

export function governedIssueLifecycleIssueSnapshot(
  issue: typeof issues.$inferSelect,
): GovernedIssueLifecycleIssueV1 {
  return governedIssueLifecycleIssueV1Schema.parse({
    id: issue.id,
    companyId: issue.companyId,
    projectId: issue.projectId,
    projectWorkspaceId: issue.projectWorkspaceId,
    goalId: issue.goalId,
    parentId: issue.parentId,
    title: issue.title,
    description: issue.description,
    status: issue.status,
    workMode: issue.workMode,
    harnessKind: issue.harnessKind,
    priority: issue.priority,
    reviewPolicy: issue.reviewPolicy,
    assigneeAgentId: issue.assigneeAgentId,
    assigneeUserId: issue.assigneeUserId,
    createdByAgentId: issue.createdByAgentId,
    createdByUserId: issue.createdByUserId,
    responsibleUserId: issue.responsibleUserId,
    issueNumber: issue.issueNumber,
    identifier: issue.identifier,
    requestDepth: issue.requestDepth,
    billingCode: issue.billingCode,
    assigneeAdapterOverrides: issue.assigneeAdapterOverrides,
    executionPolicy: issue.executionPolicy,
    executionState: parseIssueExecutionState(issue.executionState),
    executionWorkspaceId: issue.executionWorkspaceId,
    executionWorkspacePreference: issue.executionWorkspacePreference,
    executionWorkspaceSettings: issue.executionWorkspaceSettings,
    createdAt: issue.createdAt.toISOString(),
    updatedAt: issue.updatedAt.toISOString(),
  });
}

export function governedIssueReservedSnapshot(issue: typeof issues.$inferSelect): Record<string, unknown> {
  return canonicalJsonValue(governedIssueLifecycleIssueSnapshot(issue)) as Record<string, unknown>;
}

export function assertGovernedReservationIssueUnchanged(input: {
  issue: typeof issues.$inferSelect;
  reservedIssueSnapshot: Record<string, unknown>;
}): void {
  const currentSnapshot = governedIssueReservedSnapshot(input.issue);
  if (governedIssueSha256(currentSnapshot) === governedIssueSha256(input.reservedIssueSnapshot)) return;
  throw conflict("Governed issue reservation no longer matches the reserved issue", {
    code: "governed_issue_reservation_mutated",
    issueId: input.issue.id,
    repair: "Create a new reservation key for the revised issue envelope.",
  });
}

export async function assertIssueNotPendingGovernedReservation(
  dbOrTx: Db,
  issueId: string,
): Promise<void> {
  const reservation = await dbOrTx
    .select({ id: governedIssueReservations.id })
    .from(governedIssueReservations)
    .where(and(
      eq(governedIssueReservations.issueId, issueId),
      isNull(governedIssueReservations.activatedAt),
    ))
    .for("update")
    .then((rows) => rows[0] ?? null);
  if (!reservation) return;
  throw conflict("Governed issue reservation must be activated through its versioned activation endpoint", {
    code: "governed_issue_reservation_activation_required",
    issueId,
  });
}

function storedLifecycleSnapshot(value: unknown, field: string): GovernedIssueLifecycleIssueV1 {
  const parsed = governedIssueLifecycleIssueV1Schema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw conflict("Governed issue reservation receipt snapshot is invalid", {
    code: "governed_issue_reservation_snapshot_invalid",
    field,
  });
}

export function governedIssueReservationResponseIssue(
  reservation: typeof governedIssueReservations.$inferSelect,
): GovernedIssueLifecycleIssueV1 {
  return reservation.activatedAt
    ? storedLifecycleSnapshot(reservation.activatedIssueSnapshot, "activatedIssueSnapshot")
    : storedLifecycleSnapshot(reservation.reservedIssueSnapshot, "reservedIssueSnapshot");
}

export type GovernedIssueActivationInput = {
  companyId: string;
  idempotencyKey: string;
  expectedIssueId: string;
  expectedIssueUpdatedAt: string;
  expectedEnvelopeSha256: string;
  builderAgentId: string;
  envelope: GovernedIssueEnvelope;
  requestedByActorType: "user" | "agent" | "system";
  requestedByActorId: string | null;
};

export function governedIssueContractService(db: Db) {
  return {
    getReservation: async (companyId: string, idempotencyKey: string) => {
      return db
        .select()
        .from(governedIssueReservations)
        .where(and(
          eq(governedIssueReservations.companyId, companyId),
          eq(governedIssueReservations.idempotencyKey, idempotencyKey),
        ))
        .then((rows) => rows[0] ?? null);
    },

    activate: async (input: GovernedIssueActivationInput) => db.transaction(async (tx) => {
      const reservation = await tx
        .select()
        .from(governedIssueReservations)
        .where(and(
          eq(governedIssueReservations.companyId, input.companyId),
          eq(governedIssueReservations.idempotencyKey, input.idempotencyKey),
        ))
        .for("update")
        .then((rows) => rows[0] ?? null);
      if (!reservation) throw notFound("Governed issue reservation not found");

      const issue = await tx
        .select()
        .from(issues)
        .where(and(eq(issues.id, reservation.issueId), eq(issues.companyId, input.companyId)))
        .for("update")
        .then((rows) => rows[0] ?? null);
      if (!issue) {
        throw conflict("Governed issue reservation target no longer exists", {
          code: "governed_issue_reservation_target_missing",
          issueId: reservation.issueId,
        });
      }

      const envelopeSha256 = governedIssueEnvelopeSha256(input.envelope);
      if (input.expectedIssueId !== reservation.issueId) {
        throw preconditionFailed("Governed issue reservation targets a different issue", {
          code: "governed_issue_reservation_issue_mismatch",
          expectedIssueId: input.expectedIssueId,
          actualIssueId: reservation.issueId,
        });
      }
      if (
        input.expectedEnvelopeSha256 !== reservation.envelopeSha256
        || envelopeSha256 !== reservation.envelopeSha256
      ) {
        throw preconditionFailed("Governed issue envelope fingerprint does not match the reservation", {
          code: "governed_issue_reservation_envelope_mismatch",
          expectedEnvelopeSha256: input.expectedEnvelopeSha256,
          reservationEnvelopeSha256: reservation.envelopeSha256,
          requestEnvelopeSha256: envelopeSha256,
        });
      }

      const activationSha256 = governedIssueSha256({
        version: GOVERNED_ISSUE_LIFECYCLE_VERSION,
        issueId: reservation.issueId,
        envelopeSha256,
        builderAgentId: input.builderAgentId,
      });
      if (reservation.activatedAt) {
        if (reservation.activationSha256 !== activationSha256) {
          throw conflict("Governed issue reservation was already activated with different intent", {
            code: "governed_issue_activation_conflict",
            issueId: reservation.issueId,
            activatedBuilderAgentId: reservation.builderAgentId,
          });
        }
        const runStatus = reservation.heartbeatRunId
          ? await tx.select({ status: heartbeatRuns.status })
            .from(heartbeatRuns)
            .where(eq(heartbeatRuns.id, reservation.heartbeatRunId))
            .then((rows) => rows[0]?.status ?? null)
          : null;
        return {
          reservation,
          issue: governedIssueReservationResponseIssue(reservation),
          replayed: true as const,
          needsDispatch: runStatus === "queued",
        };
      }

      if (new Date(input.expectedIssueUpdatedAt).getTime() !== reservation.reservedIssueUpdatedAt.getTime()) {
        throw preconditionFailed("Governed issue reservation revision does not match", {
          code: "governed_issue_reservation_revision_mismatch",
          expectedIssueUpdatedAt: input.expectedIssueUpdatedAt,
          reservedIssueUpdatedAt: reservation.reservedIssueUpdatedAt.toISOString(),
        });
      }
      if (issue.updatedAt.getTime() !== reservation.reservedIssueUpdatedAt.getTime()) {
        throw preconditionFailed("Governed issue changed after reservation", {
          code: "governed_issue_activation_issue_changed",
          expectedIssueUpdatedAt: reservation.reservedIssueUpdatedAt.toISOString(),
          actualIssueUpdatedAt: issue.updatedAt.toISOString(),
        });
      }
      if (issue.status !== "backlog" || issue.assigneeAgentId || issue.assigneeUserId) {
        throw conflict("Governed issue must remain backlog and unassigned until activation", {
          code: "governed_issue_activation_state_conflict",
          status: issue.status,
          assigneeAgentId: issue.assigneeAgentId,
          assigneeUserId: issue.assigneeUserId,
        });
      }
      assertGovernedReservationIssueUnchanged({
        issue,
        reservedIssueSnapshot: reservation.reservedIssueSnapshot,
      });

      const policy = normalizeIssueExecutionPolicy(issue.executionPolicy ?? null);
      const state = parseIssueExecutionState(issue.executionState);
      await assertIssueExecutionPolicyParticipants(tx as unknown as Db, {
        companyId: input.companyId,
        reviewPolicy: issue.reviewPolicy,
        executionPolicy: policy,
        executionState: state,
        assigneeAgentId: input.builderAgentId,
        assigneeUserId: null,
        createdByAgentId: issue.createdByAgentId,
        createdByUserId: issue.createdByUserId,
      });

      const now = new Date();
      await tx.execute(sql`select set_config('paperclip.governed_activation_issue_id', ${issue.id}, true)`);
      const activatedIssue = await tx
        .update(issues)
        .set({ status: "todo", assigneeAgentId: input.builderAgentId, updatedAt: now })
        .where(and(
          eq(issues.id, issue.id),
          eq(issues.companyId, input.companyId),
          eq(issues.status, "backlog"),
        ))
        .returning()
        .then((rows) => rows[0] ?? null);
      if (!activatedIssue) {
        throw conflict("Governed issue activation lost its compare-and-set race", {
          code: "governed_issue_activation_cas_conflict",
          issueId: issue.id,
        });
      }
      const activatedIssueSnapshot = governedIssueLifecycleIssueSnapshot(activatedIssue);

      const wakeIdempotencyKey = `governed_issue_activation:v1:${reservation.id}`;
      const wakeupRequest = await tx
        .insert(agentWakeupRequests)
        .values({
          companyId: input.companyId,
          agentId: input.builderAgentId,
          source: "assignment",
          triggerDetail: "system",
          reason: "governed_issue_activated",
          payload: { issueId: issue.id, mutation: "governed_activation", taskKey: issue.identifier },
          status: "queued",
          requestedByActorType: input.requestedByActorType,
          requestedByActorId: input.requestedByActorId,
          idempotencyKey: wakeIdempotencyKey,
          requestedAt: now,
          createdAt: now,
          updatedAt: now,
        })
        .returning()
        .then((rows) => rows[0]);
      const heartbeatRun = await tx
        .insert(heartbeatRuns)
        .values({
          companyId: input.companyId,
          agentId: input.builderAgentId,
          invocationSource: "assignment",
          triggerDetail: "system",
          status: "queued",
          responsibleUserId: issue.responsibleUserId,
          wakeupRequestId: wakeupRequest.id,
          contextSnapshot: {
            issueId: issue.id,
            taskId: issue.id,
            taskKey: issue.identifier,
            source: "issue.governed_activation",
            wakeReason: "governed_issue_activated",
          },
          createdAt: now,
          updatedAt: now,
        })
        .returning()
        .then((rows) => rows[0]);
      await tx
        .update(agentWakeupRequests)
        .set({ runId: heartbeatRun.id, updatedAt: now })
        .where(eq(agentWakeupRequests.id, wakeupRequest.id));
      const activatedReservation = await tx
        .update(governedIssueReservations)
        .set({
          activationSha256,
          builderAgentId: input.builderAgentId,
          activatedAt: now,
          activatedIssueUpdatedAt: activatedIssue.updatedAt,
          activatedIssueSnapshot: activatedIssueSnapshot as unknown as Record<string, unknown>,
          wakeupRequestId: wakeupRequest.id,
          heartbeatRunId: heartbeatRun.id,
          updatedAt: now,
        })
        .where(eq(governedIssueReservations.id, reservation.id))
        .returning()
        .then((rows) => rows[0]);

      return {
        reservation: activatedReservation,
        issue: activatedIssueSnapshot,
        replayed: false as const,
        needsDispatch: true,
      };
    }),
  };
}

export function serializeGovernedIssueReservation(
  reservation: typeof governedIssueReservations.$inferSelect,
) {
  return {
    idempotencyKey: reservation.idempotencyKey,
    issueId: reservation.issueId,
    requestIntentSha256: reservation.requestIntentSha256,
    envelopeSha256: reservation.envelopeSha256,
    reservedIssueUpdatedAt: reservation.reservedIssueUpdatedAt.toISOString(),
    createdAt: reservation.createdAt.toISOString(),
  };
}

export function serializeGovernedIssueActivationReceipt(
  reservation: typeof governedIssueReservations.$inferSelect,
) {
  if (
    !reservation.activatedAt
    || !reservation.activatedIssueUpdatedAt
    || !reservation.activationSha256
    || !reservation.builderAgentId
    || !reservation.wakeupRequestId
    || !reservation.heartbeatRunId
  ) return null;
  return {
    version: GOVERNED_ISSUE_LIFECYCLE_VERSION,
    idempotencyKey: reservation.idempotencyKey,
    issueId: reservation.issueId,
    builderAgentId: reservation.builderAgentId,
    envelopeSha256: reservation.envelopeSha256,
    activationSha256: reservation.activationSha256,
    activatedAt: reservation.activatedAt.toISOString(),
    issueUpdatedAt: reservation.activatedIssueUpdatedAt.toISOString(),
    issueSnapshot: governedIssueReservationResponseIssue(reservation),
    wake: {
      durable: true as const,
      idempotencyKey: `governed_issue_activation:v1:${reservation.id}`,
      requestId: reservation.wakeupRequestId,
      runId: reservation.heartbeatRunId,
      status: "queued" as const,
    },
  };
}
