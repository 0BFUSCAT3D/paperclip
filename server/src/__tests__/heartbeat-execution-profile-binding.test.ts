import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  agentRuntimeState,
  agents,
  companies,
  createDb,
  governedIssueReservations,
  heartbeatRunExecutionProfiles,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  SUBSCRIPTION_AUTH_AUTHORITY_SCHEMA,
  SUBSCRIPTION_AUTH_AUTHORITY_VERSION,
  SUBSCRIPTION_ONLY_BILLING_CAPABILITY,
  type SubscriptionAuthAuthorityProofV1,
} from "@paperclipai/adapter-utils";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const preparedDisposals = vi.hoisted(() => [] as Array<ReturnType<typeof vi.fn>>);
const inspectAuthority = vi.hoisted(() => vi.fn(async (input: {
  companyId: string;
  agentId: string;
  adapterType: string;
  mode: "inspect" | "prepare";
}) => {
  const opaque = (character: string) => `decision-spec-v1.${character.repeat(64)}`;
  const evidence = {
    evidence: "account_id_bound" as const,
    identityFingerprint: opaque("a"),
    revisionFingerprint: opaque("b"),
  };
  const proof: SubscriptionAuthAuthorityProofV1 = {
    schema: SUBSCRIPTION_AUTH_AUTHORITY_SCHEMA,
    version: SUBSCRIPTION_AUTH_AUTHORITY_VERSION,
    adapterType: "codex_local",
    companyId: input.companyId,
    agentId: input.agentId,
    authKind: "codex_chatgpt_managed_profile",
    sourceKind: "managed_local_profile",
    authProfile: evidence,
    account: { ...evidence, identityFingerprint: opaque("c"), revisionFingerprint: opaque("d") },
    principal: { ...evidence, identityFingerprint: opaque("e"), revisionFingerprint: opaque("f") },
    credentialRevisionFingerprint: opaque("0"),
  };
  const dispose = vi.fn(async () => undefined);
  if (input.mode === "prepare") preparedDisposals.push(dispose);
  return {
    proof,
    ...(input.mode === "prepare"
      ? {
          prepared: {
            apply: async () => ({
              schema: "paperclip.subscription-auth-host-owned-final-env" as const,
              version: 1 as const,
              adapterType: "codex_local" as const,
            }),
            dispose,
          },
        }
      : {}),
  };
}));

vi.doMock("../adapters/index.js", () => ({
  getServerAdapter: vi.fn(() => ({
    type: "codex_local",
    execute: vi.fn(),
    testEnvironment: vi.fn(),
    subscriptionOnlyBilling: SUBSCRIPTION_ONLY_BILLING_CAPABILITY,
    inspectSubscriptionAuthAuthority: inspectAuthority,
  })),
  findActiveServerAdapter: vi.fn(() => ({
    type: "codex_local",
    execute: vi.fn(),
    testEnvironment: vi.fn(),
    subscriptionOnlyBilling: SUBSCRIPTION_ONLY_BILLING_CAPABILITY,
    inspectSubscriptionAuthAuthority: inspectAuthority,
  })),
  listAdapterModelProfiles: vi.fn(() => []),
  runningProcesses: new Map(),
}));

