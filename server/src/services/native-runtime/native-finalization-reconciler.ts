import { and, desc, eq, inArray, isNotNull, ne } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRuns, nativeRunFinalizations, workspaceOperations } from "@paperclipai/db";
import { finalizeNativeRun } from "./native-run-finalizer.js";

/** Recovery is keyed only by persisted mode/coordinator state, never the live flag. */
export async function reconcileNativeFinalizations(db: Db, runIds?: string[]) {
  const rows = await db.select({ runId: heartbeatRuns.id })
    .from(heartbeatRuns)
    .innerJoin(nativeRunFinalizations, eq(nativeRunFinalizations.runId, heartbeatRuns.id))
    .where(and(
      eq(heartbeatRuns.runtimeMode, "native"),
      isNotNull(nativeRunFinalizations.resultId),
      ne(nativeRunFinalizations.phase, "applied"),
      ...(runIds && runIds.length > 0 ? [inArray(heartbeatRuns.id, runIds)] : []),
    ));
  const results = [];
  for (const row of rows) {
    const barrier = await db.select({ status: workspaceOperations.status })
      .from(workspaceOperations)
      .where(and(
        eq(workspaceOperations.heartbeatRunId, row.runId),
        eq(workspaceOperations.phase, "workspace_finalize"),
      ))
      .orderBy(desc(workspaceOperations.createdAt))
      .limit(1)
      .then((entries) => entries[0] ?? null);
    if (!barrier || !["succeeded", "failed"].includes(barrier.status)) continue;
    results.push(await finalizeNativeRun({
      db,
      runId: row.runId,
      workspaceFinalizeStatus: barrier.status as "succeeded" | "failed",
      projectRunStatus: true,
    }));
  }
  return results;
}
