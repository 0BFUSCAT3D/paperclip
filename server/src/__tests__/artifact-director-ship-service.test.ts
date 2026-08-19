import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  acquireArtifactDirectorShipIssueLocks,
  activityLog,
  agents,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  executionWorkspaces,
  heartbeatRuns,
  issueArtifactDirectorShipments,
  issueExecutionDecisions,
  issueWorkProducts,
  issues,
  projects,
  projectWorkspaces,
} from "@paperclipai/db";
import {
  buildArtifactDirectorShipCandidate,
  confirmArtifactDirectorShip,
  getArtifactDirectorShipOperation,
  reconcileArtifactDirectorShips,
} from "../services/artifact-director-ship.ts";
import {
  applyIssueExecutionPolicyTransition,
  normalizeIssueExecutionPolicy,
} from "../services/issue-execution-policy.ts";
import { buildReviewEvidenceLocatorFingerprint } from "../services/issue-execution-review-evidence.ts";
import { issueService } from "../services/issues.ts";
import { workProductService } from "../services/work-products.ts";
import { executionWorkspaceService } from "../services/execution-workspaces.ts";
import { projectService } from "../services/projects.ts";
import { errorHandler } from "../middleware/index.ts";
import { issueRoutes } from "../routes/issues.ts";
import {
  acquireArtifactDirectorShipIssueLocks,
  assertIssueArtifactDirectorShipMutationAllowed,
  assertProjectWorkspaceArtifactDirectorShipMutationAllowed,
  assertWorkProductArtifactDirectorShipMutationAllowed,
  assertWorkspaceArtifactDirectorShipMutationAllowed,
} from "../services/artifact-director-ship-guards.ts";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("artifact-bound director Ship saga", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-director-ship-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueArtifactDirectorShipments);
    await db.delete(issueExecutionDecisions);
    await db.delete(issueWorkProducts);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(executionWorkspaces);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(companyMemberships);
    await db.delete(authUsers);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCandidate() {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const executionWorkspaceId = randomUUID();
    const issueId = randomUUID();
    const builderAgentId = randomUUID();
    const reviewerAgentId = randomUUID();
    const builderRunId = randomUUID();
    const reviewerRunId = randomUUID();
    const workProductId = randomUUID();
    const reviewDecisionId = randomUUID();
    const reviewCycleId = randomUUID();
    const directorUserId = `director-${randomUUID()}`;
    const headSha = "a".repeat(40);
    const mergeCommitSha = "b".repeat(40);
    const now = new Date();
    await db.insert(companies).values({ id: companyId, name: "Ship Co", issuePrefix: `S${companyId.slice(0, 5)}` });
    await db.insert(authUsers).values({
      id: directorUserId,
      name: "Director",
      email: `${directorUserId}@example.test`,
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: directorUserId,
      status: "active",
      membershipRole: "owner",
    });
    await db.insert(agents).values([
      {
        id: builderAgentId,
        companyId,
        name: "Builder",
        role: "engineer",
        status: "active",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: reviewerAgentId,
        companyId,
        name: "Reviewer",
        role: "reviewer",
        status: "active",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(projects).values({ id: projectId, companyId, name: "Reeve" });
    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Primary",
      repoUrl: "https://github.com/acme/reeve.git",
      isPrimary: true,
    });
    const policy = normalizeIssueExecutionPolicy({
      stages: [
        { id: randomUUID(), type: "review", participants: [{ id: randomUUID(), type: "agent", agentId: reviewerAgentId }] },
        { id: randomUUID(), type: "approval", participants: [{ id: randomUUID(), type: "user", userId: directorUserId }] },
      ],
    })!;
    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
      projectWorkspaceId,
      title: "Ship exact reviewed PR",
      status: "in_review",
      priority: "high",
      reviewPolicy: "not_creator",
      assigneeUserId: directorUserId,
      createdByAgentId: builderAgentId,
      responsibleUserId: directorUserId,
      issueNumber: 1,
      identifier: `SHP-${companyId.slice(0, 6)}-1`,
      executionPolicy: policy,
      executionState: {
        status: "pending",
        currentStageId: policy.stages[1]!.id,
        currentStageIndex: 1,
        currentStageType: "approval",
        currentParticipant: { ...policy.stages[1]!.participants[0] },
        returnAssignee: { type: "agent", agentId: builderAgentId },
        reviewRequest: null,
        completedStageIds: [policy.stages[0]!.id],
        lastDecisionId: reviewDecisionId,
        lastDecisionOutcome: "approved",
        changesRequestedCount: 0,
      },
    });
    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      projectWorkspaceId,
      sourceIssueId: issueId,
      mode: "isolated_workspace",
      strategyType: "worktree",
      name: "Ship workspace",
      status: "active",
      repoUrl: "https://github.com/acme/reeve.git",
      branchName: "codex/exact-ship",
    });
    await db.update(issues).set({ executionWorkspaceId }).where(eq(issues.id, issueId));
    await db.insert(heartbeatRuns).values([
      {
        id: builderRunId,
        companyId,
        agentId: builderAgentId,
        status: "succeeded",
        finishedAt: now,
        contextSnapshot: { issueId, executionWorkspaceId },
      },
      {
        id: reviewerRunId,
        companyId,
        agentId: reviewerAgentId,
        status: "succeeded",
        finishedAt: now,
        contextSnapshot: { issueId, executionWorkspaceId },
      },
    ]);
    await db.insert(issueWorkProducts).values({
      id: workProductId,
      companyId,
      projectId,
      issueId,
      executionWorkspaceId,
      type: "pull_request",
      provider: "github",
      title: "PR #42",
      url: "https://github.com/acme/reeve/pull/42",
      status: "ready_for_review",
      reviewState: "approved",
      isPrimary: true,
      createdByRunId: builderRunId,
      lastModifiedByRunId: builderRunId,
    });
    const [workProduct, workspace, projectWorkspace] = await Promise.all([
      db.select().from(issueWorkProducts).where(eq(issueWorkProducts.id, workProductId)).then((rows) => rows[0]!),
      db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, executionWorkspaceId)).then((rows) => rows[0]!),
      db.select().from(projectWorkspaces).where(eq(projectWorkspaces.id, projectWorkspaceId)).then((rows) => rows[0]!),
    ]);
    const locatorFingerprint = buildReviewEvidenceLocatorFingerprint({
      workProduct: {
        ...workProduct,
        url: workProduct.url!,
        projectId: workProduct.projectId!,
        executionWorkspaceId: workProduct.executionWorkspaceId!,
        createdByRunId: workProduct.createdByRunId!,
        lastModifiedByRunId: workProduct.lastModifiedByRunId!,
      },
      workspace: {
        ...workspace,
        repoUrl: workspace.repoUrl!,
        branchName: workspace.branchName!,
        projectWorkspaceId: workspace.projectWorkspaceId!,
      },
      projectWorkspace: { ...projectWorkspace, repoUrl: projectWorkspace.repoUrl! },
    });
    await db.insert(issueExecutionDecisions).values({
      id: reviewDecisionId,
      companyId,
      issueId,
      stageId: policy.stages[0]!.id,
      stageType: "review",
      actorAgentId: reviewerAgentId,
      actorUserId: null,
      outcome: "approved",
      body: "Reviewed exact head.",
      reviewCycleId,
      requestIdempotencyKey: randomUUID(),
      artifactWorkProductId: workProductId,
      artifactRevision: headSha,
      artifactLocatorFingerprint: locatorFingerprint,
      reviewerAgentIdSnapshot: reviewerAgentId,
      reviewerRunIdSnapshot: reviewerRunId,
      reviewerActorSourceSnapshot: "agent_key",
      directorUserIdSnapshot: directorUserId,
      artifactSnapshot: {
        kind: "github_pull_request",
        provider: "github",
        canonicalRef: "github:acme/reeve#42",
        locatorFingerprint,
        configuredRepository: { owner: "acme", repo: "reeve", repoUrl: projectWorkspace.repoUrl! },
        headRef: workspace.branchName!,
        headSha,
        observedState: "open",
        observedAt: now.toISOString(),
        workProductTrust: "implicit_standard",
        reviewer: { agentId: reviewerAgentId, runId: reviewerRunId, actorSource: "agent_key" },
        director: { userId: directorUserId },
      },
      createdByRunId: reviewerRunId,
    });
    const actor = { userId: directorUserId, actorSource: "local_implicit" as const };
    const open = {
      state: "open" as const,
      headRef: workspace.branchName!,
      headSha,
      headRepositoryFullName: "acme/reeve",
      mergeCommitSha: null,
    };
    const merged = { ...open, state: "merged" as const, mergeCommitSha };
    return {
      actor,
      companyId,
      issueId,
      workProductId,
      executionWorkspaceId,
      projectWorkspaceId,
      reviewDecisionId,
      reviewCycleId,
      headSha,
      mergeCommitSha,
      open,
      merged,
    };
  }

  function createShipApp(input: {
    actor: Record<string, unknown>;
    resolver: ReturnType<typeof vi.fn>;
    mergeExecutor: ReturnType<typeof vi.fn>;
  }) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = input.actor;
      next();
    });
    app.use("/api", issueRoutes(db, {} as any, {
      pullRequestMergeDetailsResolver: input.resolver,
      pullRequestMergeExecutor: input.mergeExecutor,
    }));
    app.use(errorHandler);
    return app;
  }

  async function requestFor(
    fixture: Awaited<ReturnType<typeof seedCandidate>>,
    resolver: ReturnType<typeof vi.fn>,
  ) {
    const candidate = await buildArtifactDirectorShipCandidate({
      db,
      issueId: fixture.issueId,
      actor: fixture.actor,
      resolver,
    });
    return {
      version: 1 as const,
      candidateSha256: candidate.candidateSha256,
      expectedReviewDecisionId: fixture.reviewDecisionId,
      expectedReviewCycleId: fixture.reviewCycleId,
      expectedWorkProductId: fixture.workProductId,
      expectedHeadSha: fixture.headSha,
      comment: "Director confirmed this exact reviewed artifact.",
    };
  }

  it("merges the exact open head, atomically completes, and replays without a second merge or approval", async () => {
    const fixture = await seedCandidate();
    const resolver = vi.fn()
      .mockResolvedValueOnce(fixture.open)
      .mockResolvedValueOnce(fixture.open)
      .mockResolvedValueOnce(fixture.open)
      .mockResolvedValueOnce(fixture.merged);
    const request = await requestFor(fixture, resolver);
    const mergeExecutor = vi.fn(async () => ({
      ok: true as const,
      kind: "merged" as const,
      provider: "github" as const,
      mergeMethod: "merge" as const,
      mergeCommitSha: fixture.mergeCommitSha,
      providerObservedAt: new Date().toISOString(),
    }));
    const idempotencyKey = randomUUID();

    const completed = await confirmArtifactDirectorShip({
      db,
      issueId: fixture.issueId,
      idempotencyKey,
      actor: fixture.actor,
      request,
      resolver,
      mergeExecutor,
    });
    expect(completed).toMatchObject({
      state: "completed",
      replayed: false,
      receipt: { mergeCommitSha: fixture.mergeCommitSha, artifactRevision: fixture.headSha },
      issue: { status: "done" },
    });
    const replayed = await confirmArtifactDirectorShip({
      db,
      issueId: fixture.issueId,
      idempotencyKey,
      actor: fixture.actor,
      request,
      resolver,
      mergeExecutor,
    });
    expect(replayed).toMatchObject({ state: "completed", replayed: true });
    expect(mergeExecutor).toHaveBeenCalledTimes(1);
    const decisions = await db.select().from(issueExecutionDecisions).where(eq(issueExecutionDecisions.issueId, fixture.issueId));
    expect(decisions.filter((decision) => decision.stageType === "approval")).toHaveLength(1);
    const [product] = await db.select().from(issueWorkProducts).where(eq(issueWorkProducts.id, fixture.workProductId));
    expect(product).toMatchObject({ status: "merged", reviewState: "approved" });
    await expect(db.delete(issues).where(eq(issues.id, fixture.issueId))).rejects.toBeTruthy();
    await expect(db.delete(issueWorkProducts).where(eq(issueWorkProducts.id, fixture.workProductId))).rejects.toBeTruthy();

    await expect(confirmArtifactDirectorShip({
      db,
      issueId: fixture.issueId,
      idempotencyKey,
      actor: fixture.actor,
      request: { ...request, comment: "Divergent confirmation" },
      resolver,
      mergeExecutor,
    })).rejects.toMatchObject({ status: 409, details: { code: "artifact_director_ship_idempotency_conflict" } });
  });

  it("hard-rejects a pull request already merged before durable intent", async () => {
    const fixture = await seedCandidate();
    const resolver = vi.fn(async () => fixture.merged);
    await expect(buildArtifactDirectorShipCandidate({
      db,
      issueId: fixture.issueId,
      actor: fixture.actor,
      resolver,
    })).rejects.toMatchObject({
      status: 409,
      details: { code: "artifact_director_ship_preintent_merge_rejected" },
    });
    expect(await db.select().from(issueArtifactDirectorShipments)).toHaveLength(0);
  });

  it("returns reconciliation state after an ambiguous timeout, then completes from exact observed merge", async () => {
    const fixture = await seedCandidate();
    const resolver = vi.fn()
      .mockResolvedValueOnce(fixture.open)
      .mockResolvedValueOnce(fixture.open)
      .mockResolvedValueOnce(fixture.open)
      .mockResolvedValueOnce(fixture.open);
    const request = await requestFor(fixture, resolver);
    const mergeExecutor = vi.fn(async () => ({
      ok: false as const,
      kind: "timed_out" as const,
      provider: "github" as const,
      mergeMethod: "merge" as const,
      httpStatus: null,
      retryable: true,
      providerObservedAt: new Date().toISOString(),
    }));
    const idempotencyKey = randomUUID();
    const pending = await confirmArtifactDirectorShip({
      db,
      issueId: fixture.issueId,
      idempotencyKey,
      actor: fixture.actor,
      request,
      resolver,
      mergeExecutor,
    });
    expect(pending.state).toBe("reconcile_required");
    await db.update(issueArtifactDirectorShipments).set({ nextAttemptAt: new Date(0) });
    const reconcileResolver = vi.fn(async () => fixture.merged);
    await reconcileArtifactDirectorShips({ db, resolver: reconcileResolver, mergeExecutor });
    const completed = await getArtifactDirectorShipOperation({
      db,
      issueId: fixture.issueId,
      idempotencyKey,
      actor: fixture.actor,
    });
    expect(completed).toMatchObject({ state: "completed", receipt: { mergeCommitSha: fixture.mergeCommitSha } });
    expect(mergeExecutor).toHaveBeenCalledTimes(1);
  });

  it("returns 412 and never calls merge when the exact head drifts after durable intent", async () => {
    const fixture = await seedCandidate();
    const drifted = { ...fixture.open, headSha: "c".repeat(40) };
    const resolver = vi.fn()
      .mockResolvedValueOnce(fixture.open)
      .mockResolvedValueOnce(fixture.open)
      .mockResolvedValueOnce(drifted);
    const request = await requestFor(fixture, resolver);
    const mergeExecutor = vi.fn();
    const idempotencyKey = randomUUID();
    await expect(confirmArtifactDirectorShip({
      db,
      issueId: fixture.issueId,
      idempotencyKey,
      actor: fixture.actor,
      request,
      resolver,
      mergeExecutor,
    })).rejects.toMatchObject({ status: 412 });
    expect(mergeExecutor).not.toHaveBeenCalled();
    const operation = await getArtifactDirectorShipOperation({
      db,
      issueId: fixture.issueId,
      idempotencyKey,
      actor: fixture.actor,
    });
    expect(operation.state).toBe("stale");
  });

  it("never receipts a remote merge observed after intent but before an authorized outbound attempt", async () => {
    const fixture = await seedCandidate();
    const resolver = vi.fn()
      .mockResolvedValueOnce(fixture.open)
      .mockResolvedValueOnce(fixture.open)
      .mockResolvedValueOnce(fixture.merged);
    const requestBody = await requestFor(fixture, resolver);
    const mergeExecutor = vi.fn();
    await expect(confirmArtifactDirectorShip({
      db,
      issueId: fixture.issueId,
      idempotencyKey: randomUUID(),
      actor: fixture.actor,
      request: requestBody,
      resolver,
      mergeExecutor,
    })).rejects.toMatchObject({ status: 412 });
    const [shipment] = await db.select().from(issueArtifactDirectorShipments)
      .where(eq(issueArtifactDirectorShipments.issueId, fixture.issueId));
    const [issue] = await db.select().from(issues).where(eq(issues.id, fixture.issueId));
    expect(shipment).toMatchObject({
      state: "stale",
      providerRequestStartedAt: null,
      completionReceipt: null,
      lastErrorCode: "artifact_director_ship_merge_before_authorized_attempt",
    });
    expect(issue!.status).toBe("in_review");
    expect(mergeExecutor).not.toHaveBeenCalled();
  });

  it.each([
    { name: "missing authoritative SHA", authoritativeSha: null, expectedCode: "merge_commit_sha_unavailable" },
    { name: "executor/GET SHA mismatch", authoritativeSha: "c".repeat(40), expectedCode: "merge_commit_sha_mismatch" },
  ])("keeps $name in reconciliation instead of manufacturing a receipt", async ({ authoritativeSha, expectedCode }) => {
    const fixture = await seedCandidate();
    let merged = false;
    const resolver = vi.fn(async () => merged
      ? { ...fixture.merged, mergeCommitSha: authoritativeSha }
      : fixture.open);
    const requestBody = await requestFor(fixture, resolver);
    const mergeExecutor = vi.fn(async () => {
      merged = true;
      return {
        ok: true as const,
        kind: "merged" as const,
        provider: "github" as const,
        mergeMethod: "merge" as const,
        mergeCommitSha: fixture.mergeCommitSha,
        providerObservedAt: new Date().toISOString(),
      };
    });
    const result = await confirmArtifactDirectorShip({
      db,
      issueId: fixture.issueId,
      idempotencyKey: randomUUID(),
      actor: fixture.actor,
      request: requestBody,
      resolver,
      mergeExecutor,
    });
    expect(result).toMatchObject({ state: "reconcile_required", receipt: null });
    expect(result.operation.lastErrorCode).toBe(expectedCode);
    const [shipment] = await db.select().from(issueArtifactDirectorShipments)
      .where(eq(issueArtifactDirectorShipments.issueId, fixture.issueId));
    expect(shipment!.providerRequestStartedAt).toBeInstanceOf(Date);
  });

  it("allows comments without stale fingerprint noise and completes later reconciliation", async () => {
    const fixture = await seedCandidate();
    const resolver = vi.fn(async () => fixture.open);
    const requestBody = await requestFor(fixture, resolver);
    const timedOutMerge = vi.fn(async () => ({
      ok: false as const,
      kind: "timed_out" as const,
      provider: "github" as const,
      mergeMethod: "merge" as const,
      httpStatus: null,
      retryable: true,
      providerObservedAt: new Date().toISOString(),
    }));
    const idempotencyKey = randomUUID();
    expect((await confirmArtifactDirectorShip({
      db, issueId: fixture.issueId, idempotencyKey, actor: fixture.actor,
      request: requestBody, resolver, mergeExecutor: timedOutMerge,
    })).state).toBe("reconcile_required");
    await issueService(db).addComment(fixture.issueId, "A safe status comment.", {
      userId: fixture.actor.userId,
    });
    await db.update(issueArtifactDirectorShipments).set({ nextAttemptAt: new Date(0) });
    await reconcileArtifactDirectorShips({
      db,
      resolver: vi.fn(async () => fixture.merged),
      mergeExecutor: timedOutMerge,
    });
    expect((await getArtifactDirectorShipOperation({
      db, issueId: fixture.issueId, idempotencyKey, actor: fixture.actor,
    })).state).toBe("completed");
  });

  it("fences generic final approval and every bound mutation after intent", async () => {
    const fixture = await seedCandidate();
    await expect(issueService(db).update(fixture.issueId, { status: "done", actorUserId: fixture.actor.userId }))
      .rejects.toMatchObject({ status: 409, details: { code: "artifact_director_ship_required" } });
    const [pendingIssue] = await db.select().from(issues).where(eq(issues.id, fixture.issueId));
    const policy = normalizeIssueExecutionPolicy(pendingIssue!.executionPolicy)!;
    const structuredApproval = applyIssueExecutionPolicyTransition({
      issue: pendingIssue!,
      policy,
      requestedStatus: "done",
      requestedAssigneePatch: {},
      actor: { agentId: null, userId: fixture.actor.userId },
      commentBody: "## Review: APPROVED\n\nShip it.",
    });
    await expect(issueService(db).update(fixture.issueId, {
      ...structuredApproval.patch,
      status: "done",
      actorUserId: fixture.actor.userId,
    })).rejects.toMatchObject({ status: 409, details: { code: "artifact_director_ship_required" } });

    const resolver = vi.fn()
      .mockResolvedValueOnce(fixture.open)
      .mockResolvedValueOnce(fixture.open)
      .mockResolvedValueOnce(fixture.open)
      .mockResolvedValueOnce(fixture.open);
    const request = await requestFor(fixture, resolver);
    const mergeExecutor = vi.fn(async () => ({
      ok: false as const,
      kind: "timed_out" as const,
      provider: "github" as const,
      mergeMethod: "merge" as const,
      httpStatus: null,
      retryable: true,
      providerObservedAt: new Date().toISOString(),
    }));
    await confirmArtifactDirectorShip({
      db,
      issueId: fixture.issueId,
      idempotencyKey: randomUUID(),
      actor: fixture.actor,
      request,
      resolver,
      mergeExecutor,
    });
    await expect(issueService(db).update(fixture.issueId, { title: "bypass" }))
      .rejects.toMatchObject({ status: 409, details: { code: "artifact_director_ship_in_progress" } });
    await expect(workProductService(db).update(fixture.workProductId, { title: "bypass" }))
      .rejects.toMatchObject({ status: 409, details: { code: "artifact_director_ship_in_progress" } });
    await expect(executionWorkspaceService(db).update(fixture.executionWorkspaceId, { name: "bypass" }))
      .rejects.toMatchObject({ status: 409, details: { code: "artifact_director_ship_in_progress" } });
    const [projectWorkspace] = await db.select().from(projectWorkspaces)
      .where(eq(projectWorkspaces.id, fixture.projectWorkspaceId));
    await expect(projectService(db).updateWorkspace(
      projectWorkspace!.projectId,
      fixture.projectWorkspaceId,
      { name: "bypass" },
    )).rejects.toMatchObject({ status: 409, details: { code: "artifact_director_ship_in_progress" } });
    await expect(projectService(db).removeWorkspace(
      projectWorkspace!.projectId,
      fixture.projectWorkspaceId,
    )).rejects.toMatchObject({ status: 409, details: { code: "artifact_director_ship_in_progress" } });
    await expect(issueService(db).remove(fixture.issueId))
      .rejects.toMatchObject({ status: 409, details: { code: "artifact_director_ship_in_progress" } });
  });

  it("serializes concurrent confirmations so only one live lease invokes GitHub", async () => {
    const fixture = await seedCandidate();
    let merged = false;
    const resolver = vi.fn(async () => merged ? fixture.merged : fixture.open);
    const request = await requestFor(fixture, resolver);
    let releaseMerge!: () => void;
    let mergeStarted!: () => void;
    const mergeStartedPromise = new Promise<void>((resolve) => { mergeStarted = resolve; });
    const releaseMergePromise = new Promise<void>((resolve) => { releaseMerge = resolve; });
    const mergeExecutor = vi.fn(async () => {
      mergeStarted();
      await releaseMergePromise;
      merged = true;
      return {
        ok: true as const,
        kind: "merged" as const,
        provider: "github" as const,
        mergeMethod: "merge" as const,
        mergeCommitSha: fixture.mergeCommitSha,
        providerObservedAt: new Date().toISOString(),
      };
    });
    const idempotencyKey = randomUUID();
    const first = confirmArtifactDirectorShip({
      db, issueId: fixture.issueId, idempotencyKey, actor: fixture.actor, request, resolver, mergeExecutor,
    });
    await mergeStartedPromise;
    const second = confirmArtifactDirectorShip({
      db, issueId: fixture.issueId, idempotencyKey, actor: fixture.actor, request, resolver, mergeExecutor,
    });
    const active = await second;
    expect(active.state).toBe("merge_in_flight");
    releaseMerge();
    expect((await first).state).toBe("completed");
    expect(mergeExecutor).toHaveBeenCalledTimes(1);
    const decisions = await db.select().from(issueExecutionDecisions).where(eq(issueExecutionDecisions.issueId, fixture.issueId));
    expect(decisions.filter((decision) => decision.stageType === "approval")).toHaveLength(1);
  });

  it.each([
    "issue",
    "work_product",
    "execution_workspace",
    "project_workspace",
  ] as const)("serializes a two-connection %s mutation win before prepare revalidation", async (target) => {
    const fixture = await seedCandidate();
    const resolver = vi.fn(async () => fixture.open);
    const requestBody = await requestFor(fixture, resolver);
    const contenderDb = createDb(tempDb!.connectionString);
    let releaseMutation!: () => void;
    let mutationStarted!: () => void;
    const releaseMutationPromise = new Promise<void>((resolve) => { releaseMutation = resolve; });
    const mutationStartedPromise = new Promise<void>((resolve) => { mutationStarted = resolve; });
    const mutation = contenderDb.transaction(async (tx) => {
      if (target === "issue") {
        await assertIssueArtifactDirectorShipMutationAllowed(tx as any, fixture.issueId, {});
        await tx.update(issues).set({ projectWorkspaceId: null }).where(eq(issues.id, fixture.issueId));
      } else if (target === "work_product") {
        await assertWorkProductArtifactDirectorShipMutationAllowed(tx as any, { workProductId: fixture.workProductId });
        await tx.update(issueWorkProducts).set({ url: "https://github.com/acme/reeve/pull/43" })
          .where(eq(issueWorkProducts.id, fixture.workProductId));
      } else if (target === "execution_workspace") {
        await assertWorkspaceArtifactDirectorShipMutationAllowed(tx as any, fixture.executionWorkspaceId);
        await tx.update(executionWorkspaces).set({ branchName: "codex/drifted" })
          .where(eq(executionWorkspaces.id, fixture.executionWorkspaceId));
      } else {
        await assertProjectWorkspaceArtifactDirectorShipMutationAllowed(tx as any, fixture.projectWorkspaceId);
        await tx.update(projectWorkspaces).set({ repoUrl: "https://github.com/acme/other.git" })
          .where(eq(projectWorkspaces.id, fixture.projectWorkspaceId));
      }
      mutationStarted();
      await releaseMutationPromise;
    });
    await mutationStartedPromise;
    const mergeExecutor = vi.fn();
    const confirmation = confirmArtifactDirectorShip({
      db,
      issueId: fixture.issueId,
      idempotencyKey: randomUUID(),
      actor: fixture.actor,
      request: requestBody,
      resolver,
      mergeExecutor,
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(mergeExecutor).not.toHaveBeenCalled();
    releaseMutation();
    await mutation;
    await expect(confirmation).rejects.toMatchObject({ status: 412 });
    expect(mergeExecutor).not.toHaveBeenCalled();
    await (contenderDb as any).$client.end();
  });

  it.each(["membership_removed", "reviewer_becomes_builder"] as const)(
    "rechecks locked prepare authority and evidence when $s wins concurrently",
    async (drift) => {
      const fixture = await seedCandidate();
      const resolver = vi.fn(async () => fixture.open);
      const requestBody = await requestFor(fixture, resolver);
      const contenderDb = createDb(tempDb!.connectionString);
      let release!: () => void;
      let changed!: () => void;
      const releasePromise = new Promise<void>((resolve) => { release = resolve; });
      const changedPromise = new Promise<void>((resolve) => { changed = resolve; });
      const mutation = contenderDb.transaction(async (tx) => {
        await acquireArtifactDirectorShipIssueLocks(tx as any, [fixture.issueId]);
        if (drift === "membership_removed") {
          await tx.update(companyMemberships).set({ status: "removed" })
            .where(eq(companyMemberships.principalId, fixture.actor.userId));
        } else {
          const [product] = await tx.select().from(issueWorkProducts)
            .where(eq(issueWorkProducts.id, fixture.workProductId));
          const [builderRun] = await tx.select().from(heartbeatRuns)
            .where(eq(heartbeatRuns.id, product!.createdByRunId!));
          const [decision] = await tx.select().from(issueExecutionDecisions)
            .where(eq(issueExecutionDecisions.id, fixture.reviewDecisionId));
          await tx.update(issueExecutionDecisions).set({
            actorAgentId: builderRun!.agentId,
            reviewerAgentIdSnapshot: builderRun!.agentId,
            artifactSnapshot: {
              ...(decision!.artifactSnapshot as Record<string, unknown>),
              reviewer: {
                ...((decision!.artifactSnapshot as any).reviewer as Record<string, unknown>),
                agentId: builderRun!.agentId,
              },
            } as any,
          })
            .where(eq(issueExecutionDecisions.id, fixture.reviewDecisionId));
        }
        changed();
        await releasePromise;
      });
      await changedPromise;
      const mergeExecutor = vi.fn();
      const confirmation = confirmArtifactDirectorShip({
        db,
        issueId: fixture.issueId,
        idempotencyKey: randomUUID(),
        actor: fixture.actor,
        request: requestBody,
        resolver,
        mergeExecutor,
      });
      await new Promise((resolve) => setTimeout(resolve, 25));
      release();
      await mutation;
      await expect(confirmation).rejects.toMatchObject({ status: drift === "membership_removed" ? 403 : 412 });
      expect(mergeExecutor).not.toHaveBeenCalled();
      expect(await db.select().from(issueArtifactDirectorShipments)
        .where(eq(issueArtifactDirectorShipments.issueId, fixture.issueId))).toHaveLength(0);
      await (contenderDb as any).$client.end();
    },
  );

  it.each([
    "issue",
    "work_product",
    "execution_workspace",
    "project_workspace",
  ] as const)("makes a two-connection %s mutation wait for prepare, then reject the active intent", async (target) => {
    const fixture = await seedCandidate();
    const resolver = vi.fn(async () => fixture.open);
    const requestBody = await requestFor(fixture, resolver);
    const contenderDb = createDb(tempDb!.connectionString);
    await db.execute(sql.raw(`
      CREATE FUNCTION artifact_ship_test_pause_prepare() RETURNS trigger AS $$
      BEGIN
        PERFORM pg_sleep(0.35);
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `));
    await db.execute(sql.raw(`
      CREATE TRIGGER artifact_ship_test_pause_prepare
      BEFORE INSERT ON issue_artifact_director_shipments
      FOR EACH ROW EXECUTE FUNCTION artifact_ship_test_pause_prepare()
    `));
    const timedOutMerge = vi.fn(async () => ({
      ok: false as const,
      kind: "timed_out" as const,
      provider: "github" as const,
      mergeMethod: "merge" as const,
      httpStatus: null,
      retryable: true,
      providerObservedAt: new Date().toISOString(),
    }));
    const confirmation = confirmArtifactDirectorShip({
      db,
      issueId: fixture.issueId,
      idempotencyKey: randomUUID(),
      actor: fixture.actor,
      request: requestBody,
      resolver,
      mergeExecutor: timedOutMerge,
    });
    await new Promise((resolve) => setTimeout(resolve, 75));
    let mutationSettled = false;
    const mutation = (async () => {
      if (target === "issue") {
        return issueService(contenderDb).update(fixture.issueId, { title: "blocked mutation" });
      }
      if (target === "work_product") {
        return workProductService(contenderDb).update(fixture.workProductId, { title: "blocked mutation" });
      }
      if (target === "execution_workspace") {
        return executionWorkspaceService(contenderDb).update(fixture.executionWorkspaceId, { name: "blocked mutation" });
      }
      const [workspace] = await contenderDb.select().from(projectWorkspaces)
        .where(eq(projectWorkspaces.id, fixture.projectWorkspaceId));
      return projectService(contenderDb).updateWorkspace(workspace!.projectId, fixture.projectWorkspaceId, {
        name: "blocked mutation",
      });
    })().then(
      (value) => ({ value, error: null }),
      (error: unknown) => ({ value: null, error }),
    ).finally(() => { mutationSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 75));
    expect(mutationSettled).toBe(false);
    expect((await confirmation).state).toBe("reconcile_required");
    expect((await mutation).error).toMatchObject({
      status: 409,
      details: { code: "artifact_director_ship_in_progress" },
    });
    await db.execute(sql.raw("DROP TRIGGER artifact_ship_test_pause_prepare ON issue_artifact_director_shipments"));
    await db.execute(sql.raw("DROP FUNCTION artifact_ship_test_pause_prepare()"));
    await (contenderDb as any).$client.end();
  });

  it("rolls back a failed atomic finalizer and lets reconciliation repair it without another merge", async () => {
    const fixture = await seedCandidate();
    let merged = false;
    const resolver = vi.fn(async () => merged ? fixture.merged : fixture.open);
    const requestBody = await requestFor(fixture, resolver);
    const mergeExecutor = vi.fn(async () => {
      merged = true;
      return {
        ok: true as const,
        kind: "merged" as const,
        provider: "github" as const,
        mergeMethod: "merge" as const,
        mergeCommitSha: fixture.mergeCommitSha,
        providerObservedAt: new Date().toISOString(),
      };
    });
    await db.execute(sql.raw(`
      CREATE FUNCTION artifact_ship_test_fail_complete() RETURNS trigger AS $$
      BEGIN
        IF NEW.state = 'completed' THEN
          RAISE EXCEPTION 'forced Ship finalizer failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `));
    await db.execute(sql.raw(`
      CREATE TRIGGER artifact_ship_test_fail_complete
      BEFORE UPDATE ON issue_artifact_director_shipments
      FOR EACH ROW EXECUTE FUNCTION artifact_ship_test_fail_complete()
    `));
    const idempotencyKey = randomUUID();
    await expect(confirmArtifactDirectorShip({
      db,
      issueId: fixture.issueId,
      idempotencyKey,
      actor: fixture.actor,
      request: requestBody,
      resolver,
      mergeExecutor,
    })).rejects.toBeTruthy();

    const [rolledBackIssue] = await db.select().from(issues).where(eq(issues.id, fixture.issueId));
    const [rolledBackShipment] = await db.select().from(issueArtifactDirectorShipments)
      .where(eq(issueArtifactDirectorShipments.issueId, fixture.issueId));
    const decisionsBeforeRepair = await db.select().from(issueExecutionDecisions)
      .where(eq(issueExecutionDecisions.issueId, fixture.issueId));
    expect(rolledBackIssue!.status).toBe("in_review");
    expect(rolledBackShipment).toMatchObject({ state: "merge_observed", completionReceipt: null });
    expect(decisionsBeforeRepair.filter((decision) => decision.stageType === "approval")).toHaveLength(0);

    await db.execute(sql.raw("DROP TRIGGER artifact_ship_test_fail_complete ON issue_artifact_director_shipments"));
    await db.execute(sql.raw("DROP FUNCTION artifact_ship_test_fail_complete()"));
    await reconcileArtifactDirectorShips({ db, resolver, mergeExecutor });
    const repaired = await getArtifactDirectorShipOperation({
      db,
      issueId: fixture.issueId,
      idempotencyKey,
      actor: fixture.actor,
    });
    expect(repaired).toMatchObject({ state: "completed", receipt: { mergeCommitSha: fixture.mergeCommitSha } });
    expect(mergeExecutor).toHaveBeenCalledTimes(1);
  });

  it("bounds a hung resolver and does not starve or abort another due reconciliation row", async () => {
    const hungFixture = await seedCandidate();
    const healthyFixture = await seedCandidate();
    const timedOutMerge = vi.fn(async () => ({
      ok: false as const,
      kind: "timed_out" as const,
      provider: "github" as const,
      mergeMethod: "merge" as const,
      httpStatus: null,
      retryable: true,
      providerObservedAt: new Date().toISOString(),
    }));
    const keys = new Map<string, string>();
    for (const fixture of [hungFixture, healthyFixture]) {
      const resolver = vi.fn(async () => fixture.open);
      const requestBody = await requestFor(fixture, resolver);
      const idempotencyKey = randomUUID();
      keys.set(fixture.issueId, idempotencyKey);
      await confirmArtifactDirectorShip({
        db, issueId: fixture.issueId, idempotencyKey, actor: fixture.actor,
        request: requestBody, resolver, mergeExecutor: timedOutMerge,
      });
    }
    await db.update(issueArtifactDirectorShipments).set({ nextAttemptAt: new Date(0) });
    const resolver = vi.fn(async (companyId: string) => {
      if (companyId === hungFixture.companyId) return new Promise<never>(() => undefined);
      if (companyId === healthyFixture.companyId) return healthyFixture.merged;
      throw new Error("unexpected company");
    });
    const startedAt = Date.now();
    const result = await reconcileArtifactDirectorShips({
      db,
      resolver,
      mergeExecutor: timedOutMerge,
      resolverTimeoutMs: 25,
    });
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(result.scanned).toBe(2);
    expect((await getArtifactDirectorShipOperation({
      db,
      issueId: healthyFixture.issueId,
      idempotencyKey: keys.get(healthyFixture.issueId)!,
      actor: healthyFixture.actor,
    })).state).toBe("completed");
    expect((await getArtifactDirectorShipOperation({
      db,
      issueId: hungFixture.issueId,
      idempotencyKey: keys.get(hungFixture.issueId)!,
      actor: hungFixture.actor,
    })).state).toBe("reconcile_required");
  });

  it("scans due reconciliation rows in next-attempt/id order and honors the per-state limit", async () => {
    const fixtures = [await seedCandidate(), await seedCandidate(), await seedCandidate()];
    const timedOutMerge = vi.fn(async () => ({
      ok: false as const,
      kind: "timed_out" as const,
      provider: "github" as const,
      mergeMethod: "merge" as const,
      httpStatus: null,
      retryable: true,
      providerObservedAt: new Date().toISOString(),
    }));
    for (const fixture of fixtures) {
      const resolver = vi.fn(async () => fixture.open);
      await confirmArtifactDirectorShip({
        db,
        issueId: fixture.issueId,
        idempotencyKey: randomUUID(),
        actor: fixture.actor,
        request: await requestFor(fixture, resolver),
        resolver,
        mergeExecutor: timedOutMerge,
      });
    }
    const rows = await db.select().from(issueArtifactDirectorShipments)
      .where(eq(issueArtifactDirectorShipments.state, "reconcile_required"));
    const byCompany = new Map(rows.map((row) => [row.companyId, row]));
    const dueOrder = [fixtures[1]!, fixtures[2]!, fixtures[0]!];
    for (const [index, fixture] of dueOrder.entries()) {
      await db.update(issueArtifactDirectorShipments).set({ nextAttemptAt: new Date(1_000 + index * 1_000) })
        .where(eq(issueArtifactDirectorShipments.id, byCompany.get(fixture.companyId)!.id));
    }
    const observedCompanies: string[] = [];
    await reconcileArtifactDirectorShips({
      db,
      resolver: vi.fn(async (companyId: string) => {
        observedCompanies.push(companyId);
        return fixtures.find((fixture) => fixture.companyId === companyId)!.open;
      }),
      mergeExecutor: timedOutMerge,
      limit: 2,
      now: () => new Date(10_000),
    });
    expect(observedCompanies.slice(0, 2)).toEqual([dueOrder[0]!.companyId, dueOrder[1]!.companyId]);
    expect(new Set(observedCompanies)).toEqual(new Set([dueOrder[0]!.companyId, dueOrder[1]!.companyId]));
  });

  it("maps Ship route authentication and operation states to 200, 202, 409, 412, and 404", async () => {
    const pendingFixture = await seedCandidate();
    const pendingResolver = vi.fn(async () => pendingFixture.open);
    const pendingRequest = await requestFor(pendingFixture, pendingResolver);
    const timedOutMerge = vi.fn(async () => ({
      ok: false as const,
      kind: "timed_out" as const,
      provider: "github" as const,
      mergeMethod: "merge" as const,
      httpStatus: null,
      retryable: true,
      providerObservedAt: new Date().toISOString(),
    }));
    const boardActor = {
      type: "board",
      userId: pendingFixture.actor.userId,
      companyIds: [pendingFixture.companyId],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    const pendingApp = createShipApp({ actor: boardActor, resolver: pendingResolver, mergeExecutor: timedOutMerge });
    const pendingKey = randomUUID();
    expect((await request(pendingApp)
      .put(`/api/v1/issues/${pendingFixture.issueId}/artifact-director-ships/${pendingKey}`)
      .send(pendingRequest)).status).toBe(202);
    expect((await request(pendingApp)
      .get(`/api/v1/issues/${pendingFixture.issueId}/artifact-director-ships/${pendingKey}`)).status).toBe(202);
    expect((await request(pendingApp)
      .get(`/api/v1/issues/${pendingFixture.issueId}/artifact-director-ships/not-a-uuid`)).status).toBe(400);
    expect((await request(pendingApp)
      .put(`/api/v1/issues/${pendingFixture.issueId}/artifact-director-ships/not-a-uuid`)
      .send(pendingRequest)).status).toBe(400);
    expect((await request(pendingApp)
      .put(`/api/v1/issues/${pendingFixture.issueId}/artifact-director-ships/${pendingKey}`)
      .send({ ...pendingRequest, comment: "Different intent" })).status).toBe(409);

    const completedFixture = await seedCandidate();
    let completedMerged = false;
    const completedResolver = vi.fn(async () => completedMerged ? completedFixture.merged : completedFixture.open);
    const completedRequest = await requestFor(completedFixture, completedResolver);
    const completedMerge = vi.fn(async () => {
      completedMerged = true;
      return {
        ok: true as const,
        kind: "merged" as const,
        provider: "github" as const,
        mergeMethod: "merge" as const,
        mergeCommitSha: completedFixture.mergeCommitSha,
        providerObservedAt: new Date().toISOString(),
      };
    });
    const completedApp = createShipApp({
      actor: { ...boardActor, userId: completedFixture.actor.userId, companyIds: [completedFixture.companyId] },
      resolver: completedResolver,
      mergeExecutor: completedMerge,
    });
    const completedKey = randomUUID();
    expect((await request(completedApp)
      .put(`/api/v1/issues/${completedFixture.issueId}/artifact-director-ships/${completedKey}`)
      .send(completedRequest)).status).toBe(200);
    expect((await request(completedApp)
      .get(`/api/v1/issues/${completedFixture.issueId}/artifact-director-ships/${completedKey}`)).status).toBe(200);

    const staleFixture = await seedCandidate();
    let staleObservation = staleFixture.open;
    const staleResolver = vi.fn(async () => staleObservation);
    const staleRequest = await requestFor(staleFixture, staleResolver);
    staleObservation = { ...staleFixture.open, headSha: "d".repeat(40) };
    const staleApp = createShipApp({
      actor: { ...boardActor, userId: staleFixture.actor.userId, companyIds: [staleFixture.companyId] },
      resolver: staleResolver,
      mergeExecutor: vi.fn(),
    });
    expect((await request(staleApp)
      .put(`/api/v1/issues/${staleFixture.issueId}/artifact-director-ships/${randomUUID()}`)
      .send(staleRequest)).status).toBe(412);

    const agentApp = createShipApp({
      actor: {
        type: "agent",
        agentId: randomUUID(),
        companyId: pendingFixture.companyId,
        runId: null,
        source: "agent_key",
      },
      resolver: pendingResolver,
      mergeExecutor: timedOutMerge,
    });
    expect((await request(agentApp)
      .get(`/api/v1/issues/${pendingFixture.issueId}/artifact-director-ship-candidate`)).status).toBe(403);
    const crossTenantApp = createShipApp({
      actor: { ...boardActor, companyIds: [randomUUID()], source: "session" },
      resolver: pendingResolver,
      mergeExecutor: timedOutMerge,
    });
    expect((await request(crossTenantApp)
      .get(`/api/v1/issues/${pendingFixture.issueId}/artifact-director-ship-candidate`)).status).toBe(404);
  });

  it("fails closed for a viewer, wrong director, fork head, branch drift, and provenance drift", async () => {
    const fixture = await seedCandidate();
    await db.update(companyMemberships).set({ membershipRole: "viewer" }).where(eq(companyMemberships.principalId, fixture.actor.userId));
    await expect(buildArtifactDirectorShipCandidate({
      db, issueId: fixture.issueId, actor: fixture.actor, resolver: vi.fn(async () => fixture.open),
    })).rejects.toMatchObject({ status: 403, details: { code: "artifact_director_ship_director_mismatch" } });
    await db.update(companyMemberships).set({ membershipRole: "owner" }).where(eq(companyMemberships.principalId, fixture.actor.userId));

    const wrongUserId = `wrong-${randomUUID()}`;
    const now = new Date();
    await db.insert(authUsers).values({
      id: wrongUserId, name: "Wrong", email: `${wrongUserId}@example.test`, emailVerified: true, createdAt: now, updatedAt: now,
    });
    await db.insert(companyMemberships).values({
      companyId: fixture.companyId, principalType: "user", principalId: wrongUserId, status: "active", membershipRole: "owner",
    });
    await expect(buildArtifactDirectorShipCandidate({
      db,
      issueId: fixture.issueId,
      actor: { userId: wrongUserId, actorSource: "session" },
      resolver: vi.fn(async () => fixture.open),
    })).rejects.toMatchObject({ status: 409, details: { code: "artifact_director_ship_director_mismatch" } });

    await expect(buildArtifactDirectorShipCandidate({
      db,
      issueId: fixture.issueId,
      actor: fixture.actor,
      resolver: vi.fn(async () => ({ ...fixture.open, headRepositoryFullName: "fork/reeve" })),
    })).rejects.toMatchObject({ status: 409, details: { code: "artifact_director_ship_revision_stale" } });
    await expect(buildArtifactDirectorShipCandidate({
      db,
      issueId: fixture.issueId,
      actor: fixture.actor,
      resolver: vi.fn(async () => ({ ...fixture.open, headRef: "wrong-branch" })),
    })).rejects.toMatchObject({ status: 409, details: { code: "artifact_director_ship_revision_stale" } });

    await db.update(issueWorkProducts).set({ lastModifiedByRunId: null }).where(eq(issueWorkProducts.id, fixture.workProductId));
    await expect(buildArtifactDirectorShipCandidate({
      db, issueId: fixture.issueId, actor: fixture.actor, resolver: vi.fn(async () => fixture.open),
    })).rejects.toMatchObject({ status: 409, details: { code: "artifact_director_ship_evidence_invalid" } });
  });
});
