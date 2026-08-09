import type { Phase7MockControlPlaneAdapter } from "../mock-core/phase7-mock-control-plane-adapter.js";
import type {
  Phase7AuditRecord,
  Phase7DecisionRecord,
  Phase7FixtureState,
  Phase7JsonValue,
  Phase7ScheduledWake,
  Phase7SemanticCommand,
} from "../mock-core/phase7-control-plane-types.js";
import { phase7SemanticTool } from "../tools/phase7-semantic-tool-catalog.js";
import type { Phase7SemanticToolRuntime } from "../tools/phase7-semantic-tool-runtime.js";
import {
  PHASE7_CONTROL_PLANE_OWNED_OPERATION_IDS,
  type Phase7AuthorizationRecord,
  type Phase7SemanticToolDescriptor,
  type Phase7ToolInvocationResult,
} from "../tools/phase7-semantic-tool-types.js";
import {
  CREATED_INTERACTION_REF_PATTERN,
  CREATED_TASK_REF_PATTERN,
  OPERATION_RESULT_REF_PATTERN,
  type Phase7PlanStep,
} from "./scenario-plan.js";
import type {
  Phase7Exposure,
  Phase7ExposureEntry,
  Phase7RedactionChip,
  Phase7ScenarioIndexEntry,
  Phase7TimelineEntry,
} from "./scenario-explorer-types.js";

/**
 * Shared scenario execution recorder.
 *
 * The Phase 7F single-shot runner and the Phase 7I chat session both drive the
 * same mock control plane and the same 7D tool runtime, and both have to record
 * the result identically — one artifact grammar, one redaction boundary, one
 * control-plane drain. That common machinery lives here so the two surfaces can
 * never drift into two different accounts of the same run.
 *
 * The recorder decides nothing. Exposure comes from the authorization engine,
 * control-plane entries come from the mock core's own audit and decision
 * records, and outcomes come from the tool runtime.
 */

const SECRET_PLACEHOLDER = "fixture-secret-value-not-a-real-credential";

/**
 * A timeline entry before the recorder stamps its ordinal and turn. Distributed
 * over the union deliberately — a plain `Omit` would collapse the variants to
 * their shared keys and lose every payload field.
 */
type Phase7UnstampedEntry = Phase7TimelineEntry extends infer Variant
  ? Variant extends Phase7TimelineEntry
    ? Omit<Variant, "sequence" | "turn">
    : never
  : never;

export interface Phase7RecorderOptions {
  entry: Phase7ScenarioIndexEntry;
  adapter: Phase7MockControlPlaneAdapter;
  runtime: Phase7SemanticToolRuntime;
}

export class Phase7ExecutionRecorder {
  readonly timeline: Phase7TimelineEntry[] = [];

  private readonly entry: Phase7ScenarioIndexEntry;
  private readonly adapter: Phase7MockControlPlaneAdapter;
  private readonly runtime: Phase7SemanticToolRuntime;
  private readonly createdTaskIds: string[] = [];
  private readonly createdInteractionIds: string[] = [];
  private readonly operationResultIds: string[] = [];
  private sequence = 0;
  private auditCursor = 0;
  private decisionCursor = 0;
  private wakeCursor = 0;
  private turn = 0;

  constructor(options: Phase7RecorderOptions) {
    this.entry = options.entry;
    this.adapter = options.adapter;
    this.runtime = options.runtime;
  }

  /** Entries recorded from here on belong to `turn`. */
  openTurn(turn: number): void {
    this.turn = turn;
  }

  get currentTurn(): number {
    return this.turn;
  }

  get nextSequence(): number {
    return this.sequence + 1;
  }

  get lastSequence(): number {
    return this.sequence;
  }

  snapshot(): Phase7FixtureState {
    return snapshotOf(this.adapter);
  }

  instant(): string {
    return fixtureInstant(this.adapter);
  }

  /**
   * Copies everything the mock core recorded since the last drain into the
   * timeline. Allowed and duplicate decisions are omitted deliberately: the
   * semantic result already carries them, and repeating them would double-count
   * control-plane work that no agent tool performed.
   */
  drainControlPlane(): void {
    const state = this.adapter.snapshot();
    for (const audit of state.audit.slice(this.auditCursor)) {
      if (audit.action === "semantic_command.applied") continue;
      this.timeline.push(this.stamp(controlPlaneEntry(audit, state.revision)));
    }
    this.auditCursor = state.audit.length;
    for (const decision of state.decisions.slice(this.decisionCursor)) {
      if (decision.outcome === "allowed" || decision.outcome === "duplicate") continue;
      this.timeline.push(this.stamp(controlPlaneDecisionEntry(decision)));
    }
    this.decisionCursor = state.decisions.length;
    for (const wake of state.wakes.slice(this.wakeCursor)) {
      this.timeline.push(this.stamp(controlPlaneWakeEntry(wake, state.revision)));
    }
    this.wakeCursor = state.wakes.length;
  }

