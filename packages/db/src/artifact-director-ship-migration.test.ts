import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const migration = readFileSync(
  fileURLToPath(new URL("./migrations/0227_melted_jasper_sitwell.sql", import.meta.url)),
  "utf8",
);
const support = await getEmbeddedPostgresTestSupport();
const describeEmbedded = support.supported ? describe : describe.skip;
const cleanups: Array<() => Promise<void>> = [];

describe("artifact director Ship migration", () => {
  it("creates the durable state machine and recovery lease columns", () => {
    expect(migration).toContain('CREATE TABLE "issue_artifact_director_shipments"');
    for (const state of [
      "prepared",
      "merge_in_flight",
      "reconcile_required",
      "merge_observed",
      "completed",
      "stale",
    ]) {
      expect(migration).toContain(`'${state}'`);
    }
    expect(migration).toContain('"lease_token" uuid');
    expect(migration).toContain('"lease_expires_at" timestamp with time zone');
    expect(migration).toContain('"next_attempt_at" timestamp with time zone');
    expect(migration).toContain('"state" = \'merge_in_flight\'');
    expect(migration).toContain('"attempt_count" > 0');
    expect(migration).toContain('"merge_attempted_at" is not null');
    expect(migration).toContain('"state" <> \'merge_in_flight\'');
    expect(migration).toContain('"artifact_shipments_retry_shape_check"');
    expect(migration).toContain('"next_attempt_at" is not null');
    expect(migration).toContain('"last_error_code" is not null');
    expect(migration).toContain('"last_error_at" is not null');
  });

  it("enforces candidate, review-cycle, and idempotency uniqueness", () => {
    expect(migration).toContain('"artifact_shipments_company_issue_idempotency_uq"');
    expect(migration).toContain('"artifact_shipments_company_issue_candidate_uq"');
    expect(migration).toContain('"artifact_shipments_company_issue_review_cycle_uq"');
  });

  it("uses global partial keyset indexes that exactly match every recovery scan", () => {
    expect(migration).toContain(
      '"artifact_shipments_reconciliation_keyset_idx" ON "issue_artifact_director_shipments" USING btree ("next_attempt_at","id")',
    );
    expect(migration).toContain("WHERE \"issue_artifact_director_shipments\".\"state\" = 'reconcile_required'");
    expect(migration).toContain(
      '"artifact_shipments_lease_expiry_keyset_idx" ON "issue_artifact_director_shipments" USING btree ("lease_expires_at","id")',
    );
    expect(migration).toContain("WHERE \"issue_artifact_director_shipments\".\"state\" = 'merge_in_flight'");
    expect(migration).toContain(
      '"artifact_shipments_merge_observed_keyset_idx" ON "issue_artifact_director_shipments" USING btree ("id")',
    );
    expect(migration).toContain("WHERE \"issue_artifact_director_shipments\".\"state\" = 'merge_observed'");
    expect(migration).not.toContain('"artifact_shipments_recovery_idx"');
  });

  it("binds every completion receipt field back to immutable scalar provenance", () => {
    expect(migration).toContain('"artifact_shipments_completion_receipt_check"');
    for (const field of [
      "shipmentId",
      "issueId",
      "reviewDecisionId",
      "reviewCycleId",
      "policySha256",
      "approvalDecisionId",
      "workProductId",
      "artifactRevision",
      "locatorFingerprint",
      "canonicalRef",
      "mergeCommitSha",
      "directorUserId",
      "reviewerActorSource",
      "directorActorSource",
      "providerObservedAt",
      "completedAt",
      "completedIssueUpdatedAt",
    ]) {
      expect(migration).toContain(`->> '${field}'`);
    }
  });

  it("keeps every shipment provenance dependency restrictive", () => {
    for (const constraint of [
      "artifact_shipments_issue_scope_fk",
      "artifact_shipments_review_decision_scope_fk",
      "artifact_shipments_approval_decision_scope_fk",
      "artifact_shipments_work_product_scope_fk",
    ]) {
      expect(migration).toContain(`CONSTRAINT "${constraint}"`);
    }
    expect(migration.match(/ON DELETE restrict/g)?.length).toBeGreaterThanOrEqual(5);
  });
});

