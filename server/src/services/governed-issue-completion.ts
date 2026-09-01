import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  executionWorkspaces,
  governedExecutorLaunchReceipts,
  governedIssueReservations,
  heartbeatRuns,
  issueWorkProducts,
  issues,
} from "@paperclipai/db";
import {
  governedIssueReservationDraftPullRequestReleaseReceiptV1Schema,
  governedIssueReservationTerminalObservationReceiptV1Schema,
  type GovernedIssueReservationDraftPullRequestReleaseReceiptV1,
  type GovernedIssueReservationTerminalObservationReceiptV1,
  type ObserveGovernedIssueReservationTerminalV1,
  type ReleaseGovernedIssueReservationWithDraftPullRequestV1,
} from "@paperclipai/shared";
import { conflict, notFound, preconditionFailed } from "../errors.js";
import { persistActivity } from "./activity-log.js";
import { assertWorkProductArtifactDirectorShipMutationAllowed } from "./artifact-director-ship-guards.js";
import {
  GOVERNED_ISSUE_EXECUTION_PROFILE_VERSION,
  governedIssueLifecycleIssueSnapshot,
  governedIssueSha256,
} from "./governed-issue-contract.js";

const TERMINAL_RUN_STATUSES = new Set([
  "succeeded",
  "interrupted",
  "failed",
  "cancelled",
  "timed_out",
]);

function storedTerminalObservation(
  reservation: typeof governedIssueReservations.$inferSelect,
): GovernedIssueReservationTerminalObservationReceiptV1 {
  const parsed = governedIssueReservationTerminalObservationReceiptV1Schema.safeParse(
    reservation.terminalObservationReceipt,
  );
  if (
    !parsed.success
    || !reservation.terminalObservedAt
    || !reservation.terminalObservationSha256
    || parsed.data.reservationId !== reservation.id
    || parsed.data.idempotencyKey !== reservation.idempotencyKey
    || parsed.data.issueId !== reservation.issueId
    || parsed.data.envelopeSha256 !== reservation.envelopeSha256
    || parsed.data.activation.activationSha256 !== reservation.activationSha256
    || parsed.data.activation.builderAgentId !== reservation.builderAgentId
    || parsed.data.activation.heartbeatRunId !== reservation.heartbeatRunId
    || parsed.data.launch.executionWorkspaceId !== reservation.executionWorkspaceId
    || parsed.data.terminalObservationSha256 !== reservation.terminalObservationSha256
    || parsed.data.observedAt !== reservation.terminalObservedAt.toISOString()
    || governedIssueSha256({
      ...parsed.data,
      terminalObservationSha256: undefined,
    }) !== reservation.terminalObservationSha256
  ) {
    throw conflict("Governed terminal observation receipt is invalid", {
      code: "governed_terminal_observation_receipt_invalid",
    });
  }
  return parsed.data;
}

function storedDraftPullRequestRelease(
  reservation: typeof governedIssueReservations.$inferSelect,
): GovernedIssueReservationDraftPullRequestReleaseReceiptV1 {
  const parsed = governedIssueReservationDraftPullRequestReleaseReceiptV1Schema.safeParse(
    reservation.releaseReceipt,
  );
  if (
    !parsed.success
    || !reservation.releasedAt
    || !reservation.releaseSha256
    || !reservation.completionWorkProductId
    || parsed.data.reservationId !== reservation.id
    || parsed.data.idempotencyKey !== reservation.idempotencyKey
    || parsed.data.issueId !== reservation.issueId
    || parsed.data.envelopeSha256 !== reservation.envelopeSha256
    || parsed.data.terminalObservationSha256 !== reservation.terminalObservationSha256
    || parsed.data.heartbeatRunId !== reservation.heartbeatRunId
    || parsed.data.builderAgentId !== reservation.builderAgentId
    || parsed.data.executionWorkspaceId !== reservation.executionWorkspaceId
    || parsed.data.workProduct.id !== reservation.completionWorkProductId
    || parsed.data.releaseSha256 !== reservation.releaseSha256
    || parsed.data.releasedAt !== reservation.releasedAt.toISOString()
    || governedIssueSha256({ ...parsed.data, releaseSha256: undefined }) !== reservation.releaseSha256
  ) {
    throw conflict("Governed draft pull request release receipt is invalid", {
      code: "governed_draft_pull_request_release_receipt_invalid",
    });
  }
  return parsed.data;
}

