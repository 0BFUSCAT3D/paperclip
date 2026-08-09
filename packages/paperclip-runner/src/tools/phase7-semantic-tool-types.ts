import type {
  Phase7CommandResult,
  Phase7InteractionKind,
  Phase7JsonValue,
  Phase7SemanticCommand,
} from "../mock-core/phase7-control-plane-types.js";

export type { Phase7JsonValue } from "../mock-core/phase7-control-plane-types.js";

export type Phase7ToolDisposition = "always_agent_tool" | "optional_agent_tool";

export type Phase7OptionalCatalogGroup =
  | "discovery"
  | "delegation_dependencies"
  | "governance"
  | "cases"
  | "workspace_runtime"
  | "routines"
  | "company_skills"
  | "secrets"
  | "portability_admin"
  | "test_escape_hatch";

export type Phase7SideEffectClass =
  | "read"
  | "task_write"
  | "company_write"
  | "governance"
  | "workspace_control"
  | "secret_read"
  | "admin"
  | "test_escape_hatch";

export type Phase7IdempotencyBehavior = "none" | "required" | "recommended";

export type Phase7ToolTaskMode = "standard" | "ask" | "planning" | "skill_test";

export interface Phase7JsonSchema {
  $schema?: string;
  type?: "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";
  title?: string;
  description?: string;
  properties?: Record<string, Phase7JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | Phase7JsonSchema;
  items?: Phase7JsonSchema;
  enum?: Phase7JsonValue[];
  minLength?: number;
  minimum?: number;
  oneOf?: Phase7JsonSchema[];
}

export interface Phase7RedactionRule {
  path: string;
  replacement: "[REDACTED]" | "[SECRET_VALUE]";
  appliesTo: ReadonlyArray<"input" | "output" | "error" | "authorization_record">;
}

export type Phase7MockCommandMapping =
  | { kind: "context_read"; projection: string }
  | { kind: "snapshot_read"; projection: string }
  | { kind: "semantic_command"; commandKind: Phase7SemanticCommand["kind"] }
  | { kind: "operation_result" }
  | { kind: "mock_extension"; extension: string };

export interface Phase7SemanticToolDescriptor {
  operationId: string;
  version: 1;
  title: string;
  description: string;
  inputSchema: Phase7JsonSchema;
  outputSchema: Phase7JsonSchema;
  disposition: Phase7ToolDisposition;
  optionalGroup: Phase7OptionalCatalogGroup | null;
  requiredClaims: string[];
  allowedRoles?: string[];
  taskModes: Phase7ToolTaskMode[];
  sideEffectClass: Phase7SideEffectClass;
  idempotency: Phase7IdempotencyBehavior;
  redaction: Phase7RedactionRule[];
  mockCommandMapping: Phase7MockCommandMapping;
}

export interface Phase7ScenarioToolPolicy {
  deniedOperationIds?: string[];
  deniedClaims?: string[];
  allowedInteractionKinds?: Phase7InteractionKind[];
  allowSecretValueAccess?: boolean;
  allowGenericEscapeHatch?: boolean;
  genericEscapeHatchAllowlist?: Array<{ method: string; path: string }>;
}

export interface Phase7ToolAuthorizationContext {
  runId: string;
  actor: {
    id: string;
    role: string;
    capabilityGrants: string[];
  };
  task: {
    id: string;
    assigneeActorId: string | null;
    workMode: Phase7ToolTaskMode;
  };
  scenarioGrants: string[];
  policy?: Phase7ScenarioToolPolicy;
}

export type Phase7AuthorizationOutcome = "exposed" | "allowed" | "denied" | "absent";

export interface Phase7AuthorizationRecord {
  schema: "paperclip.phase7.authorization-record.v1";
  sequence: number;
  runId: string;
  actorId: string;
  taskId: string;
  operationId: string;
  phase: "exposure" | "invocation";
  outcome: Phase7AuthorizationOutcome;
  consideredClaims: string[];
  grantedClaims: string[];
  missingClaims: string[];
  reason: string;
  redactions: Array<{ path: string; replacement: string }>;
  resultingStateChange: {
    beforeRevision: number | null;
    afterRevision: number | null;
    entityRefs: string[];
  } | null;
}

export interface Phase7VisibleToolSet {
  schema: "paperclip.phase7.visible-tools.v1";
  tools: Phase7SemanticToolDescriptor[];
  authorizationRecords: Phase7AuthorizationRecord[];
}

export interface Phase7PolicyDenial {
  schema: "paperclip.phase7.tool-result.v1";
  ok: false;
  error: {
    code: "policy_denied" | "operation_absent" | "input_invalid" | "operation_unsupported";
    message: string;
    operationId: string;
    reason: string;
  };
  authorization: Phase7AuthorizationRecord;
}

export interface Phase7ToolSuccess {
  schema: "paperclip.phase7.tool-result.v1";
  ok: true;
  operationId: string;
  operationResultId: string;
  value: Phase7JsonValue;
  commandResult: Phase7CommandResult | null;
  authorization: Phase7AuthorizationRecord;
}

export type Phase7ToolInvocationResult = Phase7ToolSuccess | Phase7PolicyDenial;

/**
 * A result intended only for the provider/model tool-response channel.
 *
 * The distinct schema prevents this value from being assigned to an observable
 * tool-result sink. Callers receive it only by explicitly opening a
 * {@link Phase7ModelToolDelivery}; the delivery capsule itself serializes to
 * its redacted observable result.
 */
export interface Phase7ModelToolSuccess {
  schema: "paperclip.phase7.model-tool-result.v1";
  ok: true;
  operationId: string;
  operationResultId: string;
  value: Phase7JsonValue;
  commandResult: Phase7CommandResult | null;
  authorization: Phase7AuthorizationRecord;
}

export type Phase7ModelToolInvocationResult = Phase7ModelToolSuccess | Phase7PolicyDenial;

export interface Phase7ModelToolDelivery {
  /** Safe for traces, snapshots, persistence, errors, and browser payloads. */
  readonly observableResult: Phase7ToolInvocationResult;

  /** Explicitly opens the narrowly scoped provider/model delivery value. */
  readModelResult(): Phase7ModelToolInvocationResult;

  /** Accidental JSON serialization is always the observable redacted form. */
  toJSON(): Phase7ToolInvocationResult;
}

export interface Phase7ToolInvocation {
  operationId: string;
  input: Phase7JsonValue;
  idempotencyKey?: string;
}

export const PHASE7_CONTROL_PLANE_OWNED_OPERATION_IDS = [
  "checkout_task",
  "release_task",
  "select_work",
  "route_wake",
  "enforce_budget",
  "append_audit_record",
  "persist_run",
  "replay_run",
  "schedule_blocker_wake",
  "reconcile_run",
] as const;