  pushUserMessage(text: string): void {
    this.timeline.push(
      this.stamp({
        at: this.instant(),
        kind: "user_message",
        channel: "user",
        text,
      }),
    );
  }

  pushAgentMessage(text: string): void {
    this.timeline.push(
      this.stamp({
        at: this.instant(),
        kind: "agent_message",
        channel: "agent",
        text,
      }),
    );
  }

  pushScriptedControlPlaneAction(
    step: Extract<Phase7PlanStep, { kind: "control_plane_action" }>,
  ): void {
    this.timeline.push(
      this.stamp({
        at: this.instant(),
        kind: "control_plane_action",
        channel: "control_plane",
        action: step.action,
        summary: step.summary,
        detail: step.detail,
        auditRef: null,
        decisionRef: null,
        stateRevision: this.adapter.snapshot().revision,
      }),
    );
  }

  pushRestraintNote(forbiddenOperationCount: number): void {
    this.timeline.push(
      this.stamp({
        at: this.instant(),
        kind: "system_note",
        channel: "system",
        note: `No further operations — ${forbiddenOperationCount} forbidden operations, none invoked.`,
        forbiddenOperationCount,
      }),
    );
  }

  /** Runs one plan step and records everything it produced. */
  async runStep(step: Phase7PlanStep): Promise<void> {
    if (step.kind === "agent_message") {
      this.pushAgentMessage(step.text);
      return;
    }
    if (step.kind === "control_plane_action") {
      this.pushScriptedControlPlaneAction(step);
      return;
    }
    await this.runToolStep(step);
    this.drainControlPlane();
  }

  private async runToolStep(step: Extract<Phase7PlanStep, { kind: "tool_call" }>): Promise<void> {
    const descriptor = phase7SemanticTool(step.operationId);
    const resolvedInput = this.resolveRefs(step.input);
    // The catalog, not the plan, decides which operations need an idempotency
    // key; plans only override the suffix when one step must differ from another.
    const suffix =
      step.idempotencySuffix ??
      (descriptor?.idempotency === "required" ? step.operationId : undefined);
    const idempotencyKey = suffix === undefined ? undefined : `phase7:${this.entry.id}:${suffix}`;
    const redactions = descriptor === undefined ? [] : redactionChips(descriptor);

    const callSequence = this.sequence + 1;
    this.timeline.push(
      this.stamp({
        at: this.instant(),
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
      }),
    );

    const result: Phase7ToolInvocationResult = await this.runtime.invoke({
      operationId: step.operationId,
      input: resolvedInput,
      idempotencyKey,
    });

    const call = this.timeline.find((candidate) => candidate.sequence === callSequence);
    if (call?.kind === "semantic_call") call.authorizationSequence = result.authorization.sequence;

    if (result.ok) {
      this.operationResultIds.push(result.operationResultId);
      this.trackEntityRefs(result.commandResult?.entityRefs ?? []);
      this.timeline.push(
        this.stamp({
          at: this.instant(),
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
        }),
      );
      return;
    }

    this.timeline.push(
      this.stamp({
        at: this.instant(),
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
      }),
    );
  }

  /**
   * Applies a control-plane-owned command — one the mock core performs with no
   * agent tool at all, because no semantic operation exposes it. The board
   * answering its own interaction is the canonical case, and the resulting wake
   * is scheduled by the control plane rather than requested by the agent.
   */
  async applyControlPlaneCommand(input: {
    runId: string;
    idempotencyKey: string;
    command: Phase7SemanticCommand;
    summary: string;
  }): Promise<void> {
    const command = this.resolveRefs(
      input.command as unknown as Phase7JsonValue,
    ) as unknown as Phase7SemanticCommand;
    const result = await this.adapter.applyCommand({
      runId: input.runId,
      idempotencyKey: input.idempotencyKey,
      command,
    });
    this.trackEntityRefs(result.entityRefs);
    this.timeline.push(
      this.stamp({
        at: this.instant(),
        kind: "control_plane_action",
        channel: "control_plane",
        action: `${command.kind}.applied`,
        summary: input.summary,
        detail: {
          kind: command.kind,
          entityRefs: [...result.entityRefs],
          scheduledWakeIds: [...result.scheduledWakeIds],
        },
        auditRef: null,
        decisionRef: null,
        stateRevision: result.stateRevision,
      }),
    );
    this.drainControlPlane();
  }

  private resolveRefs(value: Phase7JsonValue): Phase7JsonValue {
    return resolvePlanRefs(
      value,
      this.createdTaskIds,
      this.operationResultIds,
      this.createdInteractionIds,
    );
  }

  private trackEntityRefs(entityRefs: readonly string[]): void {
    for (const ref of entityRefs) {
      if (ref.startsWith("task:") && ref.slice(5) !== this.activeTaskId()) {
        this.createdTaskIds.push(ref.slice(5));
      }
      if (ref.startsWith("interaction:")) {
        this.createdInteractionIds.push(ref.slice("interaction:".length));
      }
    }
  }

