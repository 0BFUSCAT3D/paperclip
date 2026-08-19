import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNotNull, lte, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  companyMemberships,
  agents,
  authUsers,
  executionWorkspaces,
  heartbeatRuns,
  issueExecutionDecisions,
  issueArtifactDirectorShipments,
  issueWorkProducts,
  issues,
  projectWorkspaces,
} from "@paperclipai/db";
import {
  artifactDirectorShipCandidateV1Schema,
  confirmArtifactDirectorShipV1Schema,
  governedIssueLifecycleIssueV1Schema,
  type ArtifactDirectorShipOperationV1,
  type ArtifactDirectorShipReceiptV1,
  type ArtifactDirectorShipResponseV1,
  type ConfirmArtifactDirectorShipV1Input,
  issueExecutionArtifactSnapshotSchema,
  type ArtifactDirectorShipCandidateV1,
} from "@paperclipai/shared";
import { conflict, forbidden, HttpError, notFound, preconditionFailed, unprocessable } from "../errors.js";
import { governedIssueLifecycleIssueSnapshot, governedIssueSha256 } from "./governed-issue-contract.js";
import {
  applyIssueExecutionPolicyTransition,
  normalizeIssueExecutionPolicy,
  parseIssueExecutionState,
} from "./issue-execution-policy.js";
import {
  buildReviewEvidenceLocatorFingerprint,
  extractBoundPullRequestReference,
  type ReviewEvidenceLocator,
} from "./issue-execution-review-evidence.js";
import type { PullRequestMergeDetailsResolver } from "./github-pull-request-merge.js";
import type { GitHubPullRequestMergeExecutor } from "./github-pull-request-merge-executor.js";
import { isLowTrustQuarantined } from "./source-trust.js";
import { logActivity } from "./activity-log.js";
import { acquireArtifactDirectorShipIssueLocks } from "./artifact-director-ship-guards.js";

export type ArtifactDirectorShipBoardActor = {
  userId: string;
  actorSource: "local_implicit" | "session" | "board_key" | "cloud_tenant";
};

type ShipIssue = typeof issues.$inferSelect;
type ShipRow = typeof issueArtifactDirectorShipments.$inferSelect;

const SHIP_LEASE_MS = 30_000;
const SHIP_RETRY_MS = 5_000;
const PROVIDER_RESOLVE_TIMEOUT_MS = 10_000;
const GIT_REVISION = /^[0-9a-f]{40,64}$/;

function issueExecutionFingerprint(issue: ShipIssue) {
  return governedIssueSha256({
    issueId: issue.id,
    status: issue.status,
    reviewPolicy: issue.reviewPolicy,
    assigneeAgentId: issue.assigneeAgentId,
    assigneeUserId: issue.assigneeUserId,
    executionPolicy: normalizeIssueExecutionPolicy(issue.executionPolicy),
    executionState: parseIssueExecutionState(issue.executionState),
    projectId: issue.projectId,
    projectWorkspaceId: issue.projectWorkspaceId,
    executionWorkspaceId: issue.executionWorkspaceId,
  });
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, code: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(code)), timeoutMs);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function failEvidence(message: string, details: Record<string, unknown> = {}): never {
  throw conflict(message, { code: "artifact_director_ship_evidence_invalid", ...details });
}

async function assertActiveDirectorMembership(db: Db, companyId: string, actor: ArtifactDirectorShipBoardActor) {
  const membership = await db.select({ role: companyMemberships.membershipRole })
    .from(companyMemberships)
    .where(and(
      eq(companyMemberships.companyId, companyId),
      eq(companyMemberships.principalType, "user"),
      eq(companyMemberships.principalId, actor.userId),
      eq(companyMemberships.status, "active"),
    ))
    .then((rows) => rows[0] ?? null);
  if (!membership || membership.role === "viewer") {
    throw forbidden("Ship requires an active non-viewer company membership.", {
      code: "artifact_director_ship_director_mismatch",
    });
  }
}

function assertPendingFinalDirector(issue: ShipIssue, actor: ArtifactDirectorShipBoardActor) {
  const policy = normalizeIssueExecutionPolicy(issue.executionPolicy);
  const state = parseIssueExecutionState(issue.executionState);
  const stageIndex = policy?.stages.findIndex((stage) => stage.id === state?.currentStageId) ?? -1;
  const stage = stageIndex >= 0 ? policy?.stages[stageIndex] ?? null : null;
  const participant = stage?.participants.length === 1 ? stage.participants[0] ?? null : null;
  if (
    issue.status !== "in_review"
    || !policy
    || !state
    || state.status !== "pending"
    || state.currentStageType !== "approval"
    || stage?.type !== "approval"
    || stageIndex !== policy.stages.length - 1
    || participant?.type !== "user"
    || participant.userId !== actor.userId
    || state.currentParticipant?.type !== "user"
    || state.currentParticipant.userId !== actor.userId
    || issue.assigneeUserId !== actor.userId
    || issue.assigneeAgentId != null
    || !state.lastDecisionId
    || state.lastDecisionOutcome !== "approved"
  ) {
    throw conflict("The issue is not waiting for this exact final director approval.", {
      code: "artifact_director_ship_director_mismatch",
    });
  }
  return { policy, state, stage };
}

function assertFinalApprovalTransition(issue: ShipIssue, actor: ArtifactDirectorShipBoardActor) {
  const { policy } = assertPendingFinalDirector(issue, actor);
  const transition = applyIssueExecutionPolicyTransition({
    issue,
    policy,
    previousPolicy: policy,
    executionPolicyGovernanceChanged: false,
    requestedStatus: "done",
    requestedAssigneePatch: {},
    actor: { agentId: null, userId: actor.userId },
    allowBoardOverride: false,
    commentBody: "Ship candidate validation",
  });
  if (transition.decision?.stageType !== "approval" || transition.decision.outcome !== "approved") {
    failEvidence("The pending execution stage is not an exact final approval.");
  }
}

/**
 * Builds the only candidate that may enter the durable Ship saga. Every source
 * of truth is re-read and the provider is freshly observed after the database
 * checks. This function is intentionally read-only: a merged PR observed here
 * has no preceding durable intent and can never be converted into a receipt.
 */
