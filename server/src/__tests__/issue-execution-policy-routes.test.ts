import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeIssueExecutionPolicy } from "../services/issue-execution-policy.ts";
import { buildReviewEvidenceLocatorFingerprint } from "../services/issue-execution-review-evidence.ts";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  getByIdForUpdate: vi.fn(),
  getByCreateIdempotencyKey: vi.fn(),
  findOpenAncestorCreatedByAgent: vi.fn(async () => null),
  assertCheckoutOwner: vi.fn(),
  update: vi.fn(),
  create: vi.fn(),
  createChild: vi.fn(),
  addComment: vi.fn(),
  findMentionedAgents: vi.fn(),
  getRelationSummaries: vi.fn(),
  listWakeableBlockedDependents: vi.fn(),
  getWakeableParentAfterChildCompletion: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  startNextQueuedRunForAgent: vi.fn(async () => undefined),
  wakeup: vi.fn(async () => undefined),
  triggerIssueMonitor: vi.fn(async () => ({ outcome: "triggered" as const })),
  reportRunActivity: vi.fn(async () => undefined),
  getRun: vi.fn(async () => null),
  getActiveRunForAgent: vi.fn(async () => null),
  cancelRun: vi.fn(async () => null),
}));

const mockGovernedIssueContractService = vi.hoisted(() => ({
  getReservation: vi.fn(),
  activate: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(async () => false),
  decide: vi.fn(),
  hasPermission: vi.fn(async () => false),
}));
const mockDbSelectWhere = vi.hoisted(() => vi.fn(() => ({
  for: () => ({
    then: (onFulfilled: (rows: unknown[]) => unknown, onRejected?: (reason: unknown) => unknown) =>
      Promise.resolve([{
        id: "55555555-5555-4555-8555-555555555555",
        companyId: "company-1",
        agentId: "33333333-3333-4333-8333-333333333333",
        contextSnapshot: { issueId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
        permissions: null,
      }]).then(onFulfilled, onRejected),
  }),
  then: (onFulfilled: (rows: unknown[]) => unknown, onRejected?: (reason: unknown) => unknown) =>
    Promise.resolve([{
      id: "55555555-5555-4555-8555-555555555555",
      companyId: "company-1",
      agentId: "33333333-3333-4333-8333-333333333333",
      contextSnapshot: { issueId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
      permissions: null,
    }]).then(onFulfilled, onRejected),
})));
const mockDbSelectFrom = vi.hoisted(() => vi.fn(() => ({ where: mockDbSelectWhere })));
const mockDbSelect = vi.hoisted(() => vi.fn(() => ({ from: mockDbSelectFrom })));
const mockDbInsertValues = vi.hoisted(() => vi.fn(async () => undefined));
const mockDbInsert = vi.hoisted(() => vi.fn(() => ({ values: mockDbInsertValues })));
const mockDb = vi.hoisted(() => ({
  select: mockDbSelect,
  insert: mockDbInsert,
  transaction: vi.fn(async (callback: (tx: {
    select: typeof mockDbSelect;
    insert: typeof mockDbInsert;
  }) => Promise<unknown>) => callback({ select: mockDbSelect, insert: mockDbInsert })),
}));

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));
const mockPullRequestMergeDetailsResolver = vi.hoisted(() => vi.fn(async () => ({
  state: "open" as const,
  headRef: "codex/reviewed-change",
  headSha: "abcdef0123456789abcdef0123456789abcdef01",
  headRepositoryFullName: "acme/reeve",
})));
const mockIssueThreadInteractionService = vi.hoisted(() => ({
  expirePendingInteractionsForTerminalIssue: vi.fn(async () => []),
  listForIssue: vi.fn(async () => []),
  expireRequestConfirmationsSupersededByComment: vi.fn(async () => []),
}));
const mockIssueApprovalService = vi.hoisted(() => ({
  listApprovalsForIssue: vi.fn(async () => []),
}));

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    companyService: () => ({
      getById: vi.fn(async () => ({ id: "company-1", attachmentMaxBytes: 10 * 1024 * 1024 })),
    }),
    accessService: () => mockAccessService,
    agentService: () => ({
      getById: vi.fn(async (agentId: string) => ({
        id: agentId,
        companyId: "company-1",
        permissions: null,
      })),
      resolveByReference: vi.fn(async (_companyId: string, reference: string) => ({
        ambiguous: false,
        agent: {
          id: reference,
          companyId: "company-1",
          status: "idle",
          orgChainHealth: { status: "healthy" },
        },
      })),
    }),
    companySkillService: () => ({
      completeTestRunForIssue: vi.fn(async () => null),
    }),
    documentAnnotationService: () => ({ remapOpenThreadsForDocument: async () => [] }),
    documentService: () => ({}),
    executionWorkspaceService: () => ({}),
    feedbackService: () => ({
      listIssueVotesForUser: vi.fn(async () => []),
      saveIssueVote: vi.fn(async () => ({ vote: null, consentEnabledNow: false, sharingEnabled: false })),
    }),
    goalService: () => ({}),
    heartbeatService: () => mockHeartbeatService,
    governedIssueContractService: () => mockGovernedIssueContractService,
    governedIssueEnvelopeSha256: vi.fn(() => "a".repeat(64)),
    governedIssueSha256: vi.fn(() => "c".repeat(64)),
    governedIssueReservationResponseIssue: (reservation: any) => reservation.activatedAt
      ? reservation.activatedIssueSnapshot
      : reservation.reservedIssueSnapshot,
    serializeGovernedIssueReservation: (reservation: any) => ({
      idempotencyKey: reservation.idempotencyKey,
      issueId: reservation.issueId,
      requestIntentSha256: reservation.requestIntentSha256,
      envelopeSha256: reservation.envelopeSha256,
      reservedIssueUpdatedAt: reservation.reservedIssueUpdatedAt.toISOString(),
      createdAt: reservation.createdAt.toISOString(),
    }),
    serializeGovernedIssueActivationReceipt: (reservation: any) => reservation.activatedAt ? ({
      version: 1,
      idempotencyKey: reservation.idempotencyKey,
      issueId: reservation.issueId,
      builderAgentId: reservation.builderAgentId,
      envelopeSha256: reservation.envelopeSha256,
      activationSha256: reservation.activationSha256,
      activatedAt: reservation.activatedAt.toISOString(),
      issueUpdatedAt: reservation.activatedIssueUpdatedAt.toISOString(),
      issueSnapshot: reservation.activatedIssueSnapshot,
      wake: {
        durable: true,
        idempotencyKey: `governed_issue_activation:v1:${reservation.id}`,
        requestId: reservation.wakeupRequestId,
        runId: reservation.heartbeatRunId,
        status: "queued",
      },
    }) : null,
    GOVERNED_ISSUE_LIFECYCLE_VERSION: 1,
    environmentService: () => ({
      getById: vi.fn(async () => null),
    }),
    instanceSettingsService: () => ({
      get: vi.fn(async () => ({
        id: "instance-settings-1",
        general: {
          censorUsernameInLogs: false,
          feedbackDataSharingPreference: "prompt",
        },
      })),
      listCompanyIds: vi.fn(async () => ["company-1"]),
    }),
    issueApprovalService: () => mockIssueApprovalService,
    issueReferenceService: () => ({
      deleteDocumentSource: async () => undefined,
      diffIssueReferenceSummary: () => ({
        addedReferencedIssues: [],
        removedReferencedIssues: [],
        currentReferencedIssues: [],
      }),
      emptySummary: () => ({ outbound: [], inbound: [] }),
      listIssueReferenceSummary: async () => ({ outbound: [], inbound: [] }),
      syncComment: async () => undefined,
      syncDocument: async () => undefined,
      syncIssue: async () => undefined,
    }),
    issueRecoveryActionService: () => ({
      getActiveForIssue: vi.fn(async () => null),
      listActiveForIssues: vi.fn(async () => new Map()),
    }),
    issueService: () => mockIssueService,
    issueThreadInteractionService: () => mockIssueThreadInteractionService,
    logActivity: mockLogActivity,
    projectService: () => ({}),
    routineService: () => ({
      syncRunStatusForIssue: vi.fn(async () => undefined),
    }),
    workProductService: () => ({}),
  }));
}

type TestActor =
  | {
      type: "board";
      userId: string;
      companyIds: string[];
      source: "local_implicit" | "session";
      isInstanceAdmin: boolean;
    }
  | {
      type: "agent";
      agentId: string;
      companyId: string;
      runId: string | null;
      source?: "agent_key" | "agent_jwt";
      keyId?: string;
      keyScope?:
        | { kind: "standard" }
        | { kind: "task_bridge"; parentIssueId?: string }
        | { kind: "skill_test"; issueId: string };
    };

async function createApp(actor?: TestActor) {
  const [{ errorHandler }, { issueRoutes }] = await Promise.all([
    import("../middleware/index.js"),
    import("../routes/issues.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor ?? {
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", issueRoutes(mockDb as any, {} as any, {
    pullRequestMergeDetailsResolver: mockPullRequestMergeDetailsResolver,
  }));
  app.use(errorHandler);
  return app;
}

function mockSelectRowsOnce(rows: unknown[]) {
  mockDbSelectWhere.mockImplementationOnce(() => ({
    for: () => Promise.resolve(rows),
    then: (
      onFulfilled: (value: unknown[]) => unknown,
      onRejected?: (reason: unknown) => unknown,
    ) => Promise.resolve(rows).then(onFulfilled, onRejected),
  }));
}

