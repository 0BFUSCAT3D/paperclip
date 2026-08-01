import { describe, expect, it } from "vitest";
import {
  BookOpen,
  Bot,
  FileSearch,
  Globe,
  Pencil,
  Plug,
  SquareTerminal,
  Wrench,
} from "lucide-react";
import { mcpToolSegment, toolTaxonomy } from "./tool-taxonomy";

describe("toolTaxonomy", () => {
  it("maps each family to its icon and verb", () => {
    expect(toolTaxonomy("Bash")).toEqual({
      family: "terminal",
      icon: SquareTerminal,
      verbLabel: "Running a command",
    });
    expect(toolTaxonomy("Shell").family).toBe("terminal");

    expect(toolTaxonomy("Grep")).toEqual({
      family: "search",
      icon: FileSearch,
      verbLabel: "Searching",
    });
    expect(toolTaxonomy("Glob").family).toBe("search");
    expect(toolTaxonomy("WebSearch").family).toBe("search");

    expect(toolTaxonomy("Read")).toEqual({
      family: "read",
      icon: BookOpen,
      verbLabel: "Reading files",
    });
    expect(toolTaxonomy("NotebookRead").family).toBe("read");

    expect(toolTaxonomy("Edit")).toEqual({
      family: "edit",
      icon: Pencil,
      verbLabel: "Editing files",
    });
    expect(toolTaxonomy("Write").family).toBe("edit");
    expect(toolTaxonomy("MultiEdit").family).toBe("edit");
    expect(toolTaxonomy("NotebookEdit").family).toBe("edit");

    expect(toolTaxonomy("WebFetch")).toEqual({
      family: "web",
      icon: Globe,
      verbLabel: "Fetching the web",
    });

    expect(toolTaxonomy("Task")).toEqual({
      family: "agent",
      icon: Bot,
      verbLabel: "Delegating",
    });
    expect(toolTaxonomy("Agent").family).toBe("agent");
  });

  it("collapses mcp__ names to a Plug entry with the tool segment verb", () => {
    const entry = toolTaxonomy("mcp__linear-server__search_issues");
    expect(entry.family).toBe("mcp");
    expect(entry.icon).toBe(Plug);
    expect(entry.verbLabel).toBe("Using Search_issues");
  });

  it("falls back to the Wrench for unknown or empty names", () => {
    expect(toolTaxonomy("SomethingNovel")).toEqual({
      family: "other",
      icon: Wrench,
      verbLabel: "Working",
    });
    expect(toolTaxonomy("")).toEqual({ family: "other", icon: Wrench, verbLabel: "Working" });
    expect(toolTaxonomy(undefined).icon).toBe(Wrench);
    expect(toolTaxonomy(null).icon).toBe(Wrench);
  });
});

describe("mcpToolSegment", () => {
  it("extracts and capitalizes the tool segment", () => {
    expect(mcpToolSegment("mcp__linear-server__search_issues")).toBe("Search_issues");
    expect(mcpToolSegment("mcp__gh__create_pr")).toBe("Create_pr");
  });

  it("returns null for non-mcp names", () => {
    expect(mcpToolSegment("Bash")).toBeNull();
    expect(mcpToolSegment("mcpish")).toBeNull();
  });
});
