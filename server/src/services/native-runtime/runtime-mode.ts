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
