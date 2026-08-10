/**
 * Phase 7G issue-thread view contract.
 *
 * The browser renders exactly this shape and nothing else. Every field is a
 * projection of a mock-core record, a canonical event, or a semantic
 * authorization record produced by the package server (Phase 7B UX contract
 * §11: the browser holds no policy, diff, or parity authority). Two producers
 * exist — the deterministic `fake` fixtures used by the screenshot matrix and
 * the live session projection — and they emit the same schema.
 */

import type {
  Phase7InteractionKind,
  Phase7JsonValue,
  Phase7TaskStatus,
} from "../mock-core/phase7-control-plane-types.js";
import type { Phase7SemanticOperationId } from "../semantic-tools/types.js";

export const PHASE7_ISSUE_THREAD_VIEW_SCHEMA = "paperclip.phase7.issue-thread-view.v1" as const;

/** Contract §0: a surface never shows an unlabeled mode. */
export type Phase7ThreadMode = "live" | "fake" | "replay";

/** Contract §0: closed disposition enum; UI copy is fixed per disposition. */
export type Phase7ToolDisposition =
  | "control_plane_owned"
  | "always_agent_tool"
  | "optional_agent_tool";

export const PHASE7_DISPOSITION_LABELS: Readonly<Record<Phase7ToolDisposition, string>> = {
  always_agent_tool: "Agent tool — always",
  optional_agent_tool: "Agent tool — granted",
  control_plane_owned: "Control plane",
};

export interface Phase7ThreadIdentity {
  /** `Real Codex` in live mode, `Fake agent` in fake mode, `Replay` in replay mode. */
  agentLabel: string;
  /** `Real runnerd` in live mode, `In-process runner` otherwise. */
  runnerLabel: string;
  /** Pulse while a runnerd session is attached; static when detached. */
  runnerAttached: boolean;
  /** Always `Mock Paperclip`. */
  controlPlaneLabel: string;
  controlPlaneTooltip: string;
  /** Present in replay mode so replay evidence can never satisfy a live criterion. */
  replaySource: "fake" | "live" | null;
}

export interface Phase7ThreadIssue {
  identifier: string;
  title: string;
  status: Phase7TaskStatus;
  priority: "critical" | "high" | "medium" | "low";
  assignee: string | null;
  runState: string;
  scenarioId: string;
  fixtureProfile: string;
}

/** Contract §4. `data-composer-state` is the test and screenshot hook. */
export type Phase7ComposerState =
  | "ready"
  | "sending"
  | "streaming"
  | "waiting"
  | "reconnecting"
  | "disabled";

export interface Phase7ComposerModel {
  state: Phase7ComposerState;
  helper: string | null;
  /** Reason line rendered by the `disabled` state. */
  reason: string | null;
  /** Anchor target for the `waiting` helper link. */
  pendingInteractionId: string | null;
}

export type Phase7ThreadInteractionState =
  | "pending"
  | "submitting"
  | "accepted"
  | "answered"
  | "rejected"
  | "stale_target"
  | "superseded_by_comment"
  | "expired"
  | "withdrawn"
  | "issue_closed";

export interface Phase7ThreadLink {
  label: string;
  /** In-explorer route only. Real Paperclip URLs never appear (§11). */
  href: string;
}

export interface Phase7ThreadQuestion {
  id: string;
  prompt: string;
  control: "radio" | "select" | "text";
  options?: string[];
  required?: boolean;
}

export interface Phase7ThreadCheckboxOption {
  id: string;
  label: string;
  defaultSelected?: boolean;
}

export interface Phase7ThreadProposedTask {
  id: string;
  title: string;
  description: string;
}

export interface Phase7ThreadVerdictItem {
  id: string;
  title: string;
  requireReason?: boolean;
  /** Set once the item has been submitted in a partial submit. */
  lockedVerdict?: "approve" | "reject" | "defer" | null;
}

export type Phase7ThreadInteractionPayload =
  | { kind: "questions"; questions: Phase7ThreadQuestion[]; submitLabel: string }
  | {
      kind: "confirmation";
      targetSummary: string;
      acceptLabel: string;
      rejectLabel: string;
      requireRejectReason: boolean;
    }
  | {
      kind: "checkbox";
      options: Phase7ThreadCheckboxOption[];
      minSelected: number;
      maxSelected: number;
      acceptLabel: string;
      rejectLabel: string;
    }
  | { kind: "suggest_tasks"; tasks: Phase7ThreadProposedTask[]; acceptLabel: string }
  | { kind: "item_verdicts"; items: Phase7ThreadVerdictItem[]; submitLabel: string };

