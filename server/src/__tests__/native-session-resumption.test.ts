import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueRecoveryActions,
  issues,
  nativeRunFinalizations,
} from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import {
  claimNativeSessionResumptions,
  dispatchNativeSessionResumptions,
} from "../services/native-runtime/native-finalization-reconciler.js";

describe("P6-25 pre-result native session recovery", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;
  const companyId = "79000000-0000-4000-8000-000000000001";
  const agentId = "79000000-0000-4000-8000-000000000002";
  const issueId = "79000000-0000-4000-8000-000000000003";
  const runId = "79000000-0000-4000-8000-000000000004";
  const cancelledRunId = "79000000-0000-4000-8000-000000000005";
  const exhaustedRunId = "79000000-0000-4000-8000-000000000006";
  const missingCheckpointRunId = "79000000-0000-4000-8000-000000000007";
  const initialRunId = "79000000-0000-4000-8000-000000000008";
  const persistedProfile = {
    mode: "native",
    nativeExecutionInput: { schema: "paperclip.native-execution-input.v1", binding: { runId } },
    sessionCheckpoint: {
      backendKind: "codex_app_server",
      sessionId: "persisted-session",
      identity: { runId },
      providerSessionId: "provider-session",
      activeTurnId: "active-turn",
    },
  };

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-native-resume-");
    db = createDb(temporary.connectionString);
    await db.insert(companies).values({ id: companyId, name: "Native resume", issuePrefix: "NRR" });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Native resume agent",
      adapterType: "codex_local",
      status: "running",
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Resume the same native run",
      status: "in_progress",
      assigneeAgentId: agentId,
      workMode: "standard",
    });
    await db.insert(heartbeatRuns).values([
      {
        id: runId,
        companyId,
        agentId,
        status: "running",
        runtimeMode: "native",
        runtimeModeResolvedAt: new Date(),
        runnerProfileJson: persistedProfile,
        contextSnapshot: { issueId },
      },
      {
        id: cancelledRunId,
        companyId,
        agentId,
        status: "cancelled",
        runtimeMode: "native",
        runtimeModeResolvedAt: new Date(),
        runnerProfileJson: persistedProfile,
        contextSnapshot: { issueId },
      },
      {
        id: exhaustedRunId,
        companyId,
        agentId,
        status: "failed",
        runtimeMode: "native",
        runtimeModeResolvedAt: new Date(),
        runnerProfileJson: persistedProfile,
        contextSnapshot: { issueId },
      },
      {
        id: missingCheckpointRunId,
        companyId,
        agentId,
        status: "running",
        runtimeMode: "native",
        runtimeModeResolvedAt: new Date(),
        runnerProfileJson: { nativeExecutionInput: persistedProfile.nativeExecutionInput },
        contextSnapshot: { issueId },
      },
      {
        id: initialRunId,
        companyId,
        agentId,
        status: "running",
        runtimeMode: "native",
        runtimeModeResolvedAt: new Date(),
        runnerProfileJson: { nativeExecutionInput: persistedProfile.nativeExecutionInput },
        contextSnapshot: { issueId },
      },
    ]);
    await db.insert(nativeRunFinalizations).values([
      { runId, companyId, issueId, phase: "retryable_failure", attempt: 1, nextAttemptAt: new Date(0) },
      { runId: cancelledRunId, companyId, issueId, phase: "retryable_failure", attempt: 1, nextAttemptAt: new Date(0) },
      { runId: exhaustedRunId, companyId, issueId, phase: "terminal_failure", attempt: 3 },
      { runId: missingCheckpointRunId, companyId, issueId, phase: "observed", attempt: 1 },
      { runId: initialRunId, companyId, issueId, phase: "observed", attempt: 0 },
    ]);
  }, 30_000);

  afterAll(async () => temporary?.cleanup());

  it("wins one database lease for the original result-less run without consulting the flag", async () => {
    const results = await Promise.all([
      claimNativeSessionResumptions({ db, runnerInstanceId: "reaper-a", runIds: [runId] }),
      claimNativeSessionResumptions({ db, runnerInstanceId: "reaper-b", runIds: [runId] }),
    ]);
    expect(results.flat()).toHaveLength(1);
    expect(results.flat()[0]).toMatchObject({ runId });
    await expect(db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId))).resolves.toEqual([
      expect.objectContaining({ id: runId, status: "running", runtimeMode: "native" }),
    ]);
    await expect(db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, runId))).resolves.toEqual([
      expect.objectContaining({ runId, phase: "observed", resultId: null, attempt: 1 }),
    ]);
  });

  it("dispatches the persisted run id and lease to the live same-run resume consumer", async () => {
    await db.update(nativeRunFinalizations).set({
      phase: "retryable_failure",
      leaseOwner: null,
      leaseExpiresAt: null,
      nextAttemptAt: new Date(0),
    }).where(eq(nativeRunFinalizations.runId, runId));
    const dispatched: Array<{ runId: string; leaseOwner: string }> = [];
    await expect(dispatchNativeSessionResumptions({
      db,
      runnerInstanceId: "heartbeat-reaper",
      runIds: [runId],
      dispatch: (claim) => dispatched.push(claim),
    })).resolves.toHaveLength(1);
    expect(dispatched).toEqual([{ runId, leaseOwner: expect.stringContaining("heartbeat-reaper:resume:") }]);
    await expect(db.select().from(heartbeatRuns)).resolves.toHaveLength(5);
    await expect(db.select().from(nativeRunFinalizations)).resolves.toHaveLength(5);
  });

  it("does not resume cancelled or exhausted runs and fails closed without a checkpoint", async () => {
    await expect(claimNativeSessionResumptions({
      db,
      runnerInstanceId: "reaper",
      runIds: [cancelledRunId, exhaustedRunId, missingCheckpointRunId],
    })).resolves.toEqual([]);
    await expect(db.select().from(nativeRunFinalizations)
      .where(eq(nativeRunFinalizations.runId, missingCheckpointRunId))).resolves.toEqual([
      expect.objectContaining({ phase: "terminal_failure", failureCode: "native_session_checkpoint_missing" }),
    ]);
    await expect(db.select().from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, issueId))).resolves.toEqual([
      expect.objectContaining({ cause: "native_session_checkpoint_missing", wakePolicy: null }),
    ]);
  });

  it("does not mistake the pre-first-attempt observed coordinator for an orphan", async () => {
    await expect(claimNativeSessionResumptions({
      db,
      runnerInstanceId: "reaper",
      runIds: [initialRunId],
    })).resolves.toEqual([]);
    await expect(db.select().from(nativeRunFinalizations)
      .where(eq(nativeRunFinalizations.runId, initialRunId))).resolves.toEqual([
      expect.objectContaining({ phase: "observed", attempt: 0, failureCode: null }),
    ]);
  });
});
