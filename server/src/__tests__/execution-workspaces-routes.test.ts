import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { executionWorkspaceRoutes } from "../routes/execution-workspaces.js";

const mockExecutionWorkspaceService = vi.hoisted(() => ({
  list: vi.fn(),
  listOverview: vi.fn(),
  listSummaries: vi.fn(),
  getById: vi.fn(),
  getCloseReadiness: vi.fn(),
  archiveWorkspaceUnderLifecycleLock: vi.fn(),
  fenceClosedWorkspaceDestruction: vi.fn(),
  reconcileExecutionWorkspaceBranch: vi.fn(),
  update: vi.fn(),
}));

const mockWorkspaceOperationService = vi.hoisted(() => ({
  listForExecutionWorkspace: vi.fn(),
  createRecorder: vi.fn(),
}));

const mockWorkspaceRuntimeLeaseService = vi.hoisted(() => ({
  claim: vi.fn(async () => ({ outcome: "created", ownerKey: "issue:issue-1", lease: null, reclaimedFrom: null })),
  release: vi.fn(async () => ({ released: false, ownerKey: null })),
  get: vi.fn(async () => null),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  decide: vi.fn(),
}));
const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));

const mockEnvironmentRuntimeService = vi.hoisted(() => ({
  destroyReusableSandboxLeases: vi.fn(async () => undefined),
}));

const mockAssertWorkspaceArtifactDirectorShipMutationAllowed = vi.hoisted(() =>
  vi.fn(async () => undefined),
);
const mockValidatePreparedExecutionWorkspace = vi.hoisted(() => vi.fn(async () => ({
  path: "/tmp/prepared",
  root: "/tmp/repository",
  commonGitDirectory: "/tmp/repository/.git",
  branchName: "reeve/task-1",
  headSha: "a".repeat(40),
})));
const mockInstanceSettingsService = vi.hoisted(() => ({
  getExperimental: vi.fn(async () => ({ enableIsolatedWorkspaces: true })),
}));

vi.mock("../services/artifact-director-ship-guards.js", () => ({
  assertWorkspaceArtifactDirectorShipMutationAllowed:
    mockAssertWorkspaceArtifactDirectorShipMutationAllowed,
}));

vi.mock("../services/index.js", () => ({
  accessService: () => mockAccessService,
  executionWorkspaceService: () => mockExecutionWorkspaceService,
  heartbeatService: () => mockHeartbeatService,
  logActivity: mockLogActivity,
  workspaceOperationService: () => mockWorkspaceOperationService,
  workspaceRuntimeLeaseService: () => mockWorkspaceRuntimeLeaseService,
  LEASED_WORKSPACE_RUNTIME_ACTIONS: ["start", "stop", "restart"],
}));

vi.mock("../services/environment-runtime.js", () => ({
  environmentRuntimeService: () => mockEnvironmentRuntimeService,
}));

vi.mock("../services/prepared-execution-workspaces.js", () => ({
  validatePreparedExecutionWorkspace: mockValidatePreparedExecutionWorkspace,
}));

vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: () => mockInstanceSettingsService,
}));

const mockWorkspaceRuntimeTeardown = vi.hoisted(() => ({
  stopRuntimeServicesForExecutionWorkspace: vi.fn(async () => undefined),
  cleanupExecutionWorkspaceArtifacts: vi.fn(async () => ({ cleaned: true, warnings: [] as string[] })),
}));

vi.mock("../services/workspace-runtime.js", async (importActual) => {
  const actual = await importActual<typeof import("../services/workspace-runtime.js")>();
  return {
    ...actual,
    stopRuntimeServicesForExecutionWorkspace:
      mockWorkspaceRuntimeTeardown.stopRuntimeServicesForExecutionWorkspace,
    cleanupExecutionWorkspaceArtifacts: mockWorkspaceRuntimeTeardown.cleanupExecutionWorkspaceArtifacts,
  };
});

function createApp(actor: Record<string, unknown> = {
  type: "board",
  userId: "local-board",
  companyIds: ["company-1"],
  source: "session",
  isInstanceAdmin: false,
}, db: unknown = {}, supportsExactProcessStartIdentity = true) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", executionWorkspaceRoutes(db as any, {
    supportsExactProcessStartIdentity: () => supportsExactProcessStartIdentity,
  }));
  app.use(errorHandler);
  return app;
}

