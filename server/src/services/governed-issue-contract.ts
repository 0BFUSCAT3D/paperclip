import { createHash } from "node:crypto";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agentWakeupRequests,
  agents,
  governedIssueReservations,
  executionWorkspaces,
  heartbeatRunExecutionProfiles,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  governedIssueLifecycleIssueV1Schema,
  type GovernedIssueEnvelope,
  type GovernedExecutionProfileIntentV2,
  type GovernedIssueLifecycleIssueV1,
  type RetireGovernedIssueReservationV1,
} from "@paperclipai/shared";
import { conflict, notFound, preconditionFailed } from "../errors.js";
import { assertIssueExecutionPolicyParticipants } from "./issue-execution-policy-participants.js";
import { normalizeIssueExecutionPolicy, parseIssueExecutionState } from "./issue-execution-policy.js";
import {
  EXECUTION_PROFILE_BINDING_VERSION,
  executionProfileSha256,
  inspectedExecutionProfileBindingMatchesScope,
  type InspectedExecutionProfileBinding,
} from "./execution-profile-binding.js";
import { persistActivity } from "./activity-log.js";

export const GOVERNED_ISSUE_LIFECYCLE_VERSION = 1 as const;
export const GOVERNED_ISSUE_EXECUTION_PROFILE_VERSION = 2 as const;
export const GOVERNED_ISSUE_RETIREMENT_VERSION = 1 as const;

const ACTIVE_GOVERNED_RUN_STATUSES = ["queued", "scheduled_retry", "running"] as const;
const TERMINAL_GOVERNED_RUN_STATUSES = new Set([
  "succeeded",
  "interrupted",
  "failed",
  "cancelled",
  "timed_out",
]);

export type GovernedIssueRetirementReceiptV1 = Readonly<{
  version: typeof GOVERNED_ISSUE_RETIREMENT_VERSION;
  idempotencyKey: string;
  issueId: string;
  envelopeSha256: string;
  priorState: "reserved" | "activated";
  heartbeatRunId: string | null;
  reason: string;
  retirementSha256: string;
  retiredAt: string;
  issueUpdatedAt: string;
  issueSnapshot: GovernedIssueLifecycleIssueV1;
}>;

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
      isNull(governedIssueReservations.retiredAt),
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
  if (reservation.retiredAt) {
    return storedGovernedIssueRetirementReceipt(reservation).issueSnapshot;
  }
  return reservation.activatedAt
    ? storedLifecycleSnapshot(reservation.activatedIssueSnapshot, "activatedIssueSnapshot")
    : storedLifecycleSnapshot(reservation.reservedIssueSnapshot, "reservedIssueSnapshot");
}