export async function buildArtifactDirectorShipCandidate(input: {
  db: Db;
  issueId: string;
  actor: ArtifactDirectorShipBoardActor;
  resolver: PullRequestMergeDetailsResolver;
}): Promise<ArtifactDirectorShipCandidateV1> {
  const issue = await input.db.select().from(issues).where(eq(issues.id, input.issueId))
    .then((rows) => rows[0] ?? null);
  if (!issue) throw notFound("Issue not found");
  await assertActiveDirectorMembership(input.db, issue.companyId, input.actor);
  const { policy, state, stage } = assertPendingFinalDirector(issue, input.actor);
  assertFinalApprovalTransition(issue, input.actor);

  const review = await input.db.select().from(issueExecutionDecisions).where(and(
    eq(issueExecutionDecisions.id, state.lastDecisionId!),
    eq(issueExecutionDecisions.companyId, issue.companyId),
    eq(issueExecutionDecisions.issueId, issue.id),
  )).then((rows) => rows[0] ?? null);
  const snapshot = issueExecutionArtifactSnapshotSchema.safeParse(review?.artifactSnapshot);
  if (
    !review
    || review.stageType !== "review"
    || review.outcome !== "approved"
    || !review.reviewCycleId
    || !review.artifactWorkProductId
    || !review.artifactRevision
    || !review.artifactLocatorFingerprint
    || !review.reviewerAgentIdSnapshot
    || !review.reviewerRunIdSnapshot
    || (review.reviewerActorSourceSnapshot !== "agent_key" && review.reviewerActorSourceSnapshot !== "agent_jwt")
    || review.directorUserIdSnapshot !== input.actor.userId
    || !snapshot.success
    || snapshot.data.observedState !== "open"
  ) {
    failEvidence("The pending approval is not immediately backed by complete artifact review evidence.");
  }
  const artifactEvidence = snapshot.data;
  if (
    artifactEvidence.headSha !== review.artifactRevision
    || artifactEvidence.locatorFingerprint !== review.artifactLocatorFingerprint
    || artifactEvidence.reviewer.agentId !== review.reviewerAgentIdSnapshot
    || artifactEvidence.reviewer.runId !== review.reviewerRunIdSnapshot
    || artifactEvidence.reviewer.actorSource !== review.reviewerActorSourceSnapshot
    || artifactEvidence.director.userId !== input.actor.userId
  ) {
    failEvidence("The stored review evidence snapshots disagree.");
  }

  const workProduct = await input.db.select().from(issueWorkProducts).where(and(
    eq(issueWorkProducts.id, review.artifactWorkProductId),
    eq(issueWorkProducts.companyId, issue.companyId),
    eq(issueWorkProducts.issueId, issue.id),
  )).then((rows) => rows[0] ?? null);
  const [workspace, projectWorkspace, builderRun] = await Promise.all([
    issue.executionWorkspaceId
      ? input.db.select().from(executionWorkspaces).where(and(
          eq(executionWorkspaces.id, issue.executionWorkspaceId),
          eq(executionWorkspaces.companyId, issue.companyId),
        )).then((rows) => rows[0] ?? null)
      : Promise.resolve(null),
    issue.projectWorkspaceId
      ? input.db.select().from(projectWorkspaces).where(and(
          eq(projectWorkspaces.id, issue.projectWorkspaceId),
          eq(projectWorkspaces.companyId, issue.companyId),
        )).then((rows) => rows[0] ?? null)
      : Promise.resolve(null),
    workProduct?.createdByRunId
      ? input.db.select().from(heartbeatRuns).where(and(
          eq(heartbeatRuns.id, workProduct.createdByRunId),
          eq(heartbeatRuns.companyId, issue.companyId),
        )).then((rows) => rows[0] ?? null)
      : Promise.resolve(null),
  ]);
  const builderAgentId = state.returnAssignee?.type === "agent" ? state.returnAssignee.agentId : null;
  const workProductTrust = !workProduct?.sourceTrust
    ? "implicit_standard" as const
    : workProduct.sourceTrust.disposition === "promoted" ? "promoted" as const : null;
  if (
    !workProduct?.url
    || workProduct.type !== "pull_request"
    || workProduct.provider !== "github"
    || workProduct.status !== "ready_for_review"
    || !workProduct.isPrimary
    || workProduct.projectId !== issue.projectId
    || workProduct.executionWorkspaceId !== issue.executionWorkspaceId
    || !workProduct.createdByRunId
    || workProduct.lastModifiedByRunId !== workProduct.createdByRunId
    || isLowTrustQuarantined(workProduct.sourceTrust)
    || !workProductTrust
    || !workspace?.repoUrl
    || !workspace.branchName
    || workspace.projectId !== issue.projectId
    || workspace.projectWorkspaceId !== issue.projectWorkspaceId
    || workspace.sourceIssueId !== issue.id
    || !projectWorkspace?.repoUrl
    || projectWorkspace.projectId !== issue.projectId
    || !builderAgentId
    || !builderRun
    || builderRun.id !== workProduct.createdByRunId
    || builderRun.agentId !== builderAgentId
    || builderRun.contextSnapshot?.issueId !== issue.id
    || builderRun.contextSnapshot?.executionWorkspaceId !== workspace.id
  ) {
    failEvidence("The reviewed artifact, workspaces, or builder provenance drifted.");
  }
  const locator: ReviewEvidenceLocator = {
    workProduct: {
      ...workProduct,
      url: workProduct.url,
      projectId: workProduct.projectId!,
      executionWorkspaceId: workProduct.executionWorkspaceId!,
      createdByRunId: workProduct.createdByRunId,
      lastModifiedByRunId: workProduct.lastModifiedByRunId!,
    },
    workspace: {
      ...workspace,
      repoUrl: workspace.repoUrl,
      branchName: workspace.branchName,
      projectWorkspaceId: workspace.projectWorkspaceId!,
    },
    projectWorkspace: { ...projectWorkspace, repoUrl: projectWorkspace.repoUrl },
  };
  const locatorFingerprint = buildReviewEvidenceLocatorFingerprint(locator);
  const reference = extractBoundPullRequestReference(locator);
  if (
    locatorFingerprint !== review.artifactLocatorFingerprint
    || artifactEvidence.configuredRepository.owner !== reference.owner.toLowerCase()
    || artifactEvidence.configuredRepository.repo !== reference.repo.toLowerCase()
    || artifactEvidence.headRef !== workspace.branchName
  ) {
    throw conflict("The reviewed artifact locator changed.", {
      code: "artifact_director_ship_artifact_drift",
    });
  }

  const current = await input.resolver(issue.companyId, reference);
  if (current.state === "merged") {
    throw conflict("The pull request was merged before durable Ship intent existed.", {
      code: "artifact_director_ship_preintent_merge_rejected",
    });
  }
  const expectedRepository = `${reference.owner}/${reference.repo}`.toLowerCase();
  if (
    current.state !== "open"
    || current.headSha?.toLowerCase() !== review.artifactRevision
    || current.headRef !== workspace.branchName
    || current.headRepositoryFullName?.toLowerCase() !== expectedRepository
  ) {
    throw conflict("The pull-request head or repository changed after review.", {
      code: "artifact_director_ship_revision_stale",
      expectedHeadSha: review.artifactRevision,
      currentHeadSha: current.headSha?.toLowerCase() ?? null,
      currentState: current.state,
    });
  }

  const policySha256 = governedIssueSha256(policy);
  const executionFingerprint = issueExecutionFingerprint(issue);
  const hashInput = {
    policySha256,
    issue: {
      id: issue.id,
      identifier: issue.identifier,
      status: "in_review" as const,
      executionFingerprint,
      currentStageId: stage.id,
    },
    review: {
      decisionId: review.id,
      reviewCycleId: review.reviewCycleId,
      stageId: review.stageId,
      workProductId: review.artifactWorkProductId,
      headSha: review.artifactRevision,
      locatorFingerprint,
      reviewerAgentId: review.reviewerAgentIdSnapshot,
      reviewerRunId: review.reviewerRunIdSnapshot,
      reviewerActorSource: review.reviewerActorSourceSnapshot,
    },
    artifact: {
      kind: "github_pull_request" as const,
      canonicalRef: artifactEvidence.canonicalRef,
      owner: reference.owner.toLowerCase(),
      repo: reference.repo.toLowerCase(),
      number: reference.number,
      headRef: current.headRef,
      headSha: current.headSha.toLowerCase(),
      workProductTrust,
    },
    director: { userId: input.actor.userId, actorSource: input.actor.actorSource },
  };
  return artifactDirectorShipCandidateV1Schema.parse({
    candidateSha256: governedIssueSha256(hashInput),
    ...hashInput,
  });
}

