import type {
  Phase7FixtureState,
  Phase7JsonValue,
  Phase7WakeReason,
} from "../mock-core/phase7-control-plane-types.js";
import type {
  Phase7AuthorizationRecord,
  Phase7ScenarioToolPolicy,
  Phase7SemanticToolDescriptor,
  Phase7ToolTaskMode,
} from "../tools/phase7-semantic-tool-types.js";

/**
 * Phase 7F run-artifact contract.
 *
 * The browser scenario explorer is a read surface: every fact it renders has
 * to arrive as one of the records below, all of which are produced by the
 * Phase 7C mock control plane and the Phase 7D authorization engine. The UI
 * never computes exposure, never evaluates a claim, never diffs state, and
 * never judges parity. See `docs/design/phase-7-scenario-explorer-ux.md` §8
 * ("authority rule").
 */

export type Phase7PrimaryDisposition =
  | "control_plane_owned"
  | "always_agent_tool"
  | "optional_agent_tool";

export type Phase7AssertionClass =
  | "control_plane_invariant"
  | "agent_tool_contract"
  | "authorization_policy"
  | "combined_multi_hop"
  | "restraint_no_call";

export type Phase7ParityStatus = "pass" | "fail" | "intentional_gap" | "not_run";

export type Phase7ActorRole = "engineer" | "manager" | "reviewer" | "board";

export interface Phase7SkillElement {
  file: string;
  section: string;
  lines: string;
}

/** One row of the generated scenario index consumed by the picker. */
export interface Phase7ScenarioIndexEntry {
  id: string;
  title: string;
  group: string;
  fixture: string;
  /** Supplied by the profile table; the UI must never infer it from prose. */
  actorRole: Phase7ActorRole;
  /** Supplied by the profile table; drives task-mode tool exposure. */
  taskMode: Phase7ToolTaskMode;
  wakeReason: Phase7WakeReason;
  /** Deterministic fixture-seed selector declared by the profile table. */
  seedKind: string;
  primaryDisposition: Phase7PrimaryDisposition;
  requiredGrants: string[];
  /** Catalog claims the profile grants so the scenario can run at all. */
  scenarioClaims: string[];
  /** Scenario-scoped policy overrides evaluated by the 7D engine. */
  policy: Phase7ScenarioToolPolicy | null;
  assertionClasses: Phase7AssertionClass[];
  sourceAnchor: string;
  skillElements: Phase7SkillElement[];
  evidenceIds: string[];
  legacyMcpAliases: string[];
  expectedSemantics: string[];
  forbiddenSemantics: string[];
}

export interface Phase7ScenarioIndex {
  schema: "paperclip.phase7.scenario-index.v1";
  generatedFrom: string;
  groups: Array<{ id: string; count: number }>;
  entries: Phase7ScenarioIndexEntry[];
}

export type Phase7RunMode = "fake" | "codex";

export interface Phase7RedactionChip {
  path: string;
  replacement: string;
  rule: string;
}

interface Phase7TimelineBase {
  sequence: number;
  /** Fixture-clock instant. Never a wall clock — see UX map §7. */
  at: string;
}

export type Phase7TimelineEntry =
  | (Phase7TimelineBase & {
      kind: "agent_message";
      channel: "agent";
      text: string;
    })
  | (Phase7TimelineBase & {
      kind: "semantic_call";
      channel: "agent";
      operationId: string;
      disposition: Phase7PrimaryDisposition;
      summary: string;
      input: Phase7JsonValue;
      requiredClaims: string[];
      idempotency: string;
      idempotencyKey: string | null;
      redactions: Phase7RedactionChip[];
      escapeHatch: boolean;
      authorizationSequence: number;
    })
  | (Phase7TimelineBase & {
      kind: "semantic_result";
      channel: "agent";
      operationId: string;
      outcome: "committed" | "read" | "duplicate" | "denied" | "absent";
      summary: string;
      value: Phase7JsonValue;
      failure: { code: string; reason: string } | null;
      redactions: Phase7RedactionChip[];
      authorizationSequence: number;
      protocolEventRefs: string[];
    })
  | (Phase7TimelineBase & {
      kind: "control_plane_action";
      channel: "control_plane";
      action: string;
      summary: string;
      detail: Phase7JsonValue;
      auditRef: string | null;
      decisionRef: string | null;
      stateRevision: number;
    })
  | (Phase7TimelineBase & {
      kind: "system_note";
      channel: "system";
      note: string;
      forbiddenOperationCount: number;
    });

