import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  executionWorkspaces,
  heartbeatRuns,
  issueExecutionDecisions,
  issueWorkProducts,
  projectWorkspaces,
} from "@paperclipai/db";
import {
  issueExecutionArtifactSnapshotSchema,
  type ApproveIssueReviewEvidence,
  type IssueExecutionReviewEvidenceReceipt,
} from "@paperclipai/shared";
import { conflict, forbidden, notFound, unprocessable } from "../errors.js";
import {
  pullRequestMatchesWorkspaceRepository,
} from "./execution-workspaces.js";
import {
  extractGitHubPullRequestReferences,
  type GitHubPullRequestReference,
  type PullRequestMergeDetails,
  type PullRequestMergeDetailsResolver,
} from "./github-pull-request-merge.js";
import {
  applyIssueExecutionPolicyTransition,
  normalizeIssueExecutionPolicy,
  parseIssueExecutionState,
} from "./issue-execution-policy.js";
import { assertIssueReviewVerdictActorAllowed } from "./issue-review-policy.js";
import { issueService } from "./issues.js";
import { logActivity } from "./activity-log.js";
import { isLowTrustQuarantined } from "./source-trust.js";

export const REVIEW_EVIDENCE_GITHUB_TIMEOUT_MS = 10_000;

export type ReviewEvidenceLocator = {
  workProduct: {
    id: string;
    url: string;
    projectId: string;
    executionWorkspaceId: string;
    createdByRunId: string;
    lastModifiedByRunId: string;
    status: string;
    isPrimary: boolean;
    sourceTrust: unknown;
    updatedAt: Date;
  };
  workspace: {
    id: string;
    repoUrl: string;
    branchName: string;
    projectWorkspaceId: string;
  };
  projectWorkspace: {
    id: string;
    repoUrl: string;
    updatedAt: Date;
  };
};

export function buildReviewEvidenceLocatorFingerprint(locator: ReviewEvidenceLocator) {
  return createHash("sha256").update(JSON.stringify({
    workProductId: locator.workProduct.id,
    workProductUrl: locator.workProduct.url,
    workProductProjectId: locator.workProduct.projectId,
    workProductExecutionWorkspaceId: locator.workProduct.executionWorkspaceId,
    workProductCreatedByRunId: locator.workProduct.createdByRunId,
    workProductLastModifiedByRunId: locator.workProduct.lastModifiedByRunId,
    workProductStatus: locator.workProduct.status,
    workProductIsPrimary: locator.workProduct.isPrimary,
    workProductSourceTrust: locator.workProduct.sourceTrust ?? null,
    workProductUpdatedAt: locator.workProduct.updatedAt.toISOString(),
    workspaceId: locator.workspace.id,
    workspaceRepoUrl: locator.workspace.repoUrl,
    workspaceBranchName: locator.workspace.branchName,
    workspaceProjectWorkspaceId: locator.workspace.projectWorkspaceId,
    projectWorkspaceId: locator.projectWorkspace.id,
    projectWorkspaceRepoUrl: locator.projectWorkspace.repoUrl,
    projectWorkspaceUpdatedAt: locator.projectWorkspace.updatedAt.toISOString(),
  })).digest("hex");
}

