import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  activityLog,
  agents,
  companies,
  createDb,
  governedIssueReservations,
  heartbeatRuns,
  issues,
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
import {
  governedIssueContractService,
  governedIssueEnvelopeSha256,
  governedIssueReservationResponseIssue,
  governedIssueReservationState,
  governedIssueSha256,
  serializeGovernedIssueActivationReceipt,
  serializeGovernedIssueRetirementReceipt,
} from "./governed-issue-contract.js";
import { lockGovernedV2ExecutionReservationForQueuedRun } from "./heartbeat.js";
import { normalizeIssueExecutionPolicy } from "./issue-execution-policy.js";
import { issueService } from "./issues.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

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

describeEmbeddedPostgres("governed issue reservation retirement", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-governed-retirement-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.execute(sql.raw('TRUNCATE TABLE "companies" RESTART IDENTITY CASCADE'));
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedReservation() {
    const companyId = randomUUID();
    const builderAgentId = randomUUID();
    const reviewerAgentId = randomUUID();
    const idempotencyKey = `reeve-build:${randomUUID()}`;
    const issuePrefix = `R${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Retirement test",
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
    const executionPolicy = normalizeIssueExecutionPolicy({
      stages: [{
        id: randomUUID(),
        type: "review" as const,
        participants: [{ id: randomUUID(), type: "agent" as const, agentId: reviewerAgentId }],
      }],
    })!;
    const envelope = governedIssueEnvelopeSchema.parse({
      title: "Retire governed work",
      workMode: "standard",
      priority: "medium",
      reviewPolicy: "not_creator",
      requestDepth: 0,
      executionPolicy,
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
    return {
      companyId,
      builderAgentId,
      reviewerAgentId,
      idempotencyKey,
      issue,
      reservation: reservation!,
      envelope,
      executionProfiles,
      executionProfileIntentSha256,
    };
  }

  async function activate(fixture: Awaited<ReturnType<typeof seedReservation>>) {
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
      envelope: fixture.envelope,
      requestedByActorType: "user",
      requestedByActorId: "director",
    });
  }

  it("retires an unchanged reserved issue and recovers the same receipt after response loss and restart", async () => {
    const fixture = await seedReservation();
    const request = {
      version: 1 as const,
      expectedIssueId: fixture.issue.id,
      expectedEnvelopeSha256: fixture.reservation.envelopeSha256,
      expectedState: "reserved" as const,
      expectedHeartbeatRunId: null,
      reason: "pre-launch coordinator abort",
    };
    const first = await governedIssueContractService(db).retire({
      companyId: fixture.companyId,
      idempotencyKey: fixture.idempotencyKey,
      request,
      requestedByActorId: "director",
    });
    const restartedService = governedIssueContractService(db);
    const replay = await restartedService.retire({
      companyId: fixture.companyId,
      idempotencyKey: fixture.idempotencyKey,
      request,
      requestedByActorId: "director",
    });

    expect(first.replayed).toBe(false);
    expect(first.activityPublication).not.toBeNull();
    expect(replay.replayed).toBe(true);
    expect(replay.activityPublication).toBeNull();
    expect(replay.receipt).toEqual(first.receipt);
    expect(governedIssueReservationState(replay.reservation)).toBe("retired");
    expect(serializeGovernedIssueRetirementReceipt(replay.reservation)).toEqual(first.receipt);
    expect(governedIssueReservationResponseIssue(replay.reservation)).toMatchObject({
      id: fixture.issue.id,
      status: "cancelled",
      assigneeAgentId: null,
    });
    expect(await db.select({ id: governedIssueReservations.id }).from(governedIssueReservations))
      .toHaveLength(1);
    expect(await db.select({
      action: activityLog.action,
      actorId: activityLog.actorId,
      entityId: activityLog.entityId,
    }).from(activityLog)).toEqual([{
      action: "issue.governed_reservation_retired",
      actorId: "director",
      entityId: fixture.issue.id,
    }]);

    const receipt = first.receipt;
    const expectInvalidReceipt = (
      reservation: typeof governedIssueReservations.$inferSelect,
    ) => expect(() => serializeGovernedIssueRetirementReceipt(reservation)).toThrowError(
      expect.objectContaining({
        status: 409,
        details: { code: "governed_issue_retirement_receipt_invalid" },
      }),
    );
    expectInvalidReceipt({
      ...replay.reservation,
      retirementSha256: "0".repeat(64),
      retirementReceipt: {
        ...receipt,
        retirementSha256: "0".repeat(64),
      },
    });
    expectInvalidReceipt({
      ...replay.reservation,
      heartbeatRunId: randomUUID(),
    });
    const activatedPriorStateSha256 = governedIssueSha256({
      version: 1,
      idempotencyKey: fixture.idempotencyKey,
      issueId: fixture.issue.id,
      envelopeSha256: fixture.reservation.envelopeSha256,
      priorState: "activated",
      heartbeatRunId: null,
      reason: receipt.reason,
    });
    expectInvalidReceipt({
      ...replay.reservation,
      retirementSha256: activatedPriorStateSha256,
      retirementReceipt: {
        ...receipt,
        priorState: "activated",
        retirementSha256: activatedPriorStateSha256,
      },
    });
    expectInvalidReceipt({
      ...replay.reservation,
      retirementReceipt: {
        ...receipt,
        issueUpdatedAt: new Date(0).toISOString(),
      },
    });
    expectInvalidReceipt({
      ...replay.reservation,
      retirementReceipt: {
        ...receipt,
        issueSnapshot: {
          ...receipt.issueSnapshot,
          id: randomUUID(),
        },
      },
    });

    await expect(restartedService.retire({
      companyId: fixture.companyId,
      idempotencyKey: fixture.idempotencyKey,
      request: { ...request, reason: "different abort intent" },
      requestedByActorId: "director",
    })).rejects.toMatchObject({
      status: 409,
      details: { code: "governed_issue_retirement_conflict" },
    });
    await expect(restartedService.activate({
      version: 2,
      companyId: fixture.companyId,
      idempotencyKey: fixture.idempotencyKey,
      expectedIssueId: fixture.issue.id,
      expectedIssueUpdatedAt: fixture.reservation.reservedIssueUpdatedAt.toISOString(),
      expectedEnvelopeSha256: fixture.reservation.envelopeSha256,
      expectedExecutionProfileIntentSha256: fixture.executionProfileIntentSha256,
      builderAgentId: fixture.builderAgentId,
      executionProfiles: fixture.executionProfiles,
      inspectExecutionProfile: async () => {
        throw new Error("retired activation must reject before inspection");
      },
      envelope: fixture.envelope,
      requestedByActorType: "user",
      requestedByActorId: "director",
    })).rejects.toMatchObject({
      status: 409,
      details: { code: "governed_issue_reservation_retired" },
    });
  });

  it("refuses active builder and reviewer runs, then retires after exact terminal observations", async () => {
    const fixture = await seedReservation();
    const activated = await activate(fixture);
    const request = {
      version: 1 as const,
      expectedIssueId: fixture.issue.id,
      expectedEnvelopeSha256: fixture.reservation.envelopeSha256,
      expectedState: "activated" as const,
      expectedHeartbeatRunId: activated.reservation.heartbeatRunId,
      reason: "delivery settled",
    };

    await expect(governedIssueContractService(db).retire({
      companyId: fixture.companyId,
      idempotencyKey: fixture.idempotencyKey,
      request,
      requestedByActorId: "director",
    })).rejects.toMatchObject({
      status: 409,
      details: { code: "governed_issue_retirement_run_active" },
    });

    await db.update(heartbeatRuns)
      .set({ status: "succeeded", finishedAt: new Date(), updatedAt: new Date() })
      .where(eq(heartbeatRuns.id, activated.reservation.heartbeatRunId!));
    const reviewerRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: reviewerRunId,
      companyId: fixture.companyId,
      agentId: fixture.reviewerAgentId,
      invocationSource: "assignment",
      status: "running",
      contextSnapshot: { issueId: fixture.issue.id, taskId: fixture.issue.id },
    });
    await expect(governedIssueContractService(db).retire({
      companyId: fixture.companyId,
      idempotencyKey: fixture.idempotencyKey,
      request,
      requestedByActorId: "director",
    })).rejects.toMatchObject({
      status: 409,
      details: { code: "governed_issue_retirement_run_active", runIds: [reviewerRunId] },
    });

    await db.update(heartbeatRuns)
      .set({ status: "failed", finishedAt: new Date(), updatedAt: new Date() })
      .where(eq(heartbeatRuns.id, reviewerRunId));
    const retired = await governedIssueContractService(db).retire({
      companyId: fixture.companyId,
      idempotencyKey: fixture.idempotencyKey,
      request,
      requestedByActorId: "director",
    });
    expect(retired.receipt).toMatchObject({
      priorState: "activated",
      heartbeatRunId: activated.reservation.heartbeatRunId,
      issueSnapshot: { id: fixture.issue.id, status: "cancelled" },
    });
    expect(serializeGovernedIssueActivationReceipt(retired.reservation)).toMatchObject({
      issueUpdatedAt: activated.issue.updatedAt,
      issueSnapshot: {
        id: fixture.issue.id,
        status: activated.issue.status,
        updatedAt: activated.issue.updatedAt,
      },
    });
    expect(serializeGovernedIssueRetirementReceipt(retired.reservation)).toMatchObject({
      issueUpdatedAt: retired.receipt.issueUpdatedAt,
      issueSnapshot: {
        id: fixture.issue.id,
        status: "cancelled",
        updatedAt: retired.receipt.issueUpdatedAt,
      },
    });
    expect(await db.select({ status: issues.status }).from(issues).where(eq(issues.id, fixture.issue.id)))
      .toEqual([{ status: "cancelled" }]);
  });

  it("rolls back a scheduled retry that loses the reservation-lock race to retirement", async () => {
    const fixture = await seedReservation();
    const activated = await activate(fixture);
    await db.update(heartbeatRuns)
      .set({ status: "succeeded", finishedAt: new Date(), updatedAt: new Date() })
      .where(eq(heartbeatRuns.id, activated.reservation.heartbeatRunId!));

    let signalRetirementLocked!: () => void;
    const retirementLocked = new Promise<void>((resolve) => {
      signalRetirementLocked = resolve;
    });
    let signalRetryInserted!: () => void;
    const retryInserted = new Promise<void>((resolve) => {
      signalRetryInserted = resolve;
    });
    const retryRunId = randomUUID();

    const retirement = db.transaction(async (tx) => {
      await tx.execute(sql`
        SELECT id FROM governed_issue_reservations
        WHERE id = ${fixture.reservation.id}
        FOR UPDATE
      `);
      signalRetirementLocked();
      await retryInserted;
      await tx.update(governedIssueReservations)
        .set({
          retirementSha256: "f".repeat(64),
          retirementReceipt: {},
          retiredAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(governedIssueReservations.id, fixture.reservation.id));
    });

    await retirementLocked;
    const retry = db.transaction(async (tx) => {
      await tx.insert(heartbeatRuns).values({
        id: retryRunId,
        companyId: fixture.companyId,
        agentId: fixture.builderAgentId,
        invocationSource: "automation",
        triggerDetail: "system",
        status: "scheduled_retry",
        contextSnapshot: { issueId: fixture.issue.id },
        retryOfRunId: activated.reservation.heartbeatRunId,
        scheduledRetryAt: new Date(Date.now() + 60_000),
        scheduledRetryAttempt: 1,
        scheduledRetryReason: "bounded_transient_failure",
      });
      signalRetryInserted();
      await lockGovernedV2ExecutionReservationForQueuedRun(tx as unknown as typeof db, {
        companyId: fixture.companyId,
        issueId: fixture.issue.id,
      });
    });

    await expect(retirement).resolves.toBeUndefined();
    await expect(retry).rejects.toMatchObject({
      status: 409,
      details: { code: "governed_issue_reservation_retired" },
    });
    expect(await db.select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, retryRunId))).toEqual([]);
  });
});