function serializeOperation(row: ShipRow): ArtifactDirectorShipOperationV1 {
  return {
    version: 1,
    shipmentId: row.id,
    issueId: row.issueId,
    idempotencyKey: row.idempotencyKey,
    candidateSha256: row.candidateSha256,
    state: row.state as ArtifactDirectorShipOperationV1["state"],
    attemptCount: row.attemptCount,
    preparedAt: row.preparedAt.toISOString(),
    mergeAttemptedAt: row.mergeAttemptedAt?.toISOString() ?? null,
    providerRequestStartedAt: row.providerRequestStartedAt?.toISOString() ?? null,
    providerObservedAt: row.providerObservedAt?.toISOString() ?? null,
    nextAttemptAt: row.nextAttemptAt?.toISOString() ?? null,
    leaseExpiresAt: row.leaseExpiresAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    staleAt: row.staleAt?.toISOString() ?? null,
    lastErrorCode: row.lastErrorCode,
  };
}

function serializeResponse(
  row: ShipRow,
  issue: ShipIssue,
  replayed: boolean,
): ArtifactDirectorShipResponseV1 {
  const operation = serializeOperation(row);
  const issueSnapshot = governedIssueLifecycleIssueV1Schema.parse(governedIssueLifecycleIssueSnapshot(issue));
  if (row.state === "completed") {
    if (!row.completionReceipt || issueSnapshot.status !== "done") {
      throw conflict("The completed Ship operation is corrupt.", { code: "artifact_director_ship_corrupt" });
    }
    return {
      version: 1,
      replayed,
      state: "completed",
      operation: { ...operation, state: "completed" },
      receipt: row.completionReceipt,
      issue: { ...issueSnapshot, status: "done" },
    };
  }
  if (row.state === "stale") {
    if (issueSnapshot.status === "done") {
      throw conflict("A stale Ship operation cannot report a completed issue.", {
        code: "artifact_director_ship_corrupt",
      });
    }
    return {
      version: 1,
      replayed,
      state: "stale",
      operation: { ...operation, state: "stale" },
      receipt: null,
      issue: {
        ...issueSnapshot,
        status: issueSnapshot.status as Exclude<typeof issueSnapshot.status, "done">,
      },
    };
  }
  if (issueSnapshot.status !== "in_review") {
    throw conflict("An active Ship operation lost its in-review issue.", {
      code: "artifact_director_ship_corrupt",
    });
  }
  const state = row.state as "prepared" | "merge_in_flight" | "reconcile_required" | "merge_observed";
  return {
    version: 1,
    replayed,
    state,
    operation: { ...operation, state },
    receipt: null,
    issue: { ...issueSnapshot, status: "in_review" },
  };
}

function assertConfirmationMatches(
  request: ConfirmArtifactDirectorShipV1Input,
  candidate: ArtifactDirectorShipCandidateV1,
) {
  if (
    request.candidateSha256 !== candidate.candidateSha256
    || request.expectedReviewDecisionId !== candidate.review.decisionId
    || request.expectedReviewCycleId !== candidate.review.reviewCycleId
    || request.expectedWorkProductId !== candidate.review.workProductId
    || request.expectedHeadSha !== candidate.review.headSha
  ) {
    throw preconditionFailed("The Ship confirmation does not match the current candidate.", {
      code: "artifact_director_ship_revision_stale",
      candidateSha256: candidate.candidateSha256,
    });
  }
}

function assertExistingOperationActor(row: ShipRow, actor: ArtifactDirectorShipBoardActor) {
  if (
    row.directorUserIdSnapshot !== actor.userId
    || row.directorActorSource !== actor.actorSource
  ) {
    throw forbidden("Only the snapshotted director may read or retry this Ship operation.", {
      code: "artifact_director_ship_director_mismatch",
    });
  }
}

async function findShipment(dbOrTx: any, companyId: string, issueId: string, idempotencyKey: string, lock = false) {
  let query = dbOrTx.select().from(issueArtifactDirectorShipments).where(and(
    eq(issueArtifactDirectorShipments.companyId, companyId),
    eq(issueArtifactDirectorShipments.issueId, issueId),
    eq(issueArtifactDirectorShipments.idempotencyKey, idempotencyKey),
  ));
  if (lock) query = query.for("update");
  return query.then((rows: ShipRow[]) => rows[0] ?? null);
}

async function loadOperationResponse(input: {
  db: Db;
  issueId: string;
  idempotencyKey: string;
  actor: ArtifactDirectorShipBoardActor;
  replayed: boolean;
}): Promise<ArtifactDirectorShipResponseV1> {
  const issue = await input.db.select().from(issues).where(eq(issues.id, input.issueId))
    .then((rows) => rows[0] ?? null);
  if (!issue) throw notFound("Issue not found");
  await assertActiveDirectorMembership(input.db, issue.companyId, input.actor);
  const row = await findShipment(input.db, issue.companyId, issue.id, input.idempotencyKey);
  if (!row) throw notFound("Artifact director Ship operation not found");
  assertExistingOperationActor(row, input.actor);
  return serializeResponse(row, issue, input.replayed);
}