  private activeTaskId(): string {
    const state = this.adapter.snapshot();
    const run = state.runs.find((candidate) => candidate.id === state.activeRunId);
    return run?.taskId ?? "";
  }

  private stamp(
    entry: Phase7UnstampedEntry,
  ): Phase7TimelineEntry {
    return { ...entry, sequence: ++this.sequence, turn: this.turn } as Phase7TimelineEntry;
  }
}

export const PHASE7_SECRET_PLACEHOLDER = SECRET_PLACEHOLDER;

export function resolvePlanRefs(
  value: Phase7JsonValue,
  createdTaskIds: readonly string[],
  operationResultIds: readonly string[],
  createdInteractionIds: readonly string[] = [],
): Phase7JsonValue {
  const recurse = (child: Phase7JsonValue): Phase7JsonValue =>
    resolvePlanRefs(child, createdTaskIds, operationResultIds, createdInteractionIds);
  if (typeof value === "string") {
    const createdTask = CREATED_TASK_REF_PATTERN.exec(value);
    if (createdTask !== null) return createdTaskIds[Number(createdTask[1]) - 1] ?? value;
    const operationResult = OPERATION_RESULT_REF_PATTERN.exec(value);
    if (operationResult !== null) {
      return operationResultIds[Number(operationResult[1]) - 1] ?? value;
    }
    const createdInteraction = CREATED_INTERACTION_REF_PATTERN.exec(value);
    if (createdInteraction !== null) {
      return createdInteractionIds[Number(createdInteraction[1]) - 1] ?? value;
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(recurse);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, recurse(child)]));
  }
  return value;
}

/**
 * Applies the descriptor's redaction rules at the artifact boundary so no raw
 * secret can reach a rendered record, even if an upstream layer returns one
 * (UX map §5: the explorer fails closed rather than receiving-and-hiding).
 */
export function redactValue(
  value: Phase7JsonValue,
  descriptor: Phase7SemanticToolDescriptor | undefined,
  channel: "input" | "output",
): Phase7JsonValue {
  if (descriptor === undefined) return value;
  let redacted = value;
  for (const rule of descriptor.redaction) {
    if (!rule.appliesTo.includes(channel)) continue;
    redacted = applyRedactionPath(
      redacted,
      rule.path.replace(/^\$\.?/, "").split("."),
      rule.replacement,
    );
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

export function redactionChips(descriptor: Phase7SemanticToolDescriptor): Phase7RedactionChip[] {
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

export function buildExposure(
  records: readonly Phase7AuthorizationRecord[],
  grants: readonly string[],
  controlPlaneCapabilities: ReadonlyArray<{ operationId: string; reason: string }>,
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
  const controlPlane = controlPlaneCapabilities.filter((capability) =>
    (PHASE7_CONTROL_PLANE_OWNED_OPERATION_IDS as readonly string[]).includes(capability.operationId),
  );
  return {
    schema: "paperclip.phase7.exposure.v1",
    always,
    optional,
    controlPlane: [...controlPlane],
    withheld,
  };
}

function controlPlaneEntry(
  audit: Phase7AuditRecord,
  stateRevision: number,
): Phase7UnstampedEntry {
  return {
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
  decision: Phase7DecisionRecord,
): Phase7UnstampedEntry {
  return {
    at: decision.at,
    kind: "control_plane_action",
    channel: "control_plane",
    action: `${decision.operation}.${decision.outcome}`,
    summary: `Control plane ${decision.outcome} \`${decision.operation}\` — ${decision.reason}. No agent tool exists for this.`,
    detail: {
      operation: decision.operation,
      reason: decision.reason,
      entityRefs: decision.entityRefs,
    },
    auditRef: null,
    decisionRef: decision.id,
    stateRevision: decision.stateRevision,
  };
}

function controlPlaneWakeEntry(
  wake: Phase7ScheduledWake,
  stateRevision: number,
): Phase7UnstampedEntry {
  return {
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

/**
 * Wake scheduling, blocker resolution, and terminal reconciliation, identified
 * from the recorded control-plane action rather than guessed at by the UI.
 */
export const PHASE7_RECONCILIATION_ACTIONS: readonly RegExp[] = [
  /^wake\./,
  /^run\.completed$/,
  /reconcile/,
  /blocker/,
];

export function phase7IsReconciliationAction(action: string): boolean {
  return PHASE7_RECONCILIATION_ACTIONS.some((pattern) => pattern.test(action));
}

export function snapshotOf(adapter: Phase7MockControlPlaneAdapter): Phase7FixtureState {
  return JSON.parse(adapter.serialize()) as Phase7FixtureState;
}

export function fixtureInstant(adapter: Phase7MockControlPlaneAdapter): string {
  const clock = adapter.snapshot().clock;
  return new Date(clock.epochMs + clock.tick * 1_000).toISOString();
}
