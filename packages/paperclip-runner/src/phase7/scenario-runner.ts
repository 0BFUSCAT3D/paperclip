import {
  Phase7MockControlPlaneAdapter,
} from "../mock-core/phase7-mock-control-plane-adapter.js";
import type {
  Phase7AuditRecord,
  Phase7DecisionRecord,
  Phase7FixtureState,
  Phase7JsonValue,
  Phase7ScheduledWake,
} from "../mock-core/phase7-control-plane-types.js";
import { PHASE7_SEMANTIC_TOOL_CATALOG, phase7SemanticTool } from "../tools/phase7-semantic-tool-catalog.js";
import { Phase7SemanticToolRuntime } from "../tools/phase7-semantic-tool-runtime.js";
import {
  PHASE7_CONTROL_PLANE_OWNED_OPERATION_IDS,
  type Phase7AuthorizationRecord,
  type Phase7SemanticToolDescriptor,
  type Phase7ToolInvocationResult,
} from "../tools/phase7-semantic-tool-types.js";
import {
  phase7ScenarioFixture,
  type Phase7ScenarioFixture,
} from "./scenario-fixtures.js";
import {
  CREATED_TASK_REF_PATTERN,
  OPERATION_RESULT_REF_PATTERN,
  phase7ScenarioPlan,
  type Phase7PlanStep,
  type Phase7ScenarioPlan,
} from "./scenario-plan.js";
import type {
  Phase7Exposure,
  Phase7ExposureEntry,
  Phase7RedactionChip,
  Phase7RunArtifact,
  Phase7RunMode,
  Phase7ScenarioIndexEntry,
  Phase7TimelineEntry,
} from "./scenario-explorer-types.js";
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
 */

export interface Phase7RunScenarioOptions {
  mode?: Phase7RunMode;
  /** Phase 7E parity output, when its report artifact has been loaded. */
  evalSuite?: Phase7EvalSuiteLookup;
}

const SECRET_PLACEHOLDER = "fixture-secret-value-not-a-real-credential";

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

  const timeline: Phase7TimelineEntry[] = [];
  let failure: Phase7RunArtifact["failure"] = null;
  let sequence = 0;
  let auditCursor = 0;
  let decisionCursor = 0;
  let wakeCursor = 0;
  const createdTaskIds: string[] = [];
  const operationResultIds: string[] = [];

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
      payload: continuationWakePayload(entry, fixture, mode),
    },
    capabilities: entry.scenarioClaims,
  });

  const runtime = new Phase7SemanticToolRuntime({
    adapter,
    runId,
    scenarioGrants: entry.scenarioClaims,
    policy: entry.policy ?? undefined,
    resolveSecretValue: () => SECRET_PLACEHOLDER,
  });

  const drainControlPlane = (): void => {
    const state = adapter.snapshot();
    for (const audit of state.audit.slice(auditCursor)) {
      if (audit.action === "semantic_command.applied") continue;
      timeline.push(controlPlaneEntry(++sequence, audit, state.revision));
    }
    auditCursor = state.audit.length;
    for (const decision of state.decisions.slice(decisionCursor)) {
      if (decision.outcome === "allowed" || decision.outcome === "duplicate") continue;
      timeline.push(controlPlaneDecisionEntry(++sequence, decision));
    }
    decisionCursor = state.decisions.length;
    for (const wake of state.wakes.slice(wakeCursor)) {
      timeline.push(controlPlaneWakeEntry(++sequence, wake, state.revision));
    }
    wakeCursor = state.wakes.length;
  };

  drainControlPlane();

  const visible = runtime.visibleTools();
  const exposure = buildExposure(visible.authorizationRecords, entry.scenarioClaims, plan);

  try {
    for (const step of plan.steps) {
      if (step.kind === "agent_message") {
        timeline.push({
          sequence: ++sequence,
          at: fixtureInstant(adapter),
          kind: "agent_message",
          channel: "agent",
          text: step.text,
        });
        continue;
      }
      if (step.kind === "control_plane_action") {
        timeline.push({
          sequence: ++sequence,
          at: fixtureInstant(adapter),
          kind: "control_plane_action",
          channel: "control_plane",
          action: step.action,
          summary: step.summary,
          detail: step.detail,
          auditRef: null,
          decisionRef: null,
          stateRevision: adapter.snapshot().revision,
        });
        continue;
      }
      sequence = await executeToolStep({
        step,
        entry,
        runtime,
        adapter,
        timeline,
        sequence,
        createdTaskIds,
        operationResultIds,
      });
      drainControlPlane();
    }
  } catch (error) {
    failure = { message: error instanceof Error ? error.message : String(error) };
  }

  drainControlPlane();

  if (plan.restraint) {
    timeline.push({
      sequence: ++sequence,
      at: fixtureInstant(adapter),
      kind: "system_note",
      channel: "system",
      note: `No further operations — ${entry.forbiddenSemantics.length} forbidden operations, none invoked.`,
      forbiddenOperationCount: entry.forbiddenSemantics.length,
    });
  }

  const after = snapshotOf(adapter);
  await adapter.stop();

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

