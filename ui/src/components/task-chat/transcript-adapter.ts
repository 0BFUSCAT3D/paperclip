/**
 * Live adapter: map a run's streaming TranscriptEntry[] (from
 * useLiveRunTranscripts — the same source the current thread consumes) into the
 * redesign's TaskChatItem[]. This is what lets a real task stream
 * thinking → tool → diff → responding while a run is in flight, rather than
 * only showing the final message once the turn produces a comment.
 */
import type { TranscriptEntry } from "@/adapters";
import type {
  TaskChatDiff,
  TaskChatItem,
  TaskChatToolItem,
} from "./task-chat-model";

const TERMINAL_STATUSES = new Set([
  "failed",
  "timed_out",
  "cancelled",
  "interrupted",
  "succeeded",
]);

export function isTerminalRunStatus(status: string | undefined | null): boolean {
  return status != null && TERMINAL_STATUSES.has(status);
}

function diffKind(changeType: string): "add" | "remove" | "context" {
  if (changeType === "add") return "add";
  if (changeType === "remove") return "remove";
  return "context";
}

interface TranscriptAdapterOptions {
  runId: string;
  agentName?: string;
  /** True while the run is still in flight (drives streaming cursors). */
  running: boolean;
}

/**
 * Reduce a transcript into ordered items, coalescing consecutive thinking and
 * assistant deltas and threading tool_result/diff onto their tool_call. Mirrors
 * buildAssistantPartsFromTranscript's grouping, emitting our presentation model.
 */
export function transcriptToTaskChatItems(
  entries: readonly TranscriptEntry[],
  { runId, agentName, running }: TranscriptAdapterOptions,
): TaskChatItem[] {
  const items: TaskChatItem[] = [];
  const toolIndexById = new Map<string, number>();
  let lastToolIndex = -1;
  let thinkingIndex = -1;
  let messageIndex = -1;

  const resetInline = () => {
    thinkingIndex = -1;
    messageIndex = -1;
  };

  for (const [i, entry] of entries.entries()) {
    switch (entry.kind) {
      case "thinking": {
        if (!entry.text) break;
        if (thinkingIndex >= 0) {
          const it = items[thinkingIndex];
          if (it.kind === "thinking") it.lines.push(...entry.text.split("\n"));
        } else {
          items.push({
            id: `${runId}:think:${i}`,
            kind: "thinking",
            lines: entry.text.split("\n"),
            streaming: running,
            collapsed: false,
          });
          thinkingIndex = items.length - 1;
          messageIndex = -1;
        }
        break;
      }
      case "assistant": {
        if (!entry.text) break;
        if (messageIndex >= 0) {
          const it = items[messageIndex];
          if (it.kind === "message") it.text += entry.text;
        } else {
          items.push({
            id: `${runId}:msg:${i}`,
            kind: "message",
            author: "agent",
            authorName: agentName,
            text: entry.text,
            streaming: running,
          });
          messageIndex = items.length - 1;
          thinkingIndex = -1;
        }
        break;
      }
      case "tool_call": {
        const toolCallId = entry.toolUseId || `tool-${i}`;
        const item: TaskChatToolItem = {
          id: `${runId}:tool:${toolCallId}`,
          kind: "tool",
          name: entry.name || "tool",
          status: "in_progress",
        };
        if (toolIndexById.has(toolCallId)) {
          items[toolIndexById.get(toolCallId)!] = item;
          lastToolIndex = toolIndexById.get(toolCallId)!;
        } else {
          items.push(item);
          toolIndexById.set(toolCallId, items.length - 1);
          lastToolIndex = items.length - 1;
        }
        resetInline();
        break;
      }
      case "tool_result": {
        const toolCallId = entry.toolUseId || `tool-result-${i}`;
        const idx = toolIndexById.get(toolCallId);
        if (idx != null) {
          const existing = items[idx];
          if (existing.kind === "tool") {
            existing.status = entry.isError ? "failed" : "completed";
            if (entry.content && !existing.detail) {
              existing.detail = String(entry.content).slice(0, 400);
            }
          }
        }
        resetInline();
        break;
      }
      case "diff": {
        const line = { kind: diffKind(entry.changeType), text: entry.text ?? "" };
        if (lastToolIndex >= 0 && items[lastToolIndex].kind === "tool") {
          const tool = items[lastToolIndex] as TaskChatToolItem;
          const diff: TaskChatDiff = tool.diff ?? { added: 0, removed: 0, lines: [] };
          diff.lines = diff.lines ?? [];
          diff.lines.push(line);
          if (line.kind === "add") diff.added += 1;
          if (line.kind === "remove") diff.removed += 1;
          tool.diff = diff;
        } else {
          items.push({
            id: `${runId}:diff:${i}`,
            kind: "tool",
            name: "edit",
            status: "completed",
            diff: {
              added: line.kind === "add" ? 1 : 0,
              removed: line.kind === "remove" ? 1 : 0,
              lines: [line],
            },
          });
          lastToolIndex = items.length - 1;
        }
        resetInline();
        break;
      }
      // init / result / stderr / stdout / system / user carry no thread-visible
      // content in the live turn (status is rendered separately).
      default:
        break;
    }
  }

  return items;
}

/** Human-readable label for the live status pill from the tail of a transcript. */
export function deriveRunStatusLabel(entries: readonly TranscriptEntry[]): {
  label: string;
  detail?: string;
} {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.kind === "tool_call") {
      return { label: "Working", detail: `Using ${entry.name || "tool"}` };
    }
    if (entry.kind === "tool_result") break;
    if (entry.kind === "assistant") return { label: "Responding" };
    if (entry.kind === "thinking") return { label: "Thinking" };
  }
  return { label: "Running" };
}