function reviewEvidenceFixture() {
  const reviewerAgentId = "44444444-4444-4444-8444-444444444444";
  const builderAgentId = "33333333-3333-4333-8333-333333333333";
  const reviewerRunId = "55555555-5555-4555-8555-555555555555";
  const builderRunId = "66666666-6666-4666-8666-666666666666";
  const projectId = "77777777-7777-4777-8777-777777777777";
  const executionWorkspaceId = "88888888-8888-4888-8888-888888888888";
  const projectWorkspaceId = "99999999-9999-4999-8999-999999999999";
  const policy = normalizeIssueExecutionPolicy({
    stages: [
      {
        id: "11111111-1111-4111-8111-111111111111",
        type: "review",
        participants: [{ type: "agent", agentId: reviewerAgentId }],
      },
      {
        id: "22222222-2222-4222-8222-222222222222",
        type: "approval",
        participants: [{ type: "user", userId: "director" }],
      },
    ],
  })!;
  const issue = {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    companyId: "company-1",
    projectId,
    projectWorkspaceId,
    executionWorkspaceId,
    status: "in_review",
    reviewPolicy: "anyone",
    assigneeAgentId: reviewerAgentId,
    assigneeUserId: null,
    executionRunId: reviewerRunId,
    createdByUserId: "director",
    identifier: "PAP-1002",
    title: "Artifact-bound review",
    executionPolicy: policy,
    executionState: {
      status: "pending",
      currentStageId: policy.stages[0].id,
      currentStageIndex: 0,
      currentStageType: "review",
      currentParticipant: { type: "agent", agentId: reviewerAgentId },
      returnAssignee: { type: "agent", agentId: builderAgentId },
      completedStageIds: [],
      lastDecisionId: null,
      lastDecisionOutcome: null,
    },
  };
  const workProduct = {
    id: "12121212-1212-4121-8121-121212121212",
    companyId: issue.companyId,
    projectId,
    issueId: issue.id,
    executionWorkspaceId,
    type: "pull_request",
    provider: "github",
    url: "https://github.com/acme/reeve/pull/42",
    status: "ready_for_review",
    isPrimary: true,
    sourceTrust: null,
    createdByRunId: builderRunId,
    lastModifiedByRunId: builderRunId,
    updatedAt: new Date("2026-08-19T08:00:00.000Z"),
  };
  const workspace = {
    id: executionWorkspaceId,
    companyId: issue.companyId,
    projectId,
    projectWorkspaceId,
    sourceIssueId: issue.id,
    repoUrl: "https://github.com/acme/reeve.git",
    branchName: "codex/reviewed-change",
  };
  const reviewerRun = {
    id: reviewerRunId,
    companyId: issue.companyId,
    agentId: reviewerAgentId,
    status: "running",
    finishedAt: null,
    contextSnapshot: { issueId: issue.id, executionWorkspaceId },
  };
  const builderRun = {
    id: builderRunId,
    companyId: issue.companyId,
    agentId: builderAgentId,
    contextSnapshot: { issueId: issue.id, executionWorkspaceId },
  };
  const projectWorkspace = {
    id: projectWorkspaceId,
    companyId: issue.companyId,
    projectId,
    repoUrl: "https://github.com/acme/reeve.git",
    updatedAt: new Date("2026-08-19T07:55:00.000Z"),
  };
  const payload = {
    idempotencyKey: "13131313-1313-4131-8131-131313131313",
    comment: "Reviewed this exact pull-request revision.",
    workProductId: workProduct.id,
    expectedHeadSha: "abcdef0123456789abcdef0123456789abcdef01",
    expectedDirectorUserId: "director",
  };
  const actor = {
    type: "agent" as const,
    agentId: reviewerAgentId,
    companyId: issue.companyId,
    runId: reviewerRunId,
  };
  return { actor, builderRun, issue, payload, policy, projectWorkspace, reviewerRun, workProduct, workspace };
}

function queueReviewEvidenceReads(fixture: ReturnType<typeof reviewEvidenceFixture>) {
  // Receipt lookup, mutation authorization, and the status-only guard.
  mockSelectRowsOnce([]);
  mockSelectRowsOnce([]);
  mockSelectRowsOnce([fixture.reviewerRun]);
  // Pre-resolve live reviewer and immutable local locator.
  mockSelectRowsOnce([fixture.reviewerRun]);
  mockSelectRowsOnce([fixture.workProduct]);
  mockSelectRowsOnce([fixture.workspace]);
  mockSelectRowsOnce([fixture.projectWorkspace]);
  // Under-lock builder-agent serialization, idempotency, and local revalidation.
  mockSelectRowsOnce([{ id: fixture.builderRun.agentId }]);
  mockSelectRowsOnce([]);
  mockSelectRowsOnce([fixture.reviewerRun]);
  mockSelectRowsOnce([fixture.workProduct]);
  mockSelectRowsOnce([fixture.workspace]);
  mockSelectRowsOnce([fixture.projectWorkspace]);
  mockSelectRowsOnce([fixture.builderRun]);
}

function persistedReviewEvidenceReceipt(
  fixture: ReturnType<typeof reviewEvidenceFixture>,
  overrides: Record<string, unknown> = {},
) {
  const locatorFingerprint = "a".repeat(64);
  return {
    id: "14141414-1414-4141-8141-141414141414",
    companyId: fixture.issue.companyId,
    issueId: fixture.issue.id,
    stageId: fixture.policy.stages[0].id,
    stageType: "review",
    actorAgentId: fixture.actor.agentId,
    actorUserId: null,
    outcome: "approved",
    body: fixture.payload.comment,
    reviewCycleId: "15151515-1515-4151-8151-151515151515",
    requestIdempotencyKey: fixture.payload.idempotencyKey,
    artifactWorkProductId: fixture.workProduct.id,
    artifactRevision: fixture.payload.expectedHeadSha,
    artifactLocatorFingerprint: locatorFingerprint,
    reviewerAgentIdSnapshot: fixture.actor.agentId,
    reviewerRunIdSnapshot: fixture.actor.runId,
    reviewerActorSourceSnapshot: "agent_key",
    directorUserIdSnapshot: fixture.payload.expectedDirectorUserId,
    artifactSnapshot: {
      kind: "github_pull_request",
      provider: "github",
      canonicalRef: "github:acme/reeve#42",
      locatorFingerprint,
      configuredRepository: {
        owner: "acme",
        repo: "reeve",
        repoUrl: fixture.workspace.repoUrl,
      },
      headRef: fixture.workspace.branchName,
      headSha: fixture.payload.expectedHeadSha,
      observedState: "open",
      observedAt: "2026-08-19T08:05:00.000Z",
      workProductTrust: "implicit_standard",
      reviewer: {
        agentId: fixture.actor.agentId,
        runId: fixture.actor.runId,
        actorSource: "agent_key",
      },
      director: { userId: fixture.payload.expectedDirectorUserId },
    },
    createdByRunId: fixture.actor.runId,
    createdAt: new Date("2026-08-19T08:05:00.000Z"),
    ...overrides,
  };
}

function directorShipCandidateFixture() {
  const fixture = reviewEvidenceFixture();
  const decision = persistedReviewEvidenceReceipt(fixture);
  const locatorFingerprint = buildReviewEvidenceLocatorFingerprint({
    workProduct: {
      ...fixture.workProduct,
      projectId: fixture.workProduct.projectId,
      executionWorkspaceId: fixture.workProduct.executionWorkspaceId,
      createdByRunId: fixture.workProduct.createdByRunId,
      lastModifiedByRunId: fixture.workProduct.lastModifiedByRunId,
    },
    workspace: {
      ...fixture.workspace,
      repoUrl: fixture.workspace.repoUrl,
      branchName: fixture.workspace.branchName,
      projectWorkspaceId: fixture.workspace.projectWorkspaceId,
    },
    projectWorkspace: { ...fixture.projectWorkspace, repoUrl: fixture.projectWorkspace.repoUrl },
  });
  Object.assign(decision, {
    artifactLocatorFingerprint: locatorFingerprint,
    artifactSnapshot: {
      ...decision.artifactSnapshot,
      locatorFingerprint,
    },
  });
  const issue = {
    ...fixture.issue,
    assigneeAgentId: null,
    assigneeUserId: "director",
    executionState: {
      ...fixture.issue.executionState,
      currentStageId: fixture.policy.stages[1].id,
      currentStageIndex: 1,
      currentStageType: "approval",
      currentParticipant: { type: "user", userId: "director" },
      completedStageIds: [fixture.policy.stages[0].id],
      lastDecisionId: decision.id,
      lastDecisionOutcome: "approved",
    },
    updatedAt: new Date("2026-08-19T08:06:00.000Z"),
  };
  return { ...fixture, issue, decision, locatorFingerprint };
}

function queueDirectorShipCandidateReads(fixture: ReturnType<typeof directorShipCandidateFixture>) {
  mockSelectRowsOnce([fixture.issue]);
  mockSelectRowsOnce([{ role: "owner" }]);
  mockSelectRowsOnce([fixture.decision]);
  mockSelectRowsOnce([fixture.workProduct]);
  mockSelectRowsOnce([fixture.workspace]);
  mockSelectRowsOnce([fixture.projectWorkspace]);
  mockSelectRowsOnce([fixture.builderRun]);
}

