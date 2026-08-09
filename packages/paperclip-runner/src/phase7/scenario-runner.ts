import { Phase7MockControlPlaneAdapter } from "../mock-core/phase7-mock-control-plane-adapter.js";
import type { Phase7JsonValue } from "../mock-core/phase7-control-plane-types.js";
import { PHASE7_SEMANTIC_TOOL_CATALOG } from "../tools/phase7-semantic-tool-catalog.js";
import { Phase7SemanticToolRuntime } from "../tools/phase7-semantic-tool-runtime.js";
import {
  phase7ScenarioFixture,
  type Phase7ScenarioFixture,
} from "./scenario-fixtures.js";
import { phase7ScenarioPlan } from "./scenario-plan.js";
import type {
  Phase7RunArtifact,
  Phase7RunMode,
  Phase7ScenarioIndexEntry,
} from "./scenario-explorer-types.js";
import {
  buildExposure,
  PHASE7_SECRET_PLACEHOLDER,
  Phase7ExecutionRecorder,
  snapshotOf,
} from "./scenario-execution.js";
import { phase7StateDiff } from "./state-diff.js";
import { phase7ScenarioParity, type Phase7EvalSuiteLookup } from "./scenario-parity.js";

/**
 * Executes one scenario against the Phase 7C mock control plane and the Phase
 * 7D semantic tool runtime, and records the result as a run artifact.
 *
 * Everything the explorer renders is produced here, in runtime code: exposure
 * comes from the authorization engine, control-plane entries come from the
 * mock core's own audit and decision records, the diff comes from immutable
 * fixture snapshots, and parity comes from the traceability expectations. The
 * browser is a read surface over this artifact and decides nothing.
 *
 * The recording machinery is shared with the Phase 7I chat session
 * (`scenario-execution.ts`) so a scenario reads the same either way.
 */

export interface Phase7RunScenarioOptions {
  mode?: Phase7RunMode;
  /** Phase 7E parity output, when its report artifact has been loaded. */
  evalSuite?: Phase7EvalSuiteLookup;
}

export async function phase7RunScenario(
  entry: Phase7ScenarioIndexEntry,
  options: Phase7RunScenarioOptions = {},
): Promise<Phase7RunArtifact> {
  const mode = options.mode ?? "fake";
  const fixture = phase7ScenarioFixture(entry);
  const plan = phase7ScenarioPlan(entry, fixture);
  const runId = `run-phase7-${entry.id}`;

  const adapter = new Phase7MockControlPlaneAdapter(fixture.seed);
  await adapter.start();

  let failure: Phase7RunArtifact["failure"] = null;

  // Snapshotted before checkout so the diff includes the control plane's own
  // seeding work, not just the agent's.
  const before = snapshotOf(adapter);
  const context = await adapter.openFixtureRun({
    identity: {
      runId,
      sessionId: `session-phase7-${entry.id}`,
      companyId: fixture.seed.company!.id!,
      issueId: fixture.taskId,
      agentId: fixture.actorId,
    },
    backendKind: "mock",
    sourceInstanceId: "phase7-scenario-explorer",
    wake: {
      reason: entry.wakeReason,
      payload: phase7ContinuationWakePayload(entry, fixture, mode),
    },
    capabilities: entry.scenarioClaims,
  });

  const runtime = new Phase7SemanticToolRuntime({
    adapter,
    runId,
    scenarioGrants: entry.scenarioClaims,
    policy: entry.policy ?? undefined,
    resolveSecretValue: () => PHASE7_SECRET_PLACEHOLDER,
  });

  const recorder = new Phase7ExecutionRecorder({ entry, adapter, runtime });

  // Turn 0 is the control-plane session seed: checkout, wake routing, and the
  // initial exposure decision all happen before the agent takes a turn.
  recorder.openTurn(0);
  recorder.drainControlPlane();

  const visible = runtime.visibleTools();
  const exposure = buildExposure(
    visible.authorizationRecords,
    entry.scenarioClaims,
    plan.controlPlaneCapabilities,
  );

  // A single-shot scenario is one agent turn over that seeded session.
  recorder.openTurn(1);
  try {
    for (const step of plan.steps) {
      await recorder.runStep(step);
    }
  } catch (error) {
    failure = { message: error instanceof Error ? error.message : String(error) };
  }

  recorder.drainControlPlane();

  if (plan.restraint) {
    recorder.pushRestraintNote(entry.forbiddenSemantics.length);
  }

  const after = recorder.snapshot();
  await adapter.stop();

  const timeline = recorder.timeline;
  const authorizationRecords = [...runtime.authorizationRecords()].filter(
    (record) => record.phase === "invocation",
  );
  const diff = phase7StateDiff(before, after);
  const parity = phase7ScenarioParity({
    entry,
    timeline,
    authorizationRecords,
    diff,
    exposure,
    failure,
    evalSuite: options.evalSuite,
  });

  return Object.freeze({
    schema: "paperclip.phase7.run-artifact.v1",
    scenarioId: entry.id,
    mode,
    runId,
    actor: {
      id: context.actor.id,
      name: context.actor.name,
      role: context.actor.role,
      capabilityGrants: [...context.actor.capabilityGrants],
    },
    task: {
      id: context.activeTask.id,
      identifier: context.activeTask.identifier,
      title: context.activeTask.title,
      workMode: context.activeTask.workMode,
    },
    wake: { reason: context.wake.reason, payload: context.wake.payload },
    budget: { ...context.budget },
    timeline,
    exposure,
    authorizationRecords,
    diff,
    parity,
    failure,
  });
}

/**
 * The continuation scenario is woken with the interaction result the board
 * already supplied; every other scenario carries only its own identity.
 */
export function phase7ContinuationWakePayload(
  entry: Phase7ScenarioIndexEntry,
  fixture: Phase7ScenarioFixture,
  mode: Phase7RunMode,
): Phase7JsonValue {
  if (entry.id !== "ix-checkbox-result-01") return { scenarioId: entry.id, mode };
  const interaction = fixture.seed.interactions?.find(
    (candidate) => candidate.id === fixture.refs.interactionId,
  );
  return {
    scenarioId: entry.id,
    mode,
    interactionId: fixture.refs.interactionId,
    result: interaction?.result ?? null,
  };
}

export const PHASE7_CATALOG_SIZE = PHASE7_SEMANTIC_TOOL_CATALOG.length;
