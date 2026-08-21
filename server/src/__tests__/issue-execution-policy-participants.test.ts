import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  governedIssueReservations,
  heartbeatRunExecutionProfiles,
  heartbeatRuns,
  instanceSettings,
  issueCreateIdempotencyKeys,
  issueExecutionDecisions,
  issueRelations,
  issueWorkProducts,
  issues,
} from "@paperclipai/db";
import {
  SUBSCRIPTION_AUTH_AUTHORITY_SCHEMA,
  SUBSCRIPTION_AUTH_AUTHORITY_VERSION,
  type SubscriptionAuthAuthorityProofV1,
} from "@paperclipai/adapter-utils";
import {
  applyIssueExecutionPolicyTransition,
  normalizeIssueExecutionPolicy,
} from "../services/issue-execution-policy.ts";
import { assertIssueExecutionPolicyParticipants } from "../services/issue-execution-policy-participants.ts";
import { issueService } from "../services/issues.ts";
import { agentService } from "../services/agents.ts";
import { companyService } from "../services/companies.ts";
import {
  governedIssueContractService,
  governedIssueEnvelopeSha256,
  governedIssueReservedSnapshot,
  governedIssueSha256,
  serializeGovernedIssueActivationReceipt,
} from "../services/governed-issue-contract.ts";
import {
  EXECUTION_PROFILE_BINDING_VERSION,
  EXECUTION_PROFILE_PROJECTION_SCHEMA,
  executionProfileSha256,
  type GovernedExecutionProfileProjectionV1,
  type InspectedExecutionProfileBinding,
} from "../services/execution-profile-binding.ts";
import { lockIssueExecutionReviewEvidenceBuilderAgent } from "../services/issue-execution-review-evidence.ts";
import {
  ensureLocalTrustedBoardPrincipal,
  LOCAL_TRUSTED_BOARD_USER_ID,
} from "../services/local-trusted-board-principal.ts";
import { loadCompanyUserDirectory } from "../routes/access.ts";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