async function prepareShipment(input: {
  db: Db;
  issue: ShipIssue;
  candidate: ArtifactDirectorShipCandidateV1;
  request: ConfirmArtifactDirectorShipV1Input;
  idempotencyKey: string;
  actor: ArtifactDirectorShipBoardActor;
}) {
  return input.db.transaction(async (tx) => {
    await acquireArtifactDirectorShipIssueLocks(tx as unknown as Db, [input.issue.id]);
    const existing = await findShipment(
      tx,
      input.issue.companyId,
      input.issue.id,
      input.idempotencyKey,
      true,
    );
    if (existing) {
      assertExistingOperationActor(existing, input.actor);
      if (
        existing.candidateSha256 !== input.request.candidateSha256
        || existing.reviewDecisionId !== input.request.expectedReviewDecisionId
        || existing.reviewCycleId !== input.request.expectedReviewCycleId
        || existing.artifactWorkProductId !== input.request.expectedWorkProductId
        || existing.artifactRevision !== input.request.expectedHeadSha
        || existing.requestComment !== input.request.comment
      ) {
        throw conflict("The Ship idempotency key was used for another confirmation.", {
          code: "artifact_director_ship_idempotency_conflict",
        });
      }
      return { row: existing, replayed: true };
    }

    // Global lock order for the saga: shipment (above), issue, review evidence,
    // work product. Mutating services use the same order when checking fences.
    const lockedIssue = await tx.select().from(issues).where(and(
      eq(issues.id, input.issue.id),
      eq(issues.companyId, input.issue.companyId),
    )).for("update").then((rows) => rows[0] ?? null);
    if (!lockedIssue) throw notFound("Issue not found");
    const [directorUser, directorMembership] = await Promise.all([
      tx.select({ id: authUsers.id }).from(authUsers)
        .where(eq(authUsers.id, input.actor.userId))
        .for("share").then((rows) => rows[0] ?? null),
      tx.select({ role: companyMemberships.membershipRole, status: companyMemberships.status })
        .from(companyMemberships)
        .where(and(
          eq(companyMemberships.companyId, lockedIssue.companyId),
          eq(companyMemberships.principalType, "user"),
          eq(companyMemberships.principalId, input.actor.userId),
        ))
        .for("share").then((rows) => rows[0] ?? null),
    ]);
    if (!directorUser || directorMembership?.status !== "active" || directorMembership.role === "viewer") {
      throw forbidden("Ship requires the exact active non-viewer director under the intent lock.", {
        code: "artifact_director_ship_director_mismatch",
      });
    }
    if (issueExecutionFingerprint(lockedIssue) !== input.candidate.issue.executionFingerprint) {
      throw preconditionFailed("The issue changed before durable Ship intent was recorded.", {
        code: "artifact_director_ship_revision_stale",
      });
    }
    const { policy, state } = assertPendingFinalDirector(lockedIssue, input.actor);
    const evidence = await tx.select().from(issueExecutionDecisions).where(and(
      eq(issueExecutionDecisions.id, input.candidate.review.decisionId),
      eq(issueExecutionDecisions.companyId, lockedIssue.companyId),
      eq(issueExecutionDecisions.issueId, lockedIssue.id),
    )).for("share").then((rows) => rows[0] ?? null);
    const workProduct = await tx.select().from(issueWorkProducts).where(and(
      eq(issueWorkProducts.id, input.candidate.review.workProductId),
      eq(issueWorkProducts.companyId, lockedIssue.companyId),
      eq(issueWorkProducts.issueId, lockedIssue.id),
    )).for("share").then((rows) => rows[0] ?? null);
    const workspace = lockedIssue.executionWorkspaceId
      ? await tx.select().from(executionWorkspaces).where(and(
          eq(executionWorkspaces.id, lockedIssue.executionWorkspaceId),
          eq(executionWorkspaces.companyId, lockedIssue.companyId),
        )).for("share").then((rows) => rows[0] ?? null)
      : null;
    const projectWorkspace = lockedIssue.projectWorkspaceId
      ? await tx.select().from(projectWorkspaces).where(and(
          eq(projectWorkspaces.id, lockedIssue.projectWorkspaceId),
          eq(projectWorkspaces.companyId, lockedIssue.companyId),
        )).for("share").then((rows) => rows[0] ?? null)
      : null;
    const evidenceSnapshot = issueExecutionArtifactSnapshotSchema.safeParse(evidence?.artifactSnapshot);
    const reviewStageIndex = policy.stages.findIndex((stage) => stage.id === evidence?.stageId);
    const approvalStageIndex = policy.stages.findIndex((stage) => stage.id === state.currentStageId);
    const reviewStage = reviewStageIndex >= 0 ? policy.stages[reviewStageIndex] : null;
    const reviewerAgentId = evidence?.reviewerAgentIdSnapshot ?? null;
    const [reviewerAgent, reviewerRun, builderRun] = await Promise.all([
      reviewerAgentId
        ? tx.select({ id: agents.id, companyId: agents.companyId }).from(agents)
          .where(and(eq(agents.id, reviewerAgentId), eq(agents.companyId, lockedIssue.companyId)))
          .for("share").then((rows) => rows[0] ?? null)
        : Promise.resolve(null),
      evidence?.reviewerRunIdSnapshot
        ? tx.select().from(heartbeatRuns).where(and(
          eq(heartbeatRuns.id, evidence.reviewerRunIdSnapshot),
          eq(heartbeatRuns.companyId, lockedIssue.companyId),
        )).for("share").then((rows) => rows[0] ?? null)
        : Promise.resolve(null),
      workProduct?.createdByRunId
        ? tx.select().from(heartbeatRuns).where(and(
          eq(heartbeatRuns.id, workProduct.createdByRunId),
          eq(heartbeatRuns.companyId, lockedIssue.companyId),
        )).for("share").then((rows) => rows[0] ?? null)
        : Promise.resolve(null),
    ]);
    const builderAgentId = state.returnAssignee?.type === "agent" ? state.returnAssignee.agentId : null;
    let currentLocatorFingerprint: string | null = null;
    if (
      workProduct?.url
      && workProduct.projectId
      && workProduct.executionWorkspaceId
      && workProduct.createdByRunId
      && workProduct.lastModifiedByRunId
      && workspace?.repoUrl
      && workspace.branchName
      && workspace.projectWorkspaceId
      && projectWorkspace?.repoUrl
    ) {
      currentLocatorFingerprint = buildReviewEvidenceLocatorFingerprint({
        workProduct: {
          ...workProduct,
          url: workProduct.url,
          projectId: workProduct.projectId,
          executionWorkspaceId: workProduct.executionWorkspaceId,
          createdByRunId: workProduct.createdByRunId,
          lastModifiedByRunId: workProduct.lastModifiedByRunId,
        },
        workspace: {
          ...workspace,
          repoUrl: workspace.repoUrl,
          branchName: workspace.branchName,
          projectWorkspaceId: workspace.projectWorkspaceId,
        },
        projectWorkspace: { ...projectWorkspace, repoUrl: projectWorkspace.repoUrl },
      });
    }
    if (
      !evidence
      || evidence.stageType !== "review"
      || evidence.outcome !== "approved"
      || evidence.reviewCycleId !== input.candidate.review.reviewCycleId
      || evidence.artifactRevision !== input.candidate.review.headSha
      || evidence.artifactLocatorFingerprint !== input.candidate.review.locatorFingerprint
      || evidence.reviewerAgentIdSnapshot !== input.candidate.review.reviewerAgentId
      || evidence.reviewerRunIdSnapshot !== input.candidate.review.reviewerRunId
      || evidence.reviewerActorSourceSnapshot !== input.candidate.review.reviewerActorSource
      || evidence.actorAgentId !== evidence.reviewerAgentIdSnapshot
      || (evidence.createdByRunId != null && evidence.createdByRunId !== evidence.reviewerRunIdSnapshot)
      || evidence.directorUserIdSnapshot !== input.actor.userId
      || !evidenceSnapshot.success
      || evidenceSnapshot.data.headSha !== evidence.artifactRevision
      || evidenceSnapshot.data.locatorFingerprint !== evidence.artifactLocatorFingerprint
      || evidenceSnapshot.data.reviewer.agentId !== evidence.reviewerAgentIdSnapshot
      || evidenceSnapshot.data.reviewer.runId !== evidence.reviewerRunIdSnapshot
      || evidenceSnapshot.data.reviewer.actorSource !== evidence.reviewerActorSourceSnapshot
      || evidenceSnapshot.data.director.userId !== input.actor.userId
      || reviewStage?.type !== "review"
      || reviewStageIndex !== approvalStageIndex - 1
      || !reviewStage.participants.some((participant) => (
        participant.type === "agent" && participant.agentId === reviewerAgentId
      ))
      || !reviewerAgent
      || !reviewerRun
      || reviewerRun.agentId !== reviewerAgentId
      || reviewerRun.contextSnapshot?.issueId !== lockedIssue.id
      || !builderAgentId
      || reviewerAgentId === builderAgentId
      || reviewerAgentId === lockedIssue.createdByAgentId
      || reviewerAgentId === (state.returnAssignee?.type === "agent" ? state.returnAssignee.agentId : null)
      || !workProduct
      || workProduct.status !== "ready_for_review"
      || workProduct.type !== "pull_request"
      || workProduct.provider !== "github"
      || !workProduct.isPrimary
      || workProduct.projectId !== lockedIssue.projectId
      || workProduct.executionWorkspaceId !== lockedIssue.executionWorkspaceId
      || !workProduct.createdByRunId
      || workProduct.lastModifiedByRunId !== workProduct.createdByRunId
      || !builderRun
      || builderRun.agentId !== builderAgentId
      || builderRun.contextSnapshot?.issueId !== lockedIssue.id
      || builderRun.contextSnapshot?.executionWorkspaceId !== workspace?.id
      || workspace?.sourceIssueId !== lockedIssue.id
      || workspace?.projectWorkspaceId !== lockedIssue.projectWorkspaceId
      || projectWorkspace?.projectId !== lockedIssue.projectId
      || currentLocatorFingerprint !== input.candidate.review.locatorFingerprint
    ) {
      throw preconditionFailed("The reviewed evidence changed before durable Ship intent was recorded.", {
        code: "artifact_director_ship_evidence_invalid",
      });
    }
    const cycleConflict = await tx.select({ id: issueArtifactDirectorShipments.id })
      .from(issueArtifactDirectorShipments)
      .where(and(
        eq(issueArtifactDirectorShipments.companyId, lockedIssue.companyId),
        eq(issueArtifactDirectorShipments.issueId, lockedIssue.id),
        eq(issueArtifactDirectorShipments.reviewCycleId, input.candidate.review.reviewCycleId),
      )).then((rows) => rows[0] ?? null);
    if (cycleConflict) {
      throw conflict("This review cycle already has a Ship operation.", {
        code: "artifact_director_ship_review_cycle_conflict",
      });
    }
    const inserted = await tx.insert(issueArtifactDirectorShipments).values({
      companyId: lockedIssue.companyId,
      issueId: lockedIssue.id,
      idempotencyKey: input.idempotencyKey,
      candidateSha256: input.candidate.candidateSha256,
      policySha256: input.candidate.policySha256,
      reviewDecisionId: input.candidate.review.decisionId,
      reviewCycleId: input.candidate.review.reviewCycleId,
      artifactWorkProductId: input.candidate.review.workProductId,
      artifactRevision: input.candidate.review.headSha,
      artifactLocatorFingerprint: input.candidate.review.locatorFingerprint,
      reviewerActorSource: input.candidate.review.reviewerActorSource,
      candidateSnapshot: input.candidate,
      reviewEvidenceSnapshot: input.candidate.review,
      artifactSnapshot: input.candidate.artifact,
      directorUserIdSnapshot: input.actor.userId,
      directorActorSource: input.actor.actorSource,
      directorSnapshot: input.candidate.director,
      requestComment: input.request.comment,
    }).returning().then((rows) => rows[0]!);
    await logActivity(tx as unknown as Db, {
      companyId: lockedIssue.companyId,
      actorType: "user",
      actorId: input.actor.userId,
      action: "issue.artifact_director_ship_prepared",
      entityType: "issue",
      entityId: lockedIssue.id,
      details: {
        shipmentId: inserted.id,
        candidateSha256: inserted.candidateSha256,
        reviewDecisionId: inserted.reviewDecisionId,
        artifactRevision: inserted.artifactRevision,
      },
    });
    return { row: inserted, replayed: false };
  });
}