function storedGovernedIssueRetirementReceipt(
  reservation: typeof governedIssueReservations.$inferSelect,
): GovernedIssueRetirementReceiptV1 {
  const value = reservation.retirementReceipt;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw conflict("Governed issue retirement receipt is invalid", {
      code: "governed_issue_retirement_receipt_invalid",
    });
  }
  const receipt = value as Record<string, unknown>;
  const issueSnapshot = governedIssueLifecycleIssueV1Schema.safeParse(receipt.issueSnapshot);
  const priorState = reservation.activatedAt ? "activated" as const : "reserved" as const;
  const expectedHeartbeatRunId = priorState === "activated" ? reservation.heartbeatRunId : null;
  const heartbeatBindingIsValid = priorState === "activated"
    ? expectedHeartbeatRunId !== null && receipt.heartbeatRunId === expectedHeartbeatRunId
    : reservation.heartbeatRunId === null && receipt.heartbeatRunId === null;
  const reasonIsCanonical = typeof receipt.reason === "string"
    && receipt.reason.length >= 1
    && receipt.reason.length <= 1_000
    && receipt.reason.trim() === receipt.reason;
  const recomputedRetirementSha256 = typeof receipt.reason === "string"
    && (receipt.priorState === "reserved" || receipt.priorState === "activated")
    && (receipt.heartbeatRunId === null || typeof receipt.heartbeatRunId === "string")
    ? governedIssueRetirementIntentSha256({
        version: GOVERNED_ISSUE_RETIREMENT_VERSION,
        idempotencyKey: reservation.idempotencyKey,
        issueId: reservation.issueId,
        envelopeSha256: reservation.envelopeSha256,
        priorState: receipt.priorState,
        heartbeatRunId: receipt.heartbeatRunId,
        reason: receipt.reason,
      })
    : null;
  const exact = Object.keys(receipt).length === 11
    && receipt.version === GOVERNED_ISSUE_RETIREMENT_VERSION
    && receipt.idempotencyKey === reservation.idempotencyKey
    && receipt.issueId === reservation.issueId
    && receipt.envelopeSha256 === reservation.envelopeSha256
    && receipt.priorState === priorState
    && heartbeatBindingIsValid
    && reasonIsCanonical
    && receipt.retirementSha256 === reservation.retirementSha256
    && receipt.retirementSha256 === recomputedRetirementSha256
    && typeof receipt.retiredAt === "string"
    && receipt.retiredAt === reservation.retiredAt?.toISOString()
    && typeof receipt.issueUpdatedAt === "string"
    && issueSnapshot.success
    && issueSnapshot.data.id === reservation.issueId
    && issueSnapshot.data.companyId === reservation.companyId
    && receipt.issueUpdatedAt === issueSnapshot.data.updatedAt;
  if (!exact) {
    throw conflict("Governed issue retirement receipt is invalid", {
      code: "governed_issue_retirement_receipt_invalid",
    });
  }
  return {
    version: GOVERNED_ISSUE_RETIREMENT_VERSION,
    idempotencyKey: receipt.idempotencyKey as string,
    issueId: receipt.issueId as string,
    envelopeSha256: receipt.envelopeSha256 as string,
    priorState: receipt.priorState as "reserved" | "activated",
    heartbeatRunId: receipt.heartbeatRunId as string | null,
    reason: receipt.reason as string,
    retirementSha256: receipt.retirementSha256 as string,
    retiredAt: receipt.retiredAt as string,
    issueUpdatedAt: receipt.issueUpdatedAt as string,
    issueSnapshot: issueSnapshot.data,
  };
}

function governedIssueRetirementIntentSha256(input: {
  version: typeof GOVERNED_ISSUE_RETIREMENT_VERSION;
  idempotencyKey: string;
  issueId: string;
  envelopeSha256: string;
  priorState: "reserved" | "activated";
  heartbeatRunId: string | null;
  reason: string;
}): string {
  return governedIssueSha256(input);
}