export function extractBoundPullRequestReference(locator: ReviewEvidenceLocator): GitHubPullRequestReference {
  const references = extractGitHubPullRequestReferences([locator.workProduct.url]);
  if (references.length !== 1) {
    throw unprocessable("The pull-request work product must identify exactly one GitHub pull request.", {
      code: "execution_review_evidence_reference_ambiguous",
    });
  }
  const reference = references[0]!;
  if (
    !pullRequestMatchesWorkspaceRepository(reference, locator.workspace)
    || !pullRequestMatchesWorkspaceRepository(reference, locator.projectWorkspace)
  ) {
    throw unprocessable("The pull request repository does not match the configured project workspace.", {
      code: "execution_review_evidence_repository_mismatch",
    });
  }
  return reference;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("github_review_evidence_timeout")), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function resolveReviewEvidencePullRequest(input: {
  resolver: PullRequestMergeDetailsResolver;
  companyId: string;
  reference: GitHubPullRequestReference;
  expectedBranchName: string;
  expectedHeadSha: string;
  timeoutMs?: number;
}): Promise<Omit<PullRequestMergeDetails, "headRef" | "headSha" | "headRepositoryFullName"> & {
  headRef: string;
  headSha: string;
  headRepositoryFullName: string;
}> {
  let details: PullRequestMergeDetails;
  try {
    details = await withTimeout(
      input.resolver(input.companyId, input.reference),
      input.timeoutMs ?? REVIEW_EVIDENCE_GITHUB_TIMEOUT_MS,
    );
  } catch {
    throw conflict("The current pull-request revision could not be independently resolved in time.", {
      code: "execution_review_evidence_resolver_timeout",
    });
  }
  const observedHeadSha = details.headSha?.toLowerCase() ?? null;
  const expectedRepository = `${input.reference.owner}/${input.reference.repo}`.toLowerCase();
  const observedRepository = details.headRepositoryFullName?.toLowerCase() ?? null;
  if (
    details.state !== "open"
    || details.headRef !== input.expectedBranchName
    || !observedHeadSha
  ) {
    throw conflict("The current pull-request revision could not be independently verified as open.", {
      code: "execution_review_evidence_unverifiable",
      observedState: details.state,
    });
  }
  if (!observedRepository || observedRepository !== expectedRepository) {
    throw unprocessable("Fork pull-request heads cannot provide artifact review evidence.", {
      code: "execution_review_evidence_fork_head_rejected",
      expectedRepository,
      observedRepository,
    });
  }
  if (observedHeadSha !== input.expectedHeadSha) {
    throw conflict("The pull-request head changed before review evidence was recorded.", {
      code: "execution_review_evidence_revision_stale",
      expectedHeadSha: input.expectedHeadSha,
      currentHeadSha: observedHeadSha,
    });
  }
  return {
    ...details,
    headRef: details.headRef!,
    headSha: observedHeadSha,
    headRepositoryFullName: details.headRepositoryFullName!,
  };
}

type IssueService = ReturnType<typeof issueService>;
type ReviewIssue = NonNullable<Awaited<ReturnType<IssueService["getById"]>>>;

export type ReviewEvidenceAgentActor = {
  actorType: "agent";
  actorId: string;
  agentId: string;
  runId: string;
  agentApiKeyId: string | null;
  actorSource: "agent_key" | "agent_jwt";
};

function readNonEmptyString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function assertReviewStageBinding(
  issue: ReviewIssue,
  actor: ReviewEvidenceAgentActor,
  request: ApproveIssueReviewEvidence,
) {
  const state = parseIssueExecutionState(issue.executionState);
  const policy = normalizeIssueExecutionPolicy(issue.executionPolicy ?? null);
  const currentStageIndex = policy?.stages.findIndex((stage) => stage.id === state?.currentStageId) ?? -1;
  const currentStage = currentStageIndex >= 0 ? policy?.stages[currentStageIndex] ?? null : null;
  const directorStage = currentStageIndex >= 0 ? policy?.stages[currentStageIndex + 1] ?? null : null;
  const reviewerParticipant = currentStage?.participants.length === 1 ? currentStage.participants[0] ?? null : null;
  const directorParticipant = directorStage?.participants.length === 1 ? directorStage.participants[0] ?? null : null;
  if (
    issue.status !== "in_review"
    || state?.status !== "pending"
    || state.currentStageType !== "review"
    || state.currentParticipant?.type !== "agent"
    || state.currentParticipant.agentId !== actor.agentId
    || issue.assigneeAgentId !== actor.agentId
    || issue.assigneeUserId != null
    || reviewerParticipant?.type !== "agent"
    || reviewerParticipant.agentId !== actor.agentId
    || state.returnAssignee?.type !== "agent"
    || !state.returnAssignee.agentId
    || state.returnAssignee.agentId === actor.agentId
  ) {
    throw conflict("Artifact evidence requires an independent active agent reviewer.", {
      code: "execution_review_evidence_reviewer_mismatch",
    });
  }
  if (
    directorStage?.type !== "approval"
    || currentStageIndex + 1 !== policy!.stages.length - 1
    || directorParticipant?.type !== "user"
    || !directorParticipant.userId
    || directorParticipant.userId !== request.expectedDirectorUserId
  ) {
    throw conflict("Artifact evidence requires the exact configured final director.", {
      code: "execution_review_evidence_director_mismatch",
    });
  }
  return { state, policy };
}