async function markReconcileRequired(
  db: Db,
  row: ShipRow,
  leaseToken: string,
  code: string,
  providerOutcome: Record<string, unknown> | null,
) {
  const now = new Date();
  await db.update(issueArtifactDirectorShipments).set({
    state: "reconcile_required",
    leaseToken: null,
    leaseExpiresAt: null,
    nextAttemptAt: new Date(now.getTime() + SHIP_RETRY_MS),
    lastErrorCode: code,
    lastErrorAt: now,
    providerOutcome,
    updatedAt: now,
  }).where(and(
    eq(issueArtifactDirectorShipments.id, row.id),
    eq(issueArtifactDirectorShipments.state, "merge_in_flight"),
    eq(issueArtifactDirectorShipments.leaseToken, leaseToken),
  ));
}

async function markStale(db: Db, row: ShipRow, leaseToken: string, code: string) {
  const now = new Date();
  await db.update(issueArtifactDirectorShipments).set({
    state: "stale",
    leaseToken: null,
    leaseExpiresAt: null,
    staleAt: now,
    lastErrorCode: code,
    lastErrorAt: now,
    updatedAt: now,
  }).where(and(
    eq(issueArtifactDirectorShipments.id, row.id),
    eq(issueArtifactDirectorShipments.state, "merge_in_flight"),
    eq(issueArtifactDirectorShipments.leaseToken, leaseToken),
  ));
}

async function markMergeObserved(
  db: Db,
  row: ShipRow,
  leaseToken: string,
  mergeCommitSha: string,
  providerObservedAt: Date,
  providerOutcome: Record<string, unknown>,
) {
  await db.update(issueArtifactDirectorShipments).set({
    state: "merge_observed",
    leaseToken: null,
    leaseExpiresAt: null,
    nextAttemptAt: null,
    mergeCommitSha,
    providerObservedAt,
    providerOutcome,
    lastErrorCode: null,
    lastErrorAt: null,
    updatedAt: new Date(),
  }).where(and(
    eq(issueArtifactDirectorShipments.id, row.id),
    eq(issueArtifactDirectorShipments.state, "merge_in_flight"),
    eq(issueArtifactDirectorShipments.leaseToken, leaseToken),
  ));
}

