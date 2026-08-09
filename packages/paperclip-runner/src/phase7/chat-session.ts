import { Phase7MockControlPlaneAdapter } from "../mock-core/phase7-mock-control-plane-adapter.js";
import type { Phase7FixtureState } from "../mock-core/phase7-control-plane-types.js";
import { Phase7SemanticToolRuntime } from "../tools/phase7-semantic-tool-runtime.js";
import type { Phase7AuthorizationRecord } from "../tools/phase7-semantic-tool-types.js";
import {
  phase7ChatScript,
  type Phase7ChatScript,
  type Phase7ChatStep,
} from "./chat-script.js";
import { phase7ScenarioFixture } from "./scenario-fixtures.js";
import {
  buildExposure,
  PHASE7_SECRET_PLACEHOLDER,
  Phase7ExecutionRecorder,
  phase7IsReconciliationAction,
  snapshotOf,
} from "./scenario-execution.js";
import { phase7ContinuationWakePayload } from "./scenario-runner.js";
import {
  phase7ScenarioParity,
  phase7TurnParity,
  type Phase7EvalSuiteLookup,
} from "./scenario-parity.js";
import { phase7StateDiff } from "./state-diff.js";
import type {
  Phase7ChatSessionArtifact,
  Phase7ChatTurn,
  Phase7Exposure,
  Phase7RunMode,
  Phase7ScenarioIndexEntry,
  Phase7TimelineEntry,
} from "./scenario-explorer-types.js";

/**
 * Phase 7I chat session over the Phase 7C mock control plane.
 *
 * A session is one long-lived mock core that survives across turns, unlike the
 * 7F single-shot run: the board sends a prompt, the scripted agent works, and
 * the state it changed is still there for the next prompt. That accumulation is
 * the whole demo — it is what makes a per-turn diff mean anything.
 *
 * The session decides nothing. It records turn boundaries and asks the existing
 * runtime layers for exposure, authorization, diffs, and verdicts, so the chat
 * UI can group evidence by turn without deriving a single fact itself
 * (7I interaction map §10).
 *
 * No credential, no network, no Paperclip service: the adapter is the in-memory
 * fixture core, and the only prompt text that leaves the page is the text the
 * board typed into this same page.
 */

export interface Phase7ChatSessionOptions {
  mode?: Phase7RunMode;
  evalSuite?: Phase7EvalSuiteLookup;
}

export class Phase7ChatSession {
  readonly entry: Phase7ScenarioIndexEntry;
  readonly script: Phase7ChatScript;

  private readonly adapter: Phase7MockControlPlaneAdapter;
  private readonly runtime: Phase7SemanticToolRuntime;
  private readonly recorder: Phase7ExecutionRecorder;
  private readonly options: Phase7ChatSessionOptions;
  private readonly context: Awaited<ReturnType<Phase7MockControlPlaneAdapter["openFixtureRun"]>>;
  private readonly seedState: Phase7FixtureState;
  private readonly turns: Phase7ChatTurn[] = [];

  private readonly runId: string;
  private turnCursor = 0;
  private authorizationCursor = 0;
  private turnState: Phase7FixtureState;
  private failure: { message: string } | null = null;
  private closed = false;

  private constructor(init: {
    entry: Phase7ScenarioIndexEntry;
    script: Phase7ChatScript;
    adapter: Phase7MockControlPlaneAdapter;
    runtime: Phase7SemanticToolRuntime;
    recorder: Phase7ExecutionRecorder;
    context: Awaited<ReturnType<Phase7MockControlPlaneAdapter["openFixtureRun"]>>;
    seedState: Phase7FixtureState;
    options: Phase7ChatSessionOptions;
  }) {
    this.entry = init.entry;
    this.script = init.script;
    this.adapter = init.adapter;
    this.runtime = init.runtime;
    this.recorder = init.recorder;
    this.context = init.context;
    this.seedState = init.seedState;
    this.turnState = init.seedState;
    this.options = init.options;
    this.runId = `run-phase7-chat-${init.entry.id}`;
  }