function reviewerRunMatchesIssue(
  run: typeof heartbeatRuns.$inferSelect | null,
  issue: ReviewIssue,
  actor: ReviewEvidenceAgentActor,
) {
  return Boolean(
    run
    && run.id === actor.runId
    && issue.executionRunId === actor.runId
    && run.companyId === issue.companyId
    && run.agentId === actor.agentId
    && run.status === "running"
    && run.finishedAt == null
    && readNonEmptyString(run.contextSnapshot?.issueId) === issue.id
    && readNonEmptyString(run.contextSnapshot?.executionWorkspaceId) === issue.executionWorkspaceId,
  );
}

export async function findIssueExecutionReviewEvidenceReceipt(input: {
  db: Db;
  companyId: string;
  issueId: string;
  idempotencyKey: string;
}) {
  return input.db
    .select()
    .from(issueExecutionDecisions)
    .where(and(
      eq(issueExecutionDecisions.companyId, input.companyId),
      eq(issueExecutionDecisions.issueId, input.issueId),
      eq(issueExecutionDecisions.requestIdempotencyKey, input.idempotencyKey),
    ))
    .then((rows) => rows[0] ?? null);
}

export function recoverIssueExecutionReviewEvidenceReceipt(input: {
  row: typeof issueExecutionDecisions.$inferSelect;
  request: ApproveIssueReviewEvidence;
  actor: ReviewEvidenceAgentActor;
}): IssueExecutionReviewEvidenceReceipt {
  const { row } = input;
  const parsedSnapshot = issueExecutionArtifactSnapshotSchema.safeParse(row.artifactSnapshot);
  const complete =
    row.stageType === "review"
    && row.outcome === "approved"
    && row.actorAgentId === row.reviewerAgentIdSnapshot
    && row.actorUserId == null
    && row.reviewCycleId != null
    && row.requestIdempotencyKey != null
    && row.artifactWorkProductId != null
    && row.artifactRevision != null
    && row.artifactLocatorFingerprint != null
    && row.reviewerAgentIdSnapshot != null
    && row.reviewerRunIdSnapshot != null
    && row.reviewerActorSourceSnapshot != null
    && row.directorUserIdSnapshot != null
    && parsedSnapshot.success;
  if (!complete) {
    throw conflict("Stored artifact review evidence is incomplete.", {
      code: "execution_review_evidence_corrupt",
      decisionId: row.id,
    });
  }
  const snapshot = parsedSnapshot.data;
  const equivalent =
    row.body === input.request.comment.trim()
    && row.artifactWorkProductId === input.request.workProductId
    && row.artifactRevision === input.request.expectedHeadSha
    && row.directorUserIdSnapshot === input.request.expectedDirectorUserId
    && row.reviewerAgentIdSnapshot === input.actor.agentId
    && row.reviewerRunIdSnapshot === input.actor.runId
    && row.reviewerActorSourceSnapshot === input.actor.actorSource
    && snapshot.headSha === row.artifactRevision
    && snapshot.locatorFingerprint === row.artifactLocatorFingerprint
    && snapshot.reviewer.agentId === row.reviewerAgentIdSnapshot
    && snapshot.reviewer.runId === row.reviewerRunIdSnapshot
    && snapshot.reviewer.actorSource === row.reviewerActorSourceSnapshot
    && snapshot.director.userId === row.directorUserIdSnapshot;
  if (!equivalent) {
    throw conflict("The artifact review idempotency key was already used for a different request.", {
      code: "execution_review_evidence_idempotency_conflict",
      decisionId: row.id,
    });
  }
  return {
    decisionId: row.id,
    reviewCycleId: row.reviewCycleId!,
    workProductId: row.artifactWorkProductId!,
    artifactRevision: row.artifactRevision!,
    artifactSnapshot: snapshot,
  };
}