async function finalizeObservedShipment(input: {
  db: Db;
  shipmentId: string;
}) {
  return input.db.transaction(async (tx) => {
    const shipment = await tx.select().from(issueArtifactDirectorShipments)
      .where(eq(issueArtifactDirectorShipments.id, input.shipmentId))
      .for("update").then((rows) => rows[0] ?? null);
    if (!shipment || shipment.state !== "merge_observed") return;
    const issue = await tx.select().from(issues).where(and(
      eq(issues.id, shipment.issueId),
      eq(issues.companyId, shipment.companyId),
    )).for("update").then((rows) => rows[0] ?? null);
    if (!issue) throw notFound("Issue not found");
    const evidence = await tx.select().from(issueExecutionDecisions).where(and(
      eq(issueExecutionDecisions.id, shipment.reviewDecisionId),
      eq(issueExecutionDecisions.companyId, shipment.companyId),
      eq(issueExecutionDecisions.issueId, shipment.issueId),
    )).for("share").then((rows) => rows[0] ?? null);
    const workProduct = await tx.select().from(issueWorkProducts).where(and(
      eq(issueWorkProducts.id, shipment.artifactWorkProductId),
      eq(issueWorkProducts.companyId, shipment.companyId),
      eq(issueWorkProducts.issueId, shipment.issueId),
    )).for("update").then((rows) => rows[0] ?? null);
    const workspace = issue.executionWorkspaceId
      ? await tx.select().from(executionWorkspaces).where(and(
          eq(executionWorkspaces.id, issue.executionWorkspaceId),
          eq(executionWorkspaces.companyId, issue.companyId),
        )).for("share").then((rows) => rows[0] ?? null)
      : null;
    const projectWorkspace = issue.projectWorkspaceId
      ? await tx.select().from(projectWorkspaces).where(and(
          eq(projectWorkspaces.id, issue.projectWorkspaceId),
          eq(projectWorkspaces.companyId, issue.companyId),
        )).for("share").then((rows) => rows[0] ?? null)
      : null;
    const candidate = artifactDirectorShipCandidateV1Schema.parse(shipment.candidateSnapshot);
    let currentLocatorFingerprint: string | null = null;
    if (
      workProduct?.url
      && workProduct.projectId
      && workProduct.executionWorkspaceId
      && workProduct.createdByRunId
      && workProduct.lastModifiedByRunId
      && workspace?.repoUrl
      && workspace.branchName
      && workspace.projectWorkspaceId
      && projectWorkspace?.repoUrl
    ) {
      currentLocatorFingerprint = buildReviewEvidenceLocatorFingerprint({
        workProduct: {
          ...workProduct,
          url: workProduct.url,
          projectId: workProduct.projectId,
          executionWorkspaceId: workProduct.executionWorkspaceId,
          createdByRunId: workProduct.createdByRunId,
          lastModifiedByRunId: workProduct.lastModifiedByRunId,
        },
        workspace: {
          ...workspace,
          repoUrl: workspace.repoUrl,
          branchName: workspace.branchName,
          projectWorkspaceId: workspace.projectWorkspaceId,
        },
        projectWorkspace: { ...projectWorkspace, repoUrl: projectWorkspace.repoUrl },
      });
    }
    if (
      !evidence
      || !workProduct
      || issueExecutionFingerprint(issue) !== candidate.issue.executionFingerprint
      || governedIssueSha256(normalizeIssueExecutionPolicy(issue.executionPolicy)) !== shipment.policySha256
      || evidence.id !== candidate.review.decisionId
      || evidence.reviewCycleId !== candidate.review.reviewCycleId
      || evidence.artifactRevision !== candidate.review.headSha
      || evidence.artifactLocatorFingerprint !== candidate.review.locatorFingerprint
      || workProduct.status !== "ready_for_review"
      || workProduct.id !== candidate.review.workProductId
      || currentLocatorFingerprint !== shipment.artifactLocatorFingerprint
      || !shipment.mergeCommitSha
      || !shipment.providerObservedAt
    ) {
      throw conflict("A merge-observed Ship operation cannot be invalidated; reconciliation must repair it.", {
        code: "artifact_director_ship_corrupt",
        shipmentId: shipment.id,
      });
    }
    const actor = {
      userId: shipment.directorUserIdSnapshot,
      actorSource: shipment.directorActorSource as ArtifactDirectorShipBoardActor["actorSource"],
    };
    const { policy } = assertPendingFinalDirector(issue, actor);
    const transition = applyIssueExecutionPolicyTransition({
      issue,
      policy,
      previousPolicy: policy,
      executionPolicyGovernanceChanged: false,
      requestedStatus: "done",
      requestedAssigneePatch: {},
      actor: { agentId: null, userId: actor.userId },
      allowBoardOverride: false,
      commentBody: shipment.requestComment,
    });
    if (transition.decision?.stageType !== "approval" || transition.decision.outcome !== "approved") {
      throw conflict("The snapshotted final approval can no longer be applied.", {
        code: "artifact_director_ship_revision_stale",
      });
    }
    const decisionId = randomUUID();
    const now = new Date();
    const nextState = parseIssueExecutionState(transition.patch.executionState);
    if (!nextState || nextState.status !== "completed") {
      throw conflict("The final approval did not complete the execution policy.", {
        code: "artifact_director_ship_corrupt",
      });
    }
    const updatedIssue = await tx.update(issues).set({
      ...transition.patch,
      status: "done",
      executionState: { ...nextState, lastDecisionId: decisionId },
      completedAt: now,
      updatedAt: now,
    }).where(and(eq(issues.id, issue.id), eq(issues.companyId, issue.companyId)))
      .returning().then((rows) => rows[0]!);
    await tx.insert(issueExecutionDecisions).values({
      id: decisionId,
      companyId: issue.companyId,
      issueId: issue.id,
      stageId: transition.decision.stageId,
      stageType: transition.decision.stageType,
      actorAgentId: null,
      actorUserId: actor.userId,
      outcome: transition.decision.outcome,
      body: transition.decision.body,
    });
    await tx.update(issueWorkProducts).set({
      status: "merged",
      reviewState: "approved",
      updatedAt: now,
    }).where(eq(issueWorkProducts.id, workProduct.id));
    const receipt: ArtifactDirectorShipReceiptV1 = {
      version: 1,
      shipmentId: shipment.id,
      issueId: issue.id,
      reviewDecisionId: shipment.reviewDecisionId,
      reviewCycleId: shipment.reviewCycleId,
      policySha256: shipment.policySha256,
      approvalDecisionId: decisionId,
      workProductId: shipment.artifactWorkProductId,
      artifactRevision: shipment.artifactRevision,
      locatorFingerprint: shipment.artifactLocatorFingerprint,
      canonicalRef: candidate.artifact.canonicalRef,
      provider: "github",
      mergeMethod: "merge",
      mergeCommitSha: shipment.mergeCommitSha,
      directorUserId: actor.userId,
      reviewerActorSource: shipment.reviewerActorSource as ArtifactDirectorShipReceiptV1["reviewerActorSource"],
      directorActorSource: actor.actorSource,
      providerObservedAt: shipment.providerObservedAt.toISOString(),
      completedAt: now.toISOString(),
      completedIssueUpdatedAt: updatedIssue.updatedAt.toISOString(),
    };
    await logActivity(tx as unknown as Db, {
      companyId: issue.companyId,
      actorType: "user",
      actorId: actor.userId,
      action: "issue.artifact_director_ship_completed",
      entityType: "issue",
      entityId: issue.id,
      details: {
        shipmentId: shipment.id,
        approvalDecisionId: decisionId,
        reviewDecisionId: shipment.reviewDecisionId,
        workProductId: shipment.artifactWorkProductId,
        artifactRevision: shipment.artifactRevision,
        mergeCommitSha: shipment.mergeCommitSha,
      },
    });
    await tx.update(issueArtifactDirectorShipments).set({
      state: "completed",
      approvalDecisionId: decisionId,
      completionReceipt: receipt,
      completedIssueUpdatedAt: updatedIssue.updatedAt,
      completedAt: now,
      updatedAt: now,
    }).where(eq(issueArtifactDirectorShipments.id, shipment.id));
  });
}

