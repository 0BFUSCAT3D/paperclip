import { randomUUID } from "node:crypto";
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  executionWorkspaces,
  governedExecutorLaunchReceipts,
  governedIssueReservations,
  issues,
} from "@paperclipai/db";
import type { GovernedExecutorLaunchReceipt } from "@paperclipai/shared";
import { conflict } from "../errors.js";
import { validateStoredPreparedExecutionWorkspace } from "./prepared-execution-workspaces.js";
import {
  assertCapturedLocalProcessIdentityCurrent,
  captureLocalProcessStartIdentity,
  type CapturedLocalProcessStartIdentity,
} from "./process-start-identity.js";

export function captureGovernedExecutorProcessIdentityForSpawn(input: {
  requiresLaunchReceipt: boolean;
  pid: number;
  capture?: (pid: number) => CapturedLocalProcessStartIdentity;
}): CapturedLocalProcessStartIdentity | null {
  if (!input.requiresLaunchReceipt) return null;
  return (input.capture ?? captureLocalProcessStartIdentity)(input.pid);
}

export type GovernedExecutorLaunchReceiptRequirement = Readonly<{
  reservationId: string;
  executionWorkspaceId: string;
}>;

function serialize(row: typeof governedExecutorLaunchReceipts.$inferSelect): GovernedExecutorLaunchReceipt {
  return {
    version: 1,
    receipt: {
      connectionId: row.connectionId,
      lifecycleId: row.lifecycleId,
      taskId: row.taskId,
      pid: row.pid,
      startToken: row.startToken,
      instanceId: row.instanceId,
      receiptId: row.id,
    },
    workspace: {
      executionWorkspaceId: row.executionWorkspaceId,
      cwd: row.cwd,
      branch: row.branchName,
      headSha: row.headSha,
    },
  };
}