export async function recordIssueExecutionReviewEvidence(input: {
  db: Db;
  issueService: Pick<IssueService, "getByIdForUpdate" | "update">;
  activityLogger: typeof logActivity;
  existing: ReviewIssue;
  actor: ReviewEvidenceAgentActor;
  request: ApproveIssueReviewEvidence;
  resolver: PullRequestMergeDetailsResolver;
  assertSnapshotCurrent: (expected: ReviewIssue, current: ReviewIssue) => void;
}) {
  const { db, existing, actor, request } = input;
  const svc = input.issueService;
  assertReviewStageBinding(existing, actor, request);
  const preflightReviewerRun = await db.select().from(heartbeatRuns).where(and(
    eq(heartbeatRuns.id, actor.runId),
    eq(heartbeatRuns.companyId, existing.companyId),
    eq(heartbeatRuns.agentId, actor.agentId),
  )).then((rows) => rows[0] ?? null);
  if (!reviewerRunMatchesIssue(preflightReviewerRun, existing, actor)) {
    throw forbidden("The reviewer run is not the current live run for this issue workspace.", {
      code: "execution_review_evidence_run_mismatch",
    });
  }
  const preflightWorkProduct = await db
    .select()
    .from(issueWorkProducts)
    .where(and(
      eq(issueWorkProducts.id, request.workProductId),
      eq(issueWorkProducts.companyId, existing.companyId),
      eq(issueWorkProducts.issueId, existing.id),
    ))
    .then((rows) => rows[0] ?? null);
  const preflightWorkspace = existing.projectId && existing.executionWorkspaceId
    ? await db.select().from(executionWorkspaces).where(and(
        eq(executionWorkspaces.id, existing.executionWorkspaceId),
        eq(executionWorkspaces.companyId, existing.companyId),
        eq(executionWorkspaces.projectId, existing.projectId),
        eq(executionWorkspaces.sourceIssueId, existing.id),
      )).then((rows) => rows[0] ?? null)
    : null;
  const preflightProjectWorkspace = existing.projectId && existing.projectWorkspaceId
    ? await db.select().from(projectWorkspaces).where(and(
        eq(projectWorkspaces.id, existing.projectWorkspaceId),
        eq(projectWorkspaces.companyId, existing.companyId),
        eq(projectWorkspaces.projectId, existing.projectId),
      )).then((rows) => rows[0] ?? null)
    : null;
  if (
    !preflightWorkProduct?.url
    || preflightWorkProduct.type !== "pull_request"
    || preflightWorkProduct.provider !== "github"
    || preflightWorkProduct.status !== "ready_for_review"
    || preflightWorkProduct.isPrimary !== true
    || !preflightWorkProduct.projectId
    || !preflightWorkProduct.executionWorkspaceId
    || !preflightWorkProduct.createdByRunId
    || !preflightWorkProduct.lastModifiedByRunId
    || preflightWorkProduct.lastModifiedByRunId !== preflightWorkProduct.createdByRunId
    || isLowTrustQuarantined(preflightWorkProduct.sourceTrust)
    || (preflightWorkProduct.sourceTrust != null && preflightWorkProduct.sourceTrust.disposition !== "promoted")
  ) {
    throw unprocessable("Review evidence requires the trusted primary PR from this issue workspace.", {
      code: "execution_review_evidence_work_product_invalid",
    });
  }
  if (
    !preflightWorkspace?.repoUrl
    || !preflightWorkspace.branchName
    || !preflightWorkspace.projectWorkspaceId
    || !preflightProjectWorkspace?.repoUrl
  ) {
    throw unprocessable("The review artifact has no complete configured repository binding.", {
      code: "execution_review_evidence_locator_invalid",
    });
  }
  const preflightLocator: ReviewEvidenceLocator = {
    workProduct: {
      ...preflightWorkProduct,
      url: preflightWorkProduct.url,
      projectId: preflightWorkProduct.projectId,
      executionWorkspaceId: preflightWorkProduct.executionWorkspaceId,
      createdByRunId: preflightWorkProduct.createdByRunId,
      lastModifiedByRunId: preflightWorkProduct.lastModifiedByRunId,
    },
    workspace: {
      ...preflightWorkspace,
      repoUrl: preflightWorkspace.repoUrl,
      branchName: preflightWorkspace.branchName,
      projectWorkspaceId: preflightWorkspace.projectWorkspaceId,
    },
    projectWorkspace: {
      ...preflightProjectWorkspace,
      repoUrl: preflightProjectWorkspace.repoUrl,
    },
  };
  const preflightLocatorFingerprint = buildReviewEvidenceLocatorFingerprint(preflightLocator);
  const reference = extractBoundPullRequestReference(preflightLocator);
  const details = await resolveReviewEvidencePullRequest({
    resolver: input.resolver,
    companyId: existing.companyId,
    reference,
    expectedBranchName: preflightLocator.workspace.branchName,
    expectedHeadSha: request.expectedHeadSha,
  });

  const decisionId = randomUUID();
  const reviewCycleId = randomUUID();
  return db.transaction(async (tx) => {
    const lockedIssue = await svc.getByIdForUpdate(existing.id, tx);
    if (!lockedIssue) throw notFound("Issue not found");
    const racedReceipt = await findIssueExecutionReviewEvidenceReceipt({
      db: tx as unknown as Db,
      companyId: existing.companyId,
      issueId: existing.id,
      idempotencyKey: request.idempotencyKey,
    });
    if (racedReceipt) {
      return {
        issue: lockedIssue,
        evidence: recoverIssueExecutionReviewEvidenceReceipt({ row: racedReceipt, request, actor }),
        replayed: true,
      };
    }
    input.assertSnapshotCurrent(existing, lockedIssue);
    const { state, policy } = assertReviewStageBinding(lockedIssue, actor, request);
    if (lockedIssue.reviewPolicy != null && lockedIssue.reviewPolicy !== "anyone") {
      await assertIssueReviewVerdictActorAllowed(tx as unknown as Db, {
        issue: lockedIssue,
        actor: { type: actor.actorType, id: actor.actorId },
        reviewPolicy: lockedIssue.reviewPolicy,
      });
    }
    const reviewerRun = await tx.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.id, actor.runId),
      eq(heartbeatRuns.companyId, lockedIssue.companyId),
      eq(heartbeatRuns.agentId, actor.agentId),
    )).for("share").then((rows) => rows[0] ?? null);
    if (
      !reviewerRunMatchesIssue(reviewerRun, lockedIssue, actor)
    ) {
      throw forbidden("The reviewer run is not the current live run for this issue workspace.", {
        code: "execution_review_evidence_run_mismatch",
      });
    }
    const workProduct = await tx.select().from(issueWorkProducts).where(and(
      eq(issueWorkProducts.id, request.workProductId),
      eq(issueWorkProducts.companyId, lockedIssue.companyId),
      eq(issueWorkProducts.issueId, lockedIssue.id),
    )).for("update").then((rows) => rows[0] ?? null);
    const workProductTrust = !workProduct?.sourceTrust
      ? "implicit_standard" as const
      : workProduct.sourceTrust.disposition === "promoted" ? "promoted" as const : null;
    if (
      !workProduct
      || workProduct.type !== "pull_request"
      || workProduct.provider !== "github"
      || workProduct.status !== "ready_for_review"
      || workProduct.isPrimary !== true
      || !workProduct.url
      || !workProduct.createdByRunId
      || workProduct.lastModifiedByRunId !== workProduct.createdByRunId
      || !lockedIssue.projectId
      || workProduct.projectId !== lockedIssue.projectId
      || !lockedIssue.executionWorkspaceId
      || workProduct.executionWorkspaceId !== lockedIssue.executionWorkspaceId
      || isLowTrustQuarantined(workProduct.sourceTrust)
      || workProductTrust === null
    ) {
      throw unprocessable("Review evidence requires the trusted primary PR from this issue workspace.", {
        code: "execution_review_evidence_work_product_invalid",
      });
    }
    const workspace = await tx.select().from(executionWorkspaces).where(and(
      eq(executionWorkspaces.id, lockedIssue.executionWorkspaceId),
      eq(executionWorkspaces.companyId, lockedIssue.companyId),
      eq(executionWorkspaces.projectId, lockedIssue.projectId),
      eq(executionWorkspaces.sourceIssueId, lockedIssue.id),
    )).for("update").then((rows) => rows[0] ?? null);
    if (
      !workspace?.repoUrl
      || !workspace.branchName
      || !workspace.projectWorkspaceId
      || workspace.projectWorkspaceId !== lockedIssue.projectWorkspaceId
    ) {
      throw unprocessable("The issue execution workspace does not have a verifiable repository binding.", {
        code: "execution_review_evidence_workspace_invalid",
      });
    }
    const projectWorkspace = await tx.select().from(projectWorkspaces).where(and(
      eq(projectWorkspaces.id, workspace.projectWorkspaceId),
      eq(projectWorkspaces.companyId, lockedIssue.companyId),
      eq(projectWorkspaces.projectId, lockedIssue.projectId),
    )).for("share").then((rows) => rows[0] ?? null);
    if (!projectWorkspace?.repoUrl) {
      throw unprocessable("The configured project workspace has no canonical repository binding.", {
        code: "execution_review_evidence_project_workspace_invalid",
      });
    }
    const builderRun = await tx.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.id, workProduct.createdByRunId),
      eq(heartbeatRuns.companyId, lockedIssue.companyId),
    )).for("key share").then((rows) => rows[0] ?? null);
    const builderAgentId = state.returnAssignee?.type === "agent"
      ? state.returnAssignee.agentId
      : null;
    if (
      !builderRun
      || !builderAgentId
      || builderRun.agentId !== builderAgentId
      || readNonEmptyString(builderRun.contextSnapshot?.issueId) !== lockedIssue.id
      || readNonEmptyString(builderRun.contextSnapshot?.executionWorkspaceId) !== workspace.id
    ) {
      throw unprocessable("The pull-request work product has no matching builder-run provenance.", {
        code: "execution_review_evidence_builder_provenance_invalid",
      });
    }
    const lockedLocator: ReviewEvidenceLocator = {
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
        projectWorkspaceId: workspace.projectWorkspaceId,
      },
      projectWorkspace: { ...projectWorkspace, repoUrl: projectWorkspace.repoUrl },
    };
    const locatorFingerprint = buildReviewEvidenceLocatorFingerprint(lockedLocator);
    const lockedReference = extractBoundPullRequestReference(lockedLocator);
    if (
      locatorFingerprint !== preflightLocatorFingerprint
      || lockedReference.owner.toLowerCase() !== reference.owner.toLowerCase()
      || lockedReference.repo.toLowerCase() !== reference.repo.toLowerCase()
      || lockedReference.number !== reference.number
      || details.headRef !== workspace.branchName
      || details.headSha !== request.expectedHeadSha
    ) {
      throw conflict("The review artifact locator changed while GitHub was being resolved.", {
        code: "execution_review_evidence_locator_stale",
      });
    }
    const transition = applyIssueExecutionPolicyTransition({
      issue: lockedIssue,
      policy,
      previousPolicy: policy,
      executionPolicyGovernanceChanged: false,
      requestedStatus: "done",
      requestedAssigneePatch: {},
      actor: { agentId: actor.agentId, userId: null },
      allowBoardOverride: false,
      commentBody: request.comment,
    });
    if (transition.decision?.stageType !== "review" || transition.decision.outcome !== "approved") {
      throw conflict("The active execution stage is no longer an approvable review.", {
        code: "execution_review_evidence_stage_stale",
      });
    }
    const nextState = parseIssueExecutionState(transition.patch.executionState);
    if (nextState?.status !== "pending" || nextState.currentStageType !== "approval") {
      throw unprocessable("Artifact-bound review evidence requires a following approval stage.", {
        code: "execution_review_evidence_final_approval_required",
      });
    }
    if (nextState.currentParticipant?.type !== "user" || nextState.currentParticipant.userId !== request.expectedDirectorUserId) {
      throw conflict("The execution transition did not preserve the expected director.", {
        code: "execution_review_evidence_director_transition_mismatch",
      });
    }
    transition.patch.executionState = { ...nextState, lastDecisionId: decisionId };
    const updated = await svc.update(existing.id, {
      ...transition.patch,
      actorAgentId: actor.agentId,
      actorUserId: null,
    }, tx);
    if (!updated) throw notFound("Issue not found");
    const artifactSnapshot = {
      kind: "github_pull_request" as const,
      provider: "github" as const,
      canonicalRef: `github:${reference.owner.toLowerCase()}/${reference.repo.toLowerCase()}#${reference.number}`,
      locatorFingerprint,
      configuredRepository: {
        owner: reference.owner.toLowerCase(),
        repo: reference.repo.toLowerCase(),
        repoUrl: projectWorkspace.repoUrl,
      },
      headRef: details.headRef,
      headSha: details.headSha,
      observedState: "open" as const,
      observedAt: new Date().toISOString(),
      workProductTrust,
      reviewer: { agentId: actor.agentId, runId: actor.runId, actorSource: actor.actorSource },
      director: { userId: request.expectedDirectorUserId },
    };
    await tx.insert(issueExecutionDecisions).values({
      id: decisionId,
      companyId: updated.companyId,
      issueId: updated.id,
      stageId: transition.decision.stageId,
      stageType: transition.decision.stageType,
      actorAgentId: actor.agentId,
      actorUserId: null,
      outcome: transition.decision.outcome,
      body: transition.decision.body,
      reviewCycleId,
      requestIdempotencyKey: request.idempotencyKey,
      artifactWorkProductId: workProduct.id,
      artifactRevision: details.headSha,
      artifactLocatorFingerprint: locatorFingerprint,
      reviewerAgentIdSnapshot: actor.agentId,
      reviewerRunIdSnapshot: actor.runId,
      reviewerActorSourceSnapshot: actor.actorSource,
      directorUserIdSnapshot: request.expectedDirectorUserId,
      artifactSnapshot,
      createdByRunId: actor.runId,
    });
    await input.activityLogger(tx as unknown as Db, {
      companyId: updated.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
      action: "issue.execution_review_evidence_recorded",
      entityType: "issue",
      entityId: updated.id,
      details: {
        decisionId,
        reviewCycleId,
        workProductId: request.workProductId,
        artifactRevision: details.headSha,
        directorUserId: request.expectedDirectorUserId,
        idempotencyKey: request.idempotencyKey,
      },
    });
    return {
      issue: updated,
      evidence: {
        decisionId,
        reviewCycleId,
        workProductId: workProduct.id,
        artifactRevision: details.headSha,
        artifactSnapshot,
      },
      replayed: false,
    };
  });
}
