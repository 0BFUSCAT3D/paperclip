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

async function migrationHash(): Promise<string> {
  const content = await fs.promises.readFile(new URL(`./migrations/${MIGRATION_FILE}`, import.meta.url), "utf8");
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