export function governedExecutorLaunchReceiptService(
  db: Db,
  options: {
    revalidateCapturedProcessIdentity?: (
      captured: CapturedLocalProcessStartIdentity,
    ) => void | Promise<void>;
    validatePreparedExecutionWorkspace?: typeof validateStoredPreparedExecutionWorkspace;
  } = {},
) {
  const revalidateCapturedProcessIdentity = options.revalidateCapturedProcessIdentity
    ?? assertCapturedLocalProcessIdentityCurrent;
  const validatePreparedExecutionWorkspace = options.validatePreparedExecutionWorkspace
    ?? validateStoredPreparedExecutionWorkspace;
  return {
    getForReservation: async (reservationId: string) => db
      .select()
      .from(governedExecutorLaunchReceipts)
      .where(eq(governedExecutorLaunchReceipts.reservationId, reservationId))
      .then((rows) => rows[0] ? serialize(rows[0]) : null),

    resolveRequirementForExecution: async (input: {
      companyId: string;
      runId: string;
      issueId: string | null;
      governedContractVersion: number;
      selectedCwd: string;
      workspace: {
        id: string;
        custodyKind: "paperclip" | "external_prepared";
      } | null;
    }): Promise<GovernedExecutorLaunchReceiptRequirement | null> => {
      if (input.workspace?.custodyKind !== "external_prepared") return null;
      if (input.governedContractVersion !== 2 || !input.issueId) {
        throw conflict("External prepared workspace execution requires a governed version 2 launch", {
          code: "external_prepared_workspace_governed_v2_required",
        });
      }
      const [reservation, workspace, issue] = await Promise.all([
        db.select().from(governedIssueReservations).where(and(
          eq(governedIssueReservations.companyId, input.companyId),
          eq(governedIssueReservations.heartbeatRunId, input.runId),
          eq(governedIssueReservations.contractVersion, 2),
          eq(governedIssueReservations.executionWorkspaceId, input.workspace.id),
          isNotNull(governedIssueReservations.activatedAt),
          isNull(governedIssueReservations.retiredAt),
          isNull(governedIssueReservations.releasedAt),
        )).then((rows) => rows[0] ?? null),
        db.select().from(executionWorkspaces).where(and(
          eq(executionWorkspaces.companyId, input.companyId),
          eq(executionWorkspaces.id, input.workspace.id),
        )).then((rows) => rows[0] ?? null),
        db.select().from(issues).where(and(
          eq(issues.companyId, input.companyId),
          eq(issues.id, input.issueId),
        )).then((rows) => rows[0] ?? null),
      ]);
      if (
        !reservation
        || !workspace
        || !issue
        || workspace.custodyKind !== "external_prepared"
        || workspace.status !== "active"
        || workspace.sourceIssueId !== issue.id
        || issue.executionWorkspaceId !== workspace.id
        || workspace.cwd !== input.selectedCwd
        || workspace.providerRef !== input.selectedCwd
      ) {
        throw conflict("Governed executor launch receipt binding changed before spawn", {
          code: "governed_executor_workspace_binding_drift",
        });
      }
      return Object.freeze({
        reservationId: reservation.id,
        executionWorkspaceId: workspace.id,
      });
    },

    persistForSpawn: async (input: {
      companyId: string;
      runId: string;
      executionWorkspaceId: string | null;
      expectedReservationId?: string;
      selectedCwd: string;
      capturedProcessIdentity: CapturedLocalProcessStartIdentity;
    }): Promise<GovernedExecutorLaunchReceipt | null> => db.transaction(async (tx) => {
      const reservation = await tx
        .select()
        .from(governedIssueReservations)
        .where(and(
          eq(governedIssueReservations.companyId, input.companyId),
          eq(governedIssueReservations.heartbeatRunId, input.runId),
        ))
        .for("update")
        .then((rows) => rows[0] ?? null);
      if (!reservation || reservation.contractVersion !== 2 || !reservation.executionWorkspaceId) {
        const selected = input.executionWorkspaceId
          ? await tx.select({ custodyKind: executionWorkspaces.custodyKind })
            .from(executionWorkspaces)
            .where(eq(executionWorkspaces.id, input.executionWorkspaceId))
            .then((rows) => rows[0] ?? null)
          : null;
        if (selected?.custodyKind === "external_prepared") {
          throw conflict("External prepared workspace execution requires an activated version 2 reservation", {
            code: "external_prepared_workspace_governed_v2_required",
          });
        }
        return null;
      }
      if (reservation.retiredAt) {
        throw conflict("Governed issue reservation is retired", {
          code: "governed_issue_reservation_retired",
        });
      }
      if (reservation.releasedAt) {
        throw conflict("Governed issue reservation is released", {
          code: "governed_issue_reservation_released",
        });
      }
      if (input.expectedReservationId && reservation.id !== input.expectedReservationId) {
        throw conflict("Governed executor launch reservation changed before spawn", {
          code: "governed_executor_workspace_binding_drift",
        });
      }
      if (!reservation.activatedAt || reservation.heartbeatRunId !== input.runId) {
        throw conflict("Governed executor launch is not bound to an activated reservation", {
          code: "governed_executor_launch_not_activated",
        });
      }
      if (input.executionWorkspaceId !== reservation.executionWorkspaceId) {
        throw conflict("Executor selected a different workspace than the governed reservation", {
          code: "governed_executor_workspace_selection_mismatch",
        });
      }
      const workspace = await tx.select().from(executionWorkspaces)
        .where(eq(executionWorkspaces.id, reservation.executionWorkspaceId))
        .for("update")
        .then((rows) => rows[0] ?? null);
      const issue = await tx.select().from(issues)
        .where(and(eq(issues.id, reservation.issueId), eq(issues.companyId, input.companyId)))
        .then((rows) => rows[0] ?? null);
      if (
        !workspace
        || !issue
        || workspace.custodyKind !== "external_prepared"
        || workspace.status !== "active"
        || workspace.sourceIssueId !== issue.id
        || issue.executionWorkspaceId !== workspace.id
        || workspace.cwd !== input.selectedCwd
        || workspace.providerRef !== input.selectedCwd
      ) {
        throw conflict("Governed executor workspace binding changed before spawn", {
          code: "governed_executor_workspace_binding_drift",
        });
      }
      const { pid, startToken } = input.capturedProcessIdentity;
      const existing = await tx
        .select()
        .from(governedExecutorLaunchReceipts)
        .where(eq(governedExecutorLaunchReceipts.reservationId, reservation.id))
        .then((rows) => rows[0] ?? null);
      if (existing) {
        if (
          existing.heartbeatRunId !== input.runId
          || existing.executionWorkspaceId !== workspace.id
          || existing.cwd !== workspace.cwd
          || existing.branchName !== workspace.branchName
          || existing.headSha !== workspace.authorizedStartHeadSha
          || existing.pid !== pid
          || existing.startToken !== startToken
        ) {
          throw conflict("Governed executor launch receipt is already bound to a different process", {
            code: "governed_executor_launch_receipt_conflict",
          });
        }
        // An idempotent replay is also launch authority: the adapter releases
        // its prompt only after this return. Re-prove the exact child as the
        // final operation before releasing that authority.
        await revalidateCapturedProcessIdentity(input.capturedProcessIdentity);
        return serialize(existing);
      }
      const validated = await validatePreparedExecutionWorkspace({
        db: tx as unknown as Db,
        companyId: input.companyId,
        workspace,
      });
      // Repository validation may be slow. A child that exited or whose PID
      // was reused during that work must never receive the prompt, so observe
      // the captured birth identity again immediately before the receipt write.
      await revalidateCapturedProcessIdentity(input.capturedProcessIdentity);
      const row = await tx
        .insert(governedExecutorLaunchReceipts)
        .values({
          companyId: input.companyId,
          reservationId: reservation.id,
          issueId: issue.id,
          heartbeatRunId: input.runId,
          executionWorkspaceId: workspace.id,
          connectionId: workspace.externalConnectionId!,
          lifecycleId: workspace.externalLifecycleId!,
          taskId: workspace.externalTaskId!,
          cwd: validated.path,
          branchName: validated.branchName,
          headSha: validated.headSha,
          pid,
          startToken,
          instanceId: randomUUID(),
        })
        .returning()
        .then((rows) => rows[0]!);
      return serialize(row);
    }),
  };
}