export interface Phase7ThreadInteractionCard {
  interactionId: string;
  interactionKind: Phase7InteractionKind;
  title: string;
  prompt: string;
  payload: Phase7ThreadInteractionPayload;
  state: Phase7ThreadInteractionState;
  /** Revision-bound confirmation target, e.g. `plan · r4`. */
  target: Phase7ThreadLink | null;
  /** Chip copy, always paired with a glyph in the renderer (§9.5). */
  stateLabel: string;
  /** Chosen values summarised inline once resolved. */
  resolvedSummary: string[];
  /** Verbatim reject reason. */
  reason: string | null;
  /** Superseding revision or comment for the expired outcomes. */
  supersededBy: Phase7ThreadLink | null;
  evidenceRef: Phase7EvidenceRef;
}

export interface Phase7EvidenceRef {
  section: Phase7EvidenceSectionId;
  recordId: string;
}

export type Phase7ThreadItem =
  | { kind: "user_message"; id: string; at: string; author: string; body: string }
  | {
      kind: "agent_message";
      id: string;
      at: string;
      author: string;
      body: string;
      streaming: boolean;
    }
  | {
      kind: "durable_comment";
      id: string;
      at: string;
      author: string;
      body: string;
      operationId: Phase7SemanticOperationId;
      evidenceRef: Phase7EvidenceRef;
    }
  | {
      kind: "tool_activity";
      id: string;
      at: string;
      status: "ok" | "denied" | "running";
      operationId: string;
      summary: string;
      input: Phase7JsonValue;
      result: Phase7JsonValue;
      evidenceRef: Phase7EvidenceRef;
    }
  | ({ kind: "interaction"; id: string; at: string } & Phase7ThreadInteractionCard)
  | {
      kind: "document";
      id: string;
      at: string;
      documentKey: string;
      title: string;
      author: string;
      revisionFrom: number | null;
      revisionTo: number;
      staleBehind: number | null;
      evidenceRef: Phase7EvidenceRef;
    }
  | {
      kind: "deliverable";
      id: string;
      at: string;
      filename: string;
      deliverableKind: "attachment bytes" | "external ref" | "workspace file";
      byteSize: number;
      registeredBy: string;
      contentRef: string;
      evidenceRef: Phase7EvidenceRef;
    }
  | {
      kind: "dependency";
      id: string;
      at: string;
      createdTasks: Array<{ identifier: string; title: string }>;
      blockerEdges: string[];
      evidenceRef: Phase7EvidenceRef;
    }
  | {
      kind: "disposition";
      id: string;
      at: string;
      operationId: Phase7SemanticOperationId;
      status: Phase7TaskStatus;
      body: string;
      blockerOwner: string | null;
      evidenceRef: Phase7EvidenceRef;
    }
  | {
      kind: "denial";
      id: string;
      at: string;
      operationId: string;
      /** Verbatim from the authorization record; never paraphrased. */
      reason: string;
      evidenceRef: Phase7EvidenceRef;
    }
  | {
      kind: "system_notice";
      id: string;
      at: string;
      glyph: string;
      text: string;
      evidenceRef: Phase7EvidenceRef;
    };

export interface Phase7ThreadTurn {
  id: string;
  ordinal: number;
  mode: Phase7ThreadMode;
  toolCallCount: number;
  at: string;
  stoppedByUser: boolean;
  items: Phase7ThreadItem[];
}

export type Phase7EvidenceSectionId =
  | "tools"
  | "calls"
  | "authorization"
  | "control_plane"
  | "runner"
  | "state"
  | "traceability"
  | "parity";

export const PHASE7_EVIDENCE_SECTIONS: ReadonlyArray<{
  id: Phase7EvidenceSectionId;
  title: string;
}> = [
  { id: "tools", title: "Tools exposed" },
  { id: "calls", title: "Calls & results" },
  { id: "authorization", title: "Authorization" },
  { id: "control_plane", title: "Control plane" },
  { id: "runner", title: "Runner & events" },
  { id: "state", title: "State diff" },
  { id: "traceability", title: "Traceability" },
  { id: "parity", title: "Parity" },
];

export interface Phase7EvidenceToolRow {
  operationId: string;
  disposition: Phase7ToolDisposition;
  /** 7A grant string rendered verbatim, e.g. `rf:read_or_write`. */
  grant: string | null;
  description: string;
}

export interface Phase7EvidenceToolsRecord {
  id: string;
  turnId: string;
  rows: Phase7EvidenceToolRow[];
}