export interface Phase7ExposureEntry {
  operationId: string;
  title: string;
  requiredClaims: string[];
  /** For optional tools: the claim that unlocked exposure. */
  unlockedBy: string | null;
  reason: string;
}

export interface Phase7ControlPlaneCapability {
  operationId: string;
  reason: string;
}

export interface Phase7Exposure {
  schema: "paperclip.phase7.exposure.v1";
  always: Phase7ExposureEntry[];
  optional: Phase7ExposureEntry[];
  controlPlane: Phase7ControlPlaneCapability[];
  /** Operations the catalog defines but this run never exposed. */
  withheld: Phase7ExposureEntry[];
}

export type Phase7DiffDomain =
  | "tasks"
  | "comments"
  | "documents"
  | "interactions"
  | "approvals"
  | "artifacts"
  | "blockers"
  | "workspace"
  | "budget"
  | "run";

export type Phase7DiffChangeKind = "added" | "removed" | "changed";

export interface Phase7DiffFieldChange {
  field: string;
  before: string | null;
  after: string | null;
}

export interface Phase7DiffRow {
  entityId: string;
  change: Phase7DiffChangeKind;
  fields: Phase7DiffFieldChange[];
}

export interface Phase7DiffDomainSection {
  domain: Phase7DiffDomain;
  summary: string;
  changed: boolean;
  rows: Phase7DiffRow[];
  afterSnapshot: Phase7JsonValue;
}

export interface Phase7StateDiff {
  schema: "paperclip.phase7.state-diff.v1";
  beforeRevision: number;
  afterRevision: number;
  domains: Phase7DiffDomainSection[];
}

export interface Phase7ParityAssertion {
  index: number;
  assertionClass: Phase7AssertionClass;
  expectation: string;
  status: Phase7ParityStatus;
  expected: string;
  observed: string;
}

export interface Phase7ForbiddenCheck {
  semantic: string;
  invoked: boolean;
  transcriptSequence: number | null;
}

export interface Phase7IntentionalGap {
  subject: string;
  rationale: string;
}

export interface Phase7ParityReport {
  schema: "paperclip.phase7.scenario-parity.v1";
  verdict: Phase7ParityStatus;
  assertions: Phase7ParityAssertion[];
  forbidden: Phase7ForbiddenCheck[];
  intentionalGaps: Phase7IntentionalGap[];
  legacyBaselineNote: string;
  /**
   * Phase 7E's own verdict for this case when its report artifact was loaded.
   * Rendered as supplied; the explorer never re-judges it.
   */
  evalSuite: {
    available: boolean;
    status: Phase7ParityStatus;
    semanticOperation: string | null;
    authorizationDecision: string | null;
    stateDiff: string[];
  };
}

export interface Phase7RunArtifact {
  schema: "paperclip.phase7.run-artifact.v1";
  scenarioId: string;
  mode: Phase7RunMode;
  runId: string;
  actor: { id: string; name: string; role: string; capabilityGrants: string[] };
  task: { id: string; identifier: string; title: string; workMode: Phase7ToolTaskMode };
  wake: { reason: Phase7WakeReason; payload: Phase7JsonValue };
  budget: { limitCents: number; spentCents: number; remainingCents: number };
  timeline: Phase7TimelineEntry[];
  exposure: Phase7Exposure;
  authorizationRecords: Phase7AuthorizationRecord[];
  diff: Phase7StateDiff;
  parity: Phase7ParityReport;
  /** Harness failure, if the scenario could not be executed to completion. */
  failure: { message: string } | null;
}

export interface Phase7SnapshotPair {
  before: Phase7FixtureState;
  after: Phase7FixtureState;
}

export type Phase7CatalogTool = Phase7SemanticToolDescriptor;