function governedIssueRetirementSha256(input: {
  reservation: typeof governedIssueReservations.$inferSelect;
  request: RetireGovernedIssueReservationV1;
}): string {
  return governedIssueRetirementIntentSha256({
    version: input.request.version,
    idempotencyKey: input.reservation.idempotencyKey,
    issueId: input.request.expectedIssueId,
    envelopeSha256: input.request.expectedEnvelopeSha256,
    priorState: input.request.expectedState,
    heartbeatRunId: input.request.expectedHeartbeatRunId,
    reason: input.request.reason,
  });
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
} & (
  | { version?: 1; executionProfiles?: never; expectedExecutionProfileIntentSha256?: never; inspectExecutionProfile?: never }
  | {
      version: 2;
      executionProfiles: GovernedExecutionProfileIntentV2;
      expectedExecutionProfileIntentSha256: string;
      inspectExecutionProfile: (input: {
        db: Db;
        agentExecutionProfileRevision: number;
        issueAssigneeProfileRevision: number;
      }) => Promise<InspectedExecutionProfileBinding>;
      inspectPreparedExecutionWorkspace?: (input: {
        db: Db;
        workspace: typeof executionWorkspaces.$inferSelect;
      }) => Promise<void>;
    }
);

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

    retire: async (input: {
      companyId: string;
      idempotencyKey: string;
      request: RetireGovernedIssueReservationV1;
      requestedByActorId: string;
    }) => db.transaction(async (tx) => {
      const reservation = await tx
        .select()
        .from(governedIssueReservations)
        .where(and(
          eq(governedIssueReservations.companyId, input.companyId),
          eq(governedIssueReservations.idempotencyKey, input.idempotencyKey),
        ))
        .for("update")
        .then((rows) => rows[0] ?? null);
      if (!reservation || reservation.contractVersion !== GOVERNED_ISSUE_EXECUTION_PROFILE_VERSION) {
        throw notFound("Governed issue reservation not found");
      }

      const retirementSha256 = governedIssueRetirementSha256({
        reservation,
        request: input.request,
      });
      if (reservation.retiredAt) {
        if (reservation.retirementSha256 !== retirementSha256) {
          throw conflict("Governed issue reservation was already retired with different intent", {
            code: "governed_issue_retirement_conflict",
          });
        }
        return {
          reservation,
          receipt: storedGovernedIssueRetirementReceipt(reservation),
          replayed: true as const,
          activityPublication: null,
        };
      }

      if (input.request.expectedIssueId !== reservation.issueId) {
        throw preconditionFailed("Governed issue retirement targets a different issue", {
          code: "governed_issue_retirement_issue_mismatch",
          expectedIssueId: input.request.expectedIssueId,
          actualIssueId: reservation.issueId,
        });
      }
      if (input.request.expectedEnvelopeSha256 !== reservation.envelopeSha256) {
        throw preconditionFailed("Governed issue retirement envelope does not match", {
          code: "governed_issue_retirement_envelope_mismatch",
        });
      }

      const priorState = reservation.activatedAt ? "activated" as const : "reserved" as const;
      if (input.request.expectedState !== priorState) {
        throw preconditionFailed("Governed issue retirement state changed", {
          code: "governed_issue_retirement_state_mismatch",
          expectedState: input.request.expectedState,
          actualState: priorState,
        });
      }
      if (
        priorState === "reserved"
        && (input.request.expectedHeartbeatRunId !== null || reservation.heartbeatRunId !== null)
      ) {
        throw preconditionFailed("A reserved governed issue has no heartbeat run", {
          code: "governed_issue_retirement_run_mismatch",
          actualHeartbeatRunId: reservation.heartbeatRunId,
        });
      }
      if (
        priorState === "activated"
        && (
          !reservation.heartbeatRunId
          || input.request.expectedHeartbeatRunId !== reservation.heartbeatRunId
        )
      ) {
        throw preconditionFailed("Governed issue retirement run does not match activation", {
          code: "governed_issue_retirement_run_mismatch",
          expectedHeartbeatRunId: input.request.expectedHeartbeatRunId,
          actualHeartbeatRunId: reservation.heartbeatRunId,
        });
      }

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

      if (priorState === "reserved") {
        if (issue.status !== "backlog" || issue.assigneeAgentId || issue.assigneeUserId) {
          throw conflict("Reserved governed issue must remain backlog and unassigned before retirement", {
            code: "governed_issue_retirement_state_conflict",
          });
        }
        assertGovernedReservationIssueUnchanged({
          issue,
          reservedIssueSnapshot: reservation.reservedIssueSnapshot,
        });
      } else {
        const activeRuns = await tx
          .select({ id: heartbeatRuns.id, status: heartbeatRuns.status })
          .from(heartbeatRuns)
          .where(and(
            eq(heartbeatRuns.companyId, input.companyId),
            inArray(heartbeatRuns.status, [...ACTIVE_GOVERNED_RUN_STATUSES]),
            sql`(
              ${heartbeatRuns.id} = ${reservation.heartbeatRunId}
              OR ${heartbeatRuns.id} = ${issue.executionRunId}
              OR ${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issue.id}
              OR ${heartbeatRuns.contextSnapshot} ->> 'taskId' = ${issue.id}
            )`,
          ))
          .orderBy(asc(heartbeatRuns.id))
          .for("update");
        if (activeRuns.length > 0) {
          throw conflict("Governed issue reservation still has an active execution or review run", {
            code: "governed_issue_retirement_run_active",
            runIds: activeRuns.map((run) => run.id),
          });
        }
        const activationRun = await tx
          .select({ status: heartbeatRuns.status })
          .from(heartbeatRuns)
          .where(and(
            eq(heartbeatRuns.id, reservation.heartbeatRunId!),
            eq(heartbeatRuns.companyId, input.companyId),
          ))
          .for("update")
          .then((rows) => rows[0] ?? null);
        if (!activationRun || !TERMINAL_GOVERNED_RUN_STATUSES.has(activationRun.status)) {
          throw conflict("Governed issue activation run has no exact terminal observation", {
            code: "governed_issue_retirement_terminal_run_required",
            runStatus: activationRun?.status ?? null,
          });
        }
      }

      const now = new Date();
      let retiredIssue = issue;
      if (issue.status !== "done" && issue.status !== "cancelled") {
        await tx.execute(sql`select set_config('paperclip.governed_activation_issue_id', ${issue.id}, true)`);
        const cancelledIssue = await tx
          .update(issues)
          .set({
            status: "cancelled",
            completedAt: null,
            cancelledAt: now,
            checkoutRunId: null,
            executionRunId: null,
            executionAgentNameKey: null,
            executionLockedAt: null,
            updatedAt: now,
          })
          .where(and(eq(issues.id, issue.id), eq(issues.companyId, input.companyId)))
          .returning()
          .then((rows) => rows[0] ?? null);
        if (!cancelledIssue) {
          throw conflict("Governed issue retirement lost its issue compare-and-set race", {
            code: "governed_issue_retirement_issue_cas_conflict",
          });
        }
        retiredIssue = cancelledIssue;
      }
      const issueSnapshot = governedIssueLifecycleIssueSnapshot(retiredIssue);
      const receipt: GovernedIssueRetirementReceiptV1 = {
        version: GOVERNED_ISSUE_RETIREMENT_VERSION,
        idempotencyKey: reservation.idempotencyKey,
        issueId: reservation.issueId,
        envelopeSha256: reservation.envelopeSha256,
        priorState,
        heartbeatRunId: reservation.heartbeatRunId,
        reason: input.request.reason,
        retirementSha256,
        retiredAt: now.toISOString(),
        issueUpdatedAt: retiredIssue.updatedAt.toISOString(),
        issueSnapshot,
      };
      const retiredReservation = await tx
        .update(governedIssueReservations)
        .set({
          retirementSha256,
          retirementReceipt: receipt as unknown as Record<string, unknown>,
          retiredAt: now,
          updatedAt: now,
        })
        .where(and(
          eq(governedIssueReservations.id, reservation.id),
          isNull(governedIssueReservations.retiredAt),
        ))
        .returning()
        .then((rows) => rows[0] ?? null);
      if (!retiredReservation) {
        throw conflict("Governed issue retirement lost its compare-and-set race", {
          code: "governed_issue_retirement_cas_conflict",
        });
      }
      const { publication: activityPublication } = await persistActivity(tx as unknown as Db, {
        companyId: input.companyId,
        actorType: "user",
        actorId: input.requestedByActorId,
        action: "issue.governed_reservation_retired",
        entityType: "issue",
        entityId: retiredReservation.issueId,
        issueId: retiredReservation.issueId,
        details: {
          idempotencyKey: retiredReservation.idempotencyKey,
          envelopeSha256: retiredReservation.envelopeSha256,
          priorState: receipt.priorState,
          heartbeatRunId: receipt.heartbeatRunId,
          retirementSha256: receipt.retirementSha256,
          reason: receipt.reason,
        },
      });
      return {
        reservation: retiredReservation,
        receipt,
        replayed: false as const,
        activityPublication,
      };
    }),

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
      const contractVersion = input.version ?? 1;
      if (reservation.contractVersion !== contractVersion) {
        throw conflict("Governed issue reservation uses a different contract version", {
          code: "governed_issue_contract_version_mismatch",
          reservationVersion: reservation.contractVersion,
          requestVersion: contractVersion,
        });
      }
      if (reservation.retiredAt) {
        throw conflict("Governed issue reservation is retired", {
          code: "governed_issue_reservation_retired",
        });
      }

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

      let executionProfileIntentSha256: string | null = null;
      if (input.version === 2) {
        executionProfileIntentSha256 = governedIssueSha256(input.executionProfiles);
        if (
          input.expectedExecutionProfileIntentSha256 !== reservation.executionProfileIntentSha256
          || executionProfileIntentSha256 !== reservation.executionProfileIntentSha256
          || governedIssueSha256(input.executionProfiles) !== governedIssueSha256(reservation.executionProfileIntent)
        ) {
          throw preconditionFailed("Governed execution profile intent does not match the reservation", {
            code: "governed_execution_profile_intent_mismatch",
          });
        }
      }

      const activationSha256For = (executionProfile: {
        digest: unknown;
        authorityFingerprint: unknown;
        authorityProofSha256: unknown;
      } | null) => governedIssueSha256({
        version: contractVersion,
        issueId: reservation.issueId,
        envelopeSha256,
        builderAgentId: input.builderAgentId,
        ...(input.version === 2
          ? {
              executionProfileIntentSha256,
              executionProfileDigest: executionProfile?.digest,
              executionProfileAuthorityFingerprint: executionProfile?.authorityFingerprint,
              authorityProofSha256: executionProfile?.authorityProofSha256,
            }
          : {}),
      });
      if (reservation.activatedAt) {
        const storedExecutionProfile = input.version === 2
          ? reservation.executionProfileReceipt as Record<string, unknown> | null
          : null;
        const activationSha256 = activationSha256For(storedExecutionProfile
          ? {
              digest: storedExecutionProfile.digest,
              authorityFingerprint: storedExecutionProfile.authorityFingerprint,
              authorityProofSha256: storedExecutionProfile.authorityProofSha256,
            }
          : null);
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

      let builderExecutionProfileRevision: number | null = null;
      if (input.version === 2) {
        const participantIds = input.executionProfiles.participants.map((participant) => participant.agentId);
        const participantRows = await tx
          .select({ id: agents.id, executionProfileRevision: agents.executionProfileRevision })
          .from(agents)
          .where(and(
            eq(agents.companyId, input.companyId),
            inArray(agents.id, participantIds),
          ))
          .orderBy(asc(agents.id))
          .for("update");
        const revisions = new Map(participantRows.map((participant) => [
          participant.id,
          participant.executionProfileRevision,
        ]));
        for (const participant of input.executionProfiles.participants) {
          if (revisions.get(participant.agentId) !== participant.executionProfileRevision) {
            throw preconditionFailed("Governed execution participant profile revision changed", {
              code: "governed_execution_profile_revision_mismatch",
              agentId: participant.agentId,
            });
          }
        }
        builderExecutionProfileRevision = revisions.get(input.builderAgentId) ?? null;
        if (
          input.executionProfiles.builderAgentId !== input.builderAgentId
          || builderExecutionProfileRevision === null
        ) {
          throw preconditionFailed("Governed execution builder does not match the reserved profile intent", {
            code: "governed_execution_profile_builder_mismatch",
          });
        }
      }

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

      if (input.version === 2 && reservation.executionWorkspaceId) {
        const preparedWorkspace = await tx
          .select()
          .from(executionWorkspaces)
          .where(eq(executionWorkspaces.id, reservation.executionWorkspaceId))
          .for("update")
          .then((rows) => rows[0] ?? null);
        if (
          !preparedWorkspace
          || preparedWorkspace.companyId !== input.companyId
          || preparedWorkspace.custodyKind !== "external_prepared"
          || preparedWorkspace.status !== "active"
          || preparedWorkspace.sourceIssueId !== issue.id
          || issue.executionWorkspaceId !== preparedWorkspace.id
          || issue.projectId !== preparedWorkspace.projectId
          || issue.projectWorkspaceId !== preparedWorkspace.projectWorkspaceId
        ) {
          throw preconditionFailed("Governed prepared workspace binding changed after reservation", {
            code: "governed_prepared_workspace_binding_drift",
          });
        }
        if (!input.inspectPreparedExecutionWorkspace) {
          throw conflict("Prepared workspace activation validator is unavailable", {
            code: "governed_prepared_workspace_validator_unavailable",
          });
        }
        await input.inspectPreparedExecutionWorkspace({
          db: tx as unknown as Db,
          workspace: preparedWorkspace,
        });
      }

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
      const inspectedExecutionProfile = input.version === 2
        ? await input.inspectExecutionProfile({
            db: tx as unknown as Db,
            agentExecutionProfileRevision: builderExecutionProfileRevision!,
            issueAssigneeProfileRevision: activatedIssue.assigneeProfileRevision,
          })
        : null;
      if (input.version === 2 && !inspectedExecutionProfileBindingMatchesScope(
        inspectedExecutionProfile,
        {
          companyId: input.companyId,
          agentId: input.builderAgentId,
          issueId: activatedIssue.id,
          agentExecutionProfileRevision: builderExecutionProfileRevision!,
          issueAssigneeProfileRevision: activatedIssue.assigneeProfileRevision,
        },
      )) {
        const invalidPrepared = (inspectedExecutionProfile as unknown as {
          prepared?: { dispose(): Promise<void> } | null;
        } | null)?.prepared;
        await invalidPrepared?.dispose().catch(() => undefined);
        throw preconditionFailed("Governed execution profile evidence no longer matches activation", {
          code: "governed_execution_profile_activation_drift",
        });
      }
      const wakeIdempotencyKey = `governed_issue_activation:v${contractVersion}:${reservation.id}`;
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
            ...(contractVersion === 2 ? { governedContractVersion: 2 } : {}),
          },
          createdAt: now,
          updatedAt: now,
        })
        .returning()
        .then((rows) => rows[0]);
      const executionProfile = input.version === 2
        ? await tx
          .insert(heartbeatRunExecutionProfiles)
          .values({
            companyId: input.companyId,
            runId: heartbeatRun.id,
            agentId: input.builderAgentId,
            issueId: issue.id,
            bindingVersion: EXECUTION_PROFILE_BINDING_VERSION,
            agentExecutionProfileRevision:
              inspectedExecutionProfile!.projection.agentExecutionProfileRevision,
            issueAssigneeProfileRevision: activatedIssue.assigneeProfileRevision,
            digest: inspectedExecutionProfile!.digest,
            projection: inspectedExecutionProfile!.projection as unknown as Record<string, unknown>,
            authorityIdentity: {
              profile: inspectedExecutionProfile!.authorityProof,
            },
            authorityFingerprint: "pending-database-canonicalization",
            transitionKind: "fresh",
            transitionReason: "governed_activation",
            createdAt: now,
            updatedAt: now,
          })
          .returning()
          .then((rows) => rows[0])
        : null;
      const activationSha256 = activationSha256For(executionProfile
        ? {
            digest: executionProfile.digest,
            authorityFingerprint: executionProfile.authorityFingerprint,
            authorityProofSha256: executionProfileSha256(inspectedExecutionProfile!.authorityProof),
          }
        : null);
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
          ...(executionProfile
            ? {
                executionProfileReceipt: {
                  version: GOVERNED_ISSUE_EXECUTION_PROFILE_VERSION,
                  bindingVersion: executionProfile.bindingVersion,
                  profileId: executionProfile.id,
                  runId: heartbeatRun.id,
                  companyId: input.companyId,
                  issueId: issue.id,
                  agentId: input.builderAgentId,
                  agentExecutionProfileRevision: executionProfile.agentExecutionProfileRevision,
                  issueAssigneeProfileRevision: executionProfile.issueAssigneeProfileRevision,
                  digest: executionProfile.digest,
                  authorityFingerprint: executionProfile.authorityFingerprint,
                  authorityProofSha256: executionProfileSha256(
                    inspectedExecutionProfile!.authorityProof,
                  ),
                  projection: inspectedExecutionProfile!.projection,
                  authority: inspectedExecutionProfile!.authorityProof,
                },
              }
            : {}),
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
    ...(reservation.contractVersion === 2
      ? {
          executionProfileIntentSha256: reservation.executionProfileIntentSha256,
          executionProfiles: reservation.executionProfileIntent,
        }
      : {}),
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
    version: reservation.contractVersion,
    idempotencyKey: reservation.idempotencyKey,
    issueId: reservation.issueId,
    builderAgentId: reservation.builderAgentId,
    envelopeSha256: reservation.envelopeSha256,
    activationSha256: reservation.activationSha256,
    activatedAt: reservation.activatedAt.toISOString(),
    issueUpdatedAt: reservation.activatedIssueUpdatedAt.toISOString(),
    issueSnapshot: storedLifecycleSnapshot(
      reservation.activatedIssueSnapshot,
      "activatedIssueSnapshot",
    ),
    wake: {
      durable: true as const,
      idempotencyKey: `governed_issue_activation:v${reservation.contractVersion}:${reservation.id}`,
      requestId: reservation.wakeupRequestId,
      runId: reservation.heartbeatRunId,
      status: "queued" as const,
    },
    ...(reservation.contractVersion === 2
      ? { executionProfile: reservation.executionProfileReceipt }
      : {}),
  };
}

export function serializeGovernedIssueRetirementReceipt(
  reservation: typeof governedIssueReservations.$inferSelect,
): GovernedIssueRetirementReceiptV1 | null {
  return reservation.retiredAt ? storedGovernedIssueRetirementReceipt(reservation) : null;
}

export function governedIssueReservationState(
  reservation: typeof governedIssueReservations.$inferSelect,
): "reserved" | "activated" | "retired" {
  if (reservation.retiredAt) return "retired";
  return reservation.activatedAt ? "activated" : "reserved";
}