const { heartbeatService } = await import("../services/heartbeat.ts");
const { executionProfileSha256 } = await import("../services/execution-profile-binding.ts");

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("heartbeat execution profile binding", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-profile-binding-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    inspectAuthority.mockClear();
    preparedDisposals.splice(0);
    await db.delete(heartbeatRuns);
    await db.delete(governedIssueReservations);
    await db.delete(issues);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedFixture(contextSnapshot: Record<string, unknown> = {}) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Execution profile binding",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const [agent] = await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Codex builder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {
        billingPolicy: "subscription_only",
        engine: "cli",
      },
      runtimeConfig: {},
      permissions: {},
    }).returning();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Bound run",
      status: "todo",
      priority: "high",
      assigneeAgentId: agentId,
    });
    const [run] = await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "queued",
      contextSnapshot: { issueId, ...contextSnapshot },
    }).returning();
    return {
      companyId,
      agent: agent!,
      issueId,
      run: run!,
      environment: { id: randomUUID(), driver: "local" },
      resolvedConfig: {
        billingPolicy: "subscription_only",
        engine: "cli",
        model: "gpt-5.3-codex",
        env: {},
      },
    };
  }

  it("accepts one exact stored binding and fails closed on config drift", async () => {
    const fixture = await seedFixture();
    const heartbeat = heartbeatService(db);
    expect(await heartbeat.requiresSubscriptionExecutionProfilePreparation({
      run: fixture.run,
      resolvedConfig: { engine: "cli", env: {} },
    })).toBe(false);
    const prepared = await heartbeat.prepareSubscriptionExecutionProfileForRun({
      run: fixture.run,
      agent: fixture.agent,
      issueId: fixture.issueId,
      resolvedConfig: fixture.resolvedConfig,
      secretManifest: [],
      environment: fixture.environment,
    });
    expect(prepared).not.toBeNull();
    const [stored] = await db.select().from(heartbeatRunExecutionProfiles);
    expect(stored).toMatchObject({
      runId: fixture.run.id,
      agentId: fixture.agent.id,
      issueId: fixture.issueId,
      agentExecutionProfileRevision: 1,
      issueAssigneeProfileRevision: 1,
      transitionKind: "fresh",
      transitionReason: "normal_enqueue",
    });
    expect(stored!.validatedAt).toBeInstanceOf(Date);
    expect(await heartbeat.requiresSubscriptionExecutionProfilePreparation({
      run: fixture.run,
      resolvedConfig: { engine: "cli", env: {} },
    })).toBe(true);
    await expect(heartbeat.prepareSubscriptionExecutionProfileForRun({
      run: fixture.run,
      agent: fixture.agent,
      issueId: fixture.issueId,
      resolvedConfig: { engine: "cli", env: {} },
      secretManifest: [],
      environment: fixture.environment,
    })).rejects.toMatchObject({
      status: 409,
      details: { code: "execution_profile_unsupported" },
    });

    const v2Run = await db.update(heartbeatRuns)
      .set({ contextSnapshot: { issueId: fixture.issueId, governedContractVersion: 2 } })
      .where(eq(heartbeatRuns.id, fixture.run.id))
      .returning()
      .then((rows) => rows[0]!);
    await expect(heartbeat.prepareSubscriptionExecutionProfileForRun({
      run: v2Run,
      agent: fixture.agent,
      issueId: fixture.issueId,
      resolvedConfig: { ...fixture.resolvedConfig, model: "different-provider-profile" },
      secretManifest: [],
      environment: fixture.environment,
    })).rejects.toMatchObject({
      status: 409,
      details: { code: "execution_profile_pre_spawn_mismatch" },
    });
    expect(preparedDisposals.at(-1)).toHaveBeenCalledOnce();
    expect(await db.select().from(heartbeatRunExecutionProfiles)).toHaveLength(1);
  });

  it("rejects a governed version 2 run with no activation sidecar and disposes launch authority", async () => {
    const fixture = await seedFixture({ governedContractVersion: 2 });
    const heartbeat = heartbeatService(db);
    expect(await heartbeat.requiresSubscriptionExecutionProfilePreparation({
      run: fixture.run,
      resolvedConfig: { engine: "cli", env: {} },
    })).toBe(true);
    await expect(heartbeat.prepareSubscriptionExecutionProfileForRun({
      run: fixture.run,
      agent: fixture.agent,
      issueId: fixture.issueId,
      resolvedConfig: fixture.resolvedConfig,
      secretManifest: [],
      environment: fixture.environment,
    })).rejects.toMatchObject({
      status: 409,
      details: { code: "execution_profile_sidecar_missing" },
    });
    expect(preparedDisposals.at(-1)).toHaveBeenCalledOnce();
    expect(await db.select().from(heartbeatRunExecutionProfiles)).toHaveLength(0);
  });

  it("preserves the exact parent authority for a process-loss retry", async () => {
    const fixture = await seedFixture();
    const heartbeat = heartbeatService(db);
    await heartbeat.prepareSubscriptionExecutionProfileForRun({
      run: fixture.run,
      agent: fixture.agent,
      issueId: fixture.issueId,
      resolvedConfig: fixture.resolvedConfig,
      secretManifest: [],
      environment: fixture.environment,
    });
    const [parent] = await db.select().from(heartbeatRunExecutionProfiles);
    const [retryRun] = await db.insert(heartbeatRuns).values({
      companyId: fixture.companyId,
      agentId: fixture.agent.id,
      invocationSource: "assignment",
      triggerDetail: "recovery",
      status: "queued",
      retryOfRunId: fixture.run.id,
      contextSnapshot: {
        issueId: fixture.issueId,
        wakeReason: "process_lost_retry",
      },
    }).returning();
    await heartbeat.prepareSubscriptionExecutionProfileForRun({
      run: retryRun!,
      agent: fixture.agent,
      issueId: fixture.issueId,
      resolvedConfig: fixture.resolvedConfig,
      secretManifest: [],
      environment: fixture.environment,
    });
    const preserved = await db.select().from(heartbeatRunExecutionProfiles)
      .where(eq(heartbeatRunExecutionProfiles.runId, retryRun!.id))
      .then((rows) => rows[0]);
    expect(preserved).toMatchObject({
      transitionKind: "preserve",
      transitionReason: "process_loss",
      parentRunId: fixture.run.id,
      parentProfileId: parent!.id,
      digest: parent!.digest,
      authorityFingerprint: parent!.authorityFingerprint,
    });
  });

  it("binds a later governed reviewer run in its queue transaction and rejects frozen-revision drift", async () => {
    const fixture = await seedFixture();
    const reviewerId = randomUUID();
    const [reviewer] = await db.insert(agents).values({
      id: reviewerId,
      companyId: fixture.companyId,
      name: "Codex reviewer",
      role: "reviewer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: { billingPolicy: "subscription_only", engine: "cli" },
      runtimeConfig: {},
      permissions: {},
    }).returning();
    const [reviewIssue] = await db.update(issues)
      .set({ assigneeAgentId: reviewerId, status: "in_review" })
      .where(eq(issues.id, fixture.issueId))
      .returning();
    const executionProfiles = {
      builderAgentId: fixture.agent.id,
      participants: [fixture.agent.id, reviewerId]
        .sort((left, right) => left.localeCompare(right))
        .map((agentId) => ({ agentId, executionProfileRevision: 1 })),
    };
    const intentSha = executionProfileSha256(executionProfiles);
    await db.insert(governedIssueReservations).values({
      companyId: fixture.companyId,
      idempotencyKey: "reeve-build:reviewer-queue-binding",
      issueId: fixture.issueId,
      contractVersion: 2,
      requestIntentSha256: "a".repeat(64),
      envelopeSha256: "b".repeat(64),
      envelope: {},
      executionProfileIntentSha256: intentSha,
      executionProfileIntent: executionProfiles,
      reservedIssueSnapshot: {},
      reservedIssueUpdatedAt: reviewIssue!.updatedAt,
      activatedAt: new Date(),
      executionProfileReceipt: {},
    });
    const heartbeat = heartbeatService(db);
    const reviewerRunId = randomUUID();
    await db.transaction(async (tx) => {
      const [run] = await tx.insert(heartbeatRuns).values({
        id: reviewerRunId,
        companyId: fixture.companyId,
        agentId: reviewerId,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: "queued",
        contextSnapshot: {
          issueId: fixture.issueId,
          source: "issue.execution_stage",
          wakeReason: "execution_review_requested",
        },
      }).returning();
      await heartbeat.bindGovernedV2ExecutionProfileToQueuedRun(tx as typeof db, {
        run: run!,
        transition: { kind: "fresh", reason: "normal_enqueue" },
      });
    });
    const reviewerSidecar = await db.select().from(heartbeatRunExecutionProfiles)
      .where(eq(heartbeatRunExecutionProfiles.runId, reviewerRunId))
      .then((rows) => rows[0]);
    expect(reviewerSidecar).toMatchObject({
      runId: reviewerRunId,
      agentId: reviewerId,
      issueId: fixture.issueId,
      agentExecutionProfileRevision: 1,
      issueAssigneeProfileRevision: reviewIssue!.assigneeProfileRevision,
      transitionKind: "fresh",
      transitionReason: "normal_enqueue",
    });

    await db.update(agents)
      .set({ adapterConfig: { billingPolicy: "subscription_only", engine: "cli", model: "changed" } })
      .where(eq(agents.id, reviewerId));
    const driftedRunId = randomUUID();
    await expect(db.transaction(async (tx) => {
      const [run] = await tx.insert(heartbeatRuns).values({
        id: driftedRunId,
        companyId: fixture.companyId,
        agentId: reviewerId,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: "queued",
        contextSnapshot: { issueId: fixture.issueId },
      }).returning();
      await heartbeat.bindGovernedV2ExecutionProfileToQueuedRun(tx as typeof db, {
        run: run!,
        transition: { kind: "fresh", reason: "normal_enqueue" },
      });
    })).rejects.toMatchObject({
      status: 409,
      details: { code: "governed_execution_profile_queue_drift" },
    });
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, driftedRunId)))
      .toHaveLength(0);
  });
});