describe.sequential("execution workspace routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAccessService.decide.mockResolvedValue({
      allowed: true,
      action: "company_scope:read",
      reason: "allow_test",
      explanation: "Allowed by test mock.",
    });
    mockExecutionWorkspaceService.list.mockResolvedValue([]);
    mockExecutionWorkspaceService.listOverview.mockResolvedValue({
      items: [],
      total: 0,
      limit: 50,
      offset: 0,
      hasMore: false,
      nextOffset: null,
    });
    mockExecutionWorkspaceService.listSummaries.mockResolvedValue([
      {
        id: "workspace-1",
        name: "Alpha",
        mode: "isolated_workspace",
        projectWorkspaceId: null,
      },
    ]);
    mockExecutionWorkspaceService.getById.mockResolvedValue(null);
    mockExecutionWorkspaceService.reconcileExecutionWorkspaceBranch.mockResolvedValue(null);
    mockHeartbeatService.wakeup.mockResolvedValue(null);
  });

  it("rejects prepared worktree adoption from an agent before filesystem or database inspection", async () => {
    const res = await request(createApp({
      type: "agent",
      agentId: "10000000-0000-4000-8000-000000000010",
      companyId: "10000000-0000-4000-8000-000000000001",
      source: "agent_jwt",
      runId: "10000000-0000-4000-8000-000000000011",
    }))
      .put("/api/v1/projects/10000000-0000-4000-8000-000000000002/prepared-execution-workspaces/10000000-0000-4000-8000-000000000005")
      .send({
        version: 1,
        companyId: "10000000-0000-4000-8000-000000000001",
        projectWorkspaceId: "10000000-0000-4000-8000-000000000003",
        connectionId: "10000000-0000-4000-8000-000000000004",
        lifecycleId: "10000000-0000-4000-8000-000000000005",
        taskId: "task-1",
        path: "/tmp/prepared",
        root: "/tmp/repository",
        commonGitDirectory: "/tmp/repository/.git",
        branch: "reeve/task-1",
        authorizedStartHeadSha: "a".repeat(40),
        repositoryIdentitySha256: "b".repeat(64),
        inspectionReceiptSha256: "c".repeat(64),
        preparedIdentitySha256: "d".repeat(64),
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Board access required");
    expect(mockValidatePreparedExecutionWorkspace).not.toHaveBeenCalled();
  });

  it("rejects adoption when the host exact process-identity source is unavailable", async () => {
    const companyId = "10000000-0000-4000-8000-000000000001";
    const res = await request(createApp({
      type: "board",
      userId: "local-board",
      companyIds: [companyId],
      source: "session",
      isInstanceAdmin: false,
    }, {}, false))
      .put("/api/v1/projects/10000000-0000-4000-8000-000000000002/prepared-execution-workspaces/10000000-0000-4000-8000-000000000005")
      .send({
        version: 1,
        companyId,
        projectWorkspaceId: "10000000-0000-4000-8000-000000000003",
        connectionId: "10000000-0000-4000-8000-000000000004",
        lifecycleId: "10000000-0000-4000-8000-000000000005",
        taskId: "task-1",
        path: "/tmp/prepared",
        root: "/tmp/repository",
        commonGitDirectory: "/tmp/repository/.git",
        branch: "reeve/task-1",
        authorizedStartHeadSha: "a".repeat(40),
        repositoryIdentitySha256: "b".repeat(64),
        inspectionReceiptSha256: "c".repeat(64),
        preparedIdentitySha256: "d".repeat(64),
      });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("exact_process_start_identity_unavailable");
    expect(mockValidatePreparedExecutionWorkspace).not.toHaveBeenCalled();
  });

  it("adopts once, replays exact identity, and rejects lifecycle identity drift", async () => {
    const companyId = "10000000-0000-4000-8000-000000000001";
    const projectId = "10000000-0000-4000-8000-000000000002";
    const projectWorkspaceId = "10000000-0000-4000-8000-000000000003";
    const connectionId = "10000000-0000-4000-8000-000000000004";
    const lifecycleId = "10000000-0000-4000-8000-000000000005";
    let stored: Record<string, unknown> | null = null;
    const transaction = {
      execute: vi.fn(async () => undefined),
      select: vi.fn(() => ({
        from: () => ({
          where: () => Promise.resolve(stored ? [stored] : []),
        }),
      })),
      insert: vi.fn(() => ({
        values: (values: Record<string, unknown>) => ({
          returning: () => ({
            then: (resolve: (rows: Record<string, unknown>[]) => unknown) => {
              stored = { id: "10000000-0000-4000-8000-000000000006", ...values };
              return Promise.resolve(resolve([stored]));
            },
          }),
        }),
      })),
    };
    const db = {
      select: () => ({
        from: () => ({
          where: () => Promise.resolve([{ id: projectId, companyId }]),
        }),
      }),
      transaction: (callback: (tx: typeof transaction) => Promise<unknown>) => callback(transaction),
    };
    const body = {
      version: 1,
      companyId,
      projectWorkspaceId,
      connectionId,
      lifecycleId,
      taskId: "task-1",
      path: "/tmp/prepared",
      root: "/tmp/repository",
      commonGitDirectory: "/tmp/repository/.git",
      branch: "reeve/task-1",
      authorizedStartHeadSha: "a".repeat(40),
      repositoryIdentitySha256: "b".repeat(64),
      inspectionReceiptSha256: "c".repeat(64),
      preparedIdentitySha256: "d".repeat(64),
    };
    const app = createApp({
      type: "board",
      userId: "local-board",
      companyIds: [companyId],
      source: "session",
      isInstanceAdmin: false,
    }, db);

    const created = await request(app)
      .put(`/api/v1/projects/${projectId}/prepared-execution-workspaces/${lifecycleId}`)
      .send(body);
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      version: 1,
      executionWorkspaceId: "10000000-0000-4000-8000-000000000006",
      connectionId,
      lifecycleId,
      taskId: "task-1",
      replayed: false,
    });

    const replayed = await request(app)
      .put(`/api/v1/projects/${projectId}/prepared-execution-workspaces/${lifecycleId}`)
      .send(body);
    expect(replayed.status).toBe(200);
    expect(replayed.body.replayed).toBe(true);
    expect(transaction.insert).toHaveBeenCalledTimes(1);

    const drifted = await request(app)
      .put(`/api/v1/projects/${projectId}/prepared-execution-workspaces/${lifecycleId}`)
      .send({ ...body, taskId: "different-task" });
    expect(drifted.status).toBe(409);
    expect(drifted.body.code).toBe("prepared_workspace_identity_conflict");
    expect(transaction.insert).toHaveBeenCalledTimes(1);
    expect(mockValidatePreparedExecutionWorkspace).toHaveBeenCalledTimes(5);
  });

  it("uses summary mode for lightweight workspace lookups", async () => {
    const res = await request(createApp())
      .get("/api/companies/company-1/execution-workspaces?summary=true&reuseEligible=true");

    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      {
        id: "workspace-1",
        name: "Alpha",
        mode: "isolated_workspace",
        projectWorkspaceId: null,
      },
    ]);
    expect(mockExecutionWorkspaceService.listSummaries).toHaveBeenCalledWith("company-1", {
      projectId: undefined,
      projectWorkspaceId: undefined,
      issueId: undefined,
      status: undefined,
      reuseEligible: true,
    });
    expect(mockExecutionWorkspaceService.list).not.toHaveBeenCalled();
  });

  it("delegates bounded workspace overview queries", async () => {
    const res = await request(createApp())
      .get("/api/companies/company-1/workspace-overview?status=active,idle&limit=25&offset=10");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      items: [],
      total: 0,
      limit: 50,
      offset: 0,
      hasMore: false,
      nextOffset: null,
    });
    expect(mockExecutionWorkspaceService.listOverview).toHaveBeenCalledWith("company-1", {
      status: ["active", "idle"],
      limit: 25,
      offset: 10,
    });
  });

  it("denies repository identity changes by agents", async () => {
    mockExecutionWorkspaceService.getById.mockResolvedValue({
      id: "workspace-1",
      companyId: "company-1",
      repoUrl: "https://github.com/acme/app.git",
      branchName: "feature/current",
      status: "active",
      metadata: null,
    });

    const res = await request(createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      source: "agent_jwt",
      runId: "run-1",
    }))
      .patch("/api/execution-workspaces/workspace-1")
      .send({ repoUrl: "https://github.com/attacker/unrelated.git" });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("execution_workspace_repository_identity_board_only");
    expect(mockExecutionWorkspaceService.update).not.toHaveBeenCalled();
  });

  it("allows board callers to change execution workspace repository identity", async () => {
    const existing = {
      id: "workspace-1",
      companyId: "company-1",
      repoUrl: "https://github.com/acme/app.git",
      branchName: "feature/current",
      status: "active",
      metadata: null,
    };
    mockExecutionWorkspaceService.getById.mockResolvedValue(existing);
    mockExecutionWorkspaceService.update.mockResolvedValue({
      ...existing,
      repoUrl: "https://github.com/acme/replacement.git",
    });

    const res = await request(createApp())
      .patch("/api/execution-workspaces/workspace-1")
      .send({ repoUrl: "https://github.com/acme/replacement.git" });

    expect(res.status).toBe(200);
    expect(mockExecutionWorkspaceService.update).toHaveBeenCalledWith(
      "workspace-1",
      expect.objectContaining({ repoUrl: "https://github.com/acme/replacement.git" }),
    );
  });

  it("rejects invalid workspace overview pagination", async () => {
    const res = await request(createApp())
      .get("/api/companies/company-1/workspace-overview?limit=1000");

    expect(res.status).toBe(422);
    expect(mockExecutionWorkspaceService.listOverview).not.toHaveBeenCalled();
  });

  it.each([
    ["forward", { mode: "forward" }],
    ["override", { mode: "override", reason: "operator break-glass" }],
    ["quarantine_restore", { mode: "quarantine_restore", reason: "rescue dirty branch" }],
  ])("rejects agent actors for %s branch reconciliation", async (_mode, body) => {
    mockExecutionWorkspaceService.getById.mockResolvedValue({
      id: "workspace-1",
      companyId: "company-1",
      sourceIssueId: "issue-1",
    });

    const res = await request(createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      source: "agent_jwt",
      runId: "run-1",
    }))
      .post("/api/execution-workspaces/workspace-1/reconcile-branch")
      .send(body);

    expect(res.status).toBe(403);
    expect(mockExecutionWorkspaceService.reconcileExecutionWorkspaceBranch).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("logs branch reconciliation activity after the service operation succeeds", async () => {
    mockExecutionWorkspaceService.getById.mockResolvedValue({
      id: "workspace-1",
      companyId: "company-1",
      sourceIssueId: "issue-1",
    });
    mockExecutionWorkspaceService.reconcileExecutionWorkspaceBranch.mockResolvedValue({
      workspace: {
        id: "workspace-1",
        companyId: "company-1",
        sourceIssueId: "issue-1",
        branchName: "feature/current",
      },
      inspection: {
        fingerprint: "workspace_incoherence:v1:sha256:test",
        worktreePath: "/tmp/worktree",
        repoRoot: "/tmp/repo",
        fromBranch: "feature/recorded",
        toBranch: "feature/current",
        fromSha: "1111111",
        toSha: "2222222",
        ancestryVerdict: "ancestor",
        cleanliness: "clean",
        statusEntryCount: 0,
        plainLanguageReason: "forward",
      },
      recoveryAction: {
        id: "recovery-1",
      },
      auditCommentId: "comment-1",
    });

    const res = await request(createApp())
      .post("/api/execution-workspaces/workspace-1/reconcile-branch")
      .send({ mode: "forward" });

    expect(res.status).toBe(200);
    expect(mockExecutionWorkspaceService.reconcileExecutionWorkspaceBranch).toHaveBeenCalledWith("workspace-1", {
      mode: "forward",
      reason: null,
      actor: {
        actorType: "user",
        actorId: "local-board",
        agentId: null,
        runId: null,
      },
    });
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "execution_workspace.branch_reconciled",
      entityType: "execution_workspace",
      entityId: "workspace-1",
      details: expect.objectContaining({
        mode: "forward",
        fromBranch: "feature/recorded",
        toBranch: "feature/current",
        fromSha: "1111111",
        toSha: "2222222",
        ancestryVerdict: "ancestor",
        fingerprint: "workspace_incoherence:v1:sha256:test",
        sourceIssueId: "issue-1",
        auditCommentId: "comment-1",
        recoveryActionId: "recovery-1",
      }),
    }));
  });

  it("accepts quarantine_restore, logs the rescue ref, and wakes the restored source issue", async () => {
    mockExecutionWorkspaceService.getById.mockResolvedValue({
      id: "workspace-1",
      companyId: "company-1",
      sourceIssueId: "issue-1",
    });
    mockExecutionWorkspaceService.reconcileExecutionWorkspaceBranch.mockResolvedValue({
      workspace: {
        id: "workspace-1",
        companyId: "company-1",
        sourceIssueId: "issue-1",
        branchName: "feature/recorded",
      },
      inspection: {
        fingerprint: "workspace_incoherence:v1:sha256:dirty",
        worktreePath: "/tmp/worktree",
        repoRoot: "/tmp/repo",
        fromBranch: "feature/recorded",
        toBranch: "feature/live",
        fromSha: "1111111",
        toSha: "2222222",
        ancestryVerdict: "diverged",
        cleanliness: "dirty",
        statusEntryCount: 2,
        plainLanguageReason: "dirty live branch",
      },
      recoveryAction: {
        id: "recovery-1",
      },
      auditCommentId: "comment-1",
      rescueRef: {
        branchName: "paperclip/rescue/PAP-123/20260709T120000Z",
        commitSha: "3333333",
        fileCount: 2,
        sourceAuditCommentId: "comment-0",
        claimantAuditCommentId: null,
      },
      restoredSourceIssue: {
        id: "issue-1",
        companyId: "company-1",
        status: "todo",
        assigneeAgentId: "agent-1",
      },
      sourceIssueStatusChanged: true,
    });

    const res = await request(createApp())
      .post("/api/execution-workspaces/workspace-1/reconcile-branch")
      .send({ mode: "quarantine_restore" });

    expect(res.status).toBe(200);
    expect(mockExecutionWorkspaceService.reconcileExecutionWorkspaceBranch).toHaveBeenCalledWith("workspace-1", {
      mode: "quarantine_restore",
      reason: null,
      actor: {
        actorType: "user",
        actorId: "local-board",
        agentId: null,
        runId: null,
      },
    });
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "execution_workspace.branch_reconciled",
      entityType: "execution_workspace",
      entityId: "workspace-1",
      details: expect.objectContaining({
        mode: "quarantine_restore",
        fingerprint: "workspace_incoherence:v1:sha256:dirty",
        recoveryActionId: "recovery-1",
        rescueRef: expect.objectContaining({
          branchName: "paperclip/rescue/PAP-123/20260709T120000Z",
          commitSha: "3333333",
        }),
        sourceIssueStatus: "todo",
      }),
    }));
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith("agent-1", expect.objectContaining({
      source: "automation",
      reason: "issue_recovery_action_restored",
      payload: expect.objectContaining({
        issueId: "issue-1",
        recoveryActionId: "recovery-1",
        executionWorkspaceId: "workspace-1",
        rescueRef: "paperclip/rescue/PAP-123/20260709T120000Z",
        mutation: "execution_workspace_quarantine_restore",
      }),
      contextSnapshot: expect.objectContaining({
        issueId: "issue-1",
        taskId: "issue-1",
        wakeReason: "issue_recovery_action_restored",
        source: "execution_workspace.quarantine_restore",
        recoveryActionId: "recovery-1",
        executionWorkspaceId: "workspace-1",
        rescueRef: "paperclip/rescue/PAP-123/20260709T120000Z",
      }),
    }));
  });

  it("wakes a restored in_review agent participant after quarantine_restore", async () => {
    mockExecutionWorkspaceService.getById.mockResolvedValue({
      id: "workspace-1",
      companyId: "company-1",
      sourceIssueId: "issue-1",
    });
    mockExecutionWorkspaceService.reconcileExecutionWorkspaceBranch.mockResolvedValue({
      workspace: {
        id: "workspace-1",
        companyId: "company-1",
        sourceIssueId: "issue-1",
        branchName: "feature/recorded",
      },
      inspection: {
        fingerprint: "workspace_incoherence:v1:sha256:dirty",
        worktreePath: "/tmp/worktree",
        repoRoot: "/tmp/repo",
        fromBranch: "feature/recorded",
        toBranch: "feature/live",
        fromSha: "1111111",
        toSha: "2222222",
        ancestryVerdict: "diverged",
        cleanliness: "dirty",
        statusEntryCount: 2,
        plainLanguageReason: "dirty live branch",
      },
      recoveryAction: {
        id: "recovery-1",
      },
      auditCommentId: "comment-1",
      rescueRef: null,
      restoredSourceIssue: {
        id: "issue-1",
        companyId: "company-1",
        status: "in_review",
        assigneeAgentId: "reviewer-agent-1",
      },
      sourceIssueStatusChanged: true,
    });

    const res = await request(createApp())
      .post("/api/execution-workspaces/workspace-1/reconcile-branch")
      .send({ mode: "quarantine_restore" });

    expect(res.status).toBe(200);
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      details: expect.objectContaining({
        sourceIssueStatus: "in_review",
      }),
    }));
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith("reviewer-agent-1", expect.objectContaining({
      reason: "issue_recovery_action_restored",
      payload: expect.objectContaining({
        issueId: "issue-1",
        mutation: "execution_workspace_quarantine_restore",
      }),
      contextSnapshot: expect.objectContaining({
        issueId: "issue-1",
        wakeReason: "issue_recovery_action_restored",
        source: "execution_workspace.quarantine_restore",
      }),
    }));
  });

  it("returns 409 and skips destructive cleanup when the archive hits a reopen-pending workspace", async () => {
    // A reopen published the workspace active while its source issue is still
    // terminal. The archive control must return 409 before any lease teardown,
    // runtime-service stop, or artifact cleanup, so it never removes the rebuilt
    // worktree.
    mockExecutionWorkspaceService.getById.mockResolvedValue({
      id: "workspace-1",
      companyId: "company-1",
      sourceIssueId: "issue-1",
      status: "active",
      mode: "isolated_workspace",
    });
    mockExecutionWorkspaceService.getCloseReadiness.mockResolvedValue({
      state: "ready",
      blockingReasons: [],
    });
    mockExecutionWorkspaceService.archiveWorkspaceUnderLifecycleLock.mockResolvedValue({
      outcome: "reopen_pending",
    });

    const res = await request(createApp())
      .patch("/api/execution-workspaces/workspace-1")
      .send({ status: "archived" });

    expect(res.status).toBe(409);
    expect(mockExecutionWorkspaceService.archiveWorkspaceUnderLifecycleLock).toHaveBeenCalledTimes(1);
    // The destruction fence never runs, so no worktree is removed.
    expect(mockExecutionWorkspaceService.fenceClosedWorkspaceDestruction).not.toHaveBeenCalled();
  });

  it("holds explicit archive of an external prepared workspace before lifecycle locks or teardown", async () => {
    mockExecutionWorkspaceService.getById.mockResolvedValue({
      id: "workspace-1",
      companyId: "company-1",
      sourceIssueId: "issue-1",
      status: "active",
      mode: "isolated_workspace",
      custodyKind: "external_prepared",
    });

    const res = await request(createApp())
      .patch("/api/execution-workspaces/workspace-1")
      .send({ status: "archived" });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("external_prepared_workspace_lifecycle_held");
    expect(mockAssertWorkspaceArtifactDirectorShipMutationAllowed).not.toHaveBeenCalled();
    expect(mockExecutionWorkspaceService.getCloseReadiness).not.toHaveBeenCalled();
    expect(mockExecutionWorkspaceService.archiveWorkspaceUnderLifecycleLock).not.toHaveBeenCalled();
    expect(mockWorkspaceRuntimeLeaseService.release).not.toHaveBeenCalled();
    expect(mockEnvironmentRuntimeService.destroyReusableSandboxLeases).not.toHaveBeenCalled();
    expect(mockWorkspaceRuntimeTeardown.stopRuntimeServicesForExecutionWorkspace).not.toHaveBeenCalled();
    expect(mockWorkspaceRuntimeTeardown.cleanupExecutionWorkspaceArtifacts).not.toHaveBeenCalled();
  });

  it("holds external prepared runtime commands before operations, leases, or commands", async () => {
    mockExecutionWorkspaceService.getById.mockResolvedValue({
      id: "workspace-1",
      companyId: "company-1",
      sourceIssueId: "issue-1",
      status: "active",
      mode: "isolated_workspace",
      custodyKind: "external_prepared",
      cwd: "/tmp/prepared",
      runtimeServices: [],
    });

    const res = await request(createApp())
      .post("/api/execution-workspaces/workspace-1/runtime-commands/run")
      .send({ workspaceCommandId: "build" });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("external_prepared_workspace_runtime_control_held");
    expect(mockAssertWorkspaceArtifactDirectorShipMutationAllowed).not.toHaveBeenCalled();
    expect(mockWorkspaceOperationService.createRecorder).not.toHaveBeenCalled();
    expect(mockWorkspaceRuntimeLeaseService.claim).not.toHaveBeenCalled();
    expect(mockWorkspaceRuntimeTeardown.stopRuntimeServicesForExecutionWorkspace).not.toHaveBeenCalled();
  });

  it("destroys the reusable sandbox leases inside the destruction fence when the archive wins", async () => {
    // The archive wins the lifecycle race. The fence runs the destroy callback,
    // so the reusable sandbox lease teardown runs with the worktree teardown.
    const archivedWorkspace = {
      id: "workspace-1",
      companyId: "company-1",
      sourceIssueId: "issue-1",
      status: "archived",
      mode: "isolated_workspace",
      projectWorkspaceId: null,
      projectId: null,
      cwd: "/tmp/worktree",
    };
    mockExecutionWorkspaceService.getById.mockResolvedValue({
      ...archivedWorkspace,
      status: "active",
    });
    mockExecutionWorkspaceService.getCloseReadiness.mockResolvedValue({
      state: "ready",
      blockingReasons: [],
    });
    mockExecutionWorkspaceService.archiveWorkspaceUnderLifecycleLock.mockResolvedValue({
      outcome: "archived",
      workspace: archivedWorkspace,
      capturedGeneration: 3,
    });
    mockExecutionWorkspaceService.fenceClosedWorkspaceDestruction.mockImplementation(
      async ({ destroy }: { destroy: () => Promise<unknown> }) => ({
        skippedReopened: false,
        result: await destroy(),
      }),
    );

    const res = await request(createApp())
      .patch("/api/execution-workspaces/workspace-1")
      .send({ status: "archived" });

    expect(res.status).toBe(200);
    // The lease teardown runs inside the fence, so it uses the closed-workspace
    // failure reason and targets the archived row.
    expect(mockEnvironmentRuntimeService.destroyReusableSandboxLeases).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: "company-1",
        executionWorkspaceId: "workspace-1",
        failureReason: "execution_workspace_closed",
      }),
    );
  });

  it("keeps the reusable sandbox leases when a reopen makes the fence skip the archive teardown", async () => {
    // A reopen raised the lifecycle generation after the archive captured its
    // own generation. The fence skips the destroy callback and keeps the
    // reopened row, so the lease teardown must not run. Before the fix the lease
    // teardown ran before the fence, so an overlapping reopen lost its leases.
    const archivedWorkspace = {
      id: "workspace-1",
      companyId: "company-1",
      sourceIssueId: "issue-1",
      status: "archived",
      mode: "isolated_workspace",
      projectWorkspaceId: null,
      projectId: null,
      cwd: "/tmp/worktree",
    };
    mockExecutionWorkspaceService.getById.mockResolvedValue({
      ...archivedWorkspace,
      status: "active",
    });
    mockExecutionWorkspaceService.getCloseReadiness.mockResolvedValue({
      state: "ready",
      blockingReasons: [],
    });
    mockExecutionWorkspaceService.archiveWorkspaceUnderLifecycleLock.mockResolvedValue({
      outcome: "archived",
      workspace: archivedWorkspace,
      capturedGeneration: 3,
    });
    // The fence detects the reopen and never runs the destroy callback.
    mockExecutionWorkspaceService.fenceClosedWorkspaceDestruction.mockResolvedValue({
      skippedReopened: true,
    });

    const res = await request(createApp())
      .patch("/api/execution-workspaces/workspace-1")
      .send({ status: "archived" });

    expect(res.status).toBe(200);
    expect(mockExecutionWorkspaceService.fenceClosedWorkspaceDestruction).toHaveBeenCalledTimes(1);
    // The reopen keeps its reusable leases because the fence skipped the destroy.
    expect(mockEnvironmentRuntimeService.destroyReusableSandboxLeases).not.toHaveBeenCalled();
  });
});