async function driveShipment(input: {
  db: Db;
  row: ShipRow;
  resolver: PullRequestMergeDetailsResolver;
  mergeExecutor: GitHubPullRequestMergeExecutor;
  now?: () => Date;
  resolverTimeoutMs?: number;
}) {
  if (input.row.state === "merge_observed") {
    await finalizeObservedShipment({ db: input.db, shipmentId: input.row.id });
    return;
  }
  if (input.row.state === "completed" || input.row.state === "stale") return;
  const now = input.now ?? (() => new Date());
  const leaseToken = randomUUID();
  const leased = await input.db.transaction(async (tx) => {
    const row = await tx.select().from(issueArtifactDirectorShipments)
      .where(eq(issueArtifactDirectorShipments.id, input.row.id))
      .for("update").then((rows) => rows[0] ?? null);
    if (!row || row.state === "completed" || row.state === "stale" || row.state === "merge_observed") return row;
    const instant = now();
    if (row.state === "merge_in_flight" && row.leaseExpiresAt && row.leaseExpiresAt > instant) return row;
    if (row.state === "reconcile_required" && row.nextAttemptAt && row.nextAttemptAt > instant) return row;
    return tx.update(issueArtifactDirectorShipments).set({
      state: "merge_in_flight",
      attemptCount: row.attemptCount + 1,
      leaseToken,
      leaseExpiresAt: new Date(instant.getTime() + SHIP_LEASE_MS),
      mergeAttemptedAt: instant,
      nextAttemptAt: null,
      updatedAt: instant,
    }).where(eq(issueArtifactDirectorShipments.id, row.id)).returning().then((rows) => rows[0]!);
  });
  if (!leased || leased.state !== "merge_in_flight" || leased.leaseToken !== leaseToken) {
    if (leased?.state === "merge_observed") {
      await finalizeObservedShipment({ db: input.db, shipmentId: leased.id });
    }
    return;
  }
  const candidate = artifactDirectorShipCandidateV1Schema.parse(leased.candidateSnapshot);
  const reference = {
    host: "github.com" as const,
    owner: candidate.artifact.owner,
    repo: candidate.artifact.repo,
    number: candidate.artifact.number,
  };
  const expectedRepository = `${reference.owner}/${reference.repo}`.toLowerCase();
  const observe = async () => withTimeout(
    input.resolver(leased.companyId, reference),
    input.resolverTimeoutMs ?? PROVIDER_RESOLVE_TIMEOUT_MS,
    "artifact_director_ship_provider_timeout",
  );
  let before;
  try {
    before = await observe();
  } catch {
    await markReconcileRequired(input.db, leased, leaseToken, "provider_observation_failed", null);
    return;
  }
  const exactObserved = (value: typeof before) =>
    value.headSha?.toLowerCase() === leased.artifactRevision
    && value.headRef === candidate.artifact.headRef
    && value.headRepositoryFullName?.toLowerCase() === expectedRepository;
  if (!exactObserved(before)) {
    await markStale(input.db, leased, leaseToken, "artifact_director_ship_revision_stale");
    return;
  }
  if (before.state === "merged") {
    if (!leased.providerRequestStartedAt) {
      await markStale(input.db, leased, leaseToken, "artifact_director_ship_merge_before_authorized_attempt");
    } else if (before.mergeCommitSha && GIT_REVISION.test(before.mergeCommitSha)) {
      await markMergeObserved(input.db, leased, leaseToken, before.mergeCommitSha, now(), {
        kind: "merged_observed_before_retry",
      });
      await finalizeObservedShipment({ db: input.db, shipmentId: leased.id });
    } else {
      await markReconcileRequired(input.db, leased, leaseToken, "merge_commit_sha_unavailable", {
        kind: "merged_observed_before_retry",
      });
    }
    return;
  }
  if (before.state !== "open") {
    await markStale(input.db, leased, leaseToken, "artifact_director_ship_artifact_drift");
    return;
  }
  const providerRequestStartedAt = now();
  const authorized = await input.db.update(issueArtifactDirectorShipments).set({
    providerRequestStartedAt,
    updatedAt: providerRequestStartedAt,
  }).where(and(
    eq(issueArtifactDirectorShipments.id, leased.id),
    eq(issueArtifactDirectorShipments.state, "merge_in_flight"),
    eq(issueArtifactDirectorShipments.leaseToken, leaseToken),
  )).returning().then((rows) => rows[0] ?? null);
  if (!authorized) return;
  const outcome = await input.mergeExecutor({
    companyId: leased.companyId,
    reference,
    expectedHeadSha: leased.artifactRevision,
  });
  let after;
  try {
    after = await observe();
  } catch {
    await markReconcileRequired(input.db, leased, leaseToken, "provider_observation_failed", {
      mergeOutcome: outcome.kind,
    });
    return;
  }
  if (!exactObserved(after)) {
    await markStale(input.db, leased, leaseToken, "artifact_director_ship_revision_stale");
    return;
  }
  const authoritativeMergeCommitSha = after.state === "merged" && after.mergeCommitSha
    ? after.mergeCommitSha.toLowerCase()
    : null;
  if (
    after.state === "merged"
    && authoritativeMergeCommitSha
    && GIT_REVISION.test(authoritativeMergeCommitSha)
    && (!outcome.ok || outcome.mergeCommitSha.toLowerCase() === authoritativeMergeCommitSha)
  ) {
    await markMergeObserved(input.db, authorized, leaseToken, authoritativeMergeCommitSha, now(), {
      mergeOutcome: outcome.kind,
      observedState: after.state,
    });
    await finalizeObservedShipment({ db: input.db, shipmentId: leased.id });
    return;
  }
  if (
    after.state === "merged"
    && outcome.ok
    && authoritativeMergeCommitSha
    && outcome.mergeCommitSha.toLowerCase() !== authoritativeMergeCommitSha
  ) {
    await markReconcileRequired(input.db, authorized, leaseToken, "merge_commit_sha_mismatch", {
      mergeOutcome: outcome.kind,
      executorMergeCommitSha: outcome.mergeCommitSha,
      authoritativeMergeCommitSha,
    });
    return;
  }
  if (!outcome.ok && !outcome.retryable) {
    await markStale(input.db, authorized, leaseToken, `provider_${outcome.kind}`);
    return;
  }
  await markReconcileRequired(input.db, authorized, leaseToken, outcome.ok
    ? (after.state === "merged" ? "merge_commit_sha_unavailable" : "merge_not_observed")
    : `provider_${outcome.kind}`, {
    mergeOutcome: outcome.kind,
    observedState: after.state,
  });
}