describe("issue execution policy routes", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../routes/issues.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.clearAllMocks();
    mockDbSelectWhere.mockReset();
    mockDbSelectFrom.mockReset();
    mockDbSelect.mockReset();
    mockIssueService.assertCheckoutOwner.mockResolvedValue({ adoptedFromRunId: null });
    mockIssueService.getByIdForUpdate.mockImplementation(async () => mockIssueService.getById());
    mockIssueService.findMentionedAgents.mockResolvedValue([]);
    mockIssueService.getRelationSummaries.mockResolvedValue({ blockedBy: [], blocks: [] });
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([]);
    mockIssueService.getWakeableParentAfterChildCompletion.mockResolvedValue(null);
    mockIssueThreadInteractionService.listForIssue.mockResolvedValue([]);
    mockIssueThreadInteractionService.expireRequestConfirmationsSupersededByComment.mockResolvedValue([]);
    mockIssueApprovalService.listApprovalsForIssue.mockResolvedValue([]);
    mockPullRequestMergeDetailsResolver.mockResolvedValue({
      state: "open",
      headRef: "codex/reviewed-change",
      headSha: "abcdef0123456789abcdef0123456789abcdef01",
      headRepositoryFullName: "acme/reeve",
    });
    mockDbSelect.mockImplementation(() => ({ from: mockDbSelectFrom }));
    mockDbSelectFrom.mockImplementation(() => ({ where: mockDbSelectWhere }));
    mockDbSelectWhere.mockImplementation(() => ({
      for: () => ({
        then: (onFulfilled: (rows: unknown[]) => unknown, onRejected?: (reason: unknown) => unknown) =>
          Promise.resolve([{
            id: "55555555-5555-4555-8555-555555555555",
            companyId: "company-1",
            agentId: "33333333-3333-4333-8333-333333333333",
            contextSnapshot: { issueId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
            permissions: null,
          }]).then(onFulfilled, onRejected),
      }),
      then: (onFulfilled: (rows: unknown[]) => unknown, onRejected?: (reason: unknown) => unknown) =>
        Promise.resolve([{
          id: "55555555-5555-4555-8555-555555555555",
          companyId: "company-1",
          agentId: "33333333-3333-4333-8333-333333333333",
          contextSnapshot: { issueId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
          permissions: null,
        }]).then(onFulfilled, onRejected),
    }));
    mockIssueService.createChild.mockResolvedValue({
      issue: {
        id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        companyId: "company-1",
        identifier: "PAP-1002",
        title: "Child issue",
      },
      parentBlockerAdded: false,
    });
    mockAccessService.canUser.mockResolvedValue(false);
    mockAccessService.decide.mockImplementation(async (input: { actor?: { type?: string; source?: string }; action?: string }) => {
      const allowed = input.actor?.type === "board" && input.actor.source === "local_implicit"
        ? true
        : input.actor?.type === "agent" && [
            "company_scope:read",
            "issue:read",
            "issue:mutate",
            "runtime:manage",
          ].includes(input.action ?? "")
          ? true
          : Boolean(await mockAccessService.canUser() || await mockAccessService.hasPermission());
      return {
        allowed,
        action: input.action,
        reason: allowed ? "allow_explicit_grant" : "deny_missing_grant",
        explanation: allowed ? "Allowed by test grant." : `Missing permission: ${input.action ?? "action"}`,
      };
    });
    mockAccessService.hasPermission.mockResolvedValue(false);
  });

  it("reauthorizes a terminal verdict against the review policy held under the update lock", async () => {
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "in_review",
      reviewPolicy: "anyone",
      assigneeAgentId: "33333333-3333-4333-8333-333333333333",
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1002",
      title: "Concurrent policy update",
      executionPolicy: null,
      executionState: null,
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.getByIdForUpdate.mockResolvedValue({
      ...issue,
      reviewPolicy: "human_only",
    });

    const res = await request(await createApp({
      type: "agent",
      agentId: "33333333-3333-4333-8333-333333333333",
      companyId: "company-1",
      runId: "55555555-5555-4555-8555-555555555555",
    }))
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ status: "done" });

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      details: {
        code: "review_policy_denied",
        policy: "human_only",
      },
    });
    expect(mockDb.transaction).toHaveBeenCalled();
    expect(mockIssueService.getByIdForUpdate).toHaveBeenCalled();
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("does not let a board user mark done during an active agent review", async () => {
    const policy = normalizeIssueExecutionPolicy({
      stages: [{
        id: "11111111-1111-4111-8111-111111111111",
        type: "review",
        participants: [{ type: "agent", agentId: "33333333-3333-4333-8333-333333333333" }],
      }],
    })!;
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "in_review",
      reviewPolicy: "anyone",
      assigneeAgentId: "33333333-3333-4333-8333-333333333333",
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1002",
      title: "Active agent review",
      executionPolicy: policy,
      executionState: {
        status: "pending",
        currentStageId: policy.stages[0].id,
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: "33333333-3333-4333-8333-333333333333" },
        returnAssignee: { type: "agent", agentId: "44444444-4444-4444-8444-444444444444" },
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    };
    mockIssueService.getById.mockResolvedValue(issue);

    const res = await request(await createApp())
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ status: "done", comment: "Ship it" });

    expect(res.status).toBe(422);
    expect(res.body.error).toContain("Only the active reviewer or approver");
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("propagates the reservation guard through generic PATCH without waking", async () => {
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      projectId: null,
      parentId: null,
      status: "backlog",
      reviewPolicy: "not_creator",
      assigneeAgentId: null,
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-RESERVED",
      title: "Reserved only",
      executionPolicy: null,
      executionState: null,
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.getByIdForUpdate.mockResolvedValue(issue);
    const app = await createApp();
    const { conflict } = await import("../errors.js");
    mockIssueService.update.mockRejectedValue(conflict(
      "Governed issue reservation must be activated through its versioned activation endpoint",
      { code: "governed_issue_reservation_activation_required", issueId: issue.id },
    ));

    const res = await request(app)
      .patch(`/api/issues/${issue.id}`)
      .send({
        status: "todo",
        assigneeAgentId: "44444444-4444-4444-8444-444444444444",
      });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body).toMatchObject({
      details: { code: "governed_issue_reservation_activation_required", issueId: issue.id },
    });
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
    expect(mockHeartbeatService.startNextQueuedRunForAgent).not.toHaveBeenCalled();
  });

  it("builds an exact artifact-bound director Ship candidate for the configured director", async () => {
    const fixture = directorShipCandidateFixture();
    mockIssueService.getById.mockResolvedValue(fixture.issue);
    const app = await createApp({
      type: "board",
      userId: "director",
      companyIds: [fixture.issue.companyId],
      source: "local_implicit",
      isInstanceAdmin: false,
    });
    queueDirectorShipCandidateReads(fixture);

    const res = await request(app)
      .get(`/api/v1/issues/${fixture.issue.id}/artifact-director-ship-candidate`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      version: 1,
      candidate: {
        policySha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        candidateSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        issue: { id: fixture.issue.id, currentStageId: fixture.policy.stages[1].id },
        review: {
          decisionId: fixture.decision.id,
          reviewCycleId: fixture.decision.reviewCycleId,
          workProductId: fixture.workProduct.id,
          headSha: fixture.payload.expectedHeadSha,
          locatorFingerprint: fixture.locatorFingerprint,
        },
        artifact: {
          canonicalRef: "github:acme/reeve#42",
          owner: "acme",
          repo: "reeve",
          number: 42,
          headSha: fixture.payload.expectedHeadSha,
        },
        director: { userId: "director", actorSource: "local_implicit" },
      },
    });
  });

  it("rejects a pull request already merged before durable Ship intent", async () => {
    const fixture = directorShipCandidateFixture();
    mockIssueService.getById.mockResolvedValue(fixture.issue);
    mockPullRequestMergeDetailsResolver.mockResolvedValueOnce({
      state: "merged",
      headRef: fixture.workspace.branchName,
      headSha: fixture.payload.expectedHeadSha,
      headRepositoryFullName: "acme/reeve",
    });
    const app = await createApp({
      type: "board",
      userId: "director",
      companyIds: [fixture.issue.companyId],
      source: "local_implicit",
      isInstanceAdmin: false,
    });
    queueDirectorShipCandidateReads(fixture);

    const res = await request(app)
      .get(`/api/v1/issues/${fixture.issue.id}/artifact-director-ship-candidate`);

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.details?.code).toBe("artifact_director_ship_preintent_merge_rejected");
  });

  it("hides cross-company Ship candidates and rejects agent callers", async () => {
    const fixture = directorShipCandidateFixture();
    mockIssueService.getById.mockResolvedValue(fixture.issue);
    const crossCompanyApp = await createApp({
      type: "board",
      userId: "director",
      companyIds: ["other-company"],
      source: "session",
      isInstanceAdmin: false,
    });
    const hidden = await request(crossCompanyApp)
      .get(`/api/v1/issues/${fixture.issue.id}/artifact-director-ship-candidate`);
    expect(hidden.status).toBe(404);

    const agentApp = await createApp(fixture.actor);
    const denied = await request(agentApp)
      .get(`/api/v1/issues/${fixture.issue.id}/artifact-director-ship-candidate`);
    expect(denied.status).toBe(403);
    expect(mockPullRequestMergeDetailsResolver).not.toHaveBeenCalled();
  });

  it("records review evidence only for the independently resolved pull-request head", async () => {
    const fixture = reviewEvidenceFixture();
    mockIssueService.getById.mockResolvedValue(fixture.issue);
    mockIssueService.getByIdForUpdate.mockResolvedValue(fixture.issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...fixture.issue,
      ...patch,
      updatedAt: new Date(),
    }));
    const app = await createApp(fixture.actor);
    queueReviewEvidenceReads(fixture);

    const res = await request(app)
      .post(`/api/issues/${fixture.issue.id}/execution-review-evidence`)
      .send(fixture.payload);

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.replayed).toBe(false);
    expect(res.body.evidence).toMatchObject({
      workProductId: fixture.workProduct.id,
      artifactRevision: "abcdef0123456789abcdef0123456789abcdef01",
      artifactSnapshot: {
        canonicalRef: "github:acme/reeve#42",
        headRef: "codex/reviewed-change",
        reviewer: {
          agentId: fixture.actor.agentId,
          runId: fixture.actor.runId,
          actorSource: "agent_key",
        },
        director: { userId: "director" },
      },
    });
    expect(mockIssueService.update).toHaveBeenCalledWith(
      fixture.issue.id,
      expect.objectContaining({
        status: "in_review",
        assigneeUserId: "director",
      }),
      expect.anything(),
    );
    expect(mockDbInsertValues).toHaveBeenCalledWith(expect.objectContaining({
      issueId: fixture.issue.id,
      stageId: fixture.policy.stages[0].id,
      stageType: "review",
      artifactWorkProductId: fixture.workProduct.id,
      artifactRevision: "abcdef0123456789abcdef0123456789abcdef01",
      requestIdempotencyKey: fixture.payload.idempotencyKey,
      reviewerAgentIdSnapshot: fixture.actor.agentId,
      reviewerRunIdSnapshot: fixture.actor.runId,
      directorUserIdSnapshot: "director",
    }));
  });

  it("rejects stale pull-request review evidence before mutating the issue", async () => {
    const fixture = reviewEvidenceFixture();
    mockIssueService.getById.mockResolvedValue(fixture.issue);
    mockIssueService.getByIdForUpdate.mockResolvedValue(fixture.issue);
    const app = await createApp(fixture.actor);
    queueReviewEvidenceReads(fixture);

    const res = await request(app)
      .post(`/api/issues/${fixture.issue.id}/execution-review-evidence`)
      .send({
        ...fixture.payload,
        comment: "Reviewed an old head.",
        expectedHeadSha: "1111111111111111111111111111111111111111",
      });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.details).toMatchObject({
      code: "execution_review_evidence_revision_stale",
      currentHeadSha: "abcdef0123456789abcdef0123456789abcdef01",
    });
    expect(mockIssueService.update).not.toHaveBeenCalled();
    expect(mockDbInsertValues).not.toHaveBeenCalled();
  });

  it("rejects self-review even when the active agent matches the review stage", async () => {
    const fixture = reviewEvidenceFixture();
    fixture.issue.executionState.returnAssignee = {
      type: "agent",
      agentId: fixture.actor.agentId,
    };
    mockIssueService.getById.mockResolvedValue(fixture.issue);
    mockIssueService.getByIdForUpdate.mockResolvedValue(fixture.issue);
    const app = await createApp(fixture.actor);
    mockSelectRowsOnce([]);
    mockSelectRowsOnce([]);
    mockSelectRowsOnce([]);

    const res = await request(app)
      .post(`/api/issues/${fixture.issue.id}/execution-review-evidence`)
      .send(fixture.payload);

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.details?.code).toBe("execution_review_evidence_reviewer_mismatch");
    expect(mockPullRequestMergeDetailsResolver).not.toHaveBeenCalled();
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("rejects an agent other than the exact active reviewer", async () => {
    const fixture = reviewEvidenceFixture();
    const wrongActor = {
      ...fixture.actor,
      agentId: "16161616-1616-4161-8161-161616161616",
      runId: "17171717-1717-4171-8171-171717171717",
    };
    mockIssueService.getById.mockResolvedValue(fixture.issue);
    mockIssueService.getByIdForUpdate.mockResolvedValue(fixture.issue);
    const app = await createApp(wrongActor);
    mockSelectRowsOnce([]);
    mockSelectRowsOnce([]);
    mockSelectRowsOnce([]);

    const res = await request(app)
      .post(`/api/issues/${fixture.issue.id}/execution-review-evidence`)
      .send(fixture.payload);

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toContain("cannot mutate another agent's issue");
    expect(mockPullRequestMergeDetailsResolver).not.toHaveBeenCalled();
  });

  it("rejects a director identity other than the exact final typed participant", async () => {
    const fixture = reviewEvidenceFixture();
    mockIssueService.getById.mockResolvedValue(fixture.issue);
    mockIssueService.getByIdForUpdate.mockResolvedValue(fixture.issue);
    const app = await createApp(fixture.actor);
    mockSelectRowsOnce([]);
    mockSelectRowsOnce([]);
    mockSelectRowsOnce([]);

    const res = await request(app)
      .post(`/api/issues/${fixture.issue.id}/execution-review-evidence`)
      .send({ ...fixture.payload, expectedDirectorUserId: "wrong-director" });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.details?.code).toBe("execution_review_evidence_director_mismatch");
    expect(mockPullRequestMergeDetailsResolver).not.toHaveBeenCalled();
  });

  it("requires a persisted reviewer run for the exact issue workspace", async () => {
    const fixture = reviewEvidenceFixture();
    mockIssueService.getById.mockResolvedValue(fixture.issue);
    mockIssueService.getByIdForUpdate.mockResolvedValue(fixture.issue);
    const app = await createApp(fixture.actor);
    mockSelectRowsOnce([]);
    mockSelectRowsOnce([]);
    mockSelectRowsOnce([]);
    mockSelectRowsOnce([]);

    const res = await request(app)
      .post(`/api/issues/${fixture.issue.id}/execution-review-evidence`)
      .send(fixture.payload);

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.details?.code).toBe("execution_review_evidence_run_mismatch");
    expect(mockPullRequestMergeDetailsResolver).not.toHaveBeenCalled();
  });

  it("rejects a historical reviewer run that is not the issue execution run", async () => {
    const fixture = reviewEvidenceFixture();
    fixture.issue.executionRunId = "18181818-1818-4181-8181-181818181818";
    mockIssueService.getById.mockResolvedValue(fixture.issue);
    mockIssueService.getByIdForUpdate.mockResolvedValue(fixture.issue);
    const app = await createApp(fixture.actor);
    mockSelectRowsOnce([]);
    mockSelectRowsOnce([]);
    mockSelectRowsOnce([fixture.reviewerRun]);
    mockSelectRowsOnce([fixture.reviewerRun]);

    const res = await request(app)
      .post(`/api/issues/${fixture.issue.id}/execution-review-evidence`)
      .send(fixture.payload);

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.details?.code).toBe("execution_review_evidence_run_mismatch");
    expect(mockPullRequestMergeDetailsResolver).not.toHaveBeenCalled();
  });

  it("rejects review evidence when the authenticated agent omits its run", async () => {
    const fixture = reviewEvidenceFixture();
    mockIssueService.getById.mockResolvedValue(fixture.issue);
    const app = await createApp({ ...fixture.actor, runId: null });

    const res = await request(app)
      .post(`/api/issues/${fixture.issue.id}/execution-review-evidence`)
      .send(fixture.payload);

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.details?.code).toBe("execution_review_evidence_agent_run_required");
    expect(mockDbSelect).not.toHaveBeenCalled();
  });

  it("rejects a quarantined pull-request work product", async () => {
    const fixture = reviewEvidenceFixture();
    fixture.workProduct.sourceTrust = {
      preset: "low_trust_review",
      disposition: "quarantined",
      sourceIssueId: fixture.issue.id,
      sourceRunId: fixture.builderRun.id,
      sourceAgentId: fixture.builderRun.agentId,
    };
    mockIssueService.getById.mockResolvedValue(fixture.issue);
    mockIssueService.getByIdForUpdate.mockResolvedValue(fixture.issue);
    const app = await createApp(fixture.actor);
    mockSelectRowsOnce([]);
    mockSelectRowsOnce([]);
    mockSelectRowsOnce([]);
    mockSelectRowsOnce([fixture.reviewerRun]);
    mockSelectRowsOnce([fixture.workProduct]);

    const res = await request(app)
      .post(`/api/issues/${fixture.issue.id}/execution-review-evidence`)
      .send(fixture.payload);

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.details?.code).toBe("execution_review_evidence_work_product_invalid");
    expect(mockPullRequestMergeDetailsResolver).not.toHaveBeenCalled();
  });

  it("rejects a pull request from a repository unrelated to the issue workspace", async () => {
    const fixture = reviewEvidenceFixture();
    fixture.workspace.repoUrl = "https://github.com/acme/unrelated.git";
    mockIssueService.getById.mockResolvedValue(fixture.issue);
    mockIssueService.getByIdForUpdate.mockResolvedValue(fixture.issue);
    const app = await createApp(fixture.actor);
    queueReviewEvidenceReads(fixture);

    const res = await request(app)
      .post(`/api/issues/${fixture.issue.id}/execution-review-evidence`)
      .send(fixture.payload);

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.details?.code).toBe("execution_review_evidence_repository_mismatch");
    expect(mockPullRequestMergeDetailsResolver).not.toHaveBeenCalled();
  });

  it("replays an equivalent idempotent request without advancing the stage again", async () => {
    const fixture = reviewEvidenceFixture();
    const receipt = persistedReviewEvidenceReceipt(fixture);
    mockIssueService.getById.mockResolvedValue(fixture.issue);
    const app = await createApp(fixture.actor);
    mockSelectRowsOnce([receipt]);

    const res = await request(app)
      .post(`/api/issues/${fixture.issue.id}/execution-review-evidence`)
      .send(fixture.payload);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.replayed).toBe(true);
    expect(res.body.evidence).toMatchObject({
      decisionId: receipt.id,
      reviewCycleId: receipt.reviewCycleId,
      workProductId: fixture.workProduct.id,
      artifactRevision: fixture.payload.expectedHeadSha,
    });
    expect(mockDb.transaction).not.toHaveBeenCalled();
    expect(mockIssueService.update).not.toHaveBeenCalled();
    expect(mockPullRequestMergeDetailsResolver).not.toHaveBeenCalled();
  });

  it("fails closed when an idempotent receipt contains only part of the evidence tuple", async () => {
    const fixture = reviewEvidenceFixture();
    const receipt = persistedReviewEvidenceReceipt(fixture, { artifactSnapshot: null });
    mockIssueService.getById.mockResolvedValue(fixture.issue);
    const app = await createApp(fixture.actor);
    mockSelectRowsOnce([receipt]);

    const res = await request(app)
      .post(`/api/issues/${fixture.issue.id}/execution-review-evidence`)
      .send(fixture.payload);

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.details?.code).toBe("execution_review_evidence_corrupt");
    expect(mockDb.transaction).not.toHaveBeenCalled();
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("does not let a board user remove the active policy while marking done", async () => {
    const policy = normalizeIssueExecutionPolicy({
      stages: [{
        id: "11111111-1111-4111-8111-111111111111",
        type: "review",
        participants: [{ type: "agent", agentId: "33333333-3333-4333-8333-333333333333" }],
      }],
    })!;
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "in_review",
      reviewPolicy: "anyone",
      assigneeAgentId: "33333333-3333-4333-8333-333333333333",
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1002",
      title: "Active governed review",
      executionPolicy: policy,
      executionState: {
        status: "pending",
        currentStageId: policy.stages[0].id,
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: "33333333-3333-4333-8333-333333333333" },
        returnAssignee: { type: "agent", agentId: "44444444-4444-4444-8444-444444444444" },
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    };
    mockIssueService.getById.mockResolvedValue(issue);

    const res = await request(await createApp())
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ status: "done", executionPolicy: null, comment: "Remove the review and ship" });

    expect(res.status).toBe(422);
    expect(res.body.details).toEqual({ code: "execution_policy_decision_policy_change_denied" });
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("does not let an agent remove existing execution policy governance", async () => {
    const policy = normalizeIssueExecutionPolicy({
      stages: [{
        id: "11111111-1111-4111-8111-111111111111",
        type: "review",
        participants: [{ type: "agent", agentId: "33333333-3333-4333-8333-333333333333" }],
      }],
    })!;
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "in_review",
      reviewPolicy: "anyone",
      assigneeAgentId: "33333333-3333-4333-8333-333333333333",
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1002",
      title: "Governed review",
      executionPolicy: policy,
      executionState: {
        status: "pending",
        currentStageId: policy.stages[0].id,
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: "33333333-3333-4333-8333-333333333333" },
        returnAssignee: { type: "agent", agentId: "44444444-4444-4444-8444-444444444444" },
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    };
    mockIssueService.getById.mockResolvedValue(issue);

    const res = await request(await createApp({
      type: "agent",
      agentId: "33333333-3333-4333-8333-333333333333",
      companyId: "company-1",
      runId: "55555555-5555-4555-8555-555555555555",
    }))
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ status: "done", executionPolicy: null, comment: "Bypass the review" });

    expect(res.status).toBe(403);
    expect(res.body.details).toEqual({ code: "execution_policy_governance_denied" });
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("lets the assignee agent update a monitor without changing existing governance", async () => {
    const policy = normalizeIssueExecutionPolicy({
      stages: [{
        id: "11111111-1111-4111-8111-111111111111",
        type: "review",
        participants: [{
          id: "22222222-2222-4222-8222-222222222222",
          type: "agent",
          agentId: "44444444-4444-4444-8444-444444444444",
        }],
      }],
    })!;
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "in_progress",
      reviewPolicy: "anyone",
      assigneeAgentId: "33333333-3333-4333-8333-333333333333",
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1002",
      title: "Governed work with monitor",
      executionPolicy: policy,
      executionState: null,
      monitorNextCheckAt: null,
      monitorWakeRequestedAt: null,
      monitorLastTriggeredAt: null,
      monitorAttemptCount: 0,
      monitorNotes: null,
      monitorScheduledBy: null,
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));

    const res = await request(await createApp({
      type: "agent",
      agentId: "33333333-3333-4333-8333-333333333333",
      companyId: "company-1",
      runId: "55555555-5555-4555-8555-555555555555",
    }))
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({
        executionPolicy: {
          ...policy,
          monitor: {
            nextCheckAt: "2026-12-01T12:00:00.000Z",
            notes: "Wait for external QA.",
          },
        },
      });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      expect.objectContaining({
        executionPolicy: expect.objectContaining({
          stages: policy.stages,
          monitor: expect.objectContaining({ scheduledBy: "assignee" }),
        }),
        monitorNextCheckAt: new Date("2026-12-01T12:00:00.000Z"),
      }),
      expect.anything(),
    );
  });

  it("lets the assignee agent update a monitor on legacy governance without explicit ids", async () => {
    const legacyPolicy = {
      mode: "normal",
      commentRequired: true,
      stages: [{
        type: "review",
        approvalsNeeded: 1,
        participants: [{
          type: "agent",
          agentId: "44444444-4444-4444-8444-444444444444",
        }],
      }],
    };
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "in_progress",
      reviewPolicy: "anyone",
      assigneeAgentId: "33333333-3333-4333-8333-333333333333",
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1002",
      title: "Legacy governed work with monitor",
      executionPolicy: legacyPolicy,
      executionState: null,
      monitorNextCheckAt: null,
      monitorWakeRequestedAt: null,
      monitorLastTriggeredAt: null,
      monitorAttemptCount: 0,
      monitorNotes: null,
      monitorScheduledBy: null,
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));

    const res = await request(await createApp({
      type: "agent",
      agentId: "33333333-3333-4333-8333-333333333333",
      companyId: "company-1",
      runId: "55555555-5555-4555-8555-555555555555",
    }))
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({
        executionPolicy: {
          ...legacyPolicy,
          monitor: {
            nextCheckAt: "2026-12-01T12:00:00.000Z",
            notes: "Wait for external QA.",
          },
        },
      });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      expect.objectContaining({
        executionPolicy: expect.objectContaining({
          monitor: expect.objectContaining({ scheduledBy: "assignee" }),
        }),
        monitorNextCheckAt: new Date("2026-12-01T12:00:00.000Z"),
      }),
      expect.anything(),
    );
  });

  it("materializes legacy execution identities before starting a governed stage", async () => {
    const legacyPolicy = {
      mode: "normal",
      commentRequired: true,
      stages: [{
        type: "review",
        approvalsNeeded: 1,
        participants: [{ type: "user", userId: "local-board" }],
      }],
    };
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "in_progress",
      reviewPolicy: "anyone",
      assigneeAgentId: "33333333-3333-4333-8333-333333333333",
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1002",
      title: "Legacy governed handoff",
      executionPolicy: legacyPolicy,
      executionState: null,
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));

    const res = await request(await createApp({
      type: "agent",
      agentId: "33333333-3333-4333-8333-333333333333",
      companyId: "company-1",
      runId: "55555555-5555-4555-8555-555555555555",
    }))
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ status: "in_review" });

    expect(res.status).toBe(200);
    const persistedPatch = mockIssueService.update.mock.calls[0]?.[1] as {
      executionPolicy?: { stages?: Array<{ id?: string; participants?: Array<{ id?: string }> }> };
      executionState?: { currentStageId?: string };
    };
    const persistedStage = persistedPatch.executionPolicy?.stages?.[0];
    expect(persistedStage?.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(persistedStage?.participants?.[0]?.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(persistedPatch.executionState?.currentStageId).toBe(persistedStage?.id);
  });

  it("does not clear an active legacy stage during an exact-policy monitor update", async () => {
    const legacyPolicy = {
      mode: "normal",
      commentRequired: true,
      stages: [{
        type: "review",
        approvalsNeeded: 1,
        participants: [{
          type: "agent",
          agentId: "44444444-4444-4444-8444-444444444444",
        }],
      }],
    };
    const activePolicy = normalizeIssueExecutionPolicy(legacyPolicy)!;
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "in_review",
      reviewPolicy: "anyone",
      assigneeAgentId: "44444444-4444-4444-8444-444444444444",
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1002",
      title: "Active legacy governed review",
      executionPolicy: legacyPolicy,
      executionState: {
        status: "pending",
        currentStageId: activePolicy.stages[0].id,
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: "44444444-4444-4444-8444-444444444444" },
        returnAssignee: { type: "agent", agentId: "33333333-3333-4333-8333-333333333333" },
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
      monitorNextCheckAt: null,
      monitorWakeRequestedAt: null,
      monitorLastTriggeredAt: null,
      monitorAttemptCount: 0,
      monitorNotes: null,
      monitorScheduledBy: null,
    };
    mockIssueService.getById.mockResolvedValue(issue);

    const res = await request(await createApp())
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({
        executionPolicy: {
          ...legacyPolicy,
          monitor: {
            nextCheckAt: "2026-12-01T12:00:00.000Z",
            notes: "Do not dissolve the active stage.",
          },
        },
      });

    expect(res.status).toBe(422);
    expect(res.body.details).toEqual({
      code: "execution_policy_stage_identity_mismatch",
      currentStageId: activePolicy.stages[0].id,
    });
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("does not let a board assignee patch bypass a mismatched legacy stage decision", async () => {
    const legacyPolicy = {
      mode: "normal",
      commentRequired: true,
      stages: [{
        type: "review",
        approvalsNeeded: 1,
        participants: [{
          type: "agent",
          agentId: "44444444-4444-4444-8444-444444444444",
        }],
      }],
    };
    const activePolicy = normalizeIssueExecutionPolicy(legacyPolicy)!;
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "in_review",
      reviewPolicy: "anyone",
      assigneeAgentId: "44444444-4444-4444-8444-444444444444",
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1002",
      title: "Active legacy governed review",
      executionPolicy: legacyPolicy,
      executionState: {
        status: "pending",
        currentStageId: activePolicy.stages[0].id,
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: "44444444-4444-4444-8444-444444444444" },
        returnAssignee: { type: "agent", agentId: "33333333-3333-4333-8333-333333333333" },
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    };
    mockIssueService.getById.mockResolvedValue(issue);

    const res = await request(await createApp())
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({
        status: "done",
        assigneeUserId: "local-board",
        comment: "Bypass the missing stage identity.",
      });

    expect(res.status).toBe(422);
    expect(res.body.details).toEqual({
      code: "execution_policy_stage_identity_mismatch",
      currentStageId: activePolicy.stages[0].id,
    });
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "reassigns",
      body: { assigneeAgentId: "55555555-5555-4555-8555-555555555555" },
      expectedAssignees: {
        assigneeAgentId: "55555555-5555-4555-8555-555555555555",
      },
    },
    {
      name: "unassigns",
      body: { assigneeAgentId: null, assigneeUserId: null },
      expectedAssignees: { assigneeAgentId: null, assigneeUserId: null },
    },
  ])("$name a mismatched legacy stage without restoring its return assignee", async ({ body, expectedAssignees }) => {
    const legacyPolicy = {
      mode: "normal",
      commentRequired: true,
      stages: [{
        type: "review",
        approvalsNeeded: 1,
        participants: [{
          type: "agent",
          agentId: "44444444-4444-4444-8444-444444444444",
        }],
      }],
    };
    const activePolicy = normalizeIssueExecutionPolicy(legacyPolicy)!;
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "in_review",
      reviewPolicy: "anyone",
      assigneeAgentId: "44444444-4444-4444-8444-444444444444",
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1002",
      title: "Active legacy governed review",
      executionPolicy: legacyPolicy,
      executionState: {
        status: "pending",
        currentStageId: activePolicy.stages[0].id,
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: "44444444-4444-4444-8444-444444444444" },
        returnAssignee: { type: "agent", agentId: "33333333-3333-4333-8333-333333333333" },
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));

    const res = await request(await createApp())
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send(body);

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      expect.objectContaining({
        status: "in_progress",
        executionState: null,
        ...expectedAssignees,
      }),
      expect.anything(),
    );
  });

  it("rejects a decision when the execution stage changed before the update lock", async () => {
    const policy = normalizeIssueExecutionPolicy({
      stages: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          type: "review",
          participants: [{ type: "agent", agentId: "33333333-3333-4333-8333-333333333333" }],
        },
        {
          id: "22222222-2222-4222-8222-222222222222",
          type: "approval",
          participants: [{ type: "user", userId: "local-board" }],
        },
      ],
    })!;
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "in_review",
      reviewPolicy: "anyone",
      assigneeAgentId: "33333333-3333-4333-8333-333333333333",
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1002",
      title: "Concurrent stage advance",
      executionPolicy: policy,
      executionState: {
        status: "pending",
        currentStageId: policy.stages[0].id,
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: "33333333-3333-4333-8333-333333333333" },
        returnAssignee: { type: "agent", agentId: "44444444-4444-4444-8444-444444444444" },
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.getByIdForUpdate.mockResolvedValue({
      ...issue,
      assigneeAgentId: null,
      assigneeUserId: "local-board",
      executionState: {
        ...issue.executionState,
        currentStageId: policy.stages[1].id,
        currentStageIndex: 1,
        currentStageType: "approval",
        currentParticipant: { type: "user", userId: "local-board" },
        completedStageIds: [policy.stages[0].id],
      },
    });

    const res = await request(await createApp({
      type: "agent",
      agentId: "33333333-3333-4333-8333-333333333333",
      companyId: "company-1",
      runId: "55555555-5555-4555-8555-555555555555",
    }))
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ status: "done", comment: "Review passed" });

    expect(res.status).toBe(409);
    expect(res.body.details).toEqual({
      code: "execution_stage_stale",
      expectedStageId: policy.stages[0].id,
      currentStageId: policy.stages[1].id,
    });
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("rejects a nonterminal update when governance appeared before the row lock", async () => {
    const initialIssue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "in_progress",
      reviewPolicy: "anyone",
      assigneeAgentId: "33333333-3333-4333-8333-333333333333",
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1002",
      title: "Initially ungoverned work",
      executionPolicy: null,
      executionState: null,
    };
    const policy = normalizeIssueExecutionPolicy({
      stages: [{
        id: "11111111-1111-4111-8111-111111111111",
        type: "review",
        participants: [{ type: "agent", agentId: "44444444-4444-4444-8444-444444444444" }],
      }],
    })!;
    mockIssueService.getById.mockResolvedValue(initialIssue);
    mockIssueService.getByIdForUpdate.mockResolvedValue({
      ...initialIssue,
      status: "in_review",
      assigneeAgentId: "44444444-4444-4444-8444-444444444444",
      executionPolicy: policy,
      executionState: {
        status: "pending",
        currentStageId: policy.stages[0].id,
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: "44444444-4444-4444-8444-444444444444" },
        returnAssignee: { type: "agent", agentId: "33333333-3333-4333-8333-333333333333" },
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    });

    const res = await request(await createApp())
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ status: "todo" });

    expect(res.status).toBe(409);
    expect(res.body.details).toEqual({
      code: "execution_stage_stale",
      expectedStageId: null,
      currentStageId: policy.stages[0].id,
    });
    expect(mockDb.transaction).toHaveBeenCalled();
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("uses a stable fingerprint for stored policies without explicit ids", async () => {
    const legacyPolicy = {
      mode: "normal",
      commentRequired: true,
      stages: [{
        type: "review",
        approvalsNeeded: 1,
        participants: [{ type: "agent", agentId: "44444444-4444-4444-8444-444444444444" }],
      }],
    };
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "in_progress",
      reviewPolicy: "anyone",
      assigneeAgentId: "33333333-3333-4333-8333-333333333333",
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1002",
      title: "Legacy governed work",
      executionPolicy: legacyPolicy,
      executionState: null,
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));

    const res = await request(await createApp())
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ title: "Legacy governed work, renamed" });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      expect.objectContaining({ title: "Legacy governed work, renamed" }),
      expect.anything(),
    );
  });

  it("rejects an agent-authored in_review transition without a review path", async () => {
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "todo",
      assigneeAgentId: "33333333-3333-4333-8333-333333333333",
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1003",
      title: "Missing review path",
      executionPolicy: null,
      executionState: null,
    };
    mockIssueService.getById.mockResolvedValue(issue);

    const res = await request(await createApp({
      type: "agent",
      agentId: "33333333-3333-4333-8333-333333333333",
      companyId: "company-1",
      runId: "55555555-5555-4555-8555-555555555555",
    }))
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ status: "in_review" });

    expect(res.status).toBe(422);
    expect(res.body.error).toContain("invalid_issue_disposition");
    expect(res.body.error).toContain("request_confirmation");
    expect(res.body.details).toMatchObject({
      code: "invalid_issue_disposition",
      missing: "review_path",
    });
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("allows an agent-authored in_review transition with a pending confirmation interaction", async () => {
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "todo",
      assigneeAgentId: "33333333-3333-4333-8333-333333333333",
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1004",
      title: "Pending confirmation",
      executionPolicy: null,
      executionState: null,
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueThreadInteractionService.listForIssue.mockResolvedValue([
      {
        id: "11111111-1111-4111-8111-111111111111",
        kind: "request_confirmation",
        status: "pending",
        createdByAgentId: "33333333-3333-4333-8333-333333333333",
        sourceRunId: "55555555-5555-4555-8555-555555555555",
      },
    ]);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));

    const res = await request(await createApp({
      type: "agent",
      agentId: "33333333-3333-4333-8333-333333333333",
      companyId: "company-1",
      runId: "55555555-5555-4555-8555-555555555555",
    }))
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ status: "in_review" });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      expect.objectContaining({ status: "in_review" }),
      expect.anything(),
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.updated",
        details: expect.not.objectContaining({ reviewInteractionId: expect.anything() }),
      }),
      expect.any(Array),
    );
    expect(mockLogActivity.mock.calls[0]?.[0]).toBe(mockIssueService.update.mock.calls[0]?.[2]);
  });

  it("binds an explicitly designated same-run confirmation to the review transition", async () => {
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "todo",
      assigneeAgentId: "33333333-3333-4333-8333-333333333333",
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1004",
      title: "Pending confirmation",
      executionPolicy: null,
      executionState: null,
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueThreadInteractionService.listForIssue.mockResolvedValue([{
      id: "11111111-1111-4111-8111-111111111111",
      kind: "request_confirmation",
      status: "pending",
      createdByAgentId: "33333333-3333-4333-8333-333333333333",
      sourceRunId: "55555555-5555-4555-8555-555555555555",
      payload: { version: 1, prompt: "Approve this review?" },
    }]);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));

    const res = await request(await createApp({
      type: "agent",
      agentId: "33333333-3333-4333-8333-333333333333",
      companyId: "company-1",
      runId: "55555555-5555-4555-8555-555555555555",
    }))
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({
        status: "in_review",
        reviewInteractionId: "11111111-1111-4111-8111-111111111111",
      });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      expect.not.objectContaining({ reviewInteractionId: expect.anything() }),
      expect.anything(),
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.updated",
        details: expect.objectContaining({
          reviewInteractionId: "11111111-1111-4111-8111-111111111111",
        }),
      }),
      expect.any(Array),
    );
  });

  it("binds a user-designated confirmation to the review transition activity", async () => {
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "todo",
      assigneeAgentId: null,
      assigneeUserId: "local-board",
      createdByUserId: "local-board",
      identifier: "PAP-1004",
      title: "Pending confirmation",
      executionPolicy: null,
      executionState: null,
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueThreadInteractionService.listForIssue.mockResolvedValue([{
      id: "11111111-1111-4111-8111-111111111111",
      kind: "request_confirmation",
      status: "pending",
      createdByAgentId: null,
      createdByUserId: "local-board",
      sourceRunId: null,
      payload: { version: 1, prompt: "Approve this review?" },
    }]);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      changes: { status: { from: "todo", to: "in_review" } },
      updatedAt: new Date(),
    }));

    const res = await request(await createApp())
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({
        status: "in_review",
        reviewInteractionId: "11111111-1111-4111-8111-111111111111",
      });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      expect.not.objectContaining({ reviewInteractionId: expect.anything() }),
      expect.anything(),
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.updated",
        actorType: "user",
        actorId: "local-board",
        details: expect.objectContaining({
          reviewInteractionId: "11111111-1111-4111-8111-111111111111",
        }),
      }),
      expect.any(Array),
    );
  });

  it("keeps a review transition and its confirmation binding in one rollback boundary", async () => {
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "todo",
      assigneeAgentId: "33333333-3333-4333-8333-333333333333",
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1004",
      title: "Pending confirmation",
      executionPolicy: null,
      executionState: null,
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueThreadInteractionService.listForIssue.mockResolvedValue([{
      id: "11111111-1111-4111-8111-111111111111",
      kind: "request_confirmation",
      status: "pending",
      createdByAgentId: "33333333-3333-4333-8333-333333333333",
      sourceRunId: "55555555-5555-4555-8555-555555555555",
      payload: { version: 1, prompt: "Approve this review?" },
    }]);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      changes: { status: { from: "todo", to: "in_review" } },
      updatedAt: new Date(),
    }));
    mockLogActivity.mockRejectedValueOnce(new Error("activity insert failed"));

    const res = await request(await createApp({
      type: "agent",
      agentId: "33333333-3333-4333-8333-333333333333",
      companyId: "company-1",
      runId: "55555555-5555-4555-8555-555555555555",
    }))
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({
        status: "in_review",
        reviewInteractionId: "11111111-1111-4111-8111-111111111111",
      });

    expect(res.status).toBe(500);
    expect(mockDb.transaction).toHaveBeenCalled();
    const updateTx = mockIssueService.update.mock.calls[0]?.[2];
    const activityTx = mockLogActivity.mock.calls[0]?.[0];
    expect(activityTx).toBe(updateTx);
  });

  it("rejects a review binding to a confirmation from another run", async () => {
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "todo",
      assigneeAgentId: "33333333-3333-4333-8333-333333333333",
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1004",
      title: "Pending confirmation",
      executionPolicy: null,
      executionState: null,
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueThreadInteractionService.listForIssue.mockResolvedValue([{
      id: "11111111-1111-4111-8111-111111111111",
      kind: "request_confirmation",
      status: "pending",
      createdByAgentId: "33333333-3333-4333-8333-333333333333",
      sourceRunId: "44444444-4444-4444-8444-444444444444",
      payload: { version: 1, prompt: "Approve another run's request?" },
    }]);

    const res = await request(await createApp({
      type: "agent",
      agentId: "33333333-3333-4333-8333-333333333333",
      companyId: "company-1",
      runId: "55555555-5555-4555-8555-555555555555",
    }))
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({
        status: "in_review",
        reviewInteractionId: "11111111-1111-4111-8111-111111111111",
      });

    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({
      error: expect.stringContaining("created by this agent run"),
      details: { code: "invalid_review_interaction" },
    });
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("allows an agent-authored in_review transition with a typed execution participant", async () => {
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "todo",
      assigneeAgentId: "33333333-3333-4333-8333-333333333333",
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1005",
      title: "Execution participant",
      executionPolicy: null,
      executionState: null,
    };
    const policy = normalizeIssueExecutionPolicy({
      stages: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          type: "review",
          participants: [{ type: "agent", agentId: "44444444-4444-4444-8444-444444444444" }],
        },
      ],
    })!;
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));

    const res = await request(await createApp({
      type: "agent",
      agentId: "33333333-3333-4333-8333-333333333333",
      companyId: "company-1",
      runId: "55555555-5555-4555-8555-555555555555",
    }))
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ status: "in_review", executionPolicy: policy });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      expect.objectContaining({
        status: "in_review",
        executionState: expect.objectContaining({
          status: "pending",
          currentParticipant: expect.objectContaining({
            type: "agent",
            agentId: "44444444-4444-4444-8444-444444444444",
          }),
        }),
      }),
      expect.anything(),
    );
  });

  it("allows an agent-authored in_review transition with a scheduled monitor", async () => {
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "todo",
      assigneeAgentId: "33333333-3333-4333-8333-333333333333",
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1006",
      title: "External review monitor",
      executionPolicy: null,
      executionState: null,
      monitorAttemptCount: 0,
      monitorNextCheckAt: null,
      monitorLastTriggeredAt: null,
      monitorNotes: null,
      monitorScheduledBy: null,
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));

    const res = await request(await createApp({
      type: "agent",
      agentId: "33333333-3333-4333-8333-333333333333",
      companyId: "company-1",
      runId: "55555555-5555-4555-8555-555555555555",
    }))
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({
        status: "in_review",
        executionPolicy: {
          monitor: {
            nextCheckAt: "2026-12-01T12:00:00.000Z",
            scheduledBy: "assignee",
            notes: "Wait for external QA report.",
          },
        },
      });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      expect.objectContaining({
        status: "in_review",
        monitorNextCheckAt: new Date("2026-12-01T12:00:00.000Z"),
      }),
      expect.anything(),
    );
  });

  it("allows board-authored in_review repair updates without a review path", async () => {
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "todo",
      assigneeAgentId: "33333333-3333-4333-8333-333333333333",
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1007",
      title: "Board repair",
      executionPolicy: null,
      executionState: null,
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));

    const res = await request(await createApp())
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ status: "in_review" });

    expect(res.status).toBe(200);
    expect(mockDb.transaction).toHaveBeenCalled();
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.updated",
        actorType: "user",
        actorId: "local-board",
        details: expect.objectContaining({ status: "in_review" }),
      }),
      expect.any(Array),
    );
    expect(mockLogActivity.mock.calls[0]?.[0]).toBe(mockIssueService.update.mock.calls[0]?.[2]);
    expect(mockIssueThreadInteractionService.listForIssue).not.toHaveBeenCalled();
    expect(mockIssueApprovalService.listApprovalsForIssue).not.toHaveBeenCalled();
  });

  it("allows a board user to cancel an active agent review task", async () => {
    const policy = normalizeIssueExecutionPolicy({
      stages: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          type: "review",
          participants: [{ type: "agent", agentId: "33333333-3333-4333-8333-333333333333" }],
        },
      ],
    })!;
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "in_review",
      assigneeAgentId: "33333333-3333-4333-8333-333333333333",
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1008",
      title: "Active review",
      executionPolicy: policy,
      executionState: {
        status: "pending",
        currentStageId: "11111111-1111-4111-8111-111111111111",
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: "33333333-3333-4333-8333-333333333333" },
        returnAssignee: { type: "agent", agentId: "44444444-4444-4444-8444-444444444444" },
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));

    const res = await request(await createApp())
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ status: "cancelled" });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      expect.objectContaining({
        status: "cancelled",
        executionState: null,
        actorAgentId: null,
        actorUserId: "local-board",
      }),
      expect.anything(),
    );
    expect(mockHeartbeatService.cancelRun).not.toHaveBeenCalled();
  });

  it("allows a board user to cancel a drifted pending agent review task", async () => {
    const policy = normalizeIssueExecutionPolicy({
      stages: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          type: "review",
          participants: [{ type: "agent", agentId: "33333333-3333-4333-8333-333333333333" }],
        },
      ],
    })!;
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "blocked",
      assigneeAgentId: "44444444-4444-4444-8444-444444444444",
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1009",
      title: "Drifted active review",
      executionPolicy: policy,
      executionState: {
        status: "pending",
        currentStageId: "11111111-1111-4111-8111-111111111111",
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: "33333333-3333-4333-8333-333333333333" },
        returnAssignee: { type: "agent", agentId: "44444444-4444-4444-8444-444444444444" },
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));

    const res = await request(await createApp())
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ status: "cancelled" });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      expect.objectContaining({
        status: "cancelled",
        executionState: null,
        actorAgentId: null,
        actorUserId: "local-board",
      }),
      expect.anything(),
    );
    const updatePatch = mockIssueService.update.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(updatePatch.status).toBe("cancelled");
    expect(updatePatch.assigneeAgentId).toBeUndefined();
    expect(updatePatch.assigneeUserId).toBeUndefined();
    expect(mockHeartbeatService.cancelRun).not.toHaveBeenCalled();
  });

  it("keeps the review stage pending when a board user reassigns to an eligible participant", async () => {
    const policy = normalizeIssueExecutionPolicy({
      stages: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          type: "review",
          participants: [
            { type: "agent", agentId: "33333333-3333-4333-8333-333333333333" },
            { type: "agent", agentId: "55555555-5555-4555-8555-555555555555" },
          ],
        },
      ],
    })!;
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "in_review",
      assigneeAgentId: "33333333-3333-4333-8333-333333333333",
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1010",
      title: "Reassigned review",
      executionPolicy: policy,
      executionState: {
        status: "pending",
        currentStageId: "11111111-1111-4111-8111-111111111111",
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: "33333333-3333-4333-8333-333333333333" },
        returnAssignee: { type: "agent", agentId: "44444444-4444-4444-8444-444444444444" },
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));

    const res = await request(await createApp())
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ assigneeAgentId: "55555555-5555-4555-8555-555555555555" });

    expect(res.status).toBe(200);
    const updatePatch = mockIssueService.update.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(updatePatch.status).toBe("in_review");
    expect(updatePatch.assigneeAgentId).toBe("55555555-5555-4555-8555-555555555555");
    expect(updatePatch.assigneeUserId).toBeNull();
    expect(updatePatch.executionState).toMatchObject({
      status: "pending",
      currentStageId: "11111111-1111-4111-8111-111111111111",
      currentStageType: "review",
      currentParticipant: { type: "agent", agentId: "55555555-5555-4555-8555-555555555555" },
      returnAssignee: { type: "agent", agentId: "44444444-4444-4444-8444-444444444444" },
    });
    expect(mockHeartbeatService.cancelRun).not.toHaveBeenCalled();
  });

  it("dissolves the review when a board user reassigns an in_review task to a non-participant", async () => {
    const policy = normalizeIssueExecutionPolicy({
      stages: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          type: "review",
          participants: [{ type: "agent", agentId: "33333333-3333-4333-8333-333333333333" }],
        },
      ],
    })!;
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "in_review",
      assigneeAgentId: "33333333-3333-4333-8333-333333333333",
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1011",
      title: "Reassigned away from review",
      executionPolicy: policy,
      executionState: {
        status: "pending",
        currentStageId: "11111111-1111-4111-8111-111111111111",
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: "33333333-3333-4333-8333-333333333333" },
        returnAssignee: { type: "agent", agentId: "44444444-4444-4444-8444-444444444444" },
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));

    const res = await request(await createApp())
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ assigneeAgentId: "55555555-5555-4555-8555-555555555555" });

    expect(res.status).toBe(200);
    const updatePatch = mockIssueService.update.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(updatePatch.status).toBe("in_progress");
    expect(updatePatch.executionState).toBeNull();
    expect(updatePatch.assigneeAgentId).toBe("55555555-5555-4555-8555-555555555555");
    expect(mockHeartbeatService.cancelRun).not.toHaveBeenCalled();
  });

  it("does not auto-start execution review when reviewers are added to an already in_review issue", async () => {
    const policy = normalizeIssueExecutionPolicy({
      stages: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          type: "review",
          participants: [{ type: "agent", agentId: "33333333-3333-4333-8333-333333333333" }],
        },
      ],
    })!;
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "in_review",
      assigneeAgentId: null,
      assigneeUserId: "local-board",
      createdByUserId: "local-board",
      identifier: "PAP-999",
      title: "Execution policy edit",
      executionPolicy: null,
      executionState: null,
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));

    const res = await request(await createApp())
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ executionPolicy: policy });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      expect.objectContaining({
        executionPolicy: policy,
        actorAgentId: null,
        actorUserId: "local-board",
      }),
      expect.anything(),
    );
    const updatePatch = mockIssueService.update.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(updatePatch.status).toBeUndefined();
    expect(updatePatch.assigneeAgentId).toBeUndefined();
    expect(updatePatch.assigneeUserId).toBeUndefined();
    expect(updatePatch.executionState).toBeUndefined();
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
  });

  it("reserves a governed backlog issue without a wake, then activates it through the dedicated CAS route", async () => {
    const builderAgentId = "44444444-4444-4444-8444-444444444444";
    const reviewerAgentId = "55555555-5555-4555-8555-555555555555";
    const policy = normalizeIssueExecutionPolicy({
      stages: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          type: "review",
          participants: [{ type: "agent", agentId: reviewerAgentId }],
        },
        {
          id: "22222222-2222-4222-8222-222222222222",
          type: "approval",
          participants: [{ type: "user", userId: "local-board" }],
        },
      ],
    })!;
    const stagedIssue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      projectWorkspaceId: null,
      status: "backlog",
      workMode: "standard",
      harnessKind: null,
      priority: "high",
      projectId: null,
      goalId: null,
      parentId: null,
      assigneeAgentId: null,
      assigneeUserId: null,
      createdByAgentId: null,
      createdByUserId: "local-board",
      responsibleUserId: "local-board",
      reviewPolicy: "not_creator",
      issueNumber: 2001,
      identifier: "PAP-2001",
      title: "Staged governed work",
      description: null,
      requestDepth: 0,
      billingCode: null,
      assigneeAdapterOverrides: null,
      executionPolicy: policy,
      executionState: null,
      executionWorkspaceId: null,
      executionWorkspacePreference: null,
      executionWorkspaceSettings: null,
      hiddenAt: null,
      createdAt: new Date("2026-08-19T12:00:00.000Z"),
      updatedAt: new Date("2026-08-19T12:00:00.000Z"),
    };
    const reservation = {
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      companyId: "company-1",
      idempotencyKey: "reeve-build:ingress-42",
      issueId: stagedIssue.id,
      requestIntentSha256: "c".repeat(64),
      envelopeSha256: "a".repeat(64),
      reservedIssueSnapshot: {
        ...stagedIssue,
        hiddenAt: undefined,
        createdAt: stagedIssue.createdAt.toISOString(),
        updatedAt: stagedIssue.updatedAt.toISOString(),
      },
      reservedIssueUpdatedAt: stagedIssue.updatedAt,
      createdAt: new Date("2026-08-19T12:00:00.000Z"),
      activatedAt: null,
    };
    mockIssueService.create.mockResolvedValue(stagedIssue);
    mockGovernedIssueContractService.getReservation.mockResolvedValue(reservation);
    mockAccessService.decide.mockResolvedValue({ allowed: true });
    mockAccessService.canUser.mockResolvedValue(true);
    mockAccessService.hasPermission.mockResolvedValue(true);
    const app = await createApp();

    const createRes = await request(app)
      .post("/api/v1/companies/company-1/governed-issue-reservations")
      .send({
        idempotencyKey: reservation.idempotencyKey,
        issue: {
          title: stagedIssue.title,
          priority: "high",
          reviewPolicy: "not_creator",
          executionPolicy: policy,
        },
      });

    expect(createRes.status).toBe(201);
    expect(createRes.body).toMatchObject({
      version: 1,
      replayed: false,
      state: "reserved",
      activationReceipt: null,
      reservation: {
        idempotencyKey: reservation.idempotencyKey,
        issueId: stagedIssue.id,
        envelopeSha256: "a".repeat(64),
      },
    });
    expect(mockIssueService.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        status: "backlog",
        assigneeAgentId: null,
        assigneeUserId: null,
        idempotencyKey: reservation.idempotencyKey,
        executionPolicy: policy,
        governanceReservation: expect.objectContaining({ envelopeSha256: "a".repeat(64) }),
      }),
    );
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
    expect(mockHeartbeatService.startNextQueuedRunForAgent).not.toHaveBeenCalled();

    mockIssueService.getById.mockResolvedValue(stagedIssue);
    mockAccessService.decide.mockResolvedValueOnce({ allowed: false });
    const deniedLookup = await request(app)
      .get(`/api/v1/companies/company-1/governed-issue-reservations/${encodeURIComponent(reservation.idempotencyKey)}`);
    expect(deniedLookup.status).toBe(404);
    expect(deniedLookup.body).toEqual({ error: "Governed issue reservation not found" });

    mockAccessService.decide.mockResolvedValueOnce({ allowed: true });
    const allowedLookup = await request(app)
      .get(`/api/v1/companies/company-1/governed-issue-reservations/${encodeURIComponent(reservation.idempotencyKey)}`);
    expect(allowedLookup.status).toBe(200);
    expect(allowedLookup.body.issue).toMatchObject({ id: stagedIssue.id, status: "backlog" });

    const activatedIssue = {
      ...stagedIssue,
      status: "todo",
      assigneeAgentId: builderAgentId,
      updatedAt: new Date("2026-08-19T12:01:00.000Z"),
    };
    const activatedReservation = {
      ...reservation,
      builderAgentId,
      activationSha256: "b".repeat(64),
      activatedAt: new Date("2026-08-19T12:01:00.000Z"),
      activatedIssueUpdatedAt: activatedIssue.updatedAt,
      activatedIssueSnapshot: {
        ...activatedIssue,
        hiddenAt: undefined,
        createdAt: activatedIssue.createdAt.toISOString(),
        updatedAt: activatedIssue.updatedAt.toISOString(),
      },
      wakeupRequestId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      heartbeatRunId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    };
    mockIssueService.getById.mockResolvedValue(stagedIssue);
    mockGovernedIssueContractService.activate.mockResolvedValue({
      reservation: activatedReservation,
      issue: activatedReservation.activatedIssueSnapshot,
      replayed: false,
      needsDispatch: true,
    });
    mockHeartbeatService.startNextQueuedRunForAgent.mockRejectedValueOnce(
      new Error("simulated immediate dispatcher failure"),
    );

    const activateRes = await request(app)
      .put(`/api/v1/companies/company-1/governed-issue-reservations/${encodeURIComponent(reservation.idempotencyKey)}/activation`)
      .send({
        version: 1,
        expectedIssueId: stagedIssue.id,
        expectedIssueUpdatedAt: stagedIssue.updatedAt.toISOString(),
        expectedEnvelopeSha256: reservation.envelopeSha256,
        builderAgentId,
        issue: {
          title: stagedIssue.title,
          priority: "high",
          reviewPolicy: "not_creator",
          executionPolicy: policy,
        },
      });

    expect(activateRes.status).toBe(201);
    expect(mockGovernedIssueContractService.activate).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: "company-1",
        idempotencyKey: reservation.idempotencyKey,
        expectedIssueId: stagedIssue.id,
        expectedIssueUpdatedAt: stagedIssue.updatedAt.toISOString(),
        expectedEnvelopeSha256: reservation.envelopeSha256,
        builderAgentId,
      }),
    );
    expect(mockHeartbeatService.startNextQueuedRunForAgent).toHaveBeenCalledTimes(1);
    expect(activateRes.body.activationReceipt).toMatchObject({
      builderAgentId,
      issueUpdatedAt: activatedIssue.updatedAt.toISOString(),
      issueSnapshot: { id: stagedIssue.id, status: "todo", assigneeAgentId: builderAgentId },
      wake: { durable: true, requestId: activatedReservation.wakeupRequestId, runId: activatedReservation.heartbeatRunId },
    });
    expect(activateRes.body.issue).toEqual(activateRes.body.activationReceipt.issueSnapshot);

    const progressedLiveIssue = {
      ...activatedIssue,
      status: "in_review",
      updatedAt: new Date("2026-08-19T12:05:00.000Z"),
    };
    mockIssueService.getById.mockResolvedValue(progressedLiveIssue);
    mockGovernedIssueContractService.activate.mockResolvedValue({
      reservation: activatedReservation,
      issue: activatedReservation.activatedIssueSnapshot,
      replayed: true,
      needsDispatch: false,
    });
    const replayRes = await request(app)
      .put(`/api/v1/companies/company-1/governed-issue-reservations/${encodeURIComponent(reservation.idempotencyKey)}/activation`)
      .send({
        version: 1,
        expectedIssueId: stagedIssue.id,
        expectedIssueUpdatedAt: stagedIssue.updatedAt.toISOString(),
        expectedEnvelopeSha256: reservation.envelopeSha256,
        builderAgentId,
        issue: {
          title: stagedIssue.title,
          priority: "high",
          reviewPolicy: "not_creator",
          executionPolicy: policy,
        },
      });
    expect(replayRes.status).toBe(200);
    expect(replayRes.body.issue).toEqual(replayRes.body.activationReceipt.issueSnapshot);
    expect(replayRes.body.issue).toMatchObject({ status: "todo", assigneeAgentId: builderAgentId });
    expect(replayRes.body.issue.updatedAt).toBe(activatedIssue.updatedAt.toISOString());
  });

  it("reads an issue by create idempotency key without creating or waking", async () => {
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      projectId: null,
      parentId: null,
      identifier: "PAP-2002",
      title: "Existing Reeve filing",
      status: "todo",
      assigneeAgentId: null,
      assigneeUserId: null,
    };
    mockIssueService.getByCreateIdempotencyKey.mockResolvedValue(issue);

    const res = await request(await createApp())
      .get("/api/companies/company-1/issues/by-create-idempotency-key/reeve-build%3Aingress-42");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ issue: expect.objectContaining({ id: issue.id }) });
    expect(mockIssueService.getByCreateIdempotencyKey).toHaveBeenCalledWith(
      "company-1",
      "reeve-build:ingress-42",
    );
    expect(mockIssueService.create).not.toHaveBeenCalled();
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
  });

  it("allows an authorized agent to read an issue by create idempotency key", async () => {
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      projectId: null,
      parentId: null,
      identifier: "PAP-2003",
      title: "Authorized replay lookup",
      status: "todo",
      assigneeAgentId: "33333333-3333-4333-8333-333333333333",
      assigneeUserId: null,
    };
    mockIssueService.getByCreateIdempotencyKey.mockResolvedValue(issue);
    const actor = {
      type: "agent" as const,
      agentId: issue.assigneeAgentId,
      companyId: "company-1",
      runId: "55555555-5555-4555-8555-555555555555",
      source: "agent_key" as const,
      keyScope: { kind: "standard" as const },
    };

    const res = await request(await createApp(actor))
      .get("/api/companies/company-1/issues/by-create-idempotency-key/reeve-build%3Aauthorized");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ issue: expect.objectContaining({ id: issue.id }) });
    expect(mockAccessService.decide).toHaveBeenCalledWith(expect.objectContaining({
      actor,
      action: "issue:read",
      resource: expect.objectContaining({ issueId: issue.id }),
    }));
  });

  it.each([
    {
      name: "unrelated standard agent",
      actor: {
        type: "agent" as const,
        agentId: "44444444-4444-4444-8444-444444444444",
        companyId: "company-1",
        runId: "55555555-5555-4555-8555-555555555555",
        source: "agent_key" as const,
        keyScope: { kind: "standard" as const },
      },
    },
    {
      name: "task-bridge key",
      actor: {
        type: "agent" as const,
        agentId: "44444444-4444-4444-8444-444444444444",
        companyId: "company-1",
        runId: "55555555-5555-4555-8555-555555555555",
        source: "agent_key" as const,
        keyId: "66666666-6666-4666-8666-666666666666",
        keyScope: { kind: "task_bridge" as const, parentIssueId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
      },
    },
    {
      name: "skill-test token",
      actor: {
        type: "agent" as const,
        agentId: "44444444-4444-4444-8444-444444444444",
        companyId: "company-1",
        runId: "55555555-5555-4555-8555-555555555555",
        source: "agent_jwt" as const,
        keyScope: { kind: "skill_test" as const, issueId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
      },
    },
  ])("returns a non-oracular 404 for $name outside the issue boundary", async ({ actor }) => {
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      projectId: null,
      parentId: null,
      identifier: "PAP-HIDDEN",
      title: "Hidden replay lookup",
      status: "todo",
      assigneeAgentId: "33333333-3333-4333-8333-333333333333",
      assigneeUserId: null,
    };
    mockIssueService.getByCreateIdempotencyKey.mockResolvedValue(issue);
    mockAccessService.decide.mockResolvedValue({
      allowed: false,
      action: "issue:read",
      reason: "deny_policy_restricted",
      explanation: "Outside scoped issue boundary.",
    });
    const app = await createApp(actor);

    const hidden = await request(app)
      .get("/api/companies/company-1/issues/by-create-idempotency-key/reeve-build%3Ahidden");
    mockIssueService.getByCreateIdempotencyKey.mockResolvedValueOnce(null);
    const absent = await request(app)
      .get("/api/companies/company-1/issues/by-create-idempotency-key/reeve-build%3Aabsent");

    expect(hidden.status).toBe(404);
    expect(absent.status).toBe(404);
    expect(hidden.body).toEqual({ error: "Issue not found" });
    expect(absent.body).toEqual(hidden.body);
  });

  it("triggers a scheduled monitor immediately from the dedicated route", async () => {
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "in_progress",
      assigneeAgentId: "33333333-3333-4333-8333-333333333333",
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1001",
      title: "Manual monitor trigger",
      executionPolicy: normalizeIssueExecutionPolicy({
        monitor: {
          nextCheckAt: "2026-04-11T12:30:00.000Z",
          notes: "Check deployment",
          scheduledBy: "board",
        },
      }),
      executionState: null,
    };
    mockIssueService.getById.mockResolvedValue(issue);

    const res = await request(await createApp())
      .post("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/monitor/check-now")
      .send({});

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(mockHeartbeatService.triggerIssueMonitor).toHaveBeenCalledWith(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      expect.objectContaining({
        actorType: "user",
        actorId: "local-board",
        agentId: null,
      }),
    );
  });

  it("lets a board user create a child issue with a scheduled monitor", async () => {
    mockIssueService.getById.mockResolvedValue({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "in_progress",
      assigneeAgentId: "11111111-1111-4111-8111-111111111111",
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1001",
      title: "Parent issue",
      executionPolicy: null,
      executionState: null,
    });

    const res = await request(await createApp())
      .post("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/children")
      .send({
        title: "Child monitor",
        status: "in_review",
        assigneeAgentId: "33333333-3333-4333-8333-333333333333",
        executionPolicy: {
          monitor: {
            nextCheckAt: "2026-04-11T12:30:00.000Z",
            scheduledBy: "assignee",
          },
        },
      });

    expect(res.status).toBe(201);
    const createPayload = mockIssueService.createChild.mock.calls[0]?.[1] as {
      executionPolicy: { monitor: { scheduledBy: string } };
    };
    expect(createPayload.executionPolicy.monitor.scheduledBy).toBe("board");
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.monitor_scheduled",
        details: expect.objectContaining({
          scheduledBy: "board",
        }),
      }),
    );
  });

  it("rejects child monitor scheduling by a non-assignee agent even with task assignment permission", async () => {
    mockAccessService.hasPermission.mockResolvedValue(true);
    mockIssueService.getById.mockResolvedValue({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "in_progress",
      assigneeAgentId: "11111111-1111-4111-8111-111111111111",
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1001",
      title: "Parent issue",
      executionPolicy: null,
      executionState: null,
    });

    const res = await request(await createApp({
      type: "agent",
      agentId: "22222222-2222-4222-8222-222222222222",
      companyId: "company-1",
      runId: "run-1",
    }))
      .post("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/children")
      .send({
        title: "Child monitor",
        status: "in_review",
        assigneeAgentId: "33333333-3333-4333-8333-333333333333",
        executionPolicy: {
          monitor: {
            nextCheckAt: "2026-04-11T12:30:00.000Z",
            scheduledBy: "board",
          },
        },
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Only the assignee agent or a board user can manage issue monitors");
    expect(mockIssueService.createChild).not.toHaveBeenCalled();
  });

  it("normalizes spoofed child monitor scheduledBy to the assignee actor", async () => {
    mockAccessService.hasPermission.mockResolvedValue(true);
    mockIssueService.getById.mockResolvedValue({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "in_progress",
      assigneeAgentId: "33333333-3333-4333-8333-333333333333",
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1001",
      title: "Parent issue",
      executionPolicy: null,
      executionState: null,
    });

    const res = await request(await createApp({
      type: "agent",
      agentId: "33333333-3333-4333-8333-333333333333",
      companyId: "company-1",
      runId: "run-1",
    }))
      .post("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/children")
      .send({
        title: "Child monitor",
        status: "in_review",
        assigneeAgentId: "33333333-3333-4333-8333-333333333333",
        executionPolicy: {
          monitor: {
            nextCheckAt: "2026-04-11T12:30:00.000Z",
            scheduledBy: "board",
            externalRef: "https://example.test/deploy?token=secret",
          },
        },
      });

    expect(res.status).toBe(201);
    const createPayload = mockIssueService.createChild.mock.calls[0]?.[1] as {
      executionPolicy: { monitor: { scheduledBy: string; externalRef: string | null } };
    };
    expect(createPayload.executionPolicy.monitor.scheduledBy).toBe("assignee");
    expect(createPayload.executionPolicy.monitor.externalRef).toBe("[redacted]");
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.monitor_scheduled",
        entityId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        details: expect.not.objectContaining({ externalRef: expect.anything() }),
      }),
    );
  });
});
