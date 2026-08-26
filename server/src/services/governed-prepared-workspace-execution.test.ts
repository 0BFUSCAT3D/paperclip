import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  agents,
  companies,
  createDb,
  executionWorkspaces,
  governedExecutorLaunchReceipts,
  governedIssueReservations,
  instanceSettings,
  issues,
  projectWorkspaces,
  projects,
} from "@paperclipai/db";
import {
  SUBSCRIPTION_AUTH_AUTHORITY_SCHEMA,
  SUBSCRIPTION_AUTH_AUTHORITY_VERSION,
  type SubscriptionAuthAuthorityProofV1,
} from "@paperclipai/adapter-utils";
import { runChildProcess } from "@paperclipai/adapter-utils/server-utils";
import { governedIssueEnvelopeSchema } from "@paperclipai/shared";
import {
  EXECUTION_PROFILE_BINDING_VERSION,
  EXECUTION_PROFILE_PROJECTION_SCHEMA,
  executionProfileSha256,
  type GovernedExecutionProfileProjectionV1,
  type InspectedExecutionProfileBinding,
} from "./execution-profile-binding.js";
import {
  governedIssueContractService,
  governedIssueEnvelopeSha256,
  governedIssueSha256,
} from "./governed-issue-contract.js";
import {
  captureGovernedExecutorProcessIdentityForSpawn,
  governedExecutorLaunchReceiptService,
} from "./governed-executor-launch-receipts.js";
import { instanceSettingsService } from "./instance-settings.js";
import { issueService } from "./issues.js";
import { executionWorkspaceService } from "./execution-workspaces.js";
import { ensureRuntimeServicesForRun } from "./workspace-runtime.js";
import { normalizeIssueExecutionPolicy } from "./issue-execution-policy.js";
import { assertCapturedLocalProcessIdentityCurrent } from "./process-start-identity.js";
import { validateStoredPreparedExecutionWorkspace } from "./prepared-execution-workspaces.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";

const execFileAsync = promisify(execFile);
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describe("governed executor spawn authority", () => {
  it("keeps ordinary Paperclip runs alive when exact process observation is unavailable", async () => {
    let metadataPersisted = false;
    const result = await runChildProcess(
      randomUUID(),
      process.execPath,
      ["-e", "process.stdin.pipe(process.stdout)"],
      {
        cwd: process.cwd(),
        env: {},
        stdin: "ordinary prompt",
        timeoutSec: 5,
        graceSec: 1,
        onLog: async () => undefined,
        onSpawn: async (meta) => {
          const captured = captureGovernedExecutorProcessIdentityForSpawn({
            requiresLaunchReceipt: false,
            pid: meta.pid,
            capture: () => {
              throw new Error("exact process observation unavailable");
            },
          });
          expect(captured).toBeNull();
          metadataPersisted = true;
        },
      },
    );

    expect(metadataPersisted).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("ordinary prompt");
  });

  it("rejects and terminates an external-prepared launch when exact process observation is unavailable", async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-prepared-spawn-authority-"));
    const marker = path.join(parent, "prompt-received");
    try {
      await expect(runChildProcess(
        randomUUID(),
        process.execPath,
        [
          "-e",
          `process.stdin.once('data',()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'received'));setInterval(()=>{},1000);`,
        ],
        {
          cwd: process.cwd(),
          env: {},
          stdin: "go",
          timeoutSec: 5,
          graceSec: 1,
          onLog: async () => undefined,
          onSpawn: async (meta) => {
            captureGovernedExecutorProcessIdentityForSpawn({
              requiresLaunchReceipt: true,
              pid: meta.pid,
              capture: () => {
                throw new Error("exact process observation unavailable");
              },
            });
          },
        },
      )).rejects.toThrow("exact process observation unavailable");
      await expect(fs.access(marker)).rejects.toThrow();
    } finally {
      await fs.rm(parent, { recursive: true, force: true });
    }
  });
});

async function git(cwd: string, args: string[]) {
  return execFileAsync("git", args, { cwd, encoding: "utf8" });
}