interface ToolStepInput {
  step: Extract<Phase7PlanStep, { kind: "tool_call" }>;
  entry: Phase7ScenarioIndexEntry;
  runtime: Phase7SemanticToolRuntime;
  adapter: Phase7MockControlPlaneAdapter;
  timeline: Phase7TimelineEntry[];
  sequence: number;
  createdTaskIds: string[];
  operationResultIds: string[];
}

async function executeToolStep(input: ToolStepInput): Promise<number> {
  const { step, entry, runtime, adapter, timeline, createdTaskIds, operationResultIds } = input;
  let sequence = input.sequence;
  const descriptor = phase7SemanticTool(step.operationId);
  const resolvedInput = resolvePlanRefs(step.input, createdTaskIds, operationResultIds);
  // The catalog, not the plan, decides which operations need an idempotency
  // key; plans only override the suffix when one step must differ from another.
  const suffix =
    step.idempotencySuffix ?? (descriptor?.idempotency === "required" ? step.operationId : undefined);
  const idempotencyKey = suffix === undefined ? undefined : `phase7:${entry.id}:${suffix}`;
  const redactions = descriptor === undefined ? [] : redactionChips(descriptor);

  const callSequence = ++sequence;
  timeline.push({
    sequence: callSequence,
    at: fixtureInstant(adapter),
    kind: "semantic_call",
    channel: "agent",
    operationId: step.operationId,
    disposition: descriptor?.disposition ?? "control_plane_owned",
    summary: step.summary,
    input: redactValue(resolvedInput, descriptor, "input"),
    requiredClaims: descriptor === undefined ? [] : [...descriptor.requiredClaims],
    idempotency: descriptor?.idempotency ?? "none",
    idempotencyKey: idempotencyKey ?? null,
    redactions,
    escapeHatch: descriptor?.sideEffectClass === "test_escape_hatch",
    authorizationSequence: 0,
  });

  const result: Phase7ToolInvocationResult = await runtime.invoke({
    operationId: step.operationId,
    input: resolvedInput,
    idempotencyKey,
  });

  const call = timeline.find((candidate) => candidate.sequence === callSequence);
  if (call?.kind === "semantic_call") call.authorizationSequence = result.authorization.sequence;

  if (result.ok) {
    operationResultIds.push(result.operationResultId);
    for (const ref of result.commandResult?.entityRefs ?? []) {
      if (ref.startsWith("task:") && ref.slice(5) !== adapterActiveTaskId(adapter)) {
        createdTaskIds.push(ref.slice(5));
      }
    }
    timeline.push({
      sequence: ++sequence,
      at: fixtureInstant(adapter),
      kind: "semantic_result",
      channel: "agent",
      operationId: step.operationId,
      outcome:
        result.commandResult === null
          ? "read"
          : result.commandResult.disposition === "duplicate"
            ? "duplicate"
            : "committed",
      summary: resultSummary(step.operationId, result),
      value: redactValue(result.value, descriptor, "output"),
      failure: null,
      redactions,
      authorizationSequence: result.authorization.sequence,
      protocolEventRefs: (result.commandResult?.scheduledWakeIds ?? []).map((id) => `wake:${id}`),
    });
    return sequence;
  }

  timeline.push({
    sequence: ++sequence,
    at: fixtureInstant(adapter),
    kind: "semantic_result",
    channel: "agent",
    operationId: step.operationId,
    outcome: result.error.code === "operation_absent" ? "absent" : "denied",
    summary:
      result.error.code === "operation_absent"
        ? `\`${step.operationId}\` is not exposed to this run.`
        : `\`${step.operationId}\` was denied — ${result.authorization.reason}.`,
    value: null,
    failure: { code: result.error.code, reason: result.authorization.reason },
    redactions,
    authorizationSequence: result.authorization.sequence,
    protocolEventRefs: [],
  });
  return sequence;
}