export interface Phase7EvidenceCallRecord {
  id: string;
  turnId: string;
  operationId: string;
  version: number;
  providerRequest: string;
  dispatchedCommand: string;
  outcome: "ok" | "denied";
  result: Phase7JsonValue;
  redactions: string[];
  threadAnchorId: string;
}

export interface Phase7EvidenceAuthorizationRecord {
  id: string;
  turnId: string;
  operationId: string;
  phase: "exposure" | "invocation";
  allowed: boolean;
  code: string;
  reason: string;
  claimsConsidered: string[];
  redactions: string[];
  stateChangeRef: string | null;
  threadAnchorId: string;
}

export interface Phase7EvidenceControlPlaneRecord {
  id: string;
  turnId: string;
  category: "checkout" | "wake" | "budget" | "idempotency" | "reconciliation" | "session";
  outcome: string;
  reason: string;
  stateRevision: number;
  threadAnchorId: string | null;
}

export interface Phase7EvidenceRunnerRecord {
  id: string;
  turnId: string;
  kind: string;
  ordinal: number;
  detail: string;
}

export interface Phase7EvidenceStateDiffRow {
  entityClass: string;
  entityRef: string;
  before: string;
  after: string;
}

export interface Phase7EvidenceStateDiffRecord {
  id: string;
  turnId: string;
  fromRevision: number;
  toRevision: number;
  rows: Phase7EvidenceStateDiffRow[];
}

export interface Phase7EvidenceTraceabilityRecord {
  id: string;
  turnId: string;
  capabilityId: string;
  sourceAnchor: string;
  caseId: string;
  group: string;
  browserEvidenceRecipe: string;
  expectedSemanticOperations: string[];
  forbiddenOperations: string[];
  requiredCapabilityGrants: string[];
}

export interface Phase7EvidenceParityRecord {
  id: string;
  turnId: string;
  assertion: string;
  verdict: "pass" | "fail" | "intentional_gap";
  note: string | null;
}

export interface Phase7EvidenceModel {
  tools: Phase7EvidenceToolsRecord[];
  calls: Phase7EvidenceCallRecord[];
  authorization: Phase7EvidenceAuthorizationRecord[];
  control_plane: Phase7EvidenceControlPlaneRecord[];
  runner: Phase7EvidenceRunnerRecord[];
  state: Phase7EvidenceStateDiffRecord[];
  traceability: Phase7EvidenceTraceabilityRecord[];
  parity: Phase7EvidenceParityRecord[];
}

export interface Phase7ThreadConnection {
  state: "connected" | "reconnecting" | "closed";
  attempt: number;
}

export interface Phase7ReplayModel {
  ordinal: number;
  total: number;
}

export interface Phase7IssueThreadSnapshot {
  schema: typeof PHASE7_ISSUE_THREAD_VIEW_SCHEMA;
  sessionId: string;
  mode: Phase7ThreadMode;
  identity: Phase7ThreadIdentity;
  issue: Phase7ThreadIssue;
  turns: Phase7ThreadTurn[];
  composer: Phase7ComposerModel;
  evidence: Phase7EvidenceModel;
  connection: Phase7ThreadConnection;
  replay: Phase7ReplayModel | null;
  /** Fixture clock; every rendered timestamp derives from snapshot data. */
  renderedAt: string;
}

export function phase7DispositionLabel(disposition: Phase7ToolDisposition): string {
  return PHASE7_DISPOSITION_LABELS[disposition];
}

/**
 * The one byte formatter for the whole surface. Deliverable sizes surface in
 * two places — the tool-activity strip summary and the deliverable card — and
 * they must agree, so both sides (fixtures, live projection, and the browser
 * components) format through here rather than rolling their own division.
 */
export function phase7FormatBytes(byteSize: number): string {
  if (byteSize < 1024) return `${byteSize} B`;
  if (byteSize < 1024 * 1024) return `${(byteSize / 1024).toFixed(1)} kB`;
  return `${(byteSize / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Authorization denials that the agent actually hit. Drives the `Evidence`
 * badge (§2.2) and reads straight off authorization records — the browser never
 * decides whether something was denied.
 *
 * Exposure-phase denials are excluded on purpose: withholding an ungranted
 * operation from the tool list is the normal, expected path (it is what §7's
 * `Control plane — not exposed` list renders), so badging it would cry wolf on
 * every turn. Only invocation-phase denials mean the model was refused.
 */
export function phase7DenialCount(
  evidence: Phase7EvidenceModel,
  turnId: string | null,
): number {
  return evidence.authorization.filter(
    (record) =>
      !record.allowed &&
      record.phase === "invocation" &&
      (turnId === null || record.turnId === turnId),
  ).length;
}