function assertRequestMatchesReservation(input: {
  reservation: typeof governedIssueReservations.$inferSelect;
  expectedIssueId: string;
  expectedEnvelopeSha256: string;
}): void {
  if (input.expectedIssueId !== input.reservation.issueId) {
    throw preconditionFailed("Governed completion targets a different issue", {
      code: "governed_completion_issue_mismatch",
      expectedIssueId: input.expectedIssueId,
      actualIssueId: input.reservation.issueId,
    });
  }
  if (input.expectedEnvelopeSha256 !== input.reservation.envelopeSha256) {
    throw preconditionFailed("Governed completion envelope changed", {
      code: "governed_completion_envelope_mismatch",
    });
  }
}

async function lockedReservation(
  db: Db,
  companyId: string,
  idempotencyKey: string,
) {
  const reservation = await db
    .select()
    .from(governedIssueReservations)
    .where(and(
      eq(governedIssueReservations.companyId, companyId),
      eq(governedIssueReservations.idempotencyKey, idempotencyKey),
    ))
    .for("update")
    .then((rows) => rows[0] ?? null);
  if (!reservation || reservation.contractVersion !== GOVERNED_ISSUE_EXECUTION_PROFILE_VERSION) {
    throw notFound("Governed issue reservation not found");
  }
  if (reservation.retiredAt) {
    throw conflict("Governed issue reservation is retired", {
      code: "governed_issue_reservation_retired",
    });
  }
  return reservation;
}

