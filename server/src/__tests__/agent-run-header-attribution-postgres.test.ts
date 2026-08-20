import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  issueComments,
  issueThreadInteractions,
  issues,
} from "@paperclipai/db";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres run-header attribution tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

/**
 * REEA-11 regression cover.
 *
 * In `local_trusted` mode every credential-less request used to land on the
 * implicit `local-board` board actor, including writes from agent runs that
 * have no injected `PAPERCLIP_API_KEY`. An agent's own status comment was then
 * stored as a *user* comment, which broke two things that key off actor type:
 *
 *  1. the self-comment wake suppression in `POST /issues/:id/comments`, so the
 *     agent woke itself on its own comment, unbounded; and
 *  2. `supersedeOnUserComment`, so the agent's own status comment silently
 *     expired the agent's own pending `ask_user_questions` and the board was
 *     never asked.
 *
 * These run against the real auth middleware, real routes, real services and a
 * real database, because the whole point of the fix is that attribution is
 * decided once at the auth layer and every downstream write inherits it — a
 * stubbed `req.actor` would assume away exactly the thing under test.
 */
describeEmbeddedPostgres("agent run-header attribution (auth middleware + routes + postgres)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-run-header-attribution-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  // A comment can land a wake row just after the response, so teardown is
  // best-effort in foreign-key order.
  afterEach(async () => {
    const cleanups = [
      () => db.delete(issueThreadInteractions),
      () => db.delete(issueComments),
      () => db.delete(activityLog),
      () => db.delete(heartbeatRuns),
      () => db.delete(agentWakeupRequests),
      () => db.delete(heartbeatRuns),
      () => db.delete(issues),
      () => db.delete(companyMemberships),
      () => db.delete(agents),
      () => db.delete(companies),
    ];
    for (const cleanup of cleanups) await cleanup().catch(() => undefined);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  /**
   * The real `local_trusted` stack: no stubbed actor, so a request without an
   * Authorization header exercises exactly the branch this fix changes.
   */
  function app() {
    const testApp = express();
    testApp.use(express.json());
    testApp.use(actorMiddleware(db, { deploymentMode: "local_trusted" }));
    testApp.use("/api", issueRoutes(db, {} as any, {}));
    testApp.use(errorHandler);
    return testApp;
  }

  let issueSequence = 0;

  async function seedCompanyAndAgent(prefix: string) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `${prefix} Company`,
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: `${prefix} Engineer`,
      role: "engineer",
      status: "idle",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: "local-board",
      status: "active",
      membershipRole: "operator",
    });
    return { companyId, agentId };
  }

  async function seedIssue(companyId: string, prefix: string, assigneeAgentId: string | null) {
    const issueId = randomUUID();
    issueSequence += 1;
    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier: `${prefix}-${issueSequence}`,
      title: `${prefix} issue ${issueSequence}`,
      status: "in_progress",
      priority: "medium",
      assigneeAgentId,
    });
    return issueId;
  }

  async function seedRun(
    companyId: string,
    agentId: string,
    issueId: string,
    status = "running",
  ) {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status,
      contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_assigned" },
    });
    return runId;
  }

  async function seedPendingAskUserQuestions(companyId: string, issueId: string) {
    const [row] = await db.insert(issueThreadInteractions).values({
      companyId,
      issueId,
      kind: "ask_user_questions",
      status: "pending",
      continuationPolicy: "wake_assignee",
      requestedResolverPolicy: "anyone",
      effectiveResolverPolicy: "anyone",
      payload: {
        version: 1,
        // The defaulted value is what makes this dangerous: the agent does not
        // opt in to being superseded, it opts out.
        supersedeOnUserComment: true,
        questions: [{
          id: "scope",
          prompt: "Which scope should I take?",
          selectionMode: "single",
          options: [{ id: "phase-1", label: "Phase 1" }],
        }],
      } as never,
    }).returning();
    return row.id;
  }

  function commentsFor(issueId: string) {
    return db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
  }

  function wakeupsFor(agentId: string) {
    return db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agentId));
  }

  /**
   * `POST /issues/:id/comments` dispatches wakes fire-and-forget after it has
   * already responded, so reading the wake table straight off the response races
   * the insert — and a *negative* assertion would race it vacuously, passing
   * whether or not the fix works.
   *
   * Every test that asserts on wakes therefore ends with a board comment, whose
   * wake is expected, and blocks until that wake row lands. Because the route
   * dispatches in order, a later wake having landed means every earlier one has
   * too: the barrier makes "no wake was queued" a real observation rather than a
   * head start.
   */
  async function commentAsBoardAndAwaitWake(issueId: string, agentId: string, body: string) {
    const before = (await wakeupsFor(agentId)).length;
    const res = await request(app()).post(`/api/issues/${issueId}/comments`).send({ body });
    expect(res.status).toBe(201);

    const deadline = Date.now() + 5_000;
    for (;;) {
      const rows = await wakeupsFor(agentId);
      if (rows.length > before) return { comment: res.body, wakeups: rows };
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for the board comment to wake agent ${agentId}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  it("stores a credential-less run-header comment as the run's agent, not the board", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent("ATTR");
    const issueId = await seedIssue(companyId, "ATTR", agentId);
    const runId = await seedRun(companyId, agentId, issueId);

    const res = await request(app())
      .post(`/api/issues/${issueId}/comments`)
      .set("X-Paperclip-Run-Id", runId)
      .send({ body: "Status: still working the auth layer." });

    expect(res.status).toBe(201);

    const [comment] = await commentsFor(issueId);
    expect(comment.authorType).toBe("agent");
    expect(comment.authorAgentId).toBe(agentId);
    expect(comment.authorUserId).toBeNull();
    expect(comment.createdByRunId).toBe(runId);
  });

  it("does not wake the commenting agent on its own comment", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent("SELF");
    const issueId = await seedIssue(companyId, "SELF", agentId);
    const runId = await seedRun(companyId, agentId, issueId);

    const res = await request(app())
      .post(`/api/issues/${issueId}/comments`)
      .set("X-Paperclip-Run-Id", runId)
      .send({ body: "Status: no reply expected." });

    expect(res.status).toBe(201);

    // Flush the wake pipeline behind a wake that *is* expected, so the absence
    // below is observed rather than merely not-yet-arrived.
    const { comment: boardComment, wakeups } = await commentAsBoardAndAwaitWake(
      issueId,
      agentId,
      "Board here — carry on.",
    );

    // The self-wake loop this closes: comment -> wake -> comment -> wake. Only
    // the board's comment may appear; the agent's own must not.
    expect(wakeups).toHaveLength(1);
    expect((wakeups[0].payload as { commentId?: string }).commentId).toBe(boardComment.id);
    expect(wakeups[0].requestedByActorId).toBe("local-board");
  });

  it("leaves the agent's own pending ask_user_questions pending when it posts status", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent("SUPER");
    const issueId = await seedIssue(companyId, "SUPER", agentId);
    const runId = await seedRun(companyId, agentId, issueId);
    const interactionId = await seedPendingAskUserQuestions(companyId, issueId);

    const res = await request(app())
      .post(`/api/issues/${issueId}/comments`)
      .set("X-Paperclip-Run-Id", runId)
      .send({ body: "Status: still waiting on the board's answer above." });

    expect(res.status).toBe(201);

    // The supersede sweep bails on `comment.createdByRunId` *and*, since this
    // fix, on a null `authorUserId`. The run-id guard predates this change, so
    // asserting only that the interaction survived would pass with or without
    // the fix and prove nothing. Pin the actor identity too: that is the half
    // this change is responsible for, and the half that fails without it.
    const [comment] = await commentsFor(issueId);
    expect(comment.authorType).toBe("agent");
    expect(comment.authorUserId).toBeNull();
    expect(comment.createdByRunId).toBe(runId);

    const [interaction] = await db
      .select()
      .from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.id, interactionId));
    // The silent failure mode: the board is never asked and nobody notices.
    expect(interaction.status).toBe("pending");
    expect(interaction.result).toBeNull();
  });

  it("still supersedes and wakes on a genuine board comment carrying no run header", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent("HUMAN");
    const issueId = await seedIssue(companyId, "HUMAN", agentId);
    const interactionId = await seedPendingAskUserQuestions(companyId, issueId);

    // The human-in-the-loop path must keep working: the board's answer both
    // supersedes the pending question and wakes the assignee, even though the
    // agent's own status comment now does neither.
    await commentAsBoardAndAwaitWake(issueId, agentId, "Take phase 1, and skip the migration for now.");

    const [comment] = await commentsFor(issueId);
    expect(comment.authorType).toBe("user");
    expect(comment.authorUserId).toBe("local-board");
    expect(comment.createdByRunId).toBeNull();

    const [interaction] = await db
      .select()
      .from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.id, interactionId));
    expect(interaction.status).toBe("expired");
  });

  it("does not attribute to the agent when the named run has already finished", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent("STALE");
    const issueId = await seedIssue(companyId, "STALE", agentId);
    const finishedRunId = await seedRun(companyId, agentId, issueId, "succeeded");

    const res = await request(app())
      .post(`/api/issues/${issueId}/comments`)
      .set("X-Paperclip-Run-Id", finishedRunId)
      .send({ body: "Replayed from a finished run." });

    expect(res.status).toBe(201);

    // The run id is not a secret, so a finished run must carry no authority.
    const [comment] = await commentsFor(issueId);
    expect(comment.authorType).toBe("user");
    expect(comment.authorAgentId).toBeNull();
  });

  it("does not attribute to the agent when the run id is unknown", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent("UNKNOWN");
    const issueId = await seedIssue(companyId, "UNKNOWN", agentId);

    const res = await request(app())
      .post(`/api/issues/${issueId}/comments`)
      .set("X-Paperclip-Run-Id", randomUUID())
      .send({ body: "Forged run id." });

    // An unknown run id must degrade to the board actor, not 500 the write:
    // the header is caller-supplied and `activity_log.run_id` is a foreign key.
    expect(res.status).toBe(201);

    const [comment] = await commentsFor(issueId);
    expect(comment.authorType).toBe("user");
    expect(comment.authorAgentId).toBeNull();
  });

  it("does not attribute to the agent when the agent is terminated", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent("TERM");
    const issueId = await seedIssue(companyId, "TERM", agentId);
    const runId = await seedRun(companyId, agentId, issueId);
    await db.update(agents).set({ status: "terminated" }).where(and(
      eq(agents.id, agentId),
      eq(agents.companyId, companyId),
    ));

    const res = await request(app())
      .post(`/api/issues/${issueId}/comments`)
      .set("X-Paperclip-Run-Id", runId)
      .send({ body: "Write from a terminated agent's run." });

    expect(res.status).toBe(201);

    const [comment] = await commentsFor(issueId);
    expect(comment.authorType).toBe("user");
    expect(comment.authorAgentId).toBeNull();
  });

  /**
   * Attribution is not only a provenance concern. `resolveInteractionAuthorization`
   * short-circuits on `actor.type === "user"` with `allow_human`, *above* the
   * `human_only`, governed-action and addressee checks. So while every agent run
   * presented as `local-board`, an agent run took the human branch and those gates
   * did not merely mis-record the actor — they did not apply at all.
   *
   * These two cover the downstream halves reported from REEA-8 and REEA-1: an
   * agent-performed withdrawal recorded as a board withdrawal, and `human_only`
   * being unenforceable against agents.
   */
  async function seedPendingAskUserQuestionsWithPolicy(
    companyId: string,
    issueId: string,
    policy: "anyone" | "human_only",
    createdByAgentId: string | null,
  ) {
    const [row] = await db.insert(issueThreadInteractions).values({
      companyId,
      issueId,
      kind: "ask_user_questions",
      status: "pending",
      continuationPolicy: "wake_assignee",
      requestedResolverPolicy: policy,
      effectiveResolverPolicy: policy,
      createdByAgentId,
      payload: {
        version: 1,
        supersedeOnUserComment: false,
        questions: [{
          id: "scope",
          prompt: "Which scope should I take?",
          selectionMode: "single",
          options: [{ id: "phase-1", label: "Phase 1" }],
        }],
      } as never,
    }).returning();
    return row.id;
  }

  it("records an agent-run withdrawal as the agent, not as a board withdrawal", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent("WDRW");
    const issueId = await seedIssue(companyId, "WDRW", agentId);
    const runId = await seedRun(companyId, agentId, issueId);
    const interactionId = await seedPendingAskUserQuestionsWithPolicy(
      companyId,
      issueId,
      "anyone",
      agentId,
    );

    const res = await request(app())
      .post(`/api/issues/${issueId}/interactions/${interactionId}/withdraw`)
      .set("X-Paperclip-Run-Id", runId)
      .send({ reason: "Superseded by a better question." });

    expect(res.status).toBe(200);

    const [interaction] = await db
      .select()
      .from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.id, interactionId));
    // Previously `resolvedByUserId: "local-board"` with both agent fields null,
    // which made an agent's withdrawal indistinguishable from the board's.
    expect(interaction.resolvedByAgentId).toBe(agentId);
    expect(interaction.resolvedByRunId).toBe(runId);
    expect(interaction.resolvedByUserId).toBeNull();
  });

  it("refuses to let an agent run resolve a human_only interaction", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent("HONLY");
    const issueId = await seedIssue(companyId, "HONLY", agentId);
    const runId = await seedRun(companyId, agentId, issueId);
    const interactionId = await seedPendingAskUserQuestionsWithPolicy(
      companyId,
      issueId,
      "human_only",
      agentId,
    );

    const res = await request(app())
      .post(`/api/issues/${issueId}/interactions/${interactionId}/respond`)
      .set("X-Paperclip-Run-Id", runId)
      .send({ answers: [{ questionId: "scope", optionIds: ["phase-1"] }] });

    // The gate exists precisely to keep agent-invented data out of a decision.
    // While agent runs resolved to the board actor it was inert, and the answer
    // was then stored as if the board had given it.
    expect(res.status).toBe(403);

    const [interaction] = await db
      .select()
      .from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.id, interactionId));
    expect(interaction.status).toBe("pending");
    expect(interaction.resolvedByAgentId).toBeNull();
    expect(interaction.resolvedByUserId).toBeNull();
  });
});