export async function confirmArtifactDirectorShip(input: {
  db: Db;
  issueId: string;
  idempotencyKey: string;
  actor: ArtifactDirectorShipBoardActor;
  request: unknown;
  resolver: PullRequestMergeDetailsResolver;
  mergeExecutor: GitHubPullRequestMergeExecutor;
}): Promise<ArtifactDirectorShipResponseV1> {
  const request = confirmArtifactDirectorShipV1Schema.parse(input.request);
  const issue = await input.db.select().from(issues).where(eq(issues.id, input.issueId))
    .then((rows) => rows[0] ?? null);
  if (!issue) throw notFound("Issue not found");
  await assertActiveDirectorMembership(input.db, issue.companyId, input.actor);
  const existing = await findShipment(input.db, issue.companyId, issue.id, input.idempotencyKey);
  if (existing) {
    assertExistingOperationActor(existing, input.actor);
    if (
      existing.candidateSha256 !== request.candidateSha256
      || existing.reviewDecisionId !== request.expectedReviewDecisionId
      || existing.reviewCycleId !== request.expectedReviewCycleId
      || existing.artifactWorkProductId !== request.expectedWorkProductId
      || existing.artifactRevision !== request.expectedHeadSha
      || existing.requestComment !== request.comment
    ) {
      throw conflict("The Ship idempotency key was used for another confirmation.", {
        code: "artifact_director_ship_idempotency_conflict",
      });
    }
    await driveShipment({ db: input.db, row: existing, resolver: input.resolver, mergeExecutor: input.mergeExecutor });
    const replay = await loadOperationResponse({ ...input, replayed: true });
    if (replay.state === "stale") {
      throw preconditionFailed("The durable Ship operation became stale before completion.", {
        code: replay.operation.lastErrorCode ?? "artifact_director_ship_revision_stale",
        operation: replay.operation,
      });
    }
    return replay;
  }
  let candidate: ArtifactDirectorShipCandidateV1;
  try {
    candidate = await buildArtifactDirectorShipCandidate({
      db: input.db,
      issueId: issue.id,
      actor: input.actor,
      resolver: input.resolver,
    });
  } catch (error) {
    const code = error instanceof HttpError && error.details && typeof error.details === "object"
      ? (error.details as Record<string, unknown>).code
      : null;
    if (
      error instanceof HttpError
      && error.status === 409
      && code !== "artifact_director_ship_preintent_merge_rejected"
      && (
        code === "artifact_director_ship_artifact_drift"
        || code === "artifact_director_ship_revision_stale"
        || code === "artifact_director_ship_evidence_invalid"
      )
    ) {
      throw preconditionFailed(error.message, error.details);
    }
    throw error;
  }
  assertConfirmationMatches(request, candidate);
  const prepared = await prepareShipment({
    db: input.db,
    issue,
    candidate,
    request,
    idempotencyKey: input.idempotencyKey,
    actor: input.actor,
  });
  await driveShipment({
    db: input.db,
    row: prepared.row,
    resolver: input.resolver,
    mergeExecutor: input.mergeExecutor,
  });
  const response = await loadOperationResponse({ ...input, replayed: prepared.replayed });
  if (response.state === "stale") {
    throw preconditionFailed("The durable Ship operation became stale before completion.", {
      code: response.operation.lastErrorCode ?? "artifact_director_ship_revision_stale",
      operation: response.operation,
    });
  }
  return response;
}

export async function getArtifactDirectorShipOperation(input: {
  db: Db;
  issueId: string;
  idempotencyKey: string;
  actor: ArtifactDirectorShipBoardActor;
}): Promise<ArtifactDirectorShipResponseV1> {
  return loadOperationResponse({ ...input, replayed: true });
}

/** Bounded startup/timer reconciler. A leased row is reclaimed only after expiry. */
export async function reconcileArtifactDirectorShips(input: {
  db: Db;
  resolver: PullRequestMergeDetailsResolver;
  mergeExecutor: GitHubPullRequestMergeExecutor;
  limit?: number;
  now?: () => Date;
  resolverTimeoutMs?: number;
}) {
  const now = input.now?.() ?? new Date();
  const limit = Math.min(100, Math.max(1, input.limit ?? 25));
  const [reconcileRequired, expiredLeases, mergeObserved] = await Promise.all([
    input.db.select().from(issueArtifactDirectorShipments).where(and(
      eq(issueArtifactDirectorShipments.state, "reconcile_required"),
      lte(issueArtifactDirectorShipments.nextAttemptAt, now),
    )).orderBy(asc(issueArtifactDirectorShipments.nextAttemptAt), asc(issueArtifactDirectorShipments.id)).limit(limit),
    input.db.select().from(issueArtifactDirectorShipments).where(and(
      eq(issueArtifactDirectorShipments.state, "merge_in_flight"),
      lte(issueArtifactDirectorShipments.leaseExpiresAt, now),
    )).orderBy(asc(issueArtifactDirectorShipments.leaseExpiresAt), asc(issueArtifactDirectorShipments.id)).limit(limit),
    input.db.select().from(issueArtifactDirectorShipments).where(and(
      eq(issueArtifactDirectorShipments.state, "merge_observed"),
      isNotNull(issueArtifactDirectorShipments.providerRequestStartedAt),
    )).orderBy(asc(issueArtifactDirectorShipments.id)).limit(limit),
  ]);
  const rows = [...reconcileRequired, ...expiredLeases, ...mergeObserved];
  await Promise.all(rows.map(async (row) => {
    try {
      await driveShipment({ ...input, row });
    } catch {
      // One corrupt provider row must not starve other due reconciliation work.
    }
  }));
  return { scanned: rows.length };
}
