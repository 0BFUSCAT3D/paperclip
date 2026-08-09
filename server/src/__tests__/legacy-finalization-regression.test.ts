import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  agents,
  companies,
  completionContracts,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  nativeRunFinalizations,
  nativeRunResults,
  statusDecisions,
  workAssessments,
} from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { reconcileNativeFinalizations } from "../services/native-runtime/native-finalization-reconciler.js";

describe("P6-32 legacy finalization regression", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const companyId = "71000000-0000-4000-8000-000000000001";
  const agentId = "71000000-0000-4000-8000-000000000002";
  const runId = "71000000-0000-4000-8000-000000000003";

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-native-legacy-");
    db = createDb(temporary.connectionString);
    await db.insert(companies).values({ id: companyId, name: "Legacy snapshot", issuePrefix: "LGC" });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Legacy agent",
      adapterType: "codex_local",
      status: "idle",
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "succeeded",
      runtimeMode: "legacy",
      nextEventSeq: 8,
      exitCode: 0,
      resultJson: { summary: "Legacy bytes", nested: { count: 1, ok: true } },
      contextSnapshot: { issueId: "legacy-opaque-issue" },
    });
    await db.insert(heartbeatRunEvents).values({
      companyId,
      runId,
      agentId,
      seq: 7,
      eventType: "lifecycle",
      stream: "system",
      message: "Legacy event bytes",
      payload: { state: "completed", nested: [1, "two", false] },
    });
  }, 30_000);

  afterAll(async () => {
    await temporary.cleanup();
  });

  it("keeps the post-kill-switch legacy read snapshot byte-equivalent with zero native rows", async () => {
    const beforeRun = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    const beforeEvents = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, runId));
    const beforeBytes = JSON.stringify({ run: beforeRun, events: beforeEvents });

    await expect(reconcileNativeFinalizations(db, [runId])).resolves.toEqual([]);

    const afterRun = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    const afterEvents = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, runId));
    expect(JSON.stringify({ run: afterRun, events: afterEvents })).toBe(beforeBytes);
    await expect(db.select().from(completionContracts).where(eq(completionContracts.companyId, companyId))).resolves.toHaveLength(0);
    await expect(db.select().from(nativeRunResults).where(eq(nativeRunResults.runId, runId))).resolves.toHaveLength(0);
    await expect(db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, runId))).resolves.toHaveLength(0);
    await expect(db.select().from(workAssessments).where(eq(workAssessments.runId, runId))).resolves.toHaveLength(0);
    await expect(db.select().from(statusDecisions)
      .where(eq(statusDecisions.companyId, companyId))).resolves.toHaveLength(0);
  });
});
