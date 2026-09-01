import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  activityLog,
  agents,
  companies,
  createDb,
  executionWorkspaces,
  governedExecutorLaunchReceipts,
  governedIssueReservations,
  heartbeatRuns,
  issueWorkProducts,
  issues,
  projectWorkspaces,
  projects,
} from "@paperclipai/db";
import {
  SUBSCRIPTION_AUTH_AUTHORITY_SCHEMA,
  SUBSCRIPTION_AUTH_AUTHORITY_VERSION,
  type SubscriptionAuthAuthorityProofV1,
} from "@paperclipai/adapter-utils";
import { governedIssueEnvelopeSchema } from "@paperclipai/shared";
import {
  EXECUTION_PROFILE_BINDING_VERSION,
  EXECUTION_PROFILE_PROJECTION_SCHEMA,
  executionProfileSha256,
  type InspectedExecutionProfileBinding,
} from "./execution-profile-binding.js";
import { governedIssueCompletionService } from "./governed-issue-completion.js";
import {
  governedIssueContractService,
  governedIssueEnvelopeSha256,
  governedIssueReservationState,
  governedIssueSha256,
} from "./governed-issue-contract.js";
import { governedExecutorLaunchReceiptService } from "./governed-executor-launch-receipts.js";
import { lockGovernedV2ExecutionReservationForQueuedRun } from "./heartbeat.js";
import { normalizeIssueExecutionPolicy } from "./issue-execution-policy.js";
import { issueService } from "./issues.js";
import { instanceSettingsService } from "./instance-settings.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]) {
  return execFileAsync("git", args, { cwd, encoding: "utf8" });
}

async function createPreparedRepository() {
  const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-completion-")));
  const root = path.join(parent, "repository");
  const worktree = path.join(parent, "prepared");
  await fs.mkdir(root);
  await git(root, ["init", "-b", "main"]);
  await git(root, ["config", "user.email", "test@example.com"]);
  await git(root, ["config", "user.name", "Test"]);
  await fs.writeFile(path.join(root, "README.md"), "ready\n", "utf8");
  await git(root, ["add", "README.md"]);
  await git(root, ["commit", "-m", "initial"]);
  await git(root, ["worktree", "add", "-b", "reeve/completion-test", worktree, "HEAD"]);
  return {
    parent,
    root,
    worktree,
    commonGitDirectory: await fs.realpath(path.join(root, ".git")),
    headSha: (await git(worktree, ["rev-parse", "HEAD"])).stdout.trim(),
    branchName: "reeve/completion-test",
  };
}

function inspectedBuilderProfile(input: {
  companyId: string;
  builderAgentId: string;
  issueId: string;
  agentExecutionProfileRevision: number;
  issueAssigneeProfileRevision: number;
}): InspectedExecutionProfileBinding {
  const fingerprint = (character: string) => `decision-spec-v1.${character.repeat(64)}`;
  const evidence = (character: string) => ({
    evidence: "credential_bound" as const,
    identityFingerprint: fingerprint(character),
    revisionFingerprint: fingerprint(character === "f" ? "e" : "f"),
  });
  const authorityProof: SubscriptionAuthAuthorityProofV1 = {
    schema: SUBSCRIPTION_AUTH_AUTHORITY_SCHEMA,
    version: SUBSCRIPTION_AUTH_AUTHORITY_VERSION,
    adapterType: "claude_local",
    companyId: input.companyId,
    agentId: input.builderAgentId,
    authKind: "claude_oauth_user_secret",
    sourceKind: "user_secret_version",
    authProfile: evidence("a"),
    account: evidence("b"),
    principal: evidence("c"),
    credentialRevisionFingerprint: fingerprint("d"),
  };
  const projection = {
    schema: EXECUTION_PROFILE_PROJECTION_SCHEMA,
    version: EXECUTION_PROFILE_BINDING_VERSION,
    companyId: input.companyId,
    agentId: input.builderAgentId,
    issueId: input.issueId,
    adapterType: "claude_local" as const,
    billingPolicy: "subscription_only" as const,
    engine: "cli" as const,
    environment: { id: randomUUID(), driver: "local" as const },
    agentExecutionProfileRevision: input.agentExecutionProfileRevision,
    issueAssigneeProfileRevision: input.issueAssigneeProfileRevision,
    securityConfigSha256: executionProfileSha256({ billingPolicy: "subscription_only" }),
    instructionsSha256: executionProfileSha256({ kind: "none" }),
    authorityProofSha256: executionProfileSha256(authorityProof),
  };
  return {
    projection,
    digest: executionProfileSha256(projection),
    authorityProof,
    prepared: null,
  };
}

