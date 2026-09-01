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
const MIGRATION_FILE = "0229_normal_gertrude_yorkes.sql";
const WORKSPACE_CONSTRAINT_MIGRATION_FILE = "0232_last_jetstream.sql";
const RETIREMENT_MIGRATION_FILE = "0233_large_morlun.sql";

async function migrationHash(file = MIGRATION_FILE): Promise<string> {
  const content = await fs.promises.readFile(new URL(`./migrations/${file}`, import.meta.url), "utf8");
  return createHash("sha256").update(content).digest("hex");
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

describeEmbeddedPostgres("governed issue reservation version 2 migration", () => {
  it("adds durable retirement state and releases the pending-activation guard only after retirement", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-governed-retirement-upgrade-");
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    cleanups.push(async () => sql.end());

    await sql`DELETE FROM "drizzle"."__drizzle_migrations" WHERE "hash" = ${await migrationHash(RETIREMENT_MIGRATION_FILE)}`;
    await sql`DROP TRIGGER IF EXISTS "governed_issue_reservation_retirement_immutable" ON "governed_issue_reservations"`;
    await sql`DROP FUNCTION IF EXISTS enforce_governed_issue_reservation_retirement_immutable()`;
    await sql`ALTER TABLE "governed_issue_reservations" DROP CONSTRAINT "governed_issue_reservations_retirement_shape_check"`;
    await sql`ALTER TABLE "governed_issue_reservations" DROP COLUMN "retirement_sha256"`;
    await sql`ALTER TABLE "governed_issue_reservations" DROP COLUMN "retirement_receipt"`;
    await sql`ALTER TABLE "governed_issue_reservations" DROP COLUMN "retired_at"`;

    await expect(applyPendingMigrations(database.connectionString)).resolves.toBeUndefined();

    const companyId = randomUUID();
    const issueId = randomUUID();
    const reservationId = randomUUID();
    await sql`
      INSERT INTO "companies" ("id", "name", "issue_prefix")
      VALUES (${companyId}, 'Retirement migration', 'RET')
    `;
    await sql`
      INSERT INTO "issues" ("id", "company_id", "title", "identifier", "status")
      VALUES (${issueId}, ${companyId}, 'Retirable reservation', 'RET-1', 'backlog')
    `;
    await sql`
      INSERT INTO "governed_issue_reservations" (
        "id", "company_id", "idempotency_key", "issue_id", "contract_version",
        "request_intent_sha256", "envelope_sha256", "envelope",
        "execution_profile_intent_sha256", "execution_profile_intent",
        "reserved_issue_snapshot", "reserved_issue_updated_at"
      ) VALUES (
        ${reservationId}, ${companyId}, 'retirement-migration', ${issueId}, 2,
        ${"a".repeat(64)}, ${"b".repeat(64)}, '{}'::jsonb,
        ${"c".repeat(64)}, '{}'::jsonb, '{}'::jsonb, now()
      )
    `;

    await expectPostgresCode(sql`
      UPDATE "governed_issue_reservations"
      SET "retirement_sha256" = ${"d".repeat(64)}
      WHERE "id" = ${reservationId}
    `, "23514");
    await expectPostgresCode(sql`
      UPDATE "issues" SET "title" = 'still guarded' WHERE "id" = ${issueId}
    `, "55000");

    await sql`
      UPDATE "governed_issue_reservations"
      SET "retirement_sha256" = ${"d".repeat(64)},
        "retirement_receipt" = '{}'::jsonb,
        "retired_at" = now()
      WHERE "id" = ${reservationId}
    `;
    await expect(sql`
      UPDATE "issues" SET "status" = 'cancelled' WHERE "id" = ${issueId}
    `).resolves.toBeDefined();
    await expectPostgresCode(sql`
      UPDATE "governed_issue_reservations"
      SET "retirement_receipt" = '{"changed":true}'::jsonb
      WHERE "id" = ${reservationId}
    `, "55000");
    await expectPostgresCode(sql`
      UPDATE "governed_issue_reservations"
      SET "envelope_sha256" = ${"e".repeat(64)}
      WHERE "id" = ${reservationId}
    `, "55000");
    await expectPostgresCode(sql`
      UPDATE "governed_issue_reservations"
      SET "idempotency_key" = 'retirement-migration-drifted'
      WHERE "id" = ${reservationId}
    `, "55000");
    await expectPostgresCode(sql`
      UPDATE "governed_issue_reservations"
      SET "activated_at" = now()
      WHERE "id" = ${reservationId}
    `, "55000");
    await expectPostgresCode(sql`
      UPDATE "governed_issue_reservations"
      SET "retired_at" = NULL, "retirement_sha256" = NULL, "retirement_receipt" = NULL
      WHERE "id" = ${reservationId}
    `, "55000");
  }, 45_000);

  it("clears legacy version 1 workspace bindings before enforcing v2-only ownership", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-governed-workspace-upgrade-");
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    cleanups.push(async () => sql.end());

    await sql`DELETE FROM "drizzle"."__drizzle_migrations" WHERE "hash" = ${await migrationHash(WORKSPACE_CONSTRAINT_MIGRATION_FILE)}`;
    await sql`ALTER TABLE "governed_issue_reservations" DROP CONSTRAINT "governed_issue_reservations_version_shape_check"`;
    await sql.unsafe(`
      ALTER TABLE "governed_issue_reservations"
      ADD CONSTRAINT "governed_issue_reservations_version_shape_check" CHECK ((
        "contract_version" = 1
        AND "execution_profile_intent_sha256" IS NULL
        AND "execution_profile_intent" IS NULL
        AND "execution_profile_receipt" IS NULL
      ) OR (
        "contract_version" = 2
        AND "execution_profile_intent_sha256" IS NOT NULL
        AND "execution_profile_intent" IS NOT NULL
        AND (("activated_at" IS NULL AND "execution_profile_receipt" IS NULL)
          OR ("activated_at" IS NOT NULL AND "execution_profile_receipt" IS NOT NULL))
      ))
    `);

    const companyId = randomUUID();
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const executionWorkspaceId = randomUUID();
    const issueId = randomUUID();
    const reservationId = randomUUID();
    await sql`INSERT INTO "companies" ("id", "name", "issue_prefix") VALUES (${companyId}, 'Workspace migration', 'WSP')`;
    await sql`INSERT INTO "projects" ("id", "company_id", "name") VALUES (${projectId}, ${companyId}, 'Project')`;
    await sql`
      INSERT INTO "project_workspaces" ("id", "company_id", "project_id", "name", "source_type", "cwd", "is_primary")
      VALUES (${projectWorkspaceId}, ${companyId}, ${projectId}, 'Primary', 'local_path', '/tmp/project', true)
    `;
    await sql`
      INSERT INTO "issues" ("id", "company_id", "project_id", "project_workspace_id", "title", "identifier", "status")
      VALUES (${issueId}, ${companyId}, ${projectId}, ${projectWorkspaceId}, 'Legacy reservation', 'WSP-1', 'backlog')
    `;
    await sql`
      INSERT INTO "execution_workspaces" (
        "id", "company_id", "project_id", "project_workspace_id", "mode", "strategy_type", "name"
      ) VALUES (
        ${executionWorkspaceId}, ${companyId}, ${projectId}, ${projectWorkspaceId},
        'isolated_workspace', 'git_worktree', 'Legacy workspace'
      )
    `;
    await sql`
      INSERT INTO "governed_issue_reservations" (
        "id", "company_id", "idempotency_key", "issue_id", "contract_version",
        "request_intent_sha256", "envelope_sha256", "envelope", "reserved_issue_snapshot",
        "reserved_issue_updated_at", "execution_workspace_id"
      ) VALUES (
        ${reservationId}, ${companyId}, 'legacy-v1-workspace', ${issueId}, 1,
        ${"a".repeat(64)}, ${"b".repeat(64)}, '{}'::jsonb, '{}'::jsonb, now(), ${executionWorkspaceId}
      )
    `;

    await expect(applyPendingMigrations(database.connectionString)).resolves.toBeUndefined();
    const [migrated] = await sql<{ execution_workspace_id: string | null }[]>`
      SELECT "execution_workspace_id" FROM "governed_issue_reservations" WHERE "id" = ${reservationId}
    `;
    expect(migrated?.execution_workspace_id).toBeNull();
    await expectPostgresCode(sql`
      UPDATE "governed_issue_reservations"
      SET "execution_workspace_id" = ${executionWorkspaceId}
      WHERE "id" = ${reservationId}
    `, "23514");
  });

  it("preserves version 1 rows and enforces the version 2 intent and receipt lifecycle", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-governed-v2-upgrade-");
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    cleanups.push(async () => sql.end());

    await sql`DELETE FROM "drizzle"."__drizzle_migrations" WHERE "hash" = ${await migrationHash()}`;
    await sql`ALTER TABLE "governed_issue_reservations" DROP CONSTRAINT "governed_issue_reservations_version_shape_check"`;
    await sql`DROP TRIGGER IF EXISTS "heartbeat_run_execution_profiles_enforce_preserved_payload" ON "heartbeat_run_execution_profiles"`;
    await sql`DROP FUNCTION IF EXISTS enforce_heartbeat_run_execution_profile_preserved_payload()`;
    await sql`ALTER TABLE "governed_issue_reservations" DROP COLUMN "execution_profile_intent_sha256"`;
    await sql`ALTER TABLE "governed_issue_reservations" DROP COLUMN "execution_profile_intent"`;
    await sql`ALTER TABLE "governed_issue_reservations" DROP COLUMN "execution_profile_receipt"`;

    const companyId = randomUUID();
    const issueId = randomUUID();
    const reservationId = randomUUID();
    await sql`
      INSERT INTO "companies" ("id", "name", "issue_prefix")
      VALUES (${companyId}, 'Governed migration', 'GOV')
    `;
    await sql`
      INSERT INTO "issues" ("id", "company_id", "title", "identifier", "status")
      VALUES (${issueId}, ${companyId}, 'Legacy governed reservation', 'GOV-1', 'backlog')
    `;
    await sql`
      INSERT INTO "governed_issue_reservations" (
        "id", "company_id", "idempotency_key", "issue_id", "contract_version",
        "request_intent_sha256", "envelope_sha256", "envelope",
        "reserved_issue_snapshot", "reserved_issue_updated_at"
      ) VALUES (
        ${reservationId}, ${companyId}, 'legacy-v1', ${issueId}, 1,
        ${"a".repeat(64)}, ${"b".repeat(64)}, '{}'::jsonb,
        '{}'::jsonb, now()
      )
    `;

    await expect(applyPendingMigrations(database.connectionString)).resolves.toBeUndefined();
    const [legacy] = await sql<{
      contract_version: number;
      execution_profile_intent_sha256: string | null;
      execution_profile_intent: unknown;
      execution_profile_receipt: unknown;
    }[]>`
      SELECT "contract_version", "execution_profile_intent_sha256",
        "execution_profile_intent", "execution_profile_receipt"
      FROM "governed_issue_reservations" WHERE "id" = ${reservationId}
    `;
    expect(legacy).toEqual({
      contract_version: 1,
      execution_profile_intent_sha256: null,
      execution_profile_intent: null,
      execution_profile_receipt: null,
    });

    const v2IssueId = randomUUID();
    await sql`
      INSERT INTO "issues" ("id", "company_id", "title", "identifier", "status")
      VALUES (${v2IssueId}, ${companyId}, 'Version 2 governed reservation', 'GOV-2', 'backlog')
    `;
    await expectPostgresCode(sql`
      INSERT INTO "governed_issue_reservations" (
        "company_id", "idempotency_key", "issue_id", "contract_version",
        "request_intent_sha256", "envelope_sha256", "envelope",
        "reserved_issue_snapshot", "reserved_issue_updated_at"
      ) VALUES (
        ${companyId}, 'invalid-v2', ${v2IssueId}, 2,
        ${"c".repeat(64)}, ${"d".repeat(64)}, '{}'::jsonb,
        '{}'::jsonb, now()
      )
    `, "23514");

    const v2ReservationId = randomUUID();
    await sql`
      INSERT INTO "governed_issue_reservations" (
        "id", "company_id", "idempotency_key", "issue_id", "contract_version",
        "request_intent_sha256", "envelope_sha256", "envelope",
        "execution_profile_intent_sha256", "execution_profile_intent",
        "reserved_issue_snapshot", "reserved_issue_updated_at"
      ) VALUES (
        ${v2ReservationId}, ${companyId}, 'valid-v2', ${v2IssueId}, 2,
        ${"e".repeat(64)}, ${"f".repeat(64)}, '{}'::jsonb,
        ${"0".repeat(64)}, '{"builderAgentId":"11111111-1111-4111-8111-111111111111"}'::jsonb,
        '{}'::jsonb, now()
      )
    `;
    await expectPostgresCode(sql`
      UPDATE "governed_issue_reservations" SET "activated_at" = now()
      WHERE "id" = ${v2ReservationId}
    `, "23514");
    await expect(sql`
      UPDATE "governed_issue_reservations"
      SET "activated_at" = now(), "execution_profile_receipt" = '{"version":2}'::jsonb
      WHERE "id" = ${v2ReservationId}
    `).resolves.toBeDefined();

    const agentId = randomUUID();
    const parentRunId = randomUUID();
    const changedDigestRunId = randomUUID();
    const changedProjectionRunId = randomUUID();
    const exactPreserveRunId = randomUUID();
    await sql`
      INSERT INTO "agents" ("id", "company_id", "name", "role", "adapter_type")
      VALUES (${agentId}, ${companyId}, 'Preserved profile agent', 'engineer', 'codex_local')
    `;
    for (const runId of [parentRunId, changedDigestRunId, changedProjectionRunId, exactPreserveRunId]) {
      await sql`
        INSERT INTO "heartbeat_runs" (
          "id", "company_id", "agent_id", "invocation_source", "status", "context_snapshot"
        ) VALUES (${runId}, ${companyId}, ${agentId}, 'assignment', 'queued', '{}'::jsonb)
      `;
    }
    const parentProfileId = randomUUID();
    const projection = { policy: "subscription_only", model: "reviewed" };
    const authority = { profile: { adapter: "codex_local", account: "opaque" } };
    await sql`
      INSERT INTO "heartbeat_run_execution_profiles" (
        "id", "company_id", "run_id", "agent_id", "binding_version",
        "agent_execution_profile_revision", "digest", "projection", "authority_identity",
        "authority_fingerprint", "transition_kind", "transition_reason"
      ) VALUES (
        ${parentProfileId}, ${companyId}, ${parentRunId}, ${agentId}, 1,
        1, ${"1".repeat(64)}, ${sql.json(projection)}, ${sql.json(authority)},
        'database-owned', 'fresh', 'normal_enqueue'
      )
    `;
    const insertPreserved = (
      runId: string,
      digest: string,
      payload: { policy: string; model: string },
    ) => sql`
      INSERT INTO "heartbeat_run_execution_profiles" (
        "company_id", "run_id", "agent_id", "binding_version",
        "agent_execution_profile_revision", "digest", "projection", "authority_identity",
        "authority_fingerprint", "transition_kind", "transition_reason",
        "parent_run_id", "parent_profile_id"
      ) VALUES (
        ${companyId}, ${runId}, ${agentId}, 1, 1, ${digest}, ${sql.json(payload)},
        ${sql.json(authority)}, 'database-owned', 'preserve', 'process_loss',
        ${parentRunId}, ${parentProfileId}
      )
    `;
    await expectPostgresCode(
      insertPreserved(changedDigestRunId, "2".repeat(64), projection),
      "23514",
    );
    await expectPostgresCode(
      insertPreserved(changedProjectionRunId, "1".repeat(64), { ...projection, model: "changed" }),
      "23514",
    );
    await expect(insertPreserved(exactPreserveRunId, "1".repeat(64), projection))
      .resolves.toBeDefined();
  }, 45_000);
});
