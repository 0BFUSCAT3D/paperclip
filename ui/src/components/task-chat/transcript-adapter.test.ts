import { describe, expect, it } from "vitest";
import type { TranscriptEntry } from "@/adapters";
import { deriveRunStatusLabel, toolDisplayName } from "./transcript-adapter";

const TS = "2026-07-31T12:00:00.000Z";

function toolCall(name: string, input?: unknown): TranscriptEntry {
  return { kind: "tool_call", ts: TS, name, toolUseId: `tool-${name}`, input } as TranscriptEntry;
}

describe("deriveRunStatusLabel", () => {
  it("labels a tail tool_call with the taxonomy verb and tool · target detail", () => {
    const status = deriveRunStatusLabel([toolCall("Grep", { pattern: "ui/src/components" })]);
    expect(status.label).toBe("Searching");
    expect(status.detail).toBe("Grep · ui/src/components");
    expect(status.toolName).toBe("Grep");
  });

  it("uses family verbs per tool", () => {
    expect(deriveRunStatusLabel([toolCall("Bash", { command: "pnpm test" })]).label).toBe(
      "Running a command",
    );
    expect(deriveRunStatusLabel([toolCall("Edit", { file_path: "a.ts" })]).label).toBe(
      "Editing files",
    );
    expect(deriveRunStatusLabel([toolCall("mcp__linear__search_issues")]).label).toBe(
      "Using Search_issues",
    );
  });

  it("omits the target from the detail when the input has none", () => {
    const status = deriveRunStatusLabel([toolCall("Read")]);
    expect(status.detail).toBe("Read");
  });

  it("keeps Thinking / Responding / Running fallbacks", () => {
    expect(
      deriveRunStatusLabel([{ kind: "thinking", ts: TS, text: "hmm" } as TranscriptEntry]).label,
    ).toBe("Thinking");
    expect(
      deriveRunStatusLabel([{ kind: "assistant", ts: TS, text: "done" } as TranscriptEntry]).label,
    ).toBe("Responding");
    expect(deriveRunStatusLabel([]).label).toBe("Running");
    // A settled tool (tool_result at the tail) means "between tools" → Running.
    expect(
      deriveRunStatusLabel([
        toolCall("Bash", { command: "ls" }),
        { kind: "tool_result", ts: TS, toolUseId: "tool-Bash", content: "ok" } as TranscriptEntry,
      ]).label,
    ).toBe("Running");
  });
});

describe("toolDisplayName", () => {
  it("collapses mcp names the same way the taxonomy does", () => {
    expect(toolDisplayName("mcp__linear-server__search_issues")).toBe("Search_issues");
    expect(toolDisplayName("bash")).toBe("Bash");
    expect(toolDisplayName("")).toBe("Tool");
    expect(toolDisplayName("tool")).toBe("Tool");
  });
});
