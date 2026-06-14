import { describe, expect, it } from "vitest";
import {
  loadDefaultAgentInstructionsBundle,
  resolveDefaultAgentInstructionsBundleRole,
} from "../services/default-agent-instructions.js";

describe("default agent instruction bundles", () => {
  it("includes the selected-agent conversation report contract in generic agent instructions", async () => {
    const bundle = await loadDefaultAgentInstructionsBundle("default");

    expect(bundle["AGENTS.md"]).toContain("## Selected-Agent Conversation Mode");
    expect(bundle["AGENTS.md"]).toContain("Report");
    expect(bundle["AGENTS.md"]).toContain("What I checked");
    expect(bundle["AGENTS.md"]).toContain("Recommendation");
    expect(bundle["AGENTS.md"]).toContain("Options");
    expect(bundle["AGENTS.md"]).toContain("suggest_tasks");
    expect(bundle["AGENTS.md"]).toContain("request_confirmation");
    expect(bundle["AGENTS.md"]).toContain("ask_user_questions");
    expect(bundle["AGENTS.md"]).toContain("Do not expose API keys");
    expect(bundle["AGENTS.md"]).toContain("I will check");
  });

  it("includes a CEO-specific board conversation contract without removing delegation boundaries", async () => {
    const bundle = await loadDefaultAgentInstructionsBundle("ceo");

    expect(bundle["AGENTS.md"]).toContain("## Board Conversation Mode");
    expect(bundle["AGENTS.md"]).toContain("not a concierge, relay, or generic chatbot");
    expect(bundle["AGENTS.md"]).toContain("Report");
    expect(bundle["AGENTS.md"]).toContain("What I checked");
    expect(bundle["AGENTS.md"]).toContain("Options");
    expect(bundle["AGENTS.md"]).toContain("Keep the CEO boundary intact");
    expect(bundle["AGENTS.md"]).toContain("you do not personally do implementation work");
  });

  it("still resolves only CEO roles to the CEO bundle", () => {
    expect(resolveDefaultAgentInstructionsBundleRole("ceo")).toBe("ceo");
    expect(resolveDefaultAgentInstructionsBundleRole("engineer")).toBe("default");
  });
});