describeEmbedded("artifact director Ship database invariants", () => {
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it("enforces lease, retry, provenance, receipt, and keyset recovery invariants", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-director-ship-");
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, { max: 1 });
    cleanups.push(async () => sql.end());

    const companyId = randomUUID();
    const reviewerAgentId = randomUUID();
    const reviewerRunId = randomUUID();
    const issueId = randomUUID();
    const workProductId = randomUUID();
    const reviewDecisionId = randomUUID();
    const approvalDecisionId = randomUUID();
    const reviewStageId = randomUUID();
    const approvalStageId = randomUUID();
    const reviewCycleId = randomUUID();
    const shipmentId = randomUUID();
    const candidateSha256 = "1".repeat(64);
    const policySha256 = "2".repeat(64);
    const headSha = "a".repeat(40);
    const mergeCommitSha = "b".repeat(40);
    const locatorFingerprint = "3".repeat(64);
    const canonicalRef = "github:acme/reeve#42";
    const observedAt = "2026-08-19T12:05:00.000Z";
    const completedAt = "2026-08-19T12:06:00.000Z";
    const candidate = {
      candidateSha256,
      policySha256,
      issue: {
        id: issueId,
        identifier: "SHP-1",
        status: "in_review",
        executionFingerprint: "4".repeat(64),
        currentStageId: approvalStageId,
      },
      review: {
        decisionId: reviewDecisionId,
        reviewCycleId,
        stageId: reviewStageId,
        workProductId,
        headSha,
        locatorFingerprint,
        reviewerAgentId,
        reviewerRunId,
        reviewerActorSource: "agent_key",
      },
      artifact: {
        kind: "github_pull_request",
        canonicalRef,
        owner: "acme",
        repo: "reeve",
        number: 42,
        headRef: "codex/reviewed",
        headSha,
        workProductTrust: "implicit_standard",
      },
      director: { userId: "local-board", actorSource: "local_implicit" },
    };
    const reviewArtifactSnapshot = {
      kind: "github_pull_request",
      provider: "github",
      canonicalRef,
      locatorFingerprint,
      configuredRepository: { owner: "acme", repo: "reeve", repoUrl: "https://github.com/acme/reeve.git" },
      headRef: "codex/reviewed",
      headSha,
      observedState: "open",
      observedAt: "2026-08-19T12:00:00.000Z",
      workProductTrust: "implicit_standard",
      reviewer: { agentId: reviewerAgentId, runId: reviewerRunId, actorSource: "agent_key" },
      director: { userId: "local-board" },
    };

    await sql`INSERT INTO companies (id, name, issue_prefix) VALUES (${companyId}, 'Ship', 'SHP')`;
    await sql`INSERT INTO agents (id, company_id, name) VALUES (${reviewerAgentId}, ${companyId}, 'Reviewer')`;
    await sql`INSERT INTO heartbeat_runs (id, company_id, agent_id, status)
      VALUES (${reviewerRunId}, ${companyId}, ${reviewerAgentId}, 'succeeded')`;
    await sql`INSERT INTO issues (id, company_id, title, status) VALUES (${issueId}, ${companyId}, 'Ship issue', 'in_review')`;
    await sql`INSERT INTO issue_work_products
      (id, company_id, issue_id, type, provider, title, status, created_by_run_id, last_modified_by_run_id)
      VALUES (${workProductId}, ${companyId}, ${issueId}, 'pull_request', 'github', 'PR', 'ready_for_review', ${reviewerRunId}, ${reviewerRunId})`;
    await sql`INSERT INTO issue_execution_decisions
      (id, company_id, issue_id, stage_id, stage_type, actor_agent_id, outcome, body,
       review_cycle_id, request_idempotency_key, artifact_work_product_id, artifact_revision,
       artifact_locator_fingerprint, reviewer_agent_id_snapshot, reviewer_run_id_snapshot,
       reviewer_actor_source_snapshot, director_user_id_snapshot, artifact_snapshot, created_by_run_id)
      VALUES (${reviewDecisionId}, ${companyId}, ${issueId}, ${reviewStageId}, 'review', ${reviewerAgentId}, 'approved', 'Reviewed',
       ${reviewCycleId}, ${randomUUID()}, ${workProductId}, ${headSha}, ${locatorFingerprint}, ${reviewerAgentId}, ${reviewerRunId},
       'agent_key', 'local-board', ${sql.json(reviewArtifactSnapshot)}, ${reviewerRunId})`;
    await sql`INSERT INTO issue_execution_decisions
      (id, company_id, issue_id, stage_id, stage_type, actor_user_id, outcome, body)
      VALUES (${approvalDecisionId}, ${companyId}, ${issueId}, ${approvalStageId}, 'approval', 'local-board', 'approved', 'Ship')`;

    await sql`INSERT INTO issue_artifact_director_shipments
      (id, company_id, issue_id, idempotency_key, candidate_sha256, policy_sha256,
       review_decision_id, review_cycle_id, artifact_work_product_id, artifact_revision,
       artifact_locator_fingerprint, reviewer_actor_source, candidate_snapshot,
       review_evidence_snapshot, artifact_snapshot, director_user_id_snapshot,
       director_actor_source, director_snapshot, request_comment)
      VALUES (${shipmentId}, ${companyId}, ${issueId}, ${randomUUID()}, ${candidateSha256}, ${policySha256},
       ${reviewDecisionId}, ${reviewCycleId}, ${workProductId}, ${headSha}, ${locatorFingerprint}, 'agent_key',
       ${sql.json(candidate)}, ${sql.json(candidate.review)}, ${sql.json(candidate.artifact)}, 'local-board',
       'local_implicit', ${sql.json(candidate.director)}, 'Ship this revision')`;

    await expect(sql`UPDATE issue_artifact_director_shipments
      SET state = 'merge_in_flight', attempt_count = 1, merge_attempted_at = now()
      WHERE id = ${shipmentId}`).rejects.toThrow();
    await sql`UPDATE issue_artifact_director_shipments
      SET state = 'merge_in_flight', attempt_count = 1, merge_attempted_at = now(),
          provider_request_started_at = now(), lease_token = ${randomUUID()},
          lease_expires_at = now() + interval '1 minute'
      WHERE id = ${shipmentId}`;
    await expect(sql`UPDATE issue_artifact_director_shipments
      SET state = 'reconcile_required', lease_token = NULL, lease_expires_at = NULL,
          next_attempt_at = now() + interval '1 minute'
      WHERE id = ${shipmentId}`).rejects.toThrow();
    await sql`UPDATE issue_artifact_director_shipments
      SET state = 'reconcile_required', lease_token = NULL, lease_expires_at = NULL,
          next_attempt_at = now() + interval '1 minute', last_error_code = 'provider_outcome_unknown', last_error_at = now()
      WHERE id = ${shipmentId}`;

    const receipt = {
      version: 1,
      shipmentId,
      issueId,
      reviewDecisionId,
      reviewCycleId,
      policySha256,
      approvalDecisionId,
      workProductId,
      artifactRevision: headSha,
      locatorFingerprint,
      canonicalRef,
      provider: "github",
      mergeMethod: "merge",
      mergeCommitSha,
      directorUserId: "local-board",
      reviewerActorSource: "agent_key",
      directorActorSource: "local_implicit",
      providerObservedAt: observedAt,
      completedAt,
      completedIssueUpdatedAt: completedAt,
    };
    await expect(sql`UPDATE issue_artifact_director_shipments
      SET state = 'completed', provider_observed_at = ${observedAt}, merge_commit_sha = ${mergeCommitSha},
          approval_decision_id = ${approvalDecisionId}, completion_receipt = ${sql.json({ ...receipt, policySha256: "9".repeat(64) })},
          completed_issue_updated_at = ${completedAt}, completed_at = ${completedAt}, next_attempt_at = NULL
      WHERE id = ${shipmentId}`).rejects.toThrow();
    await sql`UPDATE issue_artifact_director_shipments
      SET state = 'completed', provider_observed_at = ${observedAt}, merge_commit_sha = ${mergeCommitSha},
          approval_decision_id = ${approvalDecisionId}, completion_receipt = ${sql.json(receipt)},
          completed_issue_updated_at = ${completedAt}, completed_at = ${completedAt}, next_attempt_at = NULL
      WHERE id = ${shipmentId}`;

    const indexes = await sql<{ indexname: string; indexdef: string }[]>`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE tablename = 'issue_artifact_director_shipments'
        AND indexname IN (
          'artifact_shipments_reconciliation_keyset_idx',
          'artifact_shipments_lease_expiry_keyset_idx',
          'artifact_shipments_merge_observed_keyset_idx'
        )
      ORDER BY indexname`;
    expect(indexes).toHaveLength(3);
    expect(indexes.map((row) => row.indexdef).join("\n")).toContain("next_attempt_at");
    expect(indexes.map((row) => row.indexdef).join("\n")).toContain("lease_expires_at");
  }, 60_000);

  it("plans all three global recovery scans from their matching partial indexes", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-director-ship-plans-");
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, { max: 1 });
    cleanups.push(async () => sql.end());

    await sql`SET enable_seqscan = off`;
    const duePlan = await sql<{ "QUERY PLAN": string }[]>`
      EXPLAIN (COSTS OFF)
      SELECT id FROM issue_artifact_director_shipments
      WHERE state = 'reconcile_required' AND next_attempt_at <= now()
      ORDER BY next_attempt_at, id LIMIT 25`;
    const leasePlan = await sql<{ "QUERY PLAN": string }[]>`
      EXPLAIN (COSTS OFF)
      SELECT id FROM issue_artifact_director_shipments
      WHERE state = 'merge_in_flight' AND lease_expires_at <= now()
      ORDER BY lease_expires_at, id LIMIT 25`;
    const observedPlan = await sql<{ "QUERY PLAN": string }[]>`
      EXPLAIN (COSTS OFF)
      SELECT id FROM issue_artifact_director_shipments
      WHERE state = 'merge_observed' AND provider_request_started_at IS NOT NULL
      ORDER BY id LIMIT 25`;

    const renderPlan = (rows: Array<{ "QUERY PLAN": string }>) => rows.map((row) => row["QUERY PLAN"]).join("\n");
    expect(renderPlan(duePlan)).toContain("artifact_shipments_reconciliation_keyset_idx");
    expect(renderPlan(leasePlan)).toContain("artifact_shipments_lease_expiry_keyset_idx");
    expect(renderPlan(observedPlan)).toContain("artifact_shipments_merge_observed_keyset_idx");
  }, 60_000);
});