describeEmbeddedPostgres("execution-policy participant invariants", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-policy-participants-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(governedIssueReservations);
    await db.delete(issueCreateIdempotencyKeys);
    await db.delete(issueExecutionDecisions);
    await db.delete(issueWorkProducts);
    await db.delete(activityLog);
    await db.delete(issueRelations);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(agentWakeupRequests);
    await db.delete(companyMemberships);
    await db.delete(authUsers);
    await db.delete(agents);
    await db.delete(instanceSettings);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany(name = "Paperclip") {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name,
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedAgent(companyId: string, name: string, status = "active") {
    const id = randomUUID();
    await db.insert(agents).values({
      id,
      companyId,
      name,
      role: "engineer",
      status,
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return id;
  }

  async function seedUser(companyId: string, userId = `user-${randomUUID()}`) {
    const now = new Date();
    await db.insert(authUsers).values({
      id: userId,
      name: "Director",
      email: `${userId}@example.test`,
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: userId,
      status: "active",
      membershipRole: "member",
    });
    return userId;
  }

  function twoStagePolicy(reviewerAgentId: string, directorUserId: string) {
    return normalizeIssueExecutionPolicy({
      stages: [
        { type: "review", participants: [{ type: "agent", agentId: reviewerAgentId }] },
        { type: "approval", participants: [{ type: "user", userId: directorUserId }] },
      ],
    })!;
  }

  function authorityFingerprint(character: string) {
    return `decision-spec-v1.${character.repeat(64)}`;
  }

  function inspectedBuilderProfile(input: {
    companyId: string;
    builderAgentId: string;
    issueId: string;
    agentExecutionProfileRevision: number;
    issueAssigneeProfileRevision: number;
  }): InspectedExecutionProfileBinding {
    const evidence = (character: string) => ({
      evidence: "credential_bound" as const,
      identityFingerprint: authorityFingerprint(character),
      revisionFingerprint: authorityFingerprint(character === "f" ? "e" : "f"),
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
      credentialRevisionFingerprint: authorityFingerprint("d"),
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

  it("validates create participants and rejects self-review and inactive or foreign principals", async () => {
    const companyId = await seedCompany();
    const foreignCompanyId = await seedCompany("Foreign");
    const builderAgentId = await seedAgent(companyId, "Builder");
    const reviewerAgentId = await seedAgent(companyId, "Reviewer");
    const pausedReviewerId = await seedAgent(companyId, "Paused reviewer", "paused");
    const foreignReviewerId = await seedAgent(foreignCompanyId, "Foreign reviewer");
    const directorUserId = await seedUser(companyId);
    const foreignDirectorUserId = await seedUser(foreignCompanyId);
    const svc = issueService(db);

    await expect(svc.create(companyId, {
      title: "Self review is forbidden",
      status: "todo",
      priority: "medium",
      reviewPolicy: "not_creator",
      assigneeAgentId: builderAgentId,
      createdByAgentId: builderAgentId,
      executionPolicy: twoStagePolicy(builderAgentId, directorUserId),
    })).rejects.toMatchObject({
      status: 422,
      details: { code: "execution_policy_review_participant_not_independent" },
    });

    await expect(svc.create(companyId, {
      title: "Paused builder is forbidden on governed work",
      status: "todo",
      priority: "medium",
      assigneeAgentId: pausedReviewerId,
      executionPolicy: twoStagePolicy(reviewerAgentId, directorUserId),
    })).rejects.toMatchObject({
      status: 409,
      details: { code: "execution_policy_assignee_agent_ineligible", reason: "paused" },
    });

    await expect(svc.create(companyId, {
      title: "Paused reviewer is forbidden",
      status: "todo",
      priority: "medium",
      assigneeAgentId: builderAgentId,
      executionPolicy: twoStagePolicy(pausedReviewerId, directorUserId),
    })).rejects.toMatchObject({
      status: 409,
      details: { code: "execution_policy_participant_agent_ineligible", reason: "paused" },
    });

    await expect(svc.create(companyId, {
      title: "Foreign reviewer is forbidden",
      status: "todo",
      priority: "medium",
      assigneeAgentId: builderAgentId,
      executionPolicy: twoStagePolicy(foreignReviewerId, directorUserId),
    })).rejects.toMatchObject({
      status: 422,
      details: { code: "execution_policy_participant_agent_not_found" },
    });

    await expect(svc.create(companyId, {
      title: "Foreign director is forbidden",
      status: "todo",
      priority: "medium",
      assigneeAgentId: builderAgentId,
      executionPolicy: twoStagePolicy(reviewerAgentId, foreignDirectorUserId),
    })).rejects.toMatchObject({
      status: 422,
      details: { code: "execution_policy_participant_user_not_found" },
    });

    await expect(svc.create(companyId, {
      title: "Independent review",
      status: "todo",
      priority: "medium",
      reviewPolicy: "not_creator",
      assigneeAgentId: builderAgentId,
      createdByAgentId: builderAgentId,
      executionPolicy: twoStagePolicy(reviewerAgentId, directorUserId),
    })).resolves.toMatchObject({ status: "todo", assigneeAgentId: builderAgentId });
  });

  it("preserves a normal builder to independent review to director approval lifecycle", async () => {
    const companyId = await seedCompany();
    const builderAgentId = await seedAgent(companyId, "Builder");
    const reviewerAgentId = await seedAgent(companyId, "Reviewer");
    const directorUserId = await seedUser(companyId);
    const policy = twoStagePolicy(reviewerAgentId, directorUserId);
    const svc = issueService(db);
    let issue = await svc.create(companyId, {
      title: "Lifecycle",
      status: "todo",
      priority: "medium",
      reviewPolicy: "not_creator",
      assigneeAgentId: builderAgentId,
      createdByAgentId: builderAgentId,
      executionPolicy: policy,
    });
    issue = (await svc.update(issue.id, { status: "in_progress" }))!;

    const enterReview = applyIssueExecutionPolicyTransition({
      issue,
      policy,
      previousPolicy: policy,
      executionPolicyGovernanceChanged: false,
      requestedStatus: "done",
      requestedAssigneePatch: {},
      actor: { agentId: builderAgentId, userId: null },
      commentBody: "Builder completed the implementation.",
    });
    issue = (await svc.update(issue.id, { status: "done", ...enterReview.patch }))!;
    expect(issue).toMatchObject({
      status: "in_review",
      assigneeAgentId: reviewerAgentId,
      executionState: {
        status: "pending",
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: reviewerAgentId },
        returnAssignee: { type: "agent", agentId: builderAgentId },
      },
    });

    const enterApproval = applyIssueExecutionPolicyTransition({
      issue,
      policy,
      previousPolicy: policy,
      executionPolicyGovernanceChanged: false,
      requestedStatus: "done",
      requestedAssigneePatch: {},
      actor: { agentId: reviewerAgentId, userId: null },
      commentBody: "Independent review approved.",
    });
    issue = (await svc.update(issue.id, { status: "done", ...enterApproval.patch }))!;
    expect(issue).toMatchObject({
      status: "in_review",
      assigneeAgentId: null,
      assigneeUserId: directorUserId,
      executionState: {
        status: "pending",
        currentStageType: "approval",
        currentParticipant: { type: "user", userId: directorUserId },
      },
    });

    const finalApproval = applyIssueExecutionPolicyTransition({
      issue,
      policy,
      previousPolicy: policy,
      executionPolicyGovernanceChanged: false,
      requestedStatus: "done",
      requestedAssigneePatch: {},
      actor: { agentId: null, userId: directorUserId },
      commentBody: "Director approval granted.",
    });
    issue = (await svc.update(issue.id, { status: "done", ...finalApproval.patch }))!;
    expect(issue).toMatchObject({
      status: "done",
      executionState: { status: "completed" },
    });
  });

  it("materializes local-board as a real active user visible in the user directory", async () => {
    const companyId = await seedCompany();
    const reviewerAgentId = await seedAgent(companyId, "Reviewer");
    await ensureLocalTrustedBoardPrincipal(db);

    const directory = await loadCompanyUserDirectory(db, companyId);
    expect(directory).toContainEqual(expect.objectContaining({
      principalId: LOCAL_TRUSTED_BOARD_USER_ID,
      status: "active",
      user: expect.objectContaining({ id: LOCAL_TRUSTED_BOARD_USER_ID, name: "Board" }),
    }));
    await expect(issueService(db).create(companyId, {
      title: "Local director approval",
      status: "todo",
      priority: "medium",
      executionPolicy: twoStagePolicy(reviewerAgentId, LOCAL_TRUSTED_BOARD_USER_ID),
    })).resolves.toMatchObject({ title: "Local director approval" });
  });

  it("revalidates every participant and assignee on idempotent generic replay", async () => {
    const companyId = await seedCompany();
    const builderAgentId = await seedAgent(companyId, "Builder");
    const reviewerAgentId = await seedAgent(companyId, "Reviewer");
    const directorUserId = await seedUser(companyId);
    const svc = issueService(db);

    const issue = await svc.create(companyId, {
      title: "Replay validates",
      status: "todo",
      priority: "medium",
      assigneeAgentId: builderAgentId,
      idempotencyKey: "reeve-staged-filing-1",
      executionPolicy: twoStagePolicy(reviewerAgentId, directorUserId),
    });
    await expect(svc.getByCreateIdempotencyKey(companyId, "reeve-staged-filing-1"))
      .resolves.toMatchObject({ id: issue.id, title: "Replay validates" });
    await db.update(agents).set({ status: "paused" }).where(eq(agents.id, reviewerAgentId));
    await expect(svc.create(companyId, {
      title: "Replay validates",
      status: "todo",
      priority: "medium",
      assigneeAgentId: builderAgentId,
      idempotencyKey: "reeve-staged-filing-1",
      executionPolicy: twoStagePolicy(reviewerAgentId, directorUserId),
    })).rejects.toMatchObject({
      status: 409,
      details: { code: "execution_policy_participant_agent_ineligible", reason: "paused" },
    });
  });

  it("durably activates once and recovers lost responses or missing immediate dispatch by exact replay", async () => {
    const companyId = await seedCompany();
    const builderAgentId = await seedAgent(companyId, "Builder");
    const reviewerAgentId = await seedAgent(companyId, "Reviewer");
    const directorUserId = await seedUser(companyId);
    const executionPolicy = twoStagePolicy(reviewerAgentId, directorUserId);
    const envelope = {
      title: "Durable governed activation",
      description: "Build only after the reservation CAS succeeds.",
      workMode: "standard" as const,
      priority: "high" as const,
      reviewPolicy: "not_creator" as const,
      requestDepth: 0,
      executionPolicy,
    };
    const idempotencyKey = "reeve-build:lost-response";
    const issue = await issueService(db).create(companyId, {
      ...envelope,
      status: "backlog",
      assigneeAgentId: null,
      assigneeUserId: null,
      createdByUserId: directorUserId,
      idempotencyKey,
      allowDuplicate: true,
      governanceReservation: {
        envelope,
        requestIntentSha256: governedIssueSha256(envelope),
        envelopeSha256: governedIssueEnvelopeSha256(envelope),
      },
    });
    const contracts = governedIssueContractService(db);
    const reservation = await contracts.getReservation(companyId, idempotencyKey);
    expect(reservation).not.toBeNull();

    const activationInput = {
      companyId,
      idempotencyKey,
      expectedIssueId: issue.id,
      expectedIssueUpdatedAt: reservation!.reservedIssueUpdatedAt.toISOString(),
      expectedEnvelopeSha256: reservation!.envelopeSha256,
      builderAgentId,
      envelope,
      requestedByActorType: "user" as const,
      requestedByActorId: directorUserId,
    };
    // Treat the first result as a lost HTTP response and deliberately do not
    // invoke the immediate dispatcher. The transaction itself is the wake proof.
    const first = await contracts.activate(activationInput);
    expect(first.replayed).toBe(false);
    expect(first.needsDispatch).toBe(true);
    const [durableWake] = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, first.reservation.wakeupRequestId!));
    const [durableRun] = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, first.reservation.heartbeatRunId!));
    expect(durableWake).toMatchObject({ status: "queued", runId: durableRun!.id });
    expect(durableRun).toMatchObject({ status: "queued", wakeupRequestId: durableWake!.id });

    const activationSnapshot = first.issue;
    await db.update(issues).set({
      status: "in_progress",
      updatedAt: new Date(new Date(activationSnapshot.updatedAt).getTime() + 5_000),
    }).where(eq(issues.id, issue.id));

    const [replayA, replayB] = await Promise.all([
      contracts.activate(activationInput),
      contracts.activate(activationInput),
    ]);
    expect(replayA.replayed).toBe(true);
    expect(replayB.replayed).toBe(true);
    expect(replayA.reservation.wakeupRequestId).toBe(first.reservation.wakeupRequestId);
    expect(replayB.reservation.heartbeatRunId).toBe(first.reservation.heartbeatRunId);
    expect(replayA.issue).toEqual(activationSnapshot);
    expect(replayB.issue).toEqual(activationSnapshot);
    expect(serializeGovernedIssueActivationReceipt(replayA.reservation)).toMatchObject({
      issueUpdatedAt: activationSnapshot.updatedAt,
      issueSnapshot: activationSnapshot,
    });
    expect(await db.select().from(agentWakeupRequests).where(eq(
      agentWakeupRequests.idempotencyKey,
      `governed_issue_activation:v1:${reservation!.id}`,
    ))).toHaveLength(1);

    const otherBuilderAgentId = await seedAgent(companyId, "Other builder");
    await expect(contracts.activate({ ...activationInput, builderAgentId: otherBuilderAgentId }))
      .rejects.toMatchObject({
        status: 409,
        details: { code: "governed_issue_activation_conflict" },
      });
  });

  it("atomically binds a version 2 activation to participant revisions and one immutable run profile", async () => {
    const companyId = await seedCompany();
    const builderAgentId = await seedAgent(companyId, "Builder");
    const reviewerAgentId = await seedAgent(companyId, "Reviewer");
    const directorUserId = await seedUser(companyId);
    const executionPolicy = twoStagePolicy(reviewerAgentId, directorUserId);
    const envelope = {
      title: "Immutable subscription activation",
      description: "Bind the builder wake to exact execution profile authority.",
      workMode: "standard" as const,
      priority: "high" as const,
      reviewPolicy: "not_creator" as const,
      requestDepth: 0,
      executionPolicy,
    };
    const executionProfiles = {
      builderAgentId,
      participants: [builderAgentId, reviewerAgentId]
        .sort((left, right) => left.localeCompare(right))
        .map((agentId) => ({ agentId, executionProfileRevision: 1 })),
    };
    const idempotencyKey = "reeve-build:profile-bound";
    const requestIntentSha256 = governedIssueSha256({
      version: 2,
      issue: envelope,
      executionProfiles,
    });
    const executionProfileIntentSha256 = governedIssueSha256(executionProfiles);
    const issue = await issueService(db).create(companyId, {
      ...envelope,
      status: "backlog",
      assigneeAgentId: null,
      assigneeUserId: null,
      createdByUserId: directorUserId,
      idempotencyKey,
      allowDuplicate: true,
      governanceReservation: {
        contractVersion: 2,
        requestIntentSha256,
        envelopeSha256: governedIssueEnvelopeSha256(envelope),
        envelope,
        executionProfileIntentSha256,
        executionProfileIntent: executionProfiles,
      },
    });
    const contracts = governedIssueContractService(db);
    const reservation = await contracts.getReservation(companyId, idempotencyKey);
    expect(reservation).toMatchObject({
      contractVersion: 2,
      issueId: issue.id,
      executionProfileIntentSha256,
      executionProfileReceipt: null,
    });
    const inspectedExecutionProfile = inspectedBuilderProfile({
      companyId,
      builderAgentId,
      issueId: issue.id,
      agentExecutionProfileRevision: 1,
      issueAssigneeProfileRevision: 2,
    });
    let inspectionCalls = 0;
    const activationInput = {
      version: 2 as const,
      companyId,
      idempotencyKey,
      expectedIssueId: issue.id,
      expectedIssueUpdatedAt: reservation!.reservedIssueUpdatedAt.toISOString(),
      expectedEnvelopeSha256: reservation!.envelopeSha256,
      expectedExecutionProfileIntentSha256: executionProfileIntentSha256,
      builderAgentId,
      executionProfiles,
      inspectExecutionProfile: async (context: {
        db: unknown;
        agentExecutionProfileRevision: number;
        issueAssigneeProfileRevision: number;
      }) => {
        inspectionCalls += 1;
        expect(context.db).toBeDefined();
        expect(context.agentExecutionProfileRevision).toBe(1);
        expect(context.issueAssigneeProfileRevision).toBe(2);
        const [assignedInsideActivation] = await (context.db as typeof db)
          .select({
            status: issues.status,
            assigneeAgentId: issues.assigneeAgentId,
            assigneeProfileRevision: issues.assigneeProfileRevision,
          })
          .from(issues)
          .where(eq(issues.id, issue.id));
        expect(assignedInsideActivation).toEqual({
          status: "todo",
          assigneeAgentId: builderAgentId,
          assigneeProfileRevision: 2,
        });
        return inspectedExecutionProfile;
      },
      envelope,
      requestedByActorType: "user" as const,
      requestedByActorId: directorUserId,
    };
    const activated = await contracts.activate(activationInput);
    expect(activated).toMatchObject({
      replayed: false,
      needsDispatch: true,
      issue: {
        id: issue.id,
        status: "todo",
        assigneeAgentId: builderAgentId,
      },
    });
    const [sidecar] = await db.select().from(heartbeatRunExecutionProfiles);
    expect(sidecar).toMatchObject({
      runId: activated.reservation.heartbeatRunId,
      companyId,
      issueId: issue.id,
      agentId: builderAgentId,
      bindingVersion: EXECUTION_PROFILE_BINDING_VERSION,
      agentExecutionProfileRevision: 1,
      issueAssigneeProfileRevision: 2,
      digest: inspectedExecutionProfile.digest,
      transitionKind: "fresh",
      transitionReason: "governed_activation",
    });
    expect(sidecar!.authorityFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(sidecar!.authorityFingerprint).not.toBe("pending-database-canonicalization");
    const receipt = serializeGovernedIssueActivationReceipt(activated.reservation);
    expect(receipt).toMatchObject({
      version: 2,
      wake: { durable: true, runId: sidecar!.runId },
      executionProfile: {
        version: 2,
        profileId: sidecar!.id,
        runId: sidecar!.runId,
        companyId,
        issueId: issue.id,
        agentId: builderAgentId,
        agentExecutionProfileRevision: 1,
        issueAssigneeProfileRevision: 2,
        digest: inspectedExecutionProfile.digest,
        authorityFingerprint: sidecar!.authorityFingerprint,
        authorityProofSha256: executionProfileSha256(inspectedExecutionProfile.authorityProof),
        projection: inspectedExecutionProfile.projection,
      },
    });

    const replay = await contracts.activate({
      ...activationInput,
    });
    expect(replay.replayed).toBe(true);
    expect(inspectionCalls).toBe(1);
    expect(serializeGovernedIssueActivationReceipt(replay.reservation)).toEqual(receipt);
    expect(await db.select().from(heartbeatRunExecutionProfiles)).toHaveLength(1);
    expect(await db.select().from(agentWakeupRequests).where(eq(
      agentWakeupRequests.idempotencyKey,
      `governed_issue_activation:v2:${reservation!.id}`,
    ))).toHaveLength(1);
  });

  it("rolls back version 2 activation when a future-stage participant profile revision changed", async () => {
    const companyId = await seedCompany();
    const builderAgentId = await seedAgent(companyId, "Builder");
    const reviewerAgentId = await seedAgent(companyId, "Reviewer");
    const directorUserId = await seedUser(companyId);
    const executionPolicy = twoStagePolicy(reviewerAgentId, directorUserId);
    const envelope = {
      title: "Reject stale reviewer authority",
      workMode: "standard" as const,
      priority: "high" as const,
      reviewPolicy: "not_creator" as const,
      requestDepth: 0,
      executionPolicy,
    };
    const executionProfiles = {
      builderAgentId,
      participants: [builderAgentId, reviewerAgentId]
        .sort((left, right) => left.localeCompare(right))
        .map((agentId) => ({ agentId, executionProfileRevision: 1 })),
    };
    const idempotencyKey = "reeve-build:stale-reviewer-profile";
    const executionProfileIntentSha256 = governedIssueSha256(executionProfiles);
    const issue = await issueService(db).create(companyId, {
      ...envelope,
      status: "backlog",
      createdByUserId: directorUserId,
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
    const contracts = governedIssueContractService(db);
    const reservation = await contracts.getReservation(companyId, idempotencyKey);
    await db.update(agents)
      .set({ adapterConfig: { changedAfterReservation: true } })
      .where(eq(agents.id, reviewerAgentId));
    let inspectionCalls = 0;
    await expect(contracts.activate({
      version: 2,
      companyId,
      idempotencyKey,
      expectedIssueId: issue.id,
      expectedIssueUpdatedAt: reservation!.reservedIssueUpdatedAt.toISOString(),
      expectedEnvelopeSha256: reservation!.envelopeSha256,
      expectedExecutionProfileIntentSha256: executionProfileIntentSha256,
      builderAgentId,
      executionProfiles,
      inspectExecutionProfile: async () => {
        inspectionCalls += 1;
        return inspectedBuilderProfile({
          companyId,
          builderAgentId,
          issueId: issue.id,
          agentExecutionProfileRevision: 1,
          issueAssigneeProfileRevision: 2,
        });
      },
      envelope,
      requestedByActorType: "user",
      requestedByActorId: directorUserId,
    })).rejects.toMatchObject({
      status: 412,
      details: {
        code: "governed_execution_profile_revision_mismatch",
        agentId: reviewerAgentId,
      },
    });
    expect(await issueService(db).getById(issue.id)).toMatchObject({
      status: "backlog",
      assigneeAgentId: null,
      assigneeUserId: null,
    });
    expect(await db.select().from(agentWakeupRequests)).toHaveLength(0);
    expect(await db.select().from(heartbeatRuns)).toHaveLength(0);
    expect(await db.select().from(heartbeatRunExecutionProfiles)).toHaveLength(0);
    expect(inspectionCalls).toBe(0);
    expect(await contracts.getReservation(companyId, idempotencyKey)).toMatchObject({
      activatedAt: null,
      executionProfileReceipt: null,
    });
  });

  it("rolls back assignment when post-assignment execution evidence is invalid", async () => {
    const companyId = await seedCompany();
    const builderAgentId = await seedAgent(companyId, "Builder");
    const directorUserId = await seedUser(companyId);
    const envelope = {
      title: "Reject invalid activation evidence",
      workMode: "standard" as const,
      priority: "high" as const,
      reviewPolicy: "not_creator" as const,
      requestDepth: 0,
      executionPolicy: {
        mode: "normal" as const,
        commentRequired: true,
        stages: [{
          type: "approval" as const,
          approvalsNeeded: 1 as const,
          participants: [{ type: "user" as const, userId: directorUserId }],
        }],
      },
    };
    const executionProfiles = {
      builderAgentId,
      participants: [{ agentId: builderAgentId, executionProfileRevision: 1 }],
    };
    const idempotencyKey = "reeve-build:invalid-activation-evidence";
    const executionProfileIntentSha256 = governedIssueSha256(executionProfiles);
    const issue = await issueService(db).create(companyId, {
      ...envelope,
      status: "backlog",
      createdByUserId: directorUserId,
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
    const contracts = governedIssueContractService(db);
    const reservation = await contracts.getReservation(companyId, idempotencyKey);
    const valid = inspectedBuilderProfile({
      companyId,
      builderAgentId,
      issueId: issue.id,
      agentExecutionProfileRevision: 1,
      issueAssigneeProfileRevision: 2,
    });
    await expect(contracts.activate({
      version: 2,
      companyId,
      idempotencyKey,
      expectedIssueId: issue.id,
      expectedIssueUpdatedAt: reservation!.reservedIssueUpdatedAt.toISOString(),
      expectedEnvelopeSha256: reservation!.envelopeSha256,
      expectedExecutionProfileIntentSha256: executionProfileIntentSha256,
      builderAgentId,
      executionProfiles,
      inspectExecutionProfile: async () => ({
        ...valid,
        projection: { ...valid.projection, issueId: randomUUID() },
      }),
      envelope,
      requestedByActorType: "user",
      requestedByActorId: directorUserId,
    })).rejects.toMatchObject({
      status: 412,
      details: { code: "governed_execution_profile_activation_drift" },
    });
    expect(await issueService(db).getById(issue.id)).toMatchObject({
      status: "backlog",
      assigneeAgentId: null,
      assigneeUserId: null,
    });
    expect(await db.select().from(agentWakeupRequests)).toHaveLength(0);
    expect(await db.select().from(heartbeatRuns)).toHaveLength(0);
    expect(await db.select().from(heartbeatRunExecutionProfiles)).toHaveLength(0);
    expect(await contracts.getReservation(companyId, idempotencyKey)).toMatchObject({
      activatedAt: null,
      executionProfileReceipt: null,
    });
  });

  it("semantically replays an ID-less reservation after generic retention and activates the original materialization", async () => {
    const companyId = await seedCompany();
    const builderAgentId = await seedAgent(companyId, "Builder");
    const reviewerAgentId = await seedAgent(companyId, "Reviewer");
    const directorUserId = await seedUser(companyId);
    const rawEnvelope = {
      title: "ID-less durable reservation",
      workMode: "standard" as const,
      priority: "high" as const,
      reviewPolicy: "not_creator" as const,
      requestDepth: 0,
      executionPolicy: {
        mode: "normal" as const,
        commentRequired: true,
        stages: [
          { type: "review" as const, approvalsNeeded: 1 as const, participants: [{ type: "agent" as const, agentId: reviewerAgentId }] },
          { type: "approval" as const, approvalsNeeded: 1 as const, participants: [{ type: "user" as const, userId: directorUserId }] },
        ],
      },
    };
    const requestIntentSha256 = governedIssueSha256(rawEnvelope);
    const firstEnvelope = {
      ...rawEnvelope,
      executionPolicy: normalizeIssueExecutionPolicy(rawEnvelope.executionPolicy)!,
    };
    const idempotencyKey = "reeve-build:id-less-retention";
    const first = await issueService(db).create(companyId, {
      ...firstEnvelope,
      id: randomUUID(),
      status: "backlog",
      createdByUserId: directorUserId,
      idempotencyKey,
      allowDuplicate: true,
      governanceReservation: {
        requestIntentSha256,
        envelopeSha256: governedIssueEnvelopeSha256(firstEnvelope),
        envelope: firstEnvelope,
      },
    });
    const firstReservation = await governedIssueContractService(db).getReservation(companyId, idempotencyKey);
    const firstStageIds = firstEnvelope.executionPolicy.stages.map((stage) => stage.id);

    // The generic mapping is only a short-retention compatibility index. The
    // governed reservation remains the durable replay authority after it is gone.
    await db.update(issueCreateIdempotencyKeys)
      .set({ createdAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000) })
      .where(eq(issueCreateIdempotencyKeys.companyId, companyId));
    await db.delete(issueCreateIdempotencyKeys).where(eq(issueCreateIdempotencyKeys.companyId, companyId));

    const secondEnvelope = {
      ...rawEnvelope,
      executionPolicy: normalizeIssueExecutionPolicy(rawEnvelope.executionPolicy)!,
    };
    expect(secondEnvelope.executionPolicy.stages.map((stage) => stage.id)).not.toEqual(firstStageIds);
    const replay = await issueService(db).create(companyId, {
      ...secondEnvelope,
      id: randomUUID(),
      status: "backlog",
      createdByUserId: directorUserId,
      idempotencyKey,
      allowDuplicate: true,
      governanceReservation: {
        requestIntentSha256,
        envelopeSha256: governedIssueEnvelopeSha256(secondEnvelope),
        envelope: secondEnvelope,
      },
    });
    const replayReservation = await governedIssueContractService(db).getReservation(companyId, idempotencyKey);
    expect(replay.id).toBe(first.id);
    expect(replay.executionPolicy).toEqual(first.executionPolicy);
    expect(replayReservation).toMatchObject({
      id: firstReservation!.id,
      issueId: first.id,
      requestIntentSha256,
      envelopeSha256: firstReservation!.envelopeSha256,
    });

    const activation = await governedIssueContractService(db).activate({
      companyId,
      idempotencyKey,
      expectedIssueId: first.id,
      expectedIssueUpdatedAt: firstReservation!.reservedIssueUpdatedAt.toISOString(),
      expectedEnvelopeSha256: firstReservation!.envelopeSha256,
      builderAgentId,
      envelope: firstReservation!.envelope as typeof firstEnvelope,
      requestedByActorType: "user",
      requestedByActorId: directorUserId,
    });
    expect(activation.issue).toMatchObject({ id: first.id, status: "todo", assigneeAgentId: builderAgentId });
  });

  it("blocks direct mutation of an unactivated reservation before any wake", async () => {
    const companyId = await seedCompany();
    const builderAgentId = await seedAgent(companyId, "Builder");
    const reviewerAgentId = await seedAgent(companyId, "Reviewer");
    const directorUserId = await seedUser(companyId);
    const executionPolicy = twoStagePolicy(reviewerAgentId, directorUserId);
    const envelope = {
      title: "Reserved exact content",
      workMode: "standard" as const,
      priority: "medium" as const,
      reviewPolicy: "not_creator" as const,
      requestDepth: 0,
      executionPolicy,
    };
    const idempotencyKey = "reeve-build:concurrent-mutation";
    const issue = await issueService(db).create(companyId, {
      ...envelope,
      status: "backlog",
      createdByUserId: directorUserId,
      idempotencyKey,
      allowDuplicate: true,
      governanceReservation: {
        envelope,
        requestIntentSha256: governedIssueSha256(envelope),
        envelopeSha256: governedIssueEnvelopeSha256(envelope),
      },
    });
    const contracts = governedIssueContractService(db);
    const reservation = await contracts.getReservation(companyId, idempotencyKey);
    const svc = issueService(db);
    await expect(svc.update(issue.id, {
      status: "todo",
      assigneeAgentId: builderAgentId,
      title: "Generic activation bypass",
    })).rejects.toMatchObject({
      status: 409,
      details: { code: "governed_issue_reservation_activation_required" },
    });
    await expect(svc.checkout(issue.id, builderAgentId, ["backlog"], null)).rejects.toMatchObject({
      status: 409,
      details: { code: "governed_issue_reservation_activation_required" },
    });
    await expect(svc.release(issue.id, builderAgentId, null)).rejects.toMatchObject({
      status: 409,
      details: { code: "governed_issue_reservation_activation_required" },
    });
    await expect(db.update(issues).set({
      title: "Mutated after reservation",
      updatedAt: new Date(reservation!.reservedIssueUpdatedAt.getTime() + 1_000),
    }).where(eq(issues.id, issue.id))).rejects.toBeDefined();
    expect(await db.select({ title: issues.title }).from(issues).where(eq(issues.id, issue.id)))
      .toEqual([{ title: envelope.title }]);
    expect(await db.select().from(agentWakeupRequests).where(eq(
      agentWakeupRequests.companyId,
      companyId,
    ))).toHaveLength(0);
  });

  it("blocks child-helper and direct blocker insertion until activation, then wakes exactly once", async () => {
    const companyId = await seedCompany();
    const builderAgentId = await seedAgent(companyId, "Builder");
    const reviewerAgentId = await seedAgent(companyId, "Reviewer");
    const directorUserId = await seedUser(companyId);
    const executionPolicy = twoStagePolicy(reviewerAgentId, directorUserId);
    const envelope = {
      title: "Reserved parent blocker set",
      workMode: "standard" as const,
      priority: "medium" as const,
      reviewPolicy: "not_creator" as const,
      requestDepth: 0,
      executionPolicy,
    };
    const idempotencyKey = "reeve-build:blocked-child-helper";
    const svc = issueService(db);
    const parent = await svc.create(companyId, {
      ...envelope,
      status: "backlog",
      createdByUserId: directorUserId,
      idempotencyKey,
      allowDuplicate: true,
      governanceReservation: {
        envelope,
        requestIntentSha256: governedIssueSha256(envelope),
        envelopeSha256: governedIssueEnvelopeSha256(envelope),
      },
    });
    const blocker = await svc.create(companyId, {
      title: "Direct blocker",
      status: "todo",
      priority: "medium",
    });

    await expect(svc.createChild(parent.id, {
      title: "Forbidden child blocker",
      status: "todo",
      priority: "medium",
      blockParentUntilDone: true,
    })).rejects.toMatchObject({
      status: 409,
      details: { code: "governed_issue_reservation_activation_required", issueId: parent.id },
    });
    expect(await db.select().from(issues).where(eq(issues.parentId, parent.id))).toHaveLength(0);

    await expect(db.insert(issueRelations).values({
      companyId,
      issueId: blocker.id,
      relatedIssueId: parent.id,
      type: "blocks",
    })).rejects.toBeDefined();
    expect(await db.select().from(issueRelations).where(eq(issueRelations.relatedIssueId, parent.id)))
      .toHaveLength(0);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId)))
      .toHaveLength(0);

    const contracts = governedIssueContractService(db);
    const reservation = await contracts.getReservation(companyId, idempotencyKey);
    const activated = await contracts.activate({
      companyId,
      idempotencyKey,
      expectedIssueId: parent.id,
      expectedIssueUpdatedAt: reservation!.reservedIssueUpdatedAt.toISOString(),
      expectedEnvelopeSha256: reservation!.envelopeSha256,
      builderAgentId,
      envelope,
      requestedByActorType: "user",
      requestedByActorId: directorUserId,
    });
    expect(activated.issue).toMatchObject({ status: "todo", assigneeAgentId: builderAgentId });
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId)))
      .toHaveLength(1);
  });

  it("blocks direct deletion or retargeting of an existing relation after reservation", async () => {
    const companyId = await seedCompany();
    const reviewerAgentId = await seedAgent(companyId, "Reviewer");
    const directorUserId = await seedUser(companyId);
    const executionPolicy = twoStagePolicy(reviewerAgentId, directorUserId);
    const envelope = {
      title: "Reserve an existing blocker set",
      workMode: "standard" as const,
      priority: "medium" as const,
      reviewPolicy: "not_creator" as const,
      requestDepth: 0,
      executionPolicy,
    };
    const svc = issueService(db);
    const parent = await svc.create(companyId, {
      ...envelope,
      status: "backlog",
      createdByUserId: directorUserId,
    });
    const blocker = await svc.create(companyId, { title: "Existing blocker", status: "todo", priority: "medium" });
    const other = await svc.create(companyId, { title: "Other target", status: "todo", priority: "medium" });
    const [relation] = await db.insert(issueRelations).values({
      companyId,
      issueId: blocker.id,
      relatedIssueId: parent.id,
      type: "blocks",
    }).returning();
    await db.insert(governedIssueReservations).values({
      companyId,
      idempotencyKey: "reeve-build:existing-relation",
      issueId: parent.id,
      requestIntentSha256: governedIssueSha256(envelope),
      envelopeSha256: governedIssueEnvelopeSha256(envelope),
      envelope,
      reservedIssueSnapshot: governedIssueReservedSnapshot(parent as typeof issues.$inferSelect),
      reservedIssueUpdatedAt: parent.updatedAt,
    });

    await expect(db.delete(issueRelations).where(eq(issueRelations.id, relation!.id))).rejects.toBeDefined();
    await expect(db.update(issueRelations)
      .set({ relatedIssueId: other.id })
      .where(eq(issueRelations.id, relation!.id))).rejects.toBeDefined();
    expect(await db.select().from(issueRelations).where(eq(issueRelations.id, relation!.id)))
      .toEqual([expect.objectContaining({ issueId: blocker.id, relatedIssueId: parent.id })]);
  });

  it("hard-deletes a company containing both reserved and activated governed issues", async () => {
    const companyId = await seedCompany("Governed deletion");
    const builderAgentId = await seedAgent(companyId, "Builder");
    const reviewerAgentId = await seedAgent(companyId, "Reviewer");
    const directorUserId = await seedUser(companyId);
    const policy = twoStagePolicy(reviewerAgentId, directorUserId);
    const createReservation = async (key: string, title: string) => {
      const envelope = {
        title,
        workMode: "standard" as const,
        priority: "medium" as const,
        reviewPolicy: "not_creator" as const,
        requestDepth: 0,
        executionPolicy: policy,
      };
      const issue = await issueService(db).create(companyId, {
        ...envelope,
        status: "backlog",
        createdByUserId: directorUserId,
        idempotencyKey: key,
        allowDuplicate: true,
        governanceReservation: {
          requestIntentSha256: governedIssueSha256(envelope),
          envelopeSha256: governedIssueEnvelopeSha256(envelope),
          envelope,
        },
      });
      const reservation = await governedIssueContractService(db).getReservation(companyId, key);
      return { issue, reservation: reservation!, envelope };
    };
    await createReservation("reeve-build:delete-reserved", "Still reserved");
    const activated = await createReservation("reeve-build:delete-activated", "Already activated");
    await governedIssueContractService(db).activate({
      companyId,
      idempotencyKey: activated.reservation.idempotencyKey,
      expectedIssueId: activated.issue.id,
      expectedIssueUpdatedAt: activated.reservation.reservedIssueUpdatedAt.toISOString(),
      expectedEnvelopeSha256: activated.reservation.envelopeSha256,
      builderAgentId,
      envelope: activated.envelope,
      requestedByActorType: "user",
      requestedByActorId: directorUserId,
    });

    await expect(companyService(db).remove(companyId)).resolves.toMatchObject({ id: companyId });
    expect(await db.select().from(governedIssueReservations).where(eq(
      governedIssueReservations.companyId,
      companyId,
    ))).toHaveLength(0);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId))).toHaveLength(0);
    expect(await db.select().from(agentWakeupRequests).where(eq(
      agentWakeupRequests.companyId,
      companyId,
    ))).toHaveLength(0);
    expect(await db.select().from(issues).where(eq(issues.companyId, companyId))).toHaveLength(0);
  });

  it("rejects reassignment and policy mutation that would make not_creator review self-authored", async () => {
    const companyId = await seedCompany();
    const builderAgentId = await seedAgent(companyId, "Builder");
    const reviewerAgentId = await seedAgent(companyId, "Reviewer");
    const directorUserId = await seedUser(companyId);
    const svc = issueService(db);
    const issue = await svc.create(companyId, {
      title: "Keep review independent",
      status: "todo",
      priority: "medium",
      reviewPolicy: "not_creator",
      assigneeAgentId: builderAgentId,
      createdByAgentId: builderAgentId,
      executionPolicy: twoStagePolicy(reviewerAgentId, directorUserId),
    });

    await expect(svc.update(issue.id, {
      assigneeAgentId: reviewerAgentId,
    })).rejects.toMatchObject({
      status: 422,
      details: { code: "execution_policy_review_participant_not_independent" },
    });
    await expect(svc.update(issue.id, {
      executionPolicy: twoStagePolicy(builderAgentId, directorUserId),
    })).rejects.toMatchObject({
      status: 422,
      details: { code: "execution_policy_review_participant_not_independent" },
    });

    await expect(svc.update(issue.id, {
      executionPolicy: null,
      assigneeAgentId: reviewerAgentId,
    })).resolves.toMatchObject({ assigneeAgentId: reviewerAgentId, executionPolicy: null });
  });

  it("requires legacy invalid governed state to be repaired before mutation", async () => {
    const companyId = await seedCompany();
    const builderAgentId = await seedAgent(companyId, "Builder");
    const reviewerAgentId = await seedAgent(companyId, "Reviewer");
    const directorUserId = await seedUser(companyId);
    const [issue] = await db.insert(issues).values({
      companyId,
      title: "Legacy governed issue",
      status: "todo",
      priority: "medium",
      assigneeAgentId: builderAgentId,
      executionPolicy: twoStagePolicy(reviewerAgentId, directorUserId),
      executionState: { status: "legacy-invalid-state" },
    }).returning();
    const svc = issueService(db);

    await expect(svc.getById(issue.id)).resolves.toMatchObject({ id: issue.id });
    await expect(svc.update(issue.id, { title: "Unsafe mutation" })).rejects.toMatchObject({
      status: 422,
      details: { code: "execution_policy_state_repair_required" },
    });
    await expect(svc.update(issue.id, {
      executionPolicy: null,
      executionState: null,
      title: "Repaired mutation",
    })).resolves.toMatchObject({
      title: "Repaired mutation",
      executionPolicy: null,
      executionState: null,
    });
  });

  it("blocks deletion for nonterminal policy/state references and durable decisions", async () => {
    const companyId = await seedCompany();
    const builderAgentId = await seedAgent(companyId, "Builder");
    const reviewerAgentId = await seedAgent(companyId, "Reviewer");
    const directorUserId = await seedUser(companyId);
    const policy = twoStagePolicy(reviewerAgentId, directorUserId);
    const [issue] = await db.insert(issues).values({
      companyId,
      title: "Protected reviewer",
      status: "todo",
      priority: "medium",
      assigneeAgentId: builderAgentId,
      executionPolicy: policy,
    }).returning();

    await expect(agentService(db).remove(builderAgentId)).rejects.toMatchObject({
      status: 409,
      details: {
        code: "agent_execution_audit_dependency",
        issueReferences: [expect.objectContaining({ issueId: issue.id })],
      },
    });

    await expect(agentService(db).remove(reviewerAgentId)).rejects.toMatchObject({
      status: 409,
      details: {
        code: "agent_execution_audit_dependency",
        issueReferences: [expect.objectContaining({ issueId: issue.id })],
      },
    });

    await db.update(issues).set({ status: "done" }).where(eq(issues.id, issue.id));
    await db.insert(issueExecutionDecisions).values({
      companyId,
      issueId: issue.id,
      stageId: policy.stages[0]!.id,
      stageType: "review",
      actorAgentId: reviewerAgentId,
      actorUserId: null,
      outcome: "changes_requested",
      body: "Needs repair",
    });
    await expect(agentService(db).remove(reviewerAgentId)).rejects.toMatchObject({
      status: 409,
      details: {
        code: "agent_execution_audit_dependency",
        decisionReferences: [expect.objectContaining({ issueId: issue.id })],
      },
    });
  });

  it("blocks terminal-issue builder deletion when durable artifact evidence uses its run provenance", async () => {
    const companyId = await seedCompany();
    const builderAgentId = await seedAgent(companyId, "Builder");
    const reviewerAgentId = await seedAgent(companyId, "Reviewer");
    const directorUserId = await seedUser(companyId);
    const policy = twoStagePolicy(reviewerAgentId, directorUserId);
    const [issue] = await db.insert(issues).values({
      companyId,
      title: "Terminal artifact evidence",
      status: "done",
      priority: "medium",
      executionPolicy: policy,
    }).returning();
    const [builderRun] = await db.insert(heartbeatRuns).values({
      companyId,
      agentId: builderAgentId,
      status: "succeeded",
    }).returning();
    const [reviewerRun] = await db.insert(heartbeatRuns).values({
      companyId,
      agentId: reviewerAgentId,
      status: "succeeded",
    }).returning();
    const [workProduct] = await db.insert(issueWorkProducts).values({
      companyId,
      issueId: issue.id,
      type: "pull_request",
      provider: "github",
      title: "PR #42",
      url: "https://github.com/acme/reeve/pull/42",
      status: "ready_for_review",
      isPrimary: true,
      createdByRunId: builderRun.id,
      lastModifiedByRunId: builderRun.id,
    }).returning();
    const revision = "a".repeat(40);
    const fingerprint = "b".repeat(64);
    const reviewCycleId = randomUUID();
    const evidenceLocked = deferred();
    const releaseEvidence = deferred();
    const evidenceWrite = db.transaction(async (tx) => {
      expect(await lockIssueExecutionReviewEvidenceBuilderAgent(
        tx as unknown as ReturnType<typeof createDb>,
        companyId,
        builderAgentId,
      )).toMatchObject({ id: builderAgentId });
      evidenceLocked.resolve();
      await releaseEvidence.promise;
      await tx.insert(issueExecutionDecisions).values({
        companyId,
        issueId: issue.id,
        stageId: policy.stages[0]!.id,
        stageType: "review",
        actorAgentId: reviewerAgentId,
        actorUserId: null,
        outcome: "approved",
        body: "Exact artifact approved.",
        reviewCycleId,
        requestIdempotencyKey: randomUUID(),
        artifactWorkProductId: workProduct.id,
        artifactRevision: revision,
        artifactLocatorFingerprint: fingerprint,
        reviewerAgentIdSnapshot: reviewerAgentId,
        reviewerRunIdSnapshot: reviewerRun.id,
        reviewerActorSourceSnapshot: "agent_key",
        directorUserIdSnapshot: directorUserId,
        artifactSnapshot: {
          headSha: revision,
          locatorFingerprint: fingerprint,
          reviewer: { agentId: reviewerAgentId, runId: reviewerRun.id, actorSource: "agent_key" },
          director: { userId: directorUserId },
        } as any,
        createdByRunId: reviewerRun.id,
      });
    });
    await evidenceLocked.promise;
    const deletion = agentService(db).remove(builderAgentId);
    releaseEvidence.resolve();
    await evidenceWrite;

    await expect(deletion).rejects.toMatchObject({
      status: 409,
      details: {
        code: "agent_execution_audit_dependency",
        decisionReferences: [expect.objectContaining({
          issueId: issue.id,
          artifactWorkProductId: workProduct.id,
          dependencyRole: "artifact_builder_provenance",
        })],
      },
    });
    await expect(db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(eq(heartbeatRuns.id, builderRun.id)))
      .resolves.toHaveLength(1);
  });

  it("fails the evidence builder lock when deletion wins the agent-row lock order", async () => {
    const companyId = await seedCompany();
    const builderAgentId = await seedAgent(companyId, "Deleted first builder");
    const deletionLocked = deferred();
    const releaseDeletion = deferred();
    const deletion = db.transaction(async (tx) => {
      await tx.select({ id: agents.id }).from(agents).where(eq(agents.id, builderAgentId)).for("update");
      deletionLocked.resolve();
      await releaseDeletion.promise;
      await tx.delete(agents).where(eq(agents.id, builderAgentId));
    });
    await deletionLocked.promise;
    const evidenceLock = db.transaction((tx) => lockIssueExecutionReviewEvidenceBuilderAgent(
      tx as unknown as ReturnType<typeof createDb>,
      companyId,
      builderAgentId,
    ));
    releaseDeletion.resolve();
    await deletion;
    await expect(evidenceLock).resolves.toBeNull();
  });

  it("serializes policy validation with deletion in both lock orders", async () => {
    const companyId = await seedCompany();
    const builderAgentId = await seedAgent(companyId, "Builder");
    const reviewerAgentId = await seedAgent(companyId, "Reviewer");
    const directorUserId = await seedUser(companyId);
    const policy = twoStagePolicy(reviewerAgentId, directorUserId);
    const validated = deferred();
    const releaseValidation = deferred();

    const policyWrite = db.transaction(async (tx) => {
      await assertIssueExecutionPolicyParticipants(tx as unknown as ReturnType<typeof createDb>, {
        companyId,
        reviewPolicy: "not_creator",
        executionPolicy: policy,
        assigneeAgentId: builderAgentId,
        createdByAgentId: builderAgentId,
      });
      validated.resolve();
      await releaseValidation.promise;
      await tx.insert(issues).values({
        companyId,
        title: "Committed after validation",
        status: "todo",
        priority: "medium",
        assigneeAgentId: builderAgentId,
        executionPolicy: policy,
      });
    });
    await validated.promise;
    const deleteAfterValidation = agentService(db).remove(reviewerAgentId);
    releaseValidation.resolve();
    await policyWrite;
    await expect(deleteAfterValidation).rejects.toMatchObject({
      status: 409,
      details: { code: "agent_execution_audit_dependency" },
    });

    await db.delete(issues);
    const deleteLocked = deferred();
    const releaseDelete = deferred();
    const deletingFirst = db.transaction(async (tx) => {
      await tx.select({ id: agents.id }).from(agents).where(eq(agents.id, reviewerAgentId)).for("update");
      deleteLocked.resolve();
      await releaseDelete.promise;
      await tx.delete(agents).where(eq(agents.id, reviewerAgentId));
    });
    await deleteLocked.promise;
    const validationAfterDelete = db.transaction((tx) =>
      assertIssueExecutionPolicyParticipants(tx as unknown as ReturnType<typeof createDb>, {
        companyId,
        executionPolicy: policy,
        assigneeAgentId: builderAgentId,
      }));
    releaseDelete.resolve();
    await deletingFirst;
    await expect(validationAfterDelete).rejects.toMatchObject({
      status: 422,
      details: { code: "execution_policy_participant_agent_not_found" },
    });
  });
});