function adapterActiveTaskId(adapter: Phase7MockControlPlaneAdapter): string {
  const state = adapter.snapshot();
  const run = state.runs.find((candidate) => candidate.id === state.activeRunId);
  return run?.taskId ?? "";
}

function resolvePlanRefs(
  value: Phase7JsonValue,
  createdTaskIds: string[],
  operationResultIds: string[],
): Phase7JsonValue {
  if (typeof value === "string") {
    const createdTask = CREATED_TASK_REF_PATTERN.exec(value);
    if (createdTask !== null) return createdTaskIds[Number(createdTask[1]) - 1] ?? value;
    const operationResult = OPERATION_RESULT_REF_PATTERN.exec(value);
    if (operationResult !== null) {
      return operationResultIds[Number(operationResult[1]) - 1] ?? value;
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => resolvePlanRefs(item, createdTaskIds, operationResultIds));
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        resolvePlanRefs(child, createdTaskIds, operationResultIds),
      ]),
    );
  }
  return value;
}

function continuationWakePayload(
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

/**
 * Applies the descriptor's redaction rules at the artifact boundary so no raw
 * secret can reach a rendered record, even if an upstream layer returns one
 * (UX map §5: the explorer fails closed rather than receiving-and-hiding).
 */
function redactValue(
  value: Phase7JsonValue,
  descriptor: Phase7SemanticToolDescriptor | undefined,
  channel: "input" | "output",
): Phase7JsonValue {
  if (descriptor === undefined) return value;
  let redacted = value;
  for (const rule of descriptor.redaction) {
    if (!rule.appliesTo.includes(channel)) continue;
    redacted = applyRedactionPath(redacted, rule.path.replace(/^\$\.?/, "").split("."), rule.replacement);
  }
  return redacted;
}

function applyRedactionPath(
  value: Phase7JsonValue,
  path: string[],
  replacement: string,
): Phase7JsonValue {
  const [head, ...rest] = path;
  if (head === undefined) return replacement;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  if (!(head in value)) return value;
  return { ...value, [head]: applyRedactionPath(value[head]!, rest, replacement) };
}

function redactionChips(descriptor: Phase7SemanticToolDescriptor): Phase7RedactionChip[] {
  return descriptor.redaction.map((rule) => ({
    path: rule.path,
    replacement: rule.replacement,
    rule: `${descriptor.operationId}:${rule.path}`,
  }));
}

function resultSummary(operationId: string, result: Phase7ToolInvocationResult): string {
  if (!result.ok) return `\`${operationId}\` produced no result.`;
  if (result.commandResult === null) return `\`${operationId}\` returned a read projection.`;
  const refs = result.commandResult.entityRefs.length;
  return `\`${operationId}\` ${result.commandResult.disposition} at revision ${result.commandResult.stateRevision}${
    refs === 0 ? "" : ` · ${refs} ${refs === 1 ? "entity" : "entities"}`
  }.`;
}

function buildExposure(
  records: readonly Phase7AuthorizationRecord[],
  grants: readonly string[],
  plan: Phase7ScenarioPlan,
): Phase7Exposure {
  const always: Phase7ExposureEntry[] = [];
  const optional: Phase7ExposureEntry[] = [];
  const withheld: Phase7ExposureEntry[] = [];
  for (const record of records) {
    const descriptor = phase7SemanticTool(record.operationId);
    if (descriptor === undefined) continue;
    const entry: Phase7ExposureEntry = {
      operationId: descriptor.operationId,
      title: descriptor.title,
      requiredClaims: [...descriptor.requiredClaims],
      unlockedBy:
        descriptor.disposition === "optional_agent_tool"
          ? (descriptor.requiredClaims.find((claim) => grants.includes(claim)) ?? null)
          : null,
      reason: record.reason,
    };
    if (record.outcome !== "exposed") withheld.push(entry);
    else if (descriptor.disposition === "always_agent_tool") always.push(entry);
    else optional.push(entry);
  }
  const controlPlane = plan.controlPlaneCapabilities.filter((capability) =>
    (PHASE7_CONTROL_PLANE_OWNED_OPERATION_IDS as readonly string[]).includes(capability.operationId),
  );
  return {
    schema: "paperclip.phase7.exposure.v1",
    always,
    optional,
    controlPlane,
    withheld,
  };
}

function controlPlaneEntry(
  sequence: number,
  audit: Phase7AuditRecord,
  stateRevision: number,
): Phase7TimelineEntry {
  return {
    sequence,
    at: audit.at,
    kind: "control_plane_action",
    channel: "control_plane",
    action: audit.action,
    summary: CONTROL_PLANE_COPY[audit.action] ?? `Control plane recorded \`${audit.action}\`.`,
    detail: audit.details,
    auditRef: audit.id,
    decisionRef: null,
    stateRevision,
  };
}

function controlPlaneDecisionEntry(
  sequence: number,
  decision: Phase7DecisionRecord,
): Phase7TimelineEntry {
  return {
    sequence,
    at: decision.at,
    kind: "control_plane_action",
    channel: "control_plane",
    action: `${decision.operation}.${decision.outcome}`,
    summary: `Control plane ${decision.outcome} \`${decision.operation}\` — ${decision.reason}. No agent tool exists for this.`,
    detail: { operation: decision.operation, reason: decision.reason, entityRefs: decision.entityRefs },
    auditRef: null,
    decisionRef: decision.id,
    stateRevision: decision.stateRevision,
  };
}

function controlPlaneWakeEntry(
  sequence: number,
  wake: Phase7ScheduledWake,
  stateRevision: number,
): Phase7TimelineEntry {
  return {
    sequence,
    at: wake.createdAt,
    kind: "control_plane_action",
    channel: "control_plane",
    action: "wake.scheduled",
    summary: `Control plane scheduled a \`${wake.reason}\` wake for task ${wake.taskId} — no agent tool exists for this.`,
    detail: { id: wake.id, reason: wake.reason, dueAt: wake.dueAt, status: wake.status },
    auditRef: null,
    decisionRef: null,
    stateRevision,
  };
}

const CONTROL_PLANE_COPY: Record<string, string> = {
  "run.opened":
    "Control plane checked out the task and opened the run — no agent tool exists for this.",
  "run.event_appended": "Control plane appended a protocol event to the durable run log.",
  "run.session_checkpointed": "Control plane checkpointed the session for replay.",
  "run.completed": "Control plane reconciled the terminal run result.",
  "budget.hard_stop": "Control plane stopped the run on a hard budget limit.",
};

function snapshotOf(adapter: Phase7MockControlPlaneAdapter): Phase7FixtureState {
  return JSON.parse(adapter.serialize()) as Phase7FixtureState;
}

function fixtureInstant(adapter: Phase7MockControlPlaneAdapter): string {
  const clock = adapter.snapshot().clock;
  return new Date(clock.epochMs + clock.tick * 1_000).toISOString();
}

export const PHASE7_CATALOG_SIZE = PHASE7_SEMANTIC_TOOL_CATALOG.length;
