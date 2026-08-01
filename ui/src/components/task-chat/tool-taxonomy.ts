/**
 * Shared tool taxonomy: raw ACP tool_call names ("Bash", "Grep",
 * "mcp__<server>__<tool>", …) → { family, icon, verbLabel } so the live status
 * pill, the chat tool rows, and the classic transcript all agree on which
 * glyph and verb a tool gets. The Wrench is reserved for genuinely unknown
 * tools.
 */
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
import type { LucideIcon } from "lucide-react";

export type ToolFamily =
  | "terminal"
  | "search"
  | "read"
  | "edit"
  | "web"
  | "agent"
  | "mcp"
  | "other";

export interface ToolTaxonomyEntry {
  family: ToolFamily;
  icon: LucideIcon;
  /** Progressive verb for the status pill, without the trailing ellipsis. */
  verbLabel: string;
}

/**
 * Collapse an MCP tool name ("mcp__server__tool") to its tool segment,
 * capitalized — the same rule toolDisplayName() applies. Returns null for
 * non-MCP names.
 */
export function mcpToolSegment(name: string): string | null {
  const mcp = name.match(/^mcp__[^_]+(?:_[^_]+)*__(.+)$/);
  if (!mcp) return null;
  const base = mcp[1];
  return base.charAt(0).toUpperCase() + base.slice(1);
}

const FAMILY_META: Record<Exclude<ToolFamily, "mcp">, Omit<ToolTaxonomyEntry, "family">> = {
  terminal: { icon: SquareTerminal, verbLabel: "Running a command" },
  search: { icon: FileSearch, verbLabel: "Searching" },
  read: { icon: BookOpen, verbLabel: "Reading files" },
  edit: { icon: Pencil, verbLabel: "Editing files" },
  web: { icon: Globe, verbLabel: "Fetching the web" },
  agent: { icon: Bot, verbLabel: "Delegating" },
  other: { icon: Wrench, verbLabel: "Working" },
};

function classify(n: string): Exclude<ToolFamily, "mcp"> {
  if (n === "read" || n === "notebookread") return "read";
  if (n === "edit" || n === "write" || n === "multiedit" || n === "notebookedit") return "edit";
  if (n === "bash" || n === "shell" || n === "run" || n.includes("terminal")) return "terminal";
  if (n === "grep" || n === "glob" || n.includes("search")) return "search";
  if (n.includes("fetch") || n.includes("web") || n.includes("http")) return "web";
  if (n === "task" || n === "agent") return "agent";
  return "other";
}

/** Map a raw tool name to its taxonomy entry; unknown/empty names → Wrench. */
export function toolTaxonomy(name: string | undefined | null): ToolTaxonomyEntry {
  const raw = (name ?? "").trim();
  if (!raw) return { family: "other", ...FAMILY_META.other };
  const mcpTool = mcpToolSegment(raw);
  if (mcpTool) return { family: "mcp", icon: Plug, verbLabel: `Using ${mcpTool}` };
  const family = classify(raw.toLowerCase());
  return { family, ...FAMILY_META[family] };
}
