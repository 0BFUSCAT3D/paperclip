import path from "node:path";
import type { PaperclipSkillEntry } from "@paperclipai/adapter-utils/server-utils";
import type { AcpRuntimeEvent } from "acpx/runtime";

export interface SkillInvocationContext {
  skillRoot: string;
  entries: PaperclipSkillEntry[];
}

function toolInput(event: Extract<AcpRuntimeEvent, { type: "tool_call" }>): Record<string, unknown> {
  return event.rawInput && typeof event.rawInput === "object" && !Array.isArray(event.rawInput)
    ? event.rawInput as Record<string, unknown>
    : {};
}

function stringField(input: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function entryForSkillName(entries: PaperclipSkillEntry[], name: string): PaperclipSkillEntry | null {
  const normalized = name.toLowerCase();
  return entries.find((entry) =>
    entry.key.toLowerCase() === normalized ||
    entry.runtimeName.toLowerCase() === normalized
  ) ?? null;
}

function entryForReadPath(
  entries: PaperclipSkillEntry[],
  skillRoot: string,
  readPath: string,
): PaperclipSkillEntry | null {
  const absoluteRoot = path.resolve(skillRoot);
  const relative = path.relative(absoluteRoot, path.resolve(readPath));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return null;

  const [runtimeName] = relative.split(path.sep);
  return entries.find((entry) => entry.runtimeName === runtimeName) ?? null;
}

/**
 * Best-effort ACPX invocation detection. ACP adapters do not expose a
 * cross-provider invocation contract, so this intentionally recognizes only
 * Claude-style Skill and Read calls for materialized runtime skills.
 */
export function detectInvokedSkill(
  event: AcpRuntimeEvent,
  context: SkillInvocationContext,
): PaperclipSkillEntry | null {
  if (event.type !== "tool_call") return null;

  const name = (event.title ?? "").trim().toLowerCase();
  const input = toolInput(event);
  if (name === "skill") {
    const skillName = stringField(input, "skill");
    return skillName ? entryForSkillName(context.entries, skillName) : null;
  }
  if (name === "read") {
    const readPath = stringField(input, "file_path", "path");
    return readPath ? entryForReadPath(context.entries, context.skillRoot, readPath) : null;
  }
  return null;
}