export function governedIssueCompletionService(db: Db) {
  return {
    observeTerminal: async (input: {
      companyId: string;
      idempotencyKey: string;
      request: ObserveGovernedIssueReservationTerminalV1;
      requestedByActorId: string;
    }) => db.transaction(async (tx) => {
      const reservation = await lockedReservation(
        tx as unknown as Db,
        input.companyId,
        input.idempotencyKey,
      );
      const intentSha256 = governedIssueSha256(input.request);
      if (reservation.terminalObservedAt) {
        if (reservation.terminalObservationIntentSha256 !== intentSha256) {
          throw conflict("Governed terminal run was already observed with different intent", {
            code: "governed_terminal_observation_conflict",
          });
        }
        return {
          reservation,
          receipt: storedTerminalObservation(reservation),
          replayed: true as const,
          activityPublication: null,
        };
      }
      if (reservation.releasedAt) {
        throw conflict("Governed issue reservation is already released", {
          code: "governed_issue_reservation_released",
        });
      }
      assertRequestMatchesReservation({ reservation, ...input.request });
      if (
        !reservation.activatedAt
        || !reservation.activationSha256
        || !reservation.builderAgentId
        || !reservation.heartbeatRunId
        || !reservation.executionWorkspaceId
      ) {
        throw conflict("Governed terminal observation requires an activated prepared-workspace run", {
          code: "governed_terminal_observation_activation_required",
        });
      }
      if (
        input.request.expectedActivationSha256 !== reservation.activationSha256
        || input.request.expectedBuilderAgentId !== reservation.builderAgentId
        || input.request.expectedHeartbeatRunId !== reservation.heartbeatRunId
        || input.request.expectedExecutionWorkspaceId !== reservation.executionWorkspaceId
      ) {
        throw preconditionFailed("Governed terminal observation activation binding changed", {
          code: "governed_terminal_observation_activation_mismatch",
        });
      }

      const launch = await tx.select().from(governedExecutorLaunchReceipts)
        .where(eq(governedExecutorLaunchReceipts.reservationId, reservation.id))
        .for("update")
        .then((rows) => rows[0] ?? null);
      if (!launch) {
        throw conflict("Governed terminal observation requires an immutable launch receipt", {
          code: "governed_terminal_observation_launch_receipt_required",
        });
      }
      if (
        launch.companyId !== input.companyId
        || launch.issueId !== reservation.issueId
        || launch.heartbeatRunId !== reservation.heartbeatRunId
        || launch.executionWorkspaceId !== reservation.executionWorkspaceId
        || launch.id !== input.request.expectedLaunchReceiptId
        || launch.instanceId !== input.request.expectedLaunchInstanceId
        || launch.pid !== input.request.expectedPid
        || launch.startToken !== input.request.expectedStartToken
        || launch.headSha !== input.request.expectedHeadSha
      ) {
        throw preconditionFailed("Governed terminal observation launch binding changed", {
          code: "governed_terminal_observation_launch_mismatch",
        });
      }

      const [run, workspace, issue] = await Promise.all([
        tx.select().from(heartbeatRuns)
          .where(and(
            eq(heartbeatRuns.id, reservation.heartbeatRunId),
            eq(heartbeatRuns.companyId, input.companyId),
          ))
          .for("update")
          .then((rows) => rows[0] ?? null),
        tx.select().from(executionWorkspaces)
          .where(and(
            eq(executionWorkspaces.id, reservation.executionWorkspaceId),
            eq(executionWorkspaces.companyId, input.companyId),
          ))
          .for("update")
          .then((rows) => rows[0] ?? null),
        tx.select().from(issues)
          .where(and(eq(issues.id, reservation.issueId), eq(issues.companyId, input.companyId)))
          .for("update")
          .then((rows) => rows[0] ?? null),
      ]);
      if (
        !run
        || run.agentId !== reservation.builderAgentId
        || run.processPid !== launch.pid
        || !TERMINAL_RUN_STATUSES.has(run.status)
        || !run.finishedAt
      ) {
        throw conflict("Governed activation run has no exact terminal process observation", {
          code: "governed_terminal_observation_run_not_terminal",
          runStatus: run?.status ?? null,
        });
      }
      if (
        !workspace
        || workspace.custodyKind !== "external_prepared"
        || workspace.sourceIssueId !== reservation.issueId
        || workspace.id !== launch.executionWorkspaceId
        || workspace.branchName !== launch.branchName
        || workspace.authorizedStartHeadSha !== launch.headSha
      ) {
        throw conflict("Governed terminal observation workspace binding changed", {
          code: "governed_terminal_observation_workspace_mismatch",
        });
      }
      if (!issue || issue.executionWorkspaceId !== workspace.id) {
        throw conflict("Governed terminal observation issue binding changed", {
          code: "governed_terminal_observation_issue_mismatch",
        });
      }

      const observedAt = new Date();
      const receiptWithoutSha = {
        version: 1 as const,
        reservationId: reservation.id,
        idempotencyKey: reservation.idempotencyKey,
        issueId: reservation.issueId,
        envelopeSha256: reservation.envelopeSha256,
        activation: {
          activationSha256: reservation.activationSha256,
          builderAgentId: reservation.builderAgentId,
          activatedAt: reservation.activatedAt.toISOString(),
          heartbeatRunId: reservation.heartbeatRunId,
        },
        launch: {
          receiptId: launch.id,
          instanceId: launch.instanceId,
          executionWorkspaceId: launch.executionWorkspaceId,
          branch: launch.branchName,
          headSha: launch.headSha,
          pid: launch.pid,
          startToken: launch.startToken,
        },
        terminalRun: {
          status: run.status as "succeeded" | "interrupted" | "failed" | "cancelled" | "timed_out",
          exitCode: run.exitCode,
          signal: run.signal,
          finishedAt: run.finishedAt.toISOString(),
        },
        issue: {
          status: issue.status as GovernedIssueReservationTerminalObservationReceiptV1["issue"]["status"],
          updatedAt: issue.updatedAt.toISOString(),
        },
        observedAt: observedAt.toISOString(),
      };
      const terminalObservationSha256 = governedIssueSha256(receiptWithoutSha);
      const receipt = governedIssueReservationTerminalObservationReceiptV1Schema.parse({
        ...receiptWithoutSha,
        terminalObservationSha256,
      });
      const observedReservation = await tx.update(governedIssueReservations)
        .set({
          terminalObservationIntentSha256: intentSha256,
          terminalObservationSha256,
          terminalObservationReceipt: receipt as unknown as Record<string, unknown>,
          terminalObservedAt: observedAt,
          updatedAt: observedAt,
        })
        .where(eq(governedIssueReservations.id, reservation.id))
        .returning()
        .then((rows) => rows[0]!);
      const { publication: activityPublication } = await persistActivity(tx as unknown as Db, {
        companyId: input.companyId,
        actorType: "user",
        actorId: input.requestedByActorId,
        action: "issue.governed_terminal_observed",
        entityType: "issue",
        entityId: reservation.issueId,
        issueId: reservation.issueId,
        details: {
          reservationId: reservation.id,
          heartbeatRunId: reservation.heartbeatRunId,
          executionWorkspaceId: reservation.executionWorkspaceId,
          terminalObservationSha256,
          runStatus: run.status,
          exitCode: run.exitCode,
        },
      });
      return { reservation: observedReservation, receipt, replayed: false as const, activityPublication };
    }),

    releaseWithDraftPullRequest: async (input: {
      companyId: string;
      idempotencyKey: string;
      request: ReleaseGovernedIssueReservationWithDraftPullRequestV1;
      requestedByActorId: string;
    }) => db.transaction(async (tx) => {
      const reservation = await lockedReservation(
        tx as unknown as Db,
        input.companyId,
        input.idempotencyKey,
      );
      const intentSha256 = governedIssueSha256(input.request);
      if (reservation.releasedAt) {
        if (reservation.releaseIntentSha256 !== intentSha256) {
          throw conflict("Governed reservation was already released with a different draft pull request", {
            code: "governed_draft_pull_request_release_conflict",
          });
        }
        return {
          reservation,
          receipt: storedDraftPullRequestRelease(reservation),
          replayed: true as const,
          activityPublication: null,
        };
      }
      assertRequestMatchesReservation({ reservation, ...input.request });
      if (
        !reservation.terminalObservedAt
        || !reservation.terminalObservationSha256
        || !reservation.heartbeatRunId
        || !reservation.builderAgentId
        || !reservation.executionWorkspaceId
      ) {
        throw conflict("Governed draft pull request release requires a durable terminal observation", {
          code: "governed_terminal_observation_required",
        });
      }
      const terminal = storedTerminalObservation(reservation);
      if (
        input.request.expectedTerminalObservationSha256 !== reservation.terminalObservationSha256
        || input.request.expectedHeartbeatRunId !== reservation.heartbeatRunId
        || input.request.expectedExecutionWorkspaceId !== reservation.executionWorkspaceId
        || input.request.expectedHeadSha !== input.request.pullRequest.headSha
      ) {
        throw preconditionFailed("Governed draft pull request release binding changed", {
          code: "governed_draft_pull_request_release_mismatch",
        });
      }
      if (
        terminal.terminalRun.status !== "succeeded"
        || terminal.terminalRun.exitCode !== 0
        || terminal.terminalRun.signal !== null
      ) {
        throw conflict("Only a successful governed executor may publish a draft pull request", {
          code: "governed_draft_pull_request_release_run_unsuccessful",
          runStatus: terminal.terminalRun.status,
          exitCode: terminal.terminalRun.exitCode,
        });
      }

      const [issue, workspace, run, launch] = await Promise.all([
        tx.select().from(issues)
          .where(and(eq(issues.id, reservation.issueId), eq(issues.companyId, input.companyId)))
          .for("update")
          .then((rows) => rows[0] ?? null),
        tx.select().from(executionWorkspaces)
          .where(and(
            eq(executionWorkspaces.id, reservation.executionWorkspaceId),
            eq(executionWorkspaces.companyId, input.companyId),
          ))
          .for("update")
          .then((rows) => rows[0] ?? null),
        tx.select().from(heartbeatRuns)
          .where(and(eq(heartbeatRuns.id, reservation.heartbeatRunId), eq(heartbeatRuns.companyId, input.companyId)))
          .for("update")
          .then((rows) => rows[0] ?? null),
        tx.select().from(governedExecutorLaunchReceipts)
          .where(eq(governedExecutorLaunchReceipts.reservationId, reservation.id))
          .for("update")
          .then((rows) => rows[0] ?? null),
      ]);
      if (
        !issue
        || issue.status !== "in_review"
        || issue.updatedAt.toISOString() !== input.request.expectedIssueUpdatedAt
        || issue.executionWorkspaceId !== reservation.executionWorkspaceId
      ) {
        throw preconditionFailed("Governed draft pull request release requires the exact in-review issue", {
          code: "governed_draft_pull_request_release_issue_mismatch",
          issueStatus: issue?.status ?? null,
          issueUpdatedAt: issue?.updatedAt.toISOString() ?? null,
        });
      }
      if (
        !workspace
        || workspace.custodyKind !== "external_prepared"
        || workspace.sourceIssueId !== issue.id
        || workspace.branchName !== input.request.pullRequest.headRef
      ) {
        throw preconditionFailed("Governed draft pull request release workspace binding changed", {
          code: "governed_draft_pull_request_release_workspace_mismatch",
        });
      }
      if (
        !run
        || run.agentId !== reservation.builderAgentId
        || run.status !== "succeeded"
        || run.exitCode !== 0
        || run.signal !== null
        || !run.finishedAt
      ) {
        throw conflict("Governed draft pull request release lost its successful run observation", {
          code: "governed_draft_pull_request_release_run_changed",
        });
      }
      if (
        !launch
        || launch.id !== terminal.launch.receiptId
        || launch.instanceId !== terminal.launch.instanceId
        || launch.heartbeatRunId !== run.id
        || launch.executionWorkspaceId !== workspace.id
        || launch.pid !== terminal.launch.pid
        || launch.startToken !== terminal.launch.startToken
      ) {
        throw conflict("Governed draft pull request release launch binding changed", {
          code: "governed_draft_pull_request_release_launch_mismatch",
        });
      }

      await assertWorkProductArtifactDirectorShipMutationAllowed(tx as unknown as Db, { issueId: issue.id });
      const now = new Date();
      await tx.update(issueWorkProducts)
        .set({ isPrimary: false, lastModifiedByRunId: run.id, updatedAt: now })
        .where(and(
          eq(issueWorkProducts.companyId, input.companyId),
          eq(issueWorkProducts.issueId, issue.id),
          eq(issueWorkProducts.type, "pull_request"),
        ));
      const externalId = `${input.request.pullRequest.owner}/${input.request.pullRequest.repository}#${input.request.pullRequest.pullRequestNumber}`;
      const workProduct = await tx.insert(issueWorkProducts).values({
        companyId: input.companyId,
        projectId: issue.projectId,
        issueId: issue.id,
        executionWorkspaceId: workspace.id,
        type: "pull_request",
        provider: "github",
        externalId,
        title: `${input.request.pullRequest.owner}/${input.request.pullRequest.repository} #${input.request.pullRequest.pullRequestNumber}`,
        url: input.request.pullRequest.url,
        status: "draft",
        reviewState: "needs_board_review",
        isPrimary: true,
        healthStatus: "unknown",
        summary: null,
        metadata: {
          providerReceiptVersion: 1,
          owner: input.request.pullRequest.owner,
          repository: input.request.pullRequest.repository,
          pullRequestNumber: input.request.pullRequest.pullRequestNumber,
          headSha: input.request.pullRequest.headSha,
          baseRef: input.request.pullRequest.baseRef,
          headRef: input.request.pullRequest.headRef,
          draft: true,
        },
        sourceTrust: null,
        createdByRunId: run.id,
        lastModifiedByRunId: run.id,
      }).returning().then((rows) => rows[0]!);

      const releasedIssue = await tx.update(issues).set({
        checkoutRunId: null,
        executionRunId: null,
        executionAgentNameKey: null,
        executionLockedAt: null,
        updatedAt: now,
      }).where(and(
        eq(issues.id, issue.id),
        eq(issues.companyId, input.companyId),
        eq(issues.updatedAt, issue.updatedAt),
      )).returning().then((rows) => rows[0] ?? null);
      if (!releasedIssue || releasedIssue.status !== "in_review") {
        throw conflict("Governed draft pull request release lost its issue compare-and-set race", {
          code: "governed_draft_pull_request_release_issue_cas_conflict",
        });
      }

      const receiptWithoutSha = {
        version: 1 as const,
        reservationId: reservation.id,
        idempotencyKey: reservation.idempotencyKey,
        issueId: reservation.issueId,
        envelopeSha256: reservation.envelopeSha256,
        terminalObservationSha256: reservation.terminalObservationSha256,
        heartbeatRunId: run.id,
        builderAgentId: reservation.builderAgentId,
        executionWorkspaceId: workspace.id,
        headSha: input.request.pullRequest.headSha,
        pullRequest: input.request.pullRequest,
        workProduct: {
          id: workProduct.id,
          type: "pull_request" as const,
          provider: "github" as const,
          externalId,
          title: workProduct.title,
          url: input.request.pullRequest.url,
          status: "draft" as const,
          reviewState: "needs_board_review" as const,
          isPrimary: true as const,
          createdByRunId: run.id,
        },
        releasedAt: now.toISOString(),
        issueUpdatedAt: releasedIssue.updatedAt.toISOString(),
        issueSnapshot: governedIssueLifecycleIssueSnapshot(releasedIssue),
      };
      const releaseSha256 = governedIssueSha256(receiptWithoutSha);
      const receipt = governedIssueReservationDraftPullRequestReleaseReceiptV1Schema.parse({
        ...receiptWithoutSha,
        releaseSha256,
      });
      const releasedReservation = await tx.update(governedIssueReservations).set({
        releaseIntentSha256: intentSha256,
        releaseSha256,
        releaseReceipt: receipt as unknown as Record<string, unknown>,
        completionWorkProductId: workProduct.id,
        releasedAt: now,
        updatedAt: now,
      }).where(eq(governedIssueReservations.id, reservation.id))
        .returning()
        .then((rows) => rows[0]!);
      const { publication: activityPublication } = await persistActivity(tx as unknown as Db, {
        companyId: input.companyId,
        actorType: "user",
        actorId: input.requestedByActorId,
        action: "issue.governed_draft_pull_request_released",
        entityType: "issue",
        entityId: issue.id,
        issueId: issue.id,
        details: {
          reservationId: reservation.id,
          heartbeatRunId: run.id,
          executionWorkspaceId: workspace.id,
          workProductId: workProduct.id,
          pullRequest: {
            provider: "github",
            owner: input.request.pullRequest.owner,
            repository: input.request.pullRequest.repository,
            number: input.request.pullRequest.pullRequestNumber,
            headSha: input.request.pullRequest.headSha,
            draft: true,
          },
          releaseSha256,
        },
      });
      return { reservation: releasedReservation, receipt, replayed: false as const, activityPublication };
    }),
  };
}

export function serializeGovernedTerminalObservationReceipt(
  reservation: typeof governedIssueReservations.$inferSelect,
): GovernedIssueReservationTerminalObservationReceiptV1 | null {
  return reservation.terminalObservedAt ? storedTerminalObservation(reservation) : null;
}

export function serializeGovernedDraftPullRequestReleaseReceipt(
  reservation: typeof governedIssueReservations.$inferSelect,
): GovernedIssueReservationDraftPullRequestReleaseReceiptV1 | null {
  return reservation.releasedAt ? storedDraftPullRequestRelease(reservation) : null;
}
