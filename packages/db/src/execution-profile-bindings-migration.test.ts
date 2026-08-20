import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { applyPendingMigrations } from "./client.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const cleanups: Array<() => Promise<void>> = [];
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
const MIGRATION_FILE = "0228_closed_xavin.sql";

async function migrationHash(): Promise<string> {
  const content = await fs.promises.readFile(new URL(`./migrations/${MIGRATION_FILE}`, import.meta.url), "utf8");
  return createHash("sha256").update(content).digest("hex");
}

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres execution profile binding migration tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function expectPostgresCode(promise: Promise<unknown>, code: string) {
  let observed: unknown = null;
  try {
    await promise;
  } catch (error) {
    observed = error;
  }
  expect(observed).toMatchObject({ code });
}

async function waitForBlockedPostgresLock(
  sql: ReturnType<typeof postgres>,
  pid: number,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const [activity] = await sql<{ waiting: boolean }[]>`
      SELECT "wait_event_type" = 'Lock' AS "waiting"
      FROM "pg_stat_activity"
      WHERE "pid" = ${pid}
    `;
    if (activity?.waiting) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Postgres backend ${pid} did not block on the execution-profile authority lock`);
}

describeEmbeddedPostgres("immutable execution profile binding migration", () => {
  it("holds fresh agent and issue profile locks until the binding transaction commits", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-execution-profile-locks-");
    cleanups.push(database.cleanup);
    const bindingSql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    const updateSql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    const observerSql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    cleanups.push(async () => bindingSql.end());
    cleanups.push(async () => updateSql.end());
    cleanups.push(async () => observerSql.end());

    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const agentRunId = randomUUID();
    const issueRunId = randomUUID();
    await observerSql`
      INSERT INTO "companies" ("id", "name", "issue_prefix")
      VALUES (${companyId}, 'Execution profile lock company', 'EPL')
    `;
    await observerSql`
      INSERT INTO "agents" ("id", "company_id", "name", "role", "adapter_type")
      VALUES (${agentId}, ${companyId}, 'Lock agent', 'general', 'claude_local')
    `;
    await observerSql`
      INSERT INTO "issues" ("id", "company_id", "title", "identifier", "assignee_agent_id")
      VALUES (${issueId}, ${companyId}, 'Lock issue', 'EPL-1', ${agentId})
    `;
    await observerSql`
      INSERT INTO "heartbeat_runs" ("id", "company_id", "agent_id", "status") VALUES
        (${agentRunId}, ${companyId}, ${agentId}, 'queued'),
        (${issueRunId}, ${companyId}, ${agentId}, 'queued')
    `;

    const [updateBackend] = await updateSql<{ pid: number }[]>`SELECT pg_backend_pid() AS "pid"`;
    expect(updateBackend?.pid).toBeTypeOf("number");

    let releaseAgentBinding!: () => void;
    let agentBindingLocked!: () => void;
    const agentBindingMayCommit = new Promise<void>((resolve) => { releaseAgentBinding = resolve; });
    const agentBindingHasLock = new Promise<void>((resolve) => { agentBindingLocked = resolve; });
    const agentBinding = bindingSql.begin(async (tx) => {
      await tx`
        INSERT INTO "heartbeat_run_execution_profiles" (
          "company_id", "run_id", "agent_id", "binding_version",
          "agent_execution_profile_revision", "digest", "projection",
          "authority_identity", "authority_fingerprint", "transition_kind", "transition_reason"
        ) VALUES (
          ${companyId}, ${agentRunId}, ${agentId}, 1, 1, 'agent-lock', '{}'::jsonb,
          '{"profile":{"adapter":"subscription-only"}}'::jsonb, 'ignored',
          'fresh', 'normal_enqueue'
        )
      `;
      agentBindingLocked();
      await agentBindingMayCommit;
    });
    await agentBindingHasLock;
    const agentUpdate = Promise.resolve(updateSql`
      UPDATE "agents" SET "permissions" = '{"tools":["read"]}'::jsonb WHERE "id" = ${agentId}
    `);
    try {
      await waitForBlockedPostgresLock(observerSql, updateBackend!.pid);
    } finally {
      releaseAgentBinding();
    }
    await agentBinding;
    await agentUpdate;
    const [agentRevision] = await observerSql<{ revision: string }[]>`
      SELECT "execution_profile_revision"::text AS "revision" FROM "agents" WHERE "id" = ${agentId}
    `;
    expect(agentRevision?.revision).toBe("2");

    let releaseIssueBinding!: () => void;
    let issueBindingLocked!: () => void;
    const issueBindingMayCommit = new Promise<void>((resolve) => { releaseIssueBinding = resolve; });
    const issueBindingHasLock = new Promise<void>((resolve) => { issueBindingLocked = resolve; });
    const issueBinding = bindingSql.begin(async (tx) => {
      await tx`
        INSERT INTO "heartbeat_run_execution_profiles" (
          "company_id", "run_id", "agent_id", "issue_id", "binding_version",
          "agent_execution_profile_revision", "issue_assignee_profile_revision",
          "digest", "projection", "authority_identity", "authority_fingerprint",
          "transition_kind", "transition_reason"
        ) VALUES (
          ${companyId}, ${issueRunId}, ${agentId}, ${issueId}, 1, 2, 1,
          'issue-lock', '{}'::jsonb, '{"profile":{"adapter":"subscription-only"}}'::jsonb,
          'ignored', 'fresh', 'normal_enqueue'
        )
      `;
      issueBindingLocked();
      await issueBindingMayCommit;
    });
    await issueBindingHasLock;
    const issueUpdate = Promise.resolve(updateSql`
      UPDATE "issues"
      SET "assignee_adapter_overrides" = '{"modelProfile":"locked"}'::jsonb
      WHERE "id" = ${issueId}
    `);
    try {
      await waitForBlockedPostgresLock(observerSql, updateBackend!.pid);
    } finally {
      releaseIssueBinding();
    }
    await issueBinding;
    await issueUpdate;
    const [issueRevision] = await observerSql<{ revision: string }[]>`
      SELECT "assignee_profile_revision"::text AS "revision" FROM "issues" WHERE "id" = ${issueId}
    `;
    expect(issueRevision?.revision).toBe("2");
  }, 45_000);

  it("enforces authoritative revisions, company scope, transition provenance, and immutable evidence", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-execution-profiles-");
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    cleanups.push(async () => sql.end());

    const companyA = randomUUID();
    const companyB = randomUUID();
    const agentA = randomUUID();
    const agentA2 = randomUUID();
    const agentB = randomUUID();
    const issueA = randomUUID();
    const issueB = randomUUID();
    const environmentId = randomUUID();

    await sql`
      INSERT INTO "companies" ("id", "name", "issue_prefix") VALUES
        (${companyA}, 'Execution profile company A', 'EPA'),
        (${companyB}, 'Execution profile company B', 'EPB')
    `;
    await sql`
      INSERT INTO "environments" ("id", "name", "driver")
      VALUES (${environmentId}, 'Execution profile sandbox', 'sandbox')
    `;
    await sql`
      INSERT INTO "agents" (
        "id", "company_id", "name", "role", "adapter_type", "execution_profile_revision"
      ) VALUES
        (${agentA}, ${companyA}, 'Agent A', 'general', 'process', 999),
        (${agentA2}, ${companyA}, 'Agent A2', 'general', 'process', 999),
        (${agentB}, ${companyB}, 'Agent B', 'general', 'process', 999)
    `;
    await sql`
      INSERT INTO "issues" (
        "id", "company_id", "title", "identifier", "assignee_profile_revision"
      ) VALUES
        (${issueA}, ${companyA}, 'Issue A', 'EPA-1', 999),
        (${issueB}, ${companyB}, 'Issue B', 'EPB-1', 999)
    `;

    const readAgentRevision = async () => Number((await sql<{ revision: string }[]>`
      SELECT "execution_profile_revision"::text AS "revision"
      FROM "agents" WHERE "id" = ${agentA}
    `)[0]?.revision);
    expect(await readAgentRevision()).toBe(1);
    await sql`UPDATE "agents" SET "name" = 'Renamed', "execution_profile_revision" = 900 WHERE "id" = ${agentA}`;
    expect(await readAgentRevision()).toBe(1);

    const executionProfileUpdates = [
      sql`UPDATE "agents" SET "role" = 'engineer', "execution_profile_revision" = 900 WHERE "id" = ${agentA}`,
      sql`UPDATE "agents" SET "capabilities" = 'code', "execution_profile_revision" = 900 WHERE "id" = ${agentA}`,
      sql`UPDATE "agents" SET "adapter_type" = 'claude_local', "execution_profile_revision" = 900 WHERE "id" = ${agentA}`,
      sql`UPDATE "agents" SET "adapter_config" = '{"billingPolicy":"subscription_only"}'::jsonb, "execution_profile_revision" = 900 WHERE "id" = ${agentA}`,
      sql`UPDATE "agents" SET "runtime_config" = '{"heartbeat":{"enabled":true}}'::jsonb, "execution_profile_revision" = 900 WHERE "id" = ${agentA}`,
      sql`UPDATE "agents" SET "default_environment_id" = ${environmentId}, "execution_profile_revision" = 900 WHERE "id" = ${agentA}`,
      sql`UPDATE "agents" SET "permissions" = '{"tools":["read"]}'::jsonb, "execution_profile_revision" = 900 WHERE "id" = ${agentA}`,
    ];
    for (const [index, update] of executionProfileUpdates.entries()) {
      await update;
      expect(await readAgentRevision()).toBe(index + 2);
    }
    await sql`UPDATE "agents" SET "status" = 'idle', "execution_profile_revision" = 999 WHERE "id" = ${agentA}`;
    expect(await readAgentRevision()).toBe(8);

    const readIssueRevision = async () => Number((await sql<{ revision: string }[]>`
      SELECT "assignee_profile_revision"::text AS "revision"
      FROM "issues" WHERE "id" = ${issueA}
    `)[0]?.revision);
    expect(await readIssueRevision()).toBe(1);
    await sql`UPDATE "issues" SET "title" = 'Renamed issue', "assignee_profile_revision" = 900 WHERE "id" = ${issueA}`;
    expect(await readIssueRevision()).toBe(1);
    await sql`UPDATE "issues" SET "assignee_agent_id" = ${agentA2}, "assignee_profile_revision" = 900 WHERE "id" = ${issueA}`;
    expect(await readIssueRevision()).toBe(2);
    await sql`UPDATE "issues" SET "assignee_user_id" = 'user-1', "assignee_profile_revision" = 900 WHERE "id" = ${issueA}`;
    expect(await readIssueRevision()).toBe(3);
    await sql`UPDATE "issues" SET "assignee_adapter_overrides" = '{"modelProfile":"cheap"}'::jsonb, "assignee_profile_revision" = 900 WHERE "id" = ${issueA}`;
    expect(await readIssueRevision()).toBe(4);
    await sql`UPDATE "issues" SET "priority" = 'high', "assignee_profile_revision" = 999 WHERE "id" = ${issueA}`;
    expect(await readIssueRevision()).toBe(4);

    const legacyRun = randomUUID();
    const validRun = randomUUID();
    const foreignAgentRun = randomUUID();
    const sameCompanyWrongAgentRun = randomUUID();
    const foreignIssueRun = randomUUID();
    const parentRun = randomUUID();
    const childRun = randomUUID();
    const invalidShapeRun = randomUUID();
    const mismatchRun = randomUUID();
    const mismatchAuthorityRun = randomUUID();
    const forgedRevisionRun = randomUUID();
    const issueShapeRun = randomUUID();
    const driftParentRun = randomUUID();
    const preserveAfterDriftRun = randomUUID();
    const freshAfterDriftRun = randomUUID();
    const companyBRun = randomUUID();
    await sql`
      INSERT INTO "heartbeat_runs" ("id", "company_id", "agent_id", "status") VALUES
        (${legacyRun}, ${companyA}, ${agentA}, 'queued'),
        (${validRun}, ${companyA}, ${agentA}, 'queued'),
        (${foreignAgentRun}, ${companyA}, ${agentA}, 'queued'),
        (${sameCompanyWrongAgentRun}, ${companyA}, ${agentA}, 'queued'),
        (${foreignIssueRun}, ${companyA}, ${agentA}, 'queued'),
        (${parentRun}, ${companyA}, ${agentA}, 'queued'),
        (${childRun}, ${companyA}, ${agentA}, 'queued'),
        (${invalidShapeRun}, ${companyA}, ${agentA}, 'queued'),
        (${mismatchRun}, ${companyA}, ${agentA}, 'queued'),
        (${mismatchAuthorityRun}, ${companyA}, ${agentA}, 'queued'),
        (${forgedRevisionRun}, ${companyA}, ${agentA}, 'queued'),
        (${issueShapeRun}, ${companyA}, ${agentA}, 'queued'),
        (${driftParentRun}, ${companyA}, ${agentA}, 'queued'),
        (${preserveAfterDriftRun}, ${companyA}, ${agentA}, 'queued'),
        (${freshAfterDriftRun}, ${companyA}, ${agentA}, 'queued'),
        (${companyBRun}, ${companyB}, ${agentB}, 'queued')
    `;

    const legacyRows = await sql<{ run_id: string; profile_id: string | null }[]>`
      SELECT r."id" AS "run_id", p."id" AS "profile_id"
      FROM "heartbeat_runs" r
      LEFT JOIN "heartbeat_run_execution_profiles" p ON p."run_id" = r."id"
      WHERE r."id" = ${legacyRun}
    `;
    expect(legacyRows).toEqual([{ run_id: legacyRun, profile_id: null }]);

    const validProfile = randomUUID();
    await sql`
      INSERT INTO "heartbeat_run_execution_profiles" (
        "id", "company_id", "run_id", "agent_id", "issue_id", "binding_version",
        "agent_execution_profile_revision", "issue_assignee_profile_revision",
        "digest", "projection", "authority_identity", "authority_fingerprint",
        "transition_kind", "transition_reason"
      ) VALUES (
        ${validProfile}, ${companyA}, ${validRun}, ${agentA}, ${issueA}, 1,
        8, 4, 'digest-valid', '{"version":1}'::jsonb,
        '{"profile":{"adapter":"subscription-only"}}'::jsonb, 'caller-forged',
        'fresh', 'normal_enqueue'
      )
    `;
    const [normalizedAuthority] = await sql<{
      authority_identity: Record<string, unknown>;
      authority_fingerprint: string;
    }[]>`
      SELECT "authority_identity", "authority_fingerprint"
      FROM "heartbeat_run_execution_profiles" WHERE "id" = ${validProfile}
    `;
    expect(normalizedAuthority?.authority_identity).toMatchObject({
      schema: "paperclip.execution-profile-authority",
      version: 1,
      companyId: companyA,
      agentId: agentA,
      issueId: issueA,
      agentExecutionProfileRevision: 8,
      issueAssigneeProfileRevision: 4,
      profile: { adapter: "subscription-only" },
    });
    expect(normalizedAuthority?.authority_fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(normalizedAuthority?.authority_fingerprint).not.toBe("caller-forged");

    await expectPostgresCode(sql`
      INSERT INTO "heartbeat_run_execution_profiles" (
        "company_id", "run_id", "agent_id", "binding_version", "agent_execution_profile_revision",
        "digest", "projection", "authority_identity", "authority_fingerprint", "transition_kind", "transition_reason"
      ) VALUES (${companyA}, ${foreignAgentRun}, ${agentB}, 1, 1, 'foreign-agent', '{}'::jsonb, '{"profile":{}}'::jsonb, 'ignored', 'fresh', 'normal_enqueue')
    `, "23503");
    await expectPostgresCode(sql`
      INSERT INTO "heartbeat_run_execution_profiles" (
        "company_id", "run_id", "agent_id", "binding_version", "agent_execution_profile_revision",
        "digest", "projection", "authority_identity", "authority_fingerprint", "transition_kind", "transition_reason"
      ) VALUES (${companyA}, ${sameCompanyWrongAgentRun}, ${agentA2}, 1, 1, 'wrong-agent', '{}'::jsonb, '{"profile":{}}'::jsonb, 'ignored', 'fresh', 'normal_enqueue')
    `, "23503");
    await expectPostgresCode(sql`
      INSERT INTO "heartbeat_run_execution_profiles" (
        "company_id", "run_id", "agent_id", "issue_id", "binding_version", "agent_execution_profile_revision",
        "digest", "projection", "authority_identity", "authority_fingerprint", "transition_kind", "transition_reason"
      ) VALUES (${companyA}, ${foreignIssueRun}, ${agentA}, ${issueB}, 1, 8, 'foreign-issue', '{}'::jsonb, '{"profile":{}}'::jsonb, 'ignored', 'fresh', 'normal_enqueue')
    `, "23503");
    await expectPostgresCode(sql`
      INSERT INTO "heartbeat_run_execution_profiles" (
        "company_id", "run_id", "agent_id", "binding_version", "agent_execution_profile_revision",
        "digest", "projection", "authority_identity", "authority_fingerprint", "transition_kind", "transition_reason"
      ) VALUES (${companyA}, ${companyBRun}, ${agentA}, 1, 8, 'foreign-run', '{}'::jsonb, '{"profile":{}}'::jsonb, 'ignored', 'fresh', 'normal_enqueue')
    `, "23503");
    await expectPostgresCode(sql`
      INSERT INTO "heartbeat_run_execution_profiles" (
        "company_id", "run_id", "agent_id", "binding_version", "agent_execution_profile_revision",
        "digest", "projection", "authority_identity", "authority_fingerprint", "transition_kind", "transition_reason"
      ) VALUES (${companyA}, ${forgedRevisionRun}, ${agentA}, 1, 7, 'forged-revision', '{}'::jsonb, '{"profile":{}}'::jsonb, 'ignored', 'fresh', 'normal_enqueue')
    `, "23514");
    await expectPostgresCode(sql`
      INSERT INTO "heartbeat_run_execution_profiles" (
        "company_id", "run_id", "agent_id", "binding_version", "agent_execution_profile_revision",
        "issue_assignee_profile_revision", "digest", "projection", "authority_identity", "authority_fingerprint",
        "transition_kind", "transition_reason"
      ) VALUES (${companyA}, ${issueShapeRun}, ${agentA}, 1, 8, 4, 'issue-shape', '{}'::jsonb, '{"profile":{}}'::jsonb, 'ignored', 'fresh', 'normal_enqueue')
    `, "23514");
    await expectPostgresCode(sql`
      INSERT INTO "heartbeat_run_execution_profiles" (
        "company_id", "run_id", "agent_id", "issue_id", "binding_version", "agent_execution_profile_revision",
        "digest", "projection", "authority_identity", "authority_fingerprint", "transition_kind", "transition_reason"
      ) VALUES (${companyA}, ${issueShapeRun}, ${agentA}, ${issueA}, 1, 8, 'issue-shape', '{}'::jsonb, '{"profile":{}}'::jsonb, 'ignored', 'fresh', 'normal_enqueue')
    `, "23514");
    await expectPostgresCode(sql`
      INSERT INTO "heartbeat_run_execution_profiles" (
        "company_id", "run_id", "agent_id", "issue_id", "binding_version", "agent_execution_profile_revision",
        "issue_assignee_profile_revision", "digest", "projection", "authority_identity", "authority_fingerprint",
        "transition_kind", "transition_reason"
      ) VALUES (${companyA}, ${issueShapeRun}, ${agentA}, ${issueA}, 1, 8, 3, 'forged-issue-revision', '{}'::jsonb, '{"profile":{}}'::jsonb, 'ignored', 'fresh', 'normal_enqueue')
    `, "23514");

    await expectPostgresCode(sql`
      UPDATE "heartbeat_run_execution_profiles" SET "digest" = 'forged' WHERE "id" = ${validProfile}
    `, "23514");
    await expectPostgresCode(sql`
      UPDATE "heartbeat_run_execution_profiles" SET "attempt_token" = gen_random_uuid() WHERE "id" = ${validProfile}
    `, "23514");
    await expectPostgresCode(sql`
      UPDATE "heartbeat_run_execution_profiles" SET "authority_identity" = '{"profile":{"forged":true}}'::jsonb WHERE "id" = ${validProfile}
    `, "23514");
    await sql`
      UPDATE "heartbeat_run_execution_profiles"
      SET "validated_at" = now(), "updated_at" = now()
      WHERE "id" = ${validProfile}
    `;
    const [validated] = await sql<{ validated: boolean }[]>`
      SELECT "validated_at" IS NOT NULL AS "validated"
      FROM "heartbeat_run_execution_profiles" WHERE "id" = ${validProfile}
    `;
    expect(validated?.validated).toBe(true);

    const parentProfile = randomUUID();
    await sql`
      INSERT INTO "heartbeat_run_execution_profiles" (
        "id", "company_id", "run_id", "agent_id", "binding_version", "agent_execution_profile_revision",
        "digest", "projection", "authority_identity", "authority_fingerprint", "transition_kind", "transition_reason"
      ) VALUES (${parentProfile}, ${companyA}, ${parentRun}, ${agentA}, 1, 8, 'parent', '{}'::jsonb, '{"profile":{"adapter":"subscription-only"}}'::jsonb, 'ignored', 'fresh', 'normal_enqueue')
    `;
    await sql`
      INSERT INTO "heartbeat_run_execution_profiles" (
        "company_id", "run_id", "agent_id", "binding_version", "agent_execution_profile_revision",
        "digest", "projection", "authority_identity", "authority_fingerprint",
        "transition_kind", "transition_reason", "parent_run_id", "parent_profile_id"
      ) VALUES (
        ${companyA}, ${childRun}, ${agentA}, 1, 8, 'child', '{}'::jsonb,
        '{"profile":{"adapter":"subscription-only"}}'::jsonb, 'ignored',
        'preserve', 'process_loss', ${parentRun}, ${parentProfile}
      )
    `;
    const preservedFingerprints = await sql<{ authority_fingerprint: string }[]>`
      SELECT "authority_fingerprint"
      FROM "heartbeat_run_execution_profiles"
      WHERE "run_id" IN (${parentRun}, ${childRun})
      ORDER BY "run_id"
    `;
    expect(new Set(preservedFingerprints.map((row) => row.authority_fingerprint)).size).toBe(1);
    await expectPostgresCode(sql`
      INSERT INTO "heartbeat_run_execution_profiles" (
        "company_id", "run_id", "agent_id", "binding_version", "agent_execution_profile_revision",
        "digest", "projection", "authority_identity", "authority_fingerprint",
        "transition_kind", "transition_reason", "parent_run_id", "parent_profile_id"
      ) VALUES (
        ${companyA}, ${invalidShapeRun}, ${agentA}, 1, 8, 'bad-shape', '{}'::jsonb,
        '{"profile":{"adapter":"subscription-only"}}'::jsonb, 'ignored',
        'fresh', 'normal_enqueue', ${parentRun}, ${parentProfile}
      )
    `, "23514");
    await expectPostgresCode(sql`
      INSERT INTO "heartbeat_run_execution_profiles" (
        "company_id", "run_id", "agent_id", "binding_version", "agent_execution_profile_revision",
        "digest", "projection", "authority_identity", "authority_fingerprint",
        "transition_kind", "transition_reason", "parent_run_id", "parent_profile_id"
      ) VALUES (
        ${companyA}, ${mismatchRun}, ${agentA}, 1, 8, 'bad-parent', '{}'::jsonb,
        '{"profile":{"adapter":"subscription-only"}}'::jsonb, 'ignored',
        'preserve', 'process_loss', ${validRun}, ${parentProfile}
      )
    `, "23503");
    await expectPostgresCode(sql`
      INSERT INTO "heartbeat_run_execution_profiles" (
        "company_id", "run_id", "agent_id", "binding_version", "agent_execution_profile_revision",
        "digest", "projection", "authority_identity", "authority_fingerprint",
        "transition_kind", "transition_reason", "parent_run_id", "parent_profile_id"
      ) VALUES (
        ${companyA}, ${mismatchAuthorityRun}, ${agentA}, 1, 8, 'bad-authority', '{}'::jsonb,
        '{"profile":{"adapter":"different"}}'::jsonb, 'ignored',
        'preserve', 'process_loss', ${parentRun}, ${parentProfile}
      )
    `, "23514");
    await expectPostgresCode(sql`
      INSERT INTO "heartbeat_run_execution_profiles" (
        "company_id", "run_id", "agent_id", "binding_version", "agent_execution_profile_revision",
        "digest", "projection", "authority_identity", "authority_fingerprint", "transition_kind", "transition_reason"
      ) VALUES (${companyA}, ${invalidShapeRun}, ${agentA}, 1, 8, 'bad-reason', '{}'::jsonb, '{"profile":{}}'::jsonb, 'ignored', 'fresh', 'process_loss')
    `, "23514");
    await expectPostgresCode(sql`
      INSERT INTO "heartbeat_run_execution_profiles" (
        "company_id", "run_id", "agent_id", "binding_version", "agent_execution_profile_revision",
        "digest", "projection", "authority_identity", "authority_fingerprint", "transition_kind", "transition_reason"
      ) VALUES (${companyA}, ${invalidShapeRun}, ${agentA}, 1, 8, 'bad-kind', '{}'::jsonb, '{"profile":{}}'::jsonb, 'ignored', 'unknown', 'normal_enqueue')
    `, "23514");

    const driftParentProfile = randomUUID();
    await sql`
      INSERT INTO "heartbeat_run_execution_profiles" (
        "id", "company_id", "run_id", "agent_id", "issue_id", "binding_version",
        "agent_execution_profile_revision", "issue_assignee_profile_revision",
        "digest", "projection", "authority_identity", "authority_fingerprint",
        "transition_kind", "transition_reason"
      ) VALUES (
        ${driftParentProfile}, ${companyA}, ${driftParentRun}, ${agentA}, ${issueA}, 1,
        8, 4, 'drift-parent', '{}'::jsonb, '{"profile":{"adapter":"drift-test"}}'::jsonb,
        'ignored', 'fresh', 'normal_enqueue'
      )
    `;
    await sql`
      UPDATE "agents"
      SET "permissions" = '{"tools":["read","write"]}'::jsonb
      WHERE "id" = ${agentA}
    `;
    await sql`
      UPDATE "issues"
      SET "assignee_adapter_overrides" = '{"modelProfile":"cheap","adapterConfig":{"model":"new"}}'::jsonb
      WHERE "id" = ${issueA}
    `;
    expect(await readAgentRevision()).toBe(9);
    expect(await readIssueRevision()).toBe(5);

    await sql`
      INSERT INTO "heartbeat_run_execution_profiles" (
        "company_id", "run_id", "agent_id", "issue_id", "binding_version",
        "agent_execution_profile_revision", "issue_assignee_profile_revision",
        "digest", "projection", "authority_identity", "authority_fingerprint",
        "transition_kind", "transition_reason", "parent_run_id", "parent_profile_id"
      ) VALUES (
        ${companyA}, ${preserveAfterDriftRun}, ${agentA}, ${issueA}, 1,
        8, 4, 'preserved-after-drift', '{}'::jsonb, '{"profile":{"adapter":"drift-test"}}'::jsonb,
        'ignored', 'preserve', 'process_loss', ${driftParentRun}, ${driftParentProfile}
      )
    `;
    const [preservedAfterDrift] = await sql<{
      agent_revision: string;
      issue_revision: string;
    }[]>`
      SELECT
        "agent_execution_profile_revision"::text AS "agent_revision",
        "issue_assignee_profile_revision"::text AS "issue_revision"
      FROM "heartbeat_run_execution_profiles"
      WHERE "run_id" = ${preserveAfterDriftRun}
    `;
    expect(preservedAfterDrift).toEqual({ agent_revision: "8", issue_revision: "4" });

    await expectPostgresCode(sql`
      INSERT INTO "heartbeat_run_execution_profiles" (
        "company_id", "run_id", "agent_id", "issue_id", "binding_version",
        "agent_execution_profile_revision", "issue_assignee_profile_revision",
        "digest", "projection", "authority_identity", "authority_fingerprint",
        "transition_kind", "transition_reason"
      ) VALUES (
        ${companyA}, ${freshAfterDriftRun}, ${agentA}, ${issueA}, 1,
        8, 4, 'fresh-stale-after-drift', '{}'::jsonb, '{"profile":{"adapter":"drift-test"}}'::jsonb,
        'ignored', 'fresh', 'normal_enqueue'
      )
    `, "23514");

    await expectPostgresCode(sql`
      DELETE FROM "heartbeat_run_execution_profiles" WHERE "id" = ${validProfile}
    `, "23514");
    await sql`DELETE FROM "heartbeat_runs" WHERE "id" = ${validRun}`;
    const [cascaded] = await sql<{ count: number }[]>`
      SELECT count(*)::int AS "count"
      FROM "heartbeat_run_execution_profiles" WHERE "id" = ${validProfile}
    `;
    expect(cascaded?.count).toBe(0);
    await sql`DELETE FROM "heartbeat_runs" WHERE "id" = ${legacyRun}`;

    const [authorityTrigger] = await sql<{ definition: string }[]>`
      SELECT pg_get_functiondef(p.oid) AS "definition"
      FROM pg_proc p
      WHERE p.proname = 'reject_heartbeat_run_execution_profile_authority_update'
    `;
    for (const column of [
      "company_id", "run_id", "agent_id", "issue_id", "binding_version",
      "agent_execution_profile_revision", "issue_assignee_profile_revision", "digest",
      "attempt_token", "projection", "authority_identity", "authority_fingerprint",
      "transition_kind", "transition_reason",
      "parent_run_id", "parent_profile_id", "created_at",
    ]) {
      expect(authorityTrigger?.definition).toContain(column);
    }
  }, 45_000);

  it("upgrades pre-0228 rows with revision defaults while leaving legacy runs unbound", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-execution-profiles-upgrade-");
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    cleanups.push(async () => sql.end());

    await sql`DELETE FROM "drizzle"."__drizzle_migrations" WHERE "hash" = ${await migrationHash()}`;
    await sql`DROP TABLE "heartbeat_run_execution_profiles" CASCADE`;
    await sql`DROP FUNCTION IF EXISTS enforce_heartbeat_run_execution_profile_insert() CASCADE`;
    await sql`DROP FUNCTION IF EXISTS reject_heartbeat_run_execution_profile_authority_update() CASCADE`;
    await sql`DROP TRIGGER IF EXISTS "agents_bump_execution_profile_revision" ON "agents"`;
    await sql`DROP FUNCTION IF EXISTS bump_agent_execution_profile_revision()`;
    await sql`DROP TRIGGER IF EXISTS "issues_bump_assignee_profile_revision" ON "issues"`;
    await sql`DROP FUNCTION IF EXISTS bump_issue_assignee_profile_revision()`;
    await sql`DROP INDEX IF EXISTS "agents_scoped_identity_uq"`;
    await sql`DROP INDEX IF EXISTS "heartbeat_runs_scoped_identity_uq"`;
    await sql`DROP INDEX IF EXISTS "heartbeat_runs_scoped_agent_identity_uq"`;
    await sql`ALTER TABLE "agents" DROP COLUMN "execution_profile_revision"`;
    await sql`ALTER TABLE "issues" DROP COLUMN "assignee_profile_revision"`;

    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    await sql`
      INSERT INTO "companies" ("id", "name", "issue_prefix")
      VALUES (${companyId}, 'Pre-0228 company', 'PRE')
    `;
    await sql`
      INSERT INTO "agents" ("id", "company_id", "name", "role", "adapter_type")
      VALUES (${agentId}, ${companyId}, 'Pre-0228 agent', 'general', 'process')
    `;
    await sql`
      INSERT INTO "issues" ("id", "company_id", "title", "identifier", "assignee_agent_id")
      VALUES (${issueId}, ${companyId}, 'Pre-0228 issue', 'PRE-1', ${agentId})
    `;
    await sql`
      INSERT INTO "heartbeat_runs" ("id", "company_id", "agent_id", "status")
      VALUES (${runId}, ${companyId}, ${agentId}, 'queued')
    `;

    await expect(applyPendingMigrations(database.connectionString)).resolves.toBeUndefined();

    const [upgraded] = await sql<{
      agent_revision: string;
      issue_revision: string;
      sidecars: number;
      run_exists: boolean;
    }[]>`
      SELECT
        (SELECT "execution_profile_revision"::text FROM "agents" WHERE "id" = ${agentId}) AS "agent_revision",
        (SELECT "assignee_profile_revision"::text FROM "issues" WHERE "id" = ${issueId}) AS "issue_revision",
        (SELECT count(*)::int FROM "heartbeat_run_execution_profiles") AS "sidecars",
        EXISTS(SELECT 1 FROM "heartbeat_runs" WHERE "id" = ${runId}) AS "run_exists"
    `;
    expect(upgraded).toEqual({
      agent_revision: "1",
      issue_revision: "1",
      sidecars: 0,
      run_exists: true,
    });

    await sql`UPDATE "agents" SET "adapter_type" = 'claude_local', "execution_profile_revision" = 999 WHERE "id" = ${agentId}`;
    const [revisionAfterUpdate] = await sql<{ revision: string }[]>`
      SELECT "execution_profile_revision"::text AS "revision" FROM "agents" WHERE "id" = ${agentId}
    `;
    expect(revisionAfterUpdate?.revision).toBe("2");
  }, 45_000);
});
