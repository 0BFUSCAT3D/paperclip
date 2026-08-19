import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEmbedded = support.supported ? describe : describe.skip;
const cleanups: Array<() => Promise<void>> = [];

describe("artifact review evidence migration SQL", () => {
  it("closes nullable actor and JSON comparison holes", () => {
    const migrationSql = readFileSync(
      new URL("./migrations/0224_bizarre_typhoid_mary.sql", import.meta.url),
      "utf8",
    );
    expect(migrationSql).toContain('"issue_execution_decisions"."actor_agent_id" is not null');
    expect(migrationSql.match(/is not distinct from/g)).toHaveLength(8);
  });
});

describeEmbedded("artifact review evidence migration constraints", () => {
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it("applies the migration and rejects partial, duplicate, and cross-company evidence", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-review-evidence-");
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, { max: 1 });
    cleanups.push(async () => sql.end());

    const companyId = randomUUID();
    const otherCompanyId = randomUUID();
    const reviewerAgentId = randomUUID();
    const reviewerRunId = randomUUID();
    const issueId = randomUUID();
    const workProductId = randomUUID();
    const stageId = randomUUID();
    const cycleId = randomUUID();
    const requestKey = randomUUID();
    const headSha = "a".repeat(40);
    const fingerprint = "b".repeat(64);
    const snapshot = {
      kind: "github_pull_request",
      provider: "github",
      canonicalRef: "github:acme/reeve#42",
      locatorFingerprint: fingerprint,
      configuredRepository: { owner: "acme", repo: "reeve", repoUrl: "https://github.com/acme/reeve.git" },
      headRef: "codex/reviewed-change",
      headSha,
      observedState: "open",
      observedAt: "2026-08-19T08:05:00.000Z",
      workProductTrust: "implicit_standard",
      reviewer: { agentId: reviewerAgentId, runId: reviewerRunId, actorSource: "agent_key" },
      director: { userId: "director" },
    };

    await sql`INSERT INTO companies (id, name, issue_prefix) VALUES
      (${companyId}, 'Evidence', 'EVD'),
      (${otherCompanyId}, 'Other', 'OTH')`;
    await sql`INSERT INTO agents (id, company_id, name) VALUES (${reviewerAgentId}, ${companyId}, 'Reviewer')`;
    await sql`INSERT INTO heartbeat_runs (id, company_id, agent_id, status)
      VALUES (${reviewerRunId}, ${companyId}, ${reviewerAgentId}, 'running')`;
    await sql`INSERT INTO issues (id, company_id, title) VALUES (${issueId}, ${companyId}, 'Evidence issue')`;

    await expect(sql`INSERT INTO issue_work_products
      (id, company_id, issue_id, type, provider, title, status)
      VALUES (${randomUUID()}, ${otherCompanyId}, ${issueId}, 'pull_request', 'github', 'Wrong scope', 'ready_for_review')`
    ).rejects.toThrow();

    await sql`INSERT INTO issue_work_products
      (id, company_id, issue_id, type, provider, title, status, created_by_run_id, last_modified_by_run_id)
      VALUES (${workProductId}, ${companyId}, ${issueId}, 'pull_request', 'github', 'PR', 'ready_for_review', ${reviewerRunId}, ${reviewerRunId})`;

    const insertEvidence = (id: string, input: {
      actorSource?: string | null;
      actorAgentId?: string | null;
      artifactSnapshot?: postgres.JSONValue;
    } = {}) => sql`INSERT INTO issue_execution_decisions
      (id, company_id, issue_id, stage_id, stage_type, actor_agent_id, actor_user_id, outcome, body,
       review_cycle_id, request_idempotency_key, artifact_work_product_id, artifact_revision,
       artifact_locator_fingerprint, reviewer_agent_id_snapshot, reviewer_run_id_snapshot,
       reviewer_actor_source_snapshot, director_user_id_snapshot, artifact_snapshot, created_by_run_id)
      VALUES (${id}, ${companyId}, ${issueId}, ${stageId}, 'review', ${input.actorAgentId === undefined ? reviewerAgentId : input.actorAgentId}, NULL, 'approved', 'Reviewed',
       ${cycleId}, ${requestKey}, ${workProductId}, ${headSha}, ${fingerprint}, ${reviewerAgentId}, ${reviewerRunId},
       ${input.actorSource === undefined ? "agent_key" : input.actorSource}, 'director', ${sql.json(input.artifactSnapshot ?? snapshot)}, ${reviewerRunId})`;

    await expect(insertEvidence(randomUUID(), { actorSource: null })).rejects.toThrow();
    await expect(insertEvidence(randomUUID(), { actorAgentId: null })).rejects.toThrow();
    const { headSha: _omittedHeadSha, ...snapshotWithoutHeadSha } = snapshot;
    await expect(insertEvidence(randomUUID(), { artifactSnapshot: snapshotWithoutHeadSha })).rejects.toThrow();
    await insertEvidence(randomUUID());
    await expect(insertEvidence(randomUUID())).rejects.toThrow();
  }, 60_000);
});
