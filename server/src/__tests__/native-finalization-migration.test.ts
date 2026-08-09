import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  agents,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
} from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

describe("P6-18 / MIG-01..04 native finalization migration", () => {
  it("repairs only later duplicates and preserves legacy event bytes and cursors", async () => {
    const temporary = await startEmbeddedPostgresTestDatabase("paperclip-native-migration-");
    const db = createDb(temporary.connectionString);
    try {
      const companyId = "10000000-0000-4000-8000-000000000001";
      const agentId = "10000000-0000-4000-8000-000000000002";
      const runId = "10000000-0000-4000-8000-000000000003";
      await db.insert(companies).values({ id: companyId, name: "Migration fixture", issuePrefix: "MIG" });
      await db.insert(agents).values({ id: agentId, companyId, name: "Migration agent" });
      await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "succeeded", nextEventSeq: 1 });
      await db.execute(sql.raw("DROP INDEX heartbeat_run_events_run_seq_uq"));
      await db.insert(heartbeatRunEvents).values([
        { companyId, runId, agentId, seq: 1, eventType: "legacy.start", stream: "system", level: "info", message: "one", payload: { bytes: "α-1" }, createdAt: new Date("2026-08-01T00:00:01.000Z") },
        { companyId, runId, agentId, seq: 5, eventType: "legacy.log", stream: "stdout", level: "info", message: "first-five", payload: { bytes: "β-5a" }, createdAt: new Date("2026-08-01T00:00:02.000Z") },
        { companyId, runId, agentId, seq: 5, eventType: "legacy.log", stream: "stderr", level: "warn", message: "duplicate-five", payload: { bytes: "γ-5b" }, createdAt: new Date("2026-08-01T00:00:03.000Z") },
        { companyId, runId, agentId, seq: 9, eventType: "legacy.end", stream: "system", level: "info", message: "nine", payload: { bytes: "δ-9" }, createdAt: new Date("2026-08-01T00:00:04.000Z") },
      ]);

      const before = await db.select().from(heartbeatRunEvents)
        .where(eq(heartbeatRunEvents.runId, runId)).orderBy(heartbeatRunEvents.id);
      const migration = await readFile(
        new URL("../../../packages/db/src/migrations/0211_famous_guardsmen.sql", import.meta.url),
        "utf8",
      );
      const statements = migration.split("--> statement-breakpoint").map((entry) => entry.trim());
      const duplicateRepair = statements.find((entry) => entry.includes("WITH ranked AS"));
      const allocatorSeed = statements.find((entry) => entry.startsWith('UPDATE "heartbeat_runs" AS run'));
      expect(duplicateRepair).toBeTruthy();
      expect(allocatorSeed).toBeTruthy();
      await db.execute(sql.raw(duplicateRepair!));
      await db.execute(sql.raw(allocatorSeed!));
      await db.execute(sql.raw(
        'CREATE UNIQUE INDEX "heartbeat_run_events_run_seq_uq" ON "heartbeat_run_events" ("run_id", "seq")',
      ));

      const after = await db.select().from(heartbeatRunEvents)
        .where(eq(heartbeatRunEvents.runId, runId)).orderBy(heartbeatRunEvents.id);
      expect(after.map((row) => row.seq)).toEqual([1, 5, 10, 9]);
      expect((await db.select({ nextEventSeq: heartbeatRuns.nextEventSeq }).from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId)))[0]?.nextEventSeq).toBe(11);

      // The repaired duplicate's cursor is the only changed byte-equivalent read field.
      expect(after.map(({ seq: _seq, ...row }) => row)).toEqual(before.map(({ seq: _seq, ...row }) => row));
      expect(after[0]?.seq).toBe(before[0]?.seq);
      expect(after[1]?.seq).toBe(before[1]?.seq);
      expect(after[3]?.seq).toBe(before[3]?.seq);
      await expect(db.insert(heartbeatRunEvents).values({
        companyId, runId, agentId, seq: 5, eventType: "must-conflict",
      })).rejects.toThrow();
    } finally {
      await temporary.cleanup();
    }
  }, 60_000);
});