  /**
   * Seeds a session: checkout, wake routing, and the first exposure decision
   * all happen here, as turn 0, before the board can say anything. The demo has
   * to show that work happened with no agent tool involved.
   */
  static async open(
    entry: Phase7ScenarioIndexEntry,
    options: Phase7ChatSessionOptions = {},
  ): Promise<Phase7ChatSession> {
    const mode = options.mode ?? "fake";
    const fixture = phase7ScenarioFixture(entry);
    const script = phase7ChatScript(entry, fixture);
    const runId = `run-phase7-chat-${entry.id}`;

    const adapter = new Phase7MockControlPlaneAdapter(fixture.seed);
    await adapter.start();
    const beforeSeed = snapshotOf(adapter);

    const context = await adapter.openFixtureRun({
      identity: {
        runId,
        sessionId: `session-phase7-chat-${entry.id}`,
        companyId: fixture.seed.company!.id!,
        issueId: fixture.taskId,
        agentId: fixture.actorId,
      },
      backendKind: "mock",
      sourceInstanceId: "phase7-scenario-chat",
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
    recorder.openTurn(0);
    recorder.drainControlPlane();
    const seedState = snapshotOf(adapter);

    const session = new Phase7ChatSession({
      entry,
      script,
      adapter,
      runtime,
      recorder,
      context,
      seedState,
      options,
    });
    session.recordTurn({ turn: 0, prompt: null, before: beforeSeed, after: seedState });
    return session;
  }

  get remainingScriptedTurns(): number {
    return Math.max(this.script.turns.length - this.turnCursor, 0);
  }

  /** The next scripted prompt, offered to the composer as a starting point. */
  nextPrompt(): string | null {
    return this.script.turns[this.turnCursor]?.prompt ?? null;
  }

  /**
   * Runs one turn: the board's message, then the scripted agent work, then
   * whatever the control plane did in response. Every outcome comes from the
   * mock core — a prompt drives the turn, it never dictates the result.
   */
  async send(prompt: string): Promise<Phase7ChatSessionArtifact> {
    if (this.closed) throw new Error("This chat session is closed.");
    const turn = this.turns.length === 0 ? 1 : this.turns[this.turns.length - 1]!.turn + 1;
    const before = snapshotOf(this.adapter);
    this.recorder.openTurn(turn);
    this.recorder.pushUserMessage(prompt);

    const scripted = this.script.turns[this.turnCursor];
    let turnFailure: { message: string } | null = null;
    try {
      if (scripted === undefined) {
        // Past the end of the script the session stays usable rather than
        // pretending the conversation ended: the agent re-reads the task it is
        // checked out on, so the turn still shows real mock activity.
        await this.recorder.runStep({
          kind: "tool_call",
          operationId: "get_task_context",
          input: {},
          summary: "Re-read the task context for an unscripted follow-up turn.",
        });
        this.recorder.pushAgentMessage(
          "The recorded conversation for this scenario is finished. I re-read the task context so this turn still shows what the mock control plane holds; reset the session to replay the script from the seed.",
        );
      } else {
        this.turnCursor += 1;
        for (const step of scripted.steps) {
          await this.runStep(step);
        }
        if (this.script.restraint && this.remainingScriptedTurns === 0) {
          this.recorder.pushRestraintNote(this.entry.forbiddenSemantics.length);
        }
      }
    } catch (error) {
      turnFailure = { message: error instanceof Error ? error.message : String(error) };
      this.failure = turnFailure;
    }

    this.recorder.drainControlPlane();
    const after = snapshotOf(this.adapter);
    this.recordTurn({ turn, prompt, before, after, failure: turnFailure });
    return this.artifact();
  }

  private async runStep(step: Phase7ChatStep): Promise<void> {
    if (step.kind === "control_plane_command") {
      await this.recorder.applyControlPlaneCommand({
        runId: this.runId,
        idempotencyKey: `phase7:chat:${this.entry.id}:${step.idempotencySuffix}`,
        command: step.command,
        summary: step.summary,
      });
      return;
    }
    await this.recorder.runStep(step);
  }

  /** Plays every remaining scripted turn — the deterministic `replay=fake` route. */
  async replay(): Promise<Phase7ChatSessionArtifact> {
    while (this.remainingScriptedTurns > 0) {
      const prompt = this.nextPrompt();
      if (prompt === null) break;
      await this.send(prompt);
    }
    return this.artifact();
  }

  artifact(): Phase7ChatSessionArtifact {
    const timeline = [...this.recorder.timeline];
    const authorizationRecords = this.invocationRecords();
    const exposure = this.turns[0]?.exposure ?? this.exposureNow();
    const diff = phase7StateDiff(this.seedState, this.turnState);
    const parity = phase7ScenarioParity({
      entry: this.entry,
      timeline,
      authorizationRecords,
      diff,
      exposure,
      failure: this.failure,
      evalSuite: this.options.evalSuite,
    });
    return {
      schema: "paperclip.phase7.run-artifact.v1",
      scenarioId: this.entry.id,
      mode: this.options.mode ?? "fake",
      runId: this.runId,
      actor: {
        id: this.context.actor.id,
        name: this.context.actor.name,
        role: this.context.actor.role,
        capabilityGrants: [...this.context.actor.capabilityGrants],
      },
      task: {
        id: this.context.activeTask.id,
        identifier: this.context.activeTask.identifier,
        title: this.context.activeTask.title,
        workMode: this.context.activeTask.workMode,
      },
      wake: { reason: this.context.wake.reason, payload: this.context.wake.payload },
      budget: { ...this.context.budget },
      timeline,
      exposure,
      authorizationRecords,
      diff,
      parity,
      failure: this.failure,
      turns: [...this.turns],
      status:
        this.failure !== null
          ? "failed"
          : this.turns.length <= 1
            ? "idle"
            : "settled",
      remainingScriptedTurns: this.remainingScriptedTurns,
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.adapter.stop();
  }

  private recordTurn(input: {
    turn: number;
    prompt: string | null;
    before: Phase7FixtureState;
    after: Phase7FixtureState;
    failure?: { message: string } | null;
  }): void {
    const entries = this.recorder.timeline.filter((item) => item.turn === input.turn);
    const authorizationRecords = this.invocationRecords().slice(this.authorizationCursor);
    this.authorizationCursor += authorizationRecords.length;
    const diff = phase7StateDiff(input.before, input.after);
    const failure = input.failure ?? null;
    const exposure = this.exposureNow();

    this.turnState = input.after;
    this.turns.push({
      turn: input.turn,
      prompt: input.prompt,
      status: failure === null ? "settled" : "failed",
      firstSequence: entries[0]?.sequence ?? this.recorder.lastSequence,
      lastSequence: entries[entries.length - 1]?.sequence ?? this.recorder.lastSequence,
      exposure,
      authorizationRecords,
      diff,
      reconciliationEvents: reconciliationEvents(entries),
      parity: phase7TurnParity({
        entry: this.entry,
        timeline: entries,
        authorizationRecords,
        diff,
        exposure,
        failure,
      }),
      counts: {
        calls: entries.filter((item) => item.kind === "semantic_call").length,
        denied: entries.filter(
          (item) =>
            item.kind === "semantic_result" &&
            (item.outcome === "denied" || item.outcome === "absent"),
        ).length,
        controlPlane: entries.filter((item) => item.kind === "control_plane_action").length,
        changedDomains: diff.domains.filter((domain) => domain.changed).length,
      },
      failure,
    });
  }

  /** The exposure decision as it stands now, asked of the authorization engine. */
  private exposureNow(): Phase7Exposure {
    return buildExposure(
      this.runtime.visibleTools().authorizationRecords,
      this.entry.scenarioClaims,
      this.script.controlPlaneCapabilities,
    );
  }

  private invocationRecords(): Phase7AuthorizationRecord[] {
    return [...this.runtime.authorizationRecords()].filter(
      (record) => record.phase === "invocation",
    );
  }
}

function reconciliationEvents(
  entries: readonly Phase7TimelineEntry[],
): Phase7ChatTurn["reconciliationEvents"] {
  return entries
    .filter(
      (item): item is Extract<Phase7TimelineEntry, { kind: "control_plane_action" }> =>
        item.kind === "control_plane_action" && phase7IsReconciliationAction(item.action),
    )
    .map((item) => ({
      sequence: item.sequence,
      action: item.action,
      summary: item.summary,
      stateRevision: item.stateRevision,
    }));
}

/**
 * Opens a session and plays its whole script — the deterministic artifact the
 * `replay=fake` screenshot routes and the conformance tests consume.
 */
export async function phase7ReplayChatSession(
  entry: Phase7ScenarioIndexEntry,
  options: Phase7ChatSessionOptions = {},
): Promise<Phase7ChatSessionArtifact> {
  const session = await Phase7ChatSession.open(entry, options);
  try {
    return await session.replay();
  } finally {
    await session.close();
  }
}