describeEmbeddedPostgres("governed issue completion", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const fixtureRoots = new Set<string>();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-governed-completion-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.execute(sql.raw('TRUNCATE TABLE "companies" RESTART IDENTITY CASCADE'));
    await Promise.all([...fixtureRoots].map((root) => fs.rm(root, { recursive: true, force: true })));
    fixtureRoots.clear();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedActivatedLaunch() {
    const repository = await createPreparedRepository();
    fixtureRoots.add(repository.parent);
    const companyId = randomUUID();
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const executionWorkspaceId = randomUUID();
    const builderAgentId = randomUUID();
    const reviewerAgentId = randomUUID();
    const idempotencyKey = `reeve-build:${randomUUID()}`;
    const branchName = repository.branchName;
    const startHeadSha = repository.headSha;
    const pid = 42_424;
    const startToken = "b".repeat(64);
    const issuePrefix = `C${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Completion test",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: builderAgentId,
        companyId,
        name: "Builder",
        role: "engineer",
        status: "active",
        adapterType: "claude_local",
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
        adapterType: "claude_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });
    await db.insert(projects).values({ id: projectId, companyId, name: "Connected repo", status: "in_progress" });
    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Primary",
      sourceType: "local_path",
      cwd: repository.root,
      isPrimary: true,
    });
    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      projectWorkspaceId,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: "Connected task",
      status: "active",
      cwd: repository.worktree,
      baseRef: startHeadSha,
      branchName,
      providerType: "git_worktree",
      providerRef: repository.worktree,
      custodyKind: "external_prepared",
      externalConnectionId: randomUUID(),
      externalLifecycleId: randomUUID(),
      externalTaskId: "task-1",
      preparedIdentitySha256: "c".repeat(64),
      authorizedStartHeadSha: startHeadSha,
      repositoryIdentitySha256: "d".repeat(64),
      inspectionReceiptSha256: "e".repeat(64),
      externalRoot: repository.root,
      externalCommonGitDirectory: repository.commonGitDirectory,
    });

    const executionPolicy = normalizeIssueExecutionPolicy({
      stages: [{
        id: randomUUID(),
        type: "review" as const,
        participants: [{ id: randomUUID(), type: "agent" as const, agentId: reviewerAgentId }],
      }],
    })!;
    const envelope = governedIssueEnvelopeSchema.parse({
      projectId,
      projectWorkspaceId,
      title: "Publish a governed draft PR",
      workMode: "standard",
      priority: "medium",
      reviewPolicy: "not_creator",
      requestDepth: 0,
      executionPolicy,
      executionWorkspaceId,
      executionWorkspacePreference: "reuse_existing",
      executionWorkspaceSettings: { mode: "isolated_workspace" },
    });
    const executionProfiles = {
      builderAgentId,
      participants: [builderAgentId, reviewerAgentId]
        .sort((left, right) => left.localeCompare(right))
        .map((agentId) => ({ agentId, executionProfileRevision: 1 })),
    };
    const executionProfileIntentSha256 = governedIssueSha256(executionProfiles);
    const issue = await issueService(db).create(companyId, {
      ...envelope,
      status: "backlog",
      createdByUserId: "director",
      idempotencyKey,
      allowDuplicate: true,
      governanceReservation: {
        contractVersion: 2,
        requestIntentSha256: governedIssueSha256({ version: 2, issue: envelope, executionProfiles }),
        envelopeSha256: governedIssueEnvelopeSha256(envelope),
        envelope,
        executionProfileIntentSha256,
        executionProfileIntent: executionProfiles,
      },
    });
    const reserved = (await governedIssueContractService(db).getReservation(companyId, idempotencyKey))!;
    const activated = await governedIssueContractService(db).activate({
      version: 2,
      companyId,
      idempotencyKey,
      expectedIssueId: issue.id,
      expectedIssueUpdatedAt: reserved.reservedIssueUpdatedAt.toISOString(),
      expectedEnvelopeSha256: reserved.envelopeSha256,
      expectedExecutionProfileIntentSha256: executionProfileIntentSha256,
      builderAgentId,
      executionProfiles,
      inspectExecutionProfile: async ({ agentExecutionProfileRevision, issueAssigneeProfileRevision }) =>
        inspectedBuilderProfile({
          companyId,
          builderAgentId,
          issueId: issue.id,
          agentExecutionProfileRevision,
          issueAssigneeProfileRevision,
        }),
      inspectPreparedExecutionWorkspace: async () => undefined,
      envelope,
      requestedByActorType: "user",
      requestedByActorId: "director",
    });
    const runId = activated.reservation.heartbeatRunId!;
    const launch = await db.insert(governedExecutorLaunchReceipts).values({
      companyId,
      reservationId: reserved.id,
      issueId: issue.id,
      heartbeatRunId: runId,
      executionWorkspaceId,
      connectionId: "connection-1",
      lifecycleId: "lifecycle-1",
      taskId: "task-1",
      cwd: repository.worktree,
      branchName,
      headSha: startHeadSha,
      pid,
      startToken,
      instanceId: randomUUID(),
    }).returning().then((rows) => rows[0]!);
    const finishedAt = new Date();
    await db.update(heartbeatRuns).set({
      status: "succeeded",
      processPid: pid,
      exitCode: 0,
      signal: null,
      finishedAt,
      updatedAt: finishedAt,
    }).where(eq(heartbeatRuns.id, runId));
    const reviewUpdatedAt = new Date(finishedAt.getTime() + 1_000);
    const reviewIssue = await db.update(issues).set({
      status: "in_review",
      assigneeAgentId: reviewerAgentId,
      checkoutRunId: runId,
      executionRunId: runId,
      executionAgentNameKey: "builder",
      executionLockedAt: finishedAt,
      updatedAt: reviewUpdatedAt,
    }).where(eq(issues.id, issue.id)).returning().then((rows) => rows[0]!);
    return {
      companyId,
      builderAgentId,
      reviewerAgentId,
      idempotencyKey,
      issue,
      reviewIssue,
      reservation: activated.reservation,
      launch,
      runId,
      executionWorkspaceId,
      branchName,
      startHeadSha,
      pid,
      startToken,
      repository,
    };
  }

  function observationRequest(fixture: Awaited<ReturnType<typeof seedActivatedLaunch>>) {
    return {
      version: 1 as const,
      expectedIssueId: fixture.issue.id,
      expectedEnvelopeSha256: fixture.reservation.envelopeSha256,
      expectedActivationSha256: fixture.reservation.activationSha256!,
      expectedBuilderAgentId: fixture.builderAgentId,
      expectedHeartbeatRunId: fixture.runId,
      expectedExecutionWorkspaceId: fixture.executionWorkspaceId,
      expectedLaunchReceiptId: fixture.launch.id,
      expectedLaunchInstanceId: fixture.launch.instanceId,
      expectedPid: fixture.pid,
      expectedStartToken: fixture.startToken,
      expectedHeadSha: fixture.startHeadSha,
    };
  }

  it("derives and durably replays a path-free exact terminal observation", async () => {
    const fixture = await seedActivatedLaunch();
    const first = await governedIssueCompletionService(db).observeTerminal({
      companyId: fixture.companyId,
      idempotencyKey: fixture.idempotencyKey,
      request: observationRequest(fixture),
      requestedByActorId: "director",
    });
    const replay = await governedIssueCompletionService(db).observeTerminal({
      companyId: fixture.companyId,
      idempotencyKey: fixture.idempotencyKey,
      request: observationRequest(fixture),
      requestedByActorId: "director",
    });

    expect(first.replayed).toBe(false);
    expect(replay.replayed).toBe(true);
    expect(governedIssueReservationState(replay.reservation)).toBe("terminal_observed");
    expect(replay.receipt).toEqual(first.receipt);
    expect(first.receipt).toMatchObject({
      issueId: fixture.issue.id,
      activation: { builderAgentId: fixture.builderAgentId, heartbeatRunId: fixture.runId },
      launch: {
        receiptId: fixture.launch.id,
        executionWorkspaceId: fixture.executionWorkspaceId,
        pid: fixture.pid,
        startToken: fixture.startToken,
      },
      terminalRun: { status: "succeeded", exitCode: 0, signal: null },
      issue: { status: "in_review" },
    });
    expect(JSON.stringify(first.receipt)).not.toContain(fixture.repository.worktree);
    expect(JSON.stringify(first.receipt)).not.toContain('"cwd"');
    expect(await db.select({ action: activityLog.action }).from(activityLog))
      .toEqual([{ action: "issue.governed_terminal_observed" }]);
    await expect(governedIssueCompletionService(db).observeTerminal({
      companyId: fixture.companyId,
      idempotencyKey: fixture.idempotencyKey,
      request: { ...observationRequest(fixture), expectedPid: fixture.pid + 1 },
      requestedByActorId: "director",
    })).rejects.toMatchObject({
      status: 409,
      details: { code: "governed_terminal_observation_conflict" },
    });
    await expect(db.update(governedExecutorLaunchReceipts)
      .set({ pid: fixture.pid + 1 })
      .where(eq(governedExecutorLaunchReceipts.id, fixture.launch.id)))
      .rejects.toThrow("Failed query");
  });

  it("registers one exact primary draft PR and releases execution without cancelling review", async () => {
    const fixture = await seedActivatedLaunch();
    const observed = await governedIssueCompletionService(db).observeTerminal({
      companyId: fixture.companyId,
      idempotencyKey: fixture.idempotencyKey,
      request: observationRequest(fixture),
      requestedByActorId: "director",
    });
    await db.insert(issueWorkProducts).values({
      companyId: fixture.companyId,
      projectId: fixture.issue.projectId,
      issueId: fixture.issue.id,
      executionWorkspaceId: fixture.executionWorkspaceId,
      type: "pull_request",
      provider: "github",
      externalId: "0BFUSCAT3D/vantage#16",
      title: "0BFUSCAT3D/vantage #16",
      url: "https://github.com/0BFUSCAT3D/vantage/pull/16",
      status: "draft",
      reviewState: "needs_board_review",
      isPrimary: true,
      healthStatus: "unknown",
    });
    const finalHeadSha = "f".repeat(40);
    const request = {
      version: 1 as const,
      expectedIssueId: fixture.issue.id,
      expectedIssueUpdatedAt: fixture.reviewIssue.updatedAt.toISOString(),
      expectedEnvelopeSha256: fixture.reservation.envelopeSha256,
      expectedTerminalObservationSha256: observed.receipt.terminalObservationSha256,
      expectedHeartbeatRunId: fixture.runId,
      expectedExecutionWorkspaceId: fixture.executionWorkspaceId,
      expectedHeadSha: finalHeadSha,
      pullRequest: {
        provider: "github" as const,
        owner: "0BFUSCAT3D",
        repository: "vantage",
        pullRequestNumber: 17,
        url: "https://github.com/0BFUSCAT3D/vantage/pull/17",
        headSha: finalHeadSha,
        baseRef: "main",
        headRef: fixture.branchName,
        draft: true as const,
      },
    };
    const first = await governedIssueCompletionService(db).releaseWithDraftPullRequest({
      companyId: fixture.companyId,
      idempotencyKey: fixture.idempotencyKey,
      request,
      requestedByActorId: "director",
    });
    const replay = await governedIssueCompletionService(db).releaseWithDraftPullRequest({
      companyId: fixture.companyId,
      idempotencyKey: fixture.idempotencyKey,
      request,
      requestedByActorId: "director",
    });

    expect(first.replayed).toBe(false);
    expect(replay.replayed).toBe(true);
    expect(replay.receipt).toEqual(first.receipt);
    expect(governedIssueReservationState(replay.reservation)).toBe("released");
    expect(await db.select({
      status: issues.status,
      assigneeAgentId: issues.assigneeAgentId,
      checkoutRunId: issues.checkoutRunId,
      executionRunId: issues.executionRunId,
    }).from(issues).where(eq(issues.id, fixture.issue.id))).toEqual([{
      status: "in_review",
      assigneeAgentId: fixture.reviewerAgentId,
      checkoutRunId: null,
      executionRunId: null,
    }]);
    expect(await db.select({
      type: issueWorkProducts.type,
      provider: issueWorkProducts.provider,
      externalId: issueWorkProducts.externalId,
      status: issueWorkProducts.status,
      reviewState: issueWorkProducts.reviewState,
      isPrimary: issueWorkProducts.isPrimary,
      createdByRunId: issueWorkProducts.createdByRunId,
    }).from(issueWorkProducts).where(eq(issueWorkProducts.isPrimary, true))).toEqual([{
      type: "pull_request",
      provider: "github",
      externalId: "0BFUSCAT3D/vantage#17",
      status: "draft",
      reviewState: "needs_board_review",
      isPrimary: true,
      createdByRunId: fixture.runId,
    }]);
    expect(await db.select({
      externalId: issueWorkProducts.externalId,
      isPrimary: issueWorkProducts.isPrimary,
    }).from(issueWorkProducts).where(eq(issueWorkProducts.externalId, "0BFUSCAT3D/vantage#16")))
      .toEqual([{ externalId: "0BFUSCAT3D/vantage#16", isPrimary: false }]);
    expect(await db.select({ action: activityLog.action }).from(activityLog))
      .toEqual([
        { action: "issue.governed_terminal_observed" },
        { action: "issue.governed_draft_pull_request_released" },
      ]);
    await expect(lockGovernedV2ExecutionReservationForQueuedRun(db, {
      companyId: fixture.companyId,
      issueId: fixture.issue.id,
    })).rejects.toMatchObject({
      status: 409,
      details: { code: "governed_issue_reservation_released" },
    });
    await expect(governedExecutorLaunchReceiptService(db).resolveRequirementForExecution({
      companyId: fixture.companyId,
      runId: fixture.runId,
      issueId: fixture.issue.id,
      governedContractVersion: 2,
      selectedCwd: fixture.repository.worktree,
      workspace: { id: fixture.executionWorkspaceId, custodyKind: "external_prepared" },
    })).rejects.toMatchObject({
      status: 409,
      details: { code: "governed_executor_workspace_binding_drift" },
    });
    await expect(governedIssueContractService(db).retire({
      companyId: fixture.companyId,
      idempotencyKey: fixture.idempotencyKey,
      request: {
        version: 1,
        expectedIssueId: fixture.issue.id,
        expectedEnvelopeSha256: fixture.reservation.envelopeSha256,
        expectedState: "activated",
        expectedHeartbeatRunId: fixture.runId,
        reason: "must not cancel completed review",
      },
      requestedByActorId: "director",
    })).rejects.toMatchObject({
      status: 409,
      details: { code: "governed_issue_reservation_released" },
    });
    await expect(governedIssueCompletionService(db).releaseWithDraftPullRequest({
      companyId: fixture.companyId,
      idempotencyKey: fixture.idempotencyKey,
      request: {
        ...request,
        pullRequest: {
          ...request.pullRequest,
          pullRequestNumber: 18,
          url: "https://github.com/0BFUSCAT3D/vantage/pull/18",
        },
      },
      requestedByActorId: "director",
    })).rejects.toMatchObject({
      status: 409,
      details: { code: "governed_draft_pull_request_release_conflict" },
    });
    await expect(db.update(governedIssueReservations)
      .set({ releaseSha256: "0".repeat(64) })
      .where(eq(governedIssueReservations.id, fixture.reservation.id)))
      .rejects.toThrow("Failed query");
  });

  it("refuses to observe an active run or release a failed run", async () => {
    const activeFixture = await seedActivatedLaunch();
    await db.update(heartbeatRuns).set({ status: "running", finishedAt: null, exitCode: null })
      .where(eq(heartbeatRuns.id, activeFixture.runId));
    await expect(governedIssueCompletionService(db).observeTerminal({
      companyId: activeFixture.companyId,
      idempotencyKey: activeFixture.idempotencyKey,
      request: observationRequest(activeFixture),
      requestedByActorId: "director",
    })).rejects.toMatchObject({
      status: 409,
      details: { code: "governed_terminal_observation_run_not_terminal" },
    });

    await db.execute(sql.raw('TRUNCATE TABLE "companies" RESTART IDENTITY CASCADE'));
    await Promise.all([...fixtureRoots].map((root) => fs.rm(root, { recursive: true, force: true })));
    fixtureRoots.clear();
    const failedFixture = await seedActivatedLaunch();
    const failedAt = new Date();
    await db.update(heartbeatRuns).set({ status: "failed", exitCode: 1, finishedAt: failedAt })
      .where(eq(heartbeatRuns.id, failedFixture.runId));
    const observed = await governedIssueCompletionService(db).observeTerminal({
      companyId: failedFixture.companyId,
      idempotencyKey: failedFixture.idempotencyKey,
      request: observationRequest(failedFixture),
      requestedByActorId: "director",
    });
    const finalHeadSha = "f".repeat(40);
    await expect(governedIssueCompletionService(db).releaseWithDraftPullRequest({
      companyId: failedFixture.companyId,
      idempotencyKey: failedFixture.idempotencyKey,
      request: {
        version: 1,
        expectedIssueId: failedFixture.issue.id,
        expectedIssueUpdatedAt: failedFixture.reviewIssue.updatedAt.toISOString(),
        expectedEnvelopeSha256: failedFixture.reservation.envelopeSha256,
        expectedTerminalObservationSha256: observed.receipt.terminalObservationSha256,
        expectedHeartbeatRunId: failedFixture.runId,
        expectedExecutionWorkspaceId: failedFixture.executionWorkspaceId,
        expectedHeadSha: finalHeadSha,
        pullRequest: {
          provider: "github",
          owner: "0BFUSCAT3D",
          repository: "vantage",
          pullRequestNumber: 18,
          url: "https://github.com/0BFUSCAT3D/vantage/pull/18",
          headSha: finalHeadSha,
          baseRef: "main",
          headRef: failedFixture.branchName,
          draft: true,
        },
      },
      requestedByActorId: "director",
    })).rejects.toMatchObject({
      status: 409,
      details: { code: "governed_draft_pull_request_release_run_unsuccessful" },
    });
    expect(await db.select().from(issueWorkProducts)).toHaveLength(0);
    expect(await db.select({ releasedAt: governedIssueReservations.releasedAt })
      .from(governedIssueReservations)).toEqual([{ releasedAt: null }]);
  });
});
