import { describe, expect, it } from "vitest";
import { NativeRuntimeEligibilityError, resolveNativeRuntimeMode } from "./runtime-mode.js";

const eligible = {
  enabled: true,
  runtimeConfig: { nativeRunner: { mode: "native", backend: "codex_app_server", protocolVersion: 1 } },
  agent: { status: "running", adapterType: "codex_local" },
  issue: { id: "issue", workMode: "standard" },
  target: { kind: "local" },
  workspaceId: "workspace",
} as const;

describe("resolveNativeRuntimeMode", () => {
  it("preserves legacy as the default and as the kill-switch behavior", () => {
    expect(resolveNativeRuntimeMode({ ...eligible, runtimeConfig: {} }).kind).toBe("legacy");
    expect(resolveNativeRuntimeMode({ ...eligible, enabled: false })).toEqual(expect.objectContaining({
      kind: "legacy",
      reason: "instance_flag_disabled",
    }));
  });

  it("selects native only for an eligible explicit profile", () => {
    expect(resolveNativeRuntimeMode(eligible)).toEqual(expect.objectContaining({
      kind: "native",
      reason: "eligible_opt_in",
    }));
  });

  it("rejects an explicit native profile outside the approved boundary", () => {
    expect(() => resolveNativeRuntimeMode({ ...eligible, agent: { ...eligible.agent, adapterType: "claude_local" } }))
      .toThrow(NativeRuntimeEligibilityError);
    expect(() => resolveNativeRuntimeMode({ ...eligible, issue: { id: "issue", workMode: "skill_test" } }))
      .toThrow(NativeRuntimeEligibilityError);
    expect(() => resolveNativeRuntimeMode({ ...eligible, target: { kind: "remote" } }))
      .toThrow(NativeRuntimeEligibilityError);
  });
});
