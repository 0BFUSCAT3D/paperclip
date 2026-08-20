import { describe, expect, it } from "vitest";
import { createAgentSchema, updateAgentSchema } from "./agent.js";

describe("agent adapter config ownership", () => {
  const create = {
    name: "Agent", adapterType: "claude_local", adapterConfig: { billingPolicy: "subscription_only" },
  };

  it("accepts the sole enabled value and the UI's empty unset value on create", () => {
    expect(createAgentSchema.safeParse(create).success).toBe(true);
    expect(createAgentSchema.safeParse({ ...create, adapterConfig: { billingPolicy: "" } }).success).toBe(true);
  });

  it("leaves adapter-specific billing validation to the server capability route", () => {
    expect(createAgentSchema.safeParse({ ...create, adapterConfig: { billingPolicy: "api" } }).success).toBe(true);
    expect(updateAgentSchema.safeParse({ adapterConfig: { billingPolicy: "metered" } }).success).toBe(true);
  });

  it("leaves runtime model-profile billingPolicy enforcement to the server", () => {
    expect(createAgentSchema.safeParse({
      ...create,
      runtimeConfig: { modelProfiles: { cheap: { adapterConfig: { billingPolicy: "subscription_only" } } } },
    }).success).toBe(true);
  });
});