async function createPreparedRepository() {
  const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-governed-prepared-")));
  const root = path.join(parent, "repository");
  const worktree = path.join(parent, "prepared");
  await fs.mkdir(root);
  await git(root, ["init", "-b", "main"]);
  await git(root, ["config", "user.email", "test@example.com"]);
  await git(root, ["config", "user.name", "Test"]);
  await fs.writeFile(path.join(root, "README.md"), "ready\n", "utf8");
  await git(root, ["add", "README.md"]);
  await git(root, ["commit", "-m", "initial"]);
  await git(root, ["worktree", "add", "-b", "reeve/governed-task", worktree, "HEAD"]);
  return {
    parent,
    root,
    worktree,
    commonGitDirectory: await fs.realpath(path.join(root, ".git")),
    headSha: (await git(worktree, ["rev-parse", "HEAD"])).stdout.trim(),
    branchName: "reeve/governed-task",
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
  const projection: GovernedExecutionProfileProjectionV1 = {
    schema: EXECUTION_PROFILE_PROJECTION_SCHEMA,
    version: EXECUTION_PROFILE_BINDING_VERSION,
    companyId: input.companyId,
    agentId: input.builderAgentId,
    issueId: input.issueId,
    adapterType: "claude_local",
    billingPolicy: "subscription_only",
    engine: "cli",
    environment: { id: randomUUID(), driver: "local" },
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

describeEmbeddedPostgres("governed prepared-workspace execution", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const fixtureRoots = new Set<string>();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-governed-prepared-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.execute(sql.raw(`
      TRUNCATE TABLE
        "governed_executor_launch_receipts",
        "heartbeat_run_execution_profiles",
        "governed_issue_reservations",
        "agent_wakeup_requests",
        "heartbeat_runs",
        "issue_create_idempotency_keys",
        "issues",
        "execution_workspaces",
        "project_workspaces",
        "projects",
        "agents",
        "instance_settings",
        "companies"
      RESTART IDENTITY CASCADE
    `));
    await Promise.all([...fixtureRoots].map((root) => fs.rm(root, { recursive: true, force: true })));
    fixtureRoots.clear();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedReservedPreparedWorkspace() {
    const repository = await createPreparedRepository();
    fixtureRoots.add(repository.parent);
    const companyId = randomUUID();
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const executionWorkspaceId = randomUUID();
    const builderAgentId = randomUUID();
    const reviewerAgentId = randomUUID();
    const idempotencyKey = `reeve-build:${randomUUID()}`;
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
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
    await db.insert(projects).values({ id: projectId, companyId, name: "Prepared project", status: "in_progress" });
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
      name: "Prepared task",
      status: "active",
      cwd: repository.worktree,
      baseRef: repository.headSha,
      branchName: repository.branchName,
      providerType: "git_worktree",
      providerRef: repository.worktree,
      custodyKind: "external_prepared",
      externalConnectionId: randomUUID(),
      externalLifecycleId: randomUUID(),
      externalTaskId: "prepared-task",
      preparedIdentitySha256: "a".repeat(64),
      authorizedStartHeadSha: repository.headSha,
      repositoryIdentitySha256: "b".repeat(64),
      inspectionReceiptSha256: "c".repeat(64),
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
      title: "Use the prepared worktree",
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
    const reservation = await governedIssueContractService(db).getReservation(companyId, idempotencyKey);
    expect(issue.executionWorkspaceId).toBe(executionWorkspaceId);
    expect(reservation?.executionWorkspaceId).toBe(executionWorkspaceId);
    expect(await db.select({ sourceIssueId: executionWorkspaces.sourceIssueId })
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, executionWorkspaceId)))
      .toEqual([{ sourceIssueId: issue.id }]);

    return {
      ...repository,
      companyId,
      executionWorkspaceId,
      builderAgentId,
      issue,
      reservation: reservation!,
      idempotencyKey,
      envelope,
      executionProfiles,
      executionProfileIntentSha256,
    };
  }

  async function activate(fixture: Awaited<ReturnType<typeof seedReservedPreparedWorkspace>>) {
    return governedIssueContractService(db).activate({
      version: 2,
      companyId: fixture.companyId,
      idempotencyKey: fixture.idempotencyKey,
      expectedIssueId: fixture.issue.id,
      expectedIssueUpdatedAt: fixture.reservation.reservedIssueUpdatedAt.toISOString(),
      expectedEnvelopeSha256: fixture.reservation.envelopeSha256,
      expectedExecutionProfileIntentSha256: fixture.executionProfileIntentSha256,
      builderAgentId: fixture.builderAgentId,
      executionProfiles: fixture.executionProfiles,
      inspectExecutionProfile: async ({ agentExecutionProfileRevision, issueAssigneeProfileRevision }) =>
        inspectedBuilderProfile({
          companyId: fixture.companyId,
          builderAgentId: fixture.builderAgentId,
          issueId: fixture.issue.id,
          agentExecutionProfileRevision,
          issueAssigneeProfileRevision,
        }),
      inspectPreparedExecutionWorkspace: async ({ db: transaction, workspace }) => {
        await validateStoredPreparedExecutionWorkspace({
          db: transaction,
          companyId: fixture.companyId,
          workspace,
        });
      },
      envelope: fixture.envelope,
      requestedByActorType: "user",
      requestedByActorId: "director",
    });
  }

  it("revalidates the exact prepared worktree during governed v2 activation", async () => {
    const fixture = await seedReservedPreparedWorkspace();
    await fs.writeFile(path.join(fixture.worktree, "unreviewed.txt"), "dirty\n", "utf8");

    await expect(activate(fixture)).rejects.toMatchObject({
      status: 409,
      details: { code: "prepared_workspace_dirty" },
    });
    expect(await db.select({ activatedAt: governedIssueReservations.activatedAt })
      .from(governedIssueReservations)
      .where(eq(governedIssueReservations.id, fixture.reservation.id)))
      .toEqual([{ activatedAt: null }]);
    expect(await db.select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, fixture.issue.id)))
      .toEqual([{ status: "backlog" }]);
  });

  it("withholds the launch receipt when the child exits during prepared-worktree validation", async () => {
    const fixture = await seedReservedPreparedWorkspace();
    const activated = await activate(fixture);
    const runId = activated.reservation.heartbeatRunId!;
    const captured = {
      pid: process.pid,
      startToken: "a".repeat(64),
    };
    let childAlive = true;
    const service = governedExecutorLaunchReceiptService(db, {
      validatePreparedExecutionWorkspace: async (input) => {
        const validated = await validateStoredPreparedExecutionWorkspace(input);
        childAlive = false;
        return validated;
      },
      revalidateCapturedProcessIdentity: () => {
        if (!childAlive) throw new Error("executor process exited during workspace validation");
      },
    });

    await expect(service.persistForSpawn({
      companyId: fixture.companyId,
      runId,
      executionWorkspaceId: fixture.executionWorkspaceId,
      selectedCwd: fixture.worktree,
      capturedProcessIdentity: captured,
    })).rejects.toThrow("executor process exited during workspace validation");
    expect(await db.select().from(governedExecutorLaunchReceipts)).toHaveLength(0);
  });

  it("persists one immutable post-spawn receipt and replays only the exact process", async () => {
    const fixture = await seedReservedPreparedWorkspace();
    const activated = await activate(fixture);
    const runId = activated.reservation.heartbeatRunId!;
    const captured = (pid: number) => ({
      pid,
      startToken: `${pid.toString(16).padStart(64, "0")}`,
    });
    const mismatchedObserverService = governedExecutorLaunchReceiptService(db, {
      revalidateCapturedProcessIdentity: (identity) =>
        assertCapturedLocalProcessIdentityCurrent(identity, (pid) => ({
          pid,
          startToken: "f".repeat(64),
        })),
    });
    await expect(mismatchedObserverService.persistForSpawn({
      companyId: fixture.companyId,
      runId,
      executionWorkspaceId: fixture.executionWorkspaceId,
      selectedCwd: fixture.worktree,
      capturedProcessIdentity: captured(process.pid),
    })).rejects.toThrow("process instance changed");
    expect(await db.select().from(governedExecutorLaunchReceipts)).toHaveLength(0);

    const service = governedExecutorLaunchReceiptService(db, {
      revalidateCapturedProcessIdentity: () => undefined,
    });

    await expect(service.resolveRequirementForExecution({
      companyId: fixture.companyId,
      runId,
      issueId: fixture.issue.id,
      governedContractVersion: 2,
      selectedCwd: fixture.worktree,
      workspace: {
        id: fixture.executionWorkspaceId,
        custodyKind: "external_prepared",
      },
    })).resolves.toEqual({
      reservationId: fixture.reservation.id,
      executionWorkspaceId: fixture.executionWorkspaceId,
    });
    await expect(service.resolveRequirementForExecution({
      companyId: fixture.companyId,
      runId,
      issueId: null,
      governedContractVersion: 0,
      selectedCwd: fixture.root,
      workspace: {
        id: randomUUID(),
        custodyKind: "paperclip",
      },
    })).resolves.toBeNull();

    const first = await service.persistForSpawn({
      companyId: fixture.companyId,
      runId,
      executionWorkspaceId: fixture.executionWorkspaceId,
      selectedCwd: fixture.worktree,
      capturedProcessIdentity: captured(process.pid),
    });
    expect(first).toMatchObject({
      version: 1,
      receipt: {
        connectionId: expect.any(String),
        lifecycleId: expect.any(String),
        taskId: "prepared-task",
        pid: process.pid,
        startToken: expect.stringMatching(/^[0-9a-f]{64}$/),
        instanceId: expect.any(String),
        receiptId: expect.any(String),
      },
      workspace: {
        executionWorkspaceId: fixture.executionWorkspaceId,
        cwd: fixture.worktree,
        branch: fixture.branchName,
        headSha: fixture.headSha,
      },
    });
    await fs.writeFile(path.join(fixture.worktree, "executor-output.txt"), "changed after spawn\n", "utf8");
    const reusedPidReplayService = governedExecutorLaunchReceiptService(db, {
      revalidateCapturedProcessIdentity: (identity) =>
        assertCapturedLocalProcessIdentityCurrent(identity, (pid) => ({
          pid,
          startToken: "e".repeat(64),
        })),
    });
    await expect(reusedPidReplayService.persistForSpawn({
      companyId: fixture.companyId,
      runId,
      executionWorkspaceId: fixture.executionWorkspaceId,
      selectedCwd: fixture.worktree,
      capturedProcessIdentity: captured(process.pid),
    })).rejects.toThrow("process instance changed");
    expect(await db.select().from(governedExecutorLaunchReceipts)).toHaveLength(1);
    await expect(service.persistForSpawn({
      companyId: fixture.companyId,
      runId,
      executionWorkspaceId: fixture.executionWorkspaceId,
      selectedCwd: fixture.worktree,
      capturedProcessIdentity: captured(process.pid),
    })).resolves.toEqual(first);
    expect(await db.select().from(governedExecutorLaunchReceipts)).toHaveLength(1);
    await expect(service.persistForSpawn({
      companyId: fixture.companyId,
      runId,
      executionWorkspaceId: fixture.executionWorkspaceId,
      selectedCwd: fixture.worktree,
      capturedProcessIdentity: captured(process.ppid),
    })).rejects.toMatchObject({
      status: 409,
      details: { code: "governed_executor_launch_receipt_conflict" },
    });
  });

  it("allows only exact ordinary-update replay of an adopted workspace binding", async () => {
    const fixture = await seedReservedPreparedWorkspace();
    await activate(fixture);
    const service = issueService(db);

    await expect(service.update(fixture.issue.id, {
      executionWorkspaceId: fixture.executionWorkspaceId,
      executionWorkspacePreference: fixture.issue.executionWorkspacePreference,
      executionWorkspaceSettings: fixture.issue.executionWorkspaceSettings,
    })).resolves.toMatchObject({ executionWorkspaceId: fixture.executionWorkspaceId });

    await expect(service.update(fixture.issue.id, { executionWorkspaceId: null })).rejects.toMatchObject({
      status: 409,
      details: { code: "governed_prepared_workspace_binding_immutable" },
    });

    const normalWorkspaceId = randomUUID();
    await db.insert(executionWorkspaces).values({
      id: normalWorkspaceId,
      companyId: fixture.companyId,
      projectId: fixture.issue.projectId!,
      projectWorkspaceId: fixture.issue.projectWorkspaceId,
      sourceIssueId: null,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: "Paperclip workspace",
      status: "active",
      cwd: fixture.root,
      providerType: "git_worktree",
      providerRef: fixture.root,
    });
    await expect(service.update(fixture.issue.id, {
      executionWorkspaceId: normalWorkspaceId,
    })).rejects.toMatchObject({
      status: 409,
      details: { code: "governed_prepared_workspace_binding_immutable" },
    });

    await expect(service.update(fixture.issue.id, {
      executionWorkspaceSettings: { mode: "shared_workspace" },
    })).rejects.toMatchObject({
      status: 409,
      details: { code: "governed_prepared_workspace_binding_immutable" },
    });
  });

  it("holds generic branch reconciliation before any external-custody Git mutation", async () => {
    const fixture = await seedReservedPreparedWorkspace();
    await expect(executionWorkspaceService(db).reconcileExecutionWorkspaceBranch(
      fixture.executionWorkspaceId,
      {
        mode: "quarantine_restore",
        actor: { actorType: "user", actorId: "director", agentId: null, runId: null },
      },
    )).rejects.toMatchObject({
      status: 409,
      details: { code: "external_prepared_workspace_mutation_forbidden" },
    });
    await expect(fs.stat(fixture.worktree)).resolves.toBeDefined();
    expect((await git(fixture.worktree, ["status", "--porcelain=v1"])).stdout).toBe("");
  });

  it("keeps external custody out of close inspection and terminal finalization", async () => {
    const fixture = await seedReservedPreparedWorkspace();
    const marker = path.join(fixture.parent, "fsmonitor-invoked");
    const monitor = path.join(fixture.parent, "fsmonitor.sh");
    await fs.writeFile(monitor, `#!/bin/sh\n: > '${marker}'\nexit 0\n`, "utf8");
    await fs.chmod(monitor, 0o700);
    await git(fixture.worktree, ["config", "core.fsmonitor", monitor]);

    const service = executionWorkspaceService(db, { workspaceReaperCooldownDays: 0 });
    const readiness = await service.getCloseReadiness(fixture.executionWorkspaceId);
    expect(readiness).toMatchObject({
      git: null,
      warnings: expect.arrayContaining([
        expect.stringContaining("Reeve custody"),
      ]),
    });

    const sweep = await service.sweepTerminalWorkspaces();
    expect(sweep).toMatchObject({
      checked: 1,
      archived: 0,
      heldExternalCustody: 1,
    });
    await expect(fs.stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await db.select({ status: executionWorkspaces.status })
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, fixture.executionWorkspaceId)))
      .toEqual([{ status: "active" }]);

    await expect(service.update(fixture.executionWorkspaceId, { status: "idle" }))
      .rejects.toMatchObject({
        status: 409,
        details: { code: "external_prepared_workspace_identity_immutable" },
      });
    await expect(service.archiveWorkspaceUnderLifecycleLock({
      id: fixture.executionWorkspaceId,
      patch: { status: "archived" },
      closedAt: new Date(),
    })).resolves.toEqual({ outcome: "external_custody_held" });
    expect(await db.select({ status: executionWorkspaces.status })
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, fixture.executionWorkspaceId)))
      .toEqual([{ status: "active" }]);
  });

  it("blocks inherited runtime services before any prepared-worktree command executes", async () => {
    const fixture = await seedReservedPreparedWorkspace();
    const marker = path.join(fixture.parent, "runtime-command-invoked");
    const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`,
    )}`;
    await expect(ensureRuntimeServicesForRun({
      db,
      runId: randomUUID(),
      agent: { id: fixture.builderAgentId, name: "Builder", companyId: fixture.companyId },
      issue: { id: fixture.issue.id, identifier: null, title: fixture.issue.title },
      workspace: {
        baseCwd: fixture.root,
        source: "task_session",
        projectId: fixture.issue.projectId,
        workspaceId: fixture.issue.projectWorkspaceId,
        repoUrl: null,
        repoRef: fixture.headSha,
        strategy: "git_worktree",
        cwd: fixture.worktree,
        branchName: fixture.branchName,
        worktreePath: fixture.worktree,
        warnings: [],
        created: false,
      },
      executionWorkspaceId: fixture.executionWorkspaceId,
      config: {
        workspaceRuntime: {
          services: [{ name: "forbidden", command, port: { type: "auto" } }],
        },
      },
      adapterEnv: {},
    })).rejects.toMatchObject({
      status: 409,
      details: { code: "external_prepared_workspace_runtime_control_held" },
    });
    await expect(fs.stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
