import {
  arbitrateNativeStatusScenario,
  type NativeAuthoritativeIssueStatus,
  type NativeStatusAuthorityScenario,
} from "./status-arbiter.js";

export const NATIVE_RUNTIME_RESOLVER_VERSION = "phase6-v1" as const;

export type NativeRuntimeResolution =
  | { kind: "legacy"; resolverVersion: typeof NATIVE_RUNTIME_RESOLVER_VERSION; reason: string }
  | {
      kind: "native";
      resolverVersion: typeof NATIVE_RUNTIME_RESOLVER_VERSION;
      reason: "eligible_opt_in";
      profile: { mode: "native"; backend: "codex_app_server"; protocolVersion: 1 };
    };

export class NativeRuntimeEligibilityError extends Error {
  readonly code = "native_runtime_ineligible" as const;
  constructor(reason: string) {
    super(`Native runner profile is ineligible: ${reason}`);
    this.name = "NativeRuntimeEligibilityError";
  }
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function resolveNativeRuntimeMode(input: {
  enabled: boolean;
  runtimeConfig: unknown;
  agent: { status: string; adapterType: string | null };
  issue: { id: string; workMode: string; executionWorkspaceId?: string | null } | null;
  target: { kind?: string } | null | undefined;
  workspaceId: string | null;
}): NativeRuntimeResolution {
  const nativeRunner = record(record(input.runtimeConfig).nativeRunner);
  const mode = nativeRunner.mode;
  if (!input.enabled) {
    return { kind: "legacy", resolverVersion: NATIVE_RUNTIME_RESOLVER_VERSION, reason: "instance_flag_disabled" };
  }
  if (mode === undefined || mode === "legacy") {
    return { kind: "legacy", resolverVersion: NATIVE_RUNTIME_RESOLVER_VERSION, reason: "agent_not_opted_in" };
  }
  if (mode !== "native") throw new NativeRuntimeEligibilityError("unsupported profile mode");
  if (nativeRunner.backend !== "codex_app_server" || nativeRunner.protocolVersion !== 1) {
    throw new NativeRuntimeEligibilityError("unsupported backend or protocol version");
  }
  if (input.agent.adapterType !== "codex_local" || input.agent.status !== "active" && input.agent.status !== "running") {
    throw new NativeRuntimeEligibilityError("agent must be an active codex_local agent");
  }
  if (!input.issue || input.issue.workMode !== "standard") {
    throw new NativeRuntimeEligibilityError("run must be bound to a standard issue");
  }
  if (!input.workspaceId || input.target?.kind && input.target.kind !== "local") {
    throw new NativeRuntimeEligibilityError("a realized local workspace is required");
  }
  return {
    kind: "native",
    resolverVersion: NATIVE_RUNTIME_RESOLVER_VERSION,
    reason: "eligible_opt_in",
    profile: { mode: "native", backend: "codex_app_server", protocolVersion: 1 },
  };
}

/** Production read-model facts used by compatibility and mixed-ledger views. */
export function inspectNativeCompatibilityState(input: {
  resolution: NativeRuntimeResolution;
  nativeRecordCount: number;
  decisionCount: number;
  issueStatus: string;
  statusVersion: number;
  persistedEffectKinds: string[];
}) {
  const effects = input.persistedEffectKinds.length > 0
    ? [...input.persistedEffectKinds]
    : input.resolution.kind === "legacy"
      ? ["legacy_existing_behavior"]
      : input.nativeRecordCount === 0 && input.statusVersion === 0
        ? ["initialize_status_version_zero"]
        : [];
  return {
    mode: input.resolution.kind,
    native: input.nativeRecordCount > 0,
    hasNativeDecisionLineage: input.decisionCount > 0,
    issueStatus: input.issueStatus,
    statusVersion: input.statusVersion,
    statusAction: input.resolution.kind === "legacy" ? "legacy_finalizer" : "preserve",
    reasonCode: null,
    effects,
  } as const;
}

/** Expand-only migration evidence; it never mutates or synthesizes history. */
export function inspectNativeMigrationState(input: {
  resolution: NativeRuntimeResolution;
  nativeRecordCount: number;
  decisionCount: number;
  issueStatusBefore: string;
  issueStatusAfter: string;
  statusVersion: number;
  hasPendingReview: boolean;
}) {
  const effects = input.resolution.kind === "legacy"
    ? input.issueStatusBefore === "done"
      ? ["retain_legacy_mode", "retain_audit_lineage"]
      : ["return_native_false"]
    : input.nativeRecordCount === 0 && input.hasPendingReview && input.statusVersion > 0
      ? ["increment_status_version_once", "bind_reviewer"]
      : input.nativeRecordCount === 0
        ? ["expand_schema", "status_version_default_zero"]
        : [];
  return {
    mode: input.resolution.kind,
    native: input.nativeRecordCount > 0,
    hasSyntheticHistory: input.nativeRecordCount === 0 && input.decisionCount > 0,
    statusPreserved: input.issueStatusBefore === input.issueStatusAfter,
    statusVersion: input.statusVersion,
    statusAction: input.resolution.kind === "legacy" ? "legacy_finalizer"
      : input.hasPendingReview ? input.issueStatusAfter : "preserve",
    reasonCode: null,
    effects,
  } as const;
}

const COMPATIBILITY_STATUS_SCENARIOS = new Set<NativeStatusAuthorityScenario>([
  "safe_partial_parse", "explicit_resume_capability", "shadow_application_disabled",
  "mixed_ledger", "authorized_writer_incremented_version",
]);

export function resolveNativeCompatibilityStatus(input: {
  scenario: NativeStatusAuthorityScenario;
  priorIssueStatus: NativeAuthoritativeIssueStatus;
  agentId: string;
}) {
  if (!COMPATIBILITY_STATUS_SCENARIOS.has(input.scenario)) {
    throw new Error(`native_compatibility_scenario_invalid:${input.scenario}`);
  }
  return arbitrateNativeStatusScenario(input);
}

const MIGRATION_STATUS_SCENARIOS = new Set<NativeStatusAuthorityScenario>([
  "shadow_compute", "classified_native_legacy_divergence", "allowlisted_company_adapter_policy",
  "cohort_policy_pinned", "kill_switch_during_active_native_run",
]);

export function resolveNativeMigrationStatus(input: {
  scenario: NativeStatusAuthorityScenario;
  priorIssueStatus: NativeAuthoritativeIssueStatus;
  agentId: string;
}) {
  if (!MIGRATION_STATUS_SCENARIOS.has(input.scenario)) {
    throw new Error(`native_migration_scenario_invalid:${input.scenario}`);
  }
  return arbitrateNativeStatusScenario(input);
}
