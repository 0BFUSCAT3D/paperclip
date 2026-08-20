import { describe, expect, it } from "vitest";
import type { ServerAdapterModule } from "@paperclipai/adapter-utils";
import {
  getServerAdapter,
  registerServerAdapter,
  resolveExternalAdapterRegistration,
  unregisterServerAdapter,
} from "./registry.js";

function collidingAdapter(type: "claude_local" | "codex_local"): ServerAdapterModule {
  return {
    type,
    subscriptionOnlyBilling: {
      supported: true,
      version: 1,
      policy: "subscription_only",
      localExecutionOnly: true,
      supportedEngines: ["cli"],
      enforcesEnvironmentTest: true,
      billingEvidence: "local_preflight_classification",
      acpSupported: false,
      exactBillingReceiptRequired: false,
      trustedHostExecutablePrerequisite: true,
    },
    inspectSubscriptionAuthAuthority: async () => { throw new Error("external inspector must not run"); },
    execute: async () => ({ exitCode: 0, signal: null, timedOut: false }),
    testEnvironment: async () => ({ adapterType: type, status: "pass", testedAt: new Date().toISOString(), checks: [] }),
  };
}

describe("built-in subscription auth authority registry", () => {
  it("wires authority inspection only for the built-in subscription adapters", () => {
    expect(getServerAdapter("claude_local")?.inspectSubscriptionAuthAuthority).toBeTypeOf("function");
    expect(getServerAdapter("codex_local")?.inspectSubscriptionAuthAuthority).toBeTypeOf("function");
    expect(getServerAdapter("process")?.inspectSubscriptionAuthAuthority).toBeUndefined();
    expect(getServerAdapter("cursor_local")?.inspectSubscriptionAuthAuthority).toBeUndefined();
  });

  it.each(["claude_local", "codex_local"] as const)("strips protected authority from init registration collision: %s", (type) => {
    const sanitized = resolveExternalAdapterRegistration(collidingAdapter(type));
    expect(sanitized.inspectSubscriptionAuthAuthority).toBeUndefined();
    expect(sanitized.subscriptionOnlyBilling).toBeUndefined();
  });

  it.each(["claude_local", "codex_local"] as const)("strips protected authority from hot registration collision and restores built-in: %s", (type) => {
    registerServerAdapter(collidingAdapter(type));
    expect(getServerAdapter(type).inspectSubscriptionAuthAuthority).toBeUndefined();
    expect(getServerAdapter(type).subscriptionOnlyBilling).toBeUndefined();
    unregisterServerAdapter(type);
    expect(getServerAdapter(type).inspectSubscriptionAuthAuthority).toBeTypeOf("function");
    expect(getServerAdapter(type).subscriptionOnlyBilling).toBeDefined();
  });
});
