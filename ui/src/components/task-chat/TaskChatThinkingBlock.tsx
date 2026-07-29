import { useState } from "react";
import { cn } from "@/lib/utils";
import { Brain, ChevronDown, ChevronRight } from "lucide-react";
import type { TaskChatThinkingItem } from "./task-chat-model";

/**
 * Chain-of-thought (ACP agent_thought_chunk). While streaming it renders the
 * live lines with a staggered enter; when the item reports `collapsed` it folds
 * to a "Worked for N" header that can be re-expanded. Recessed styling keeps
 * thinking visually subordinate to agent output.
 */
export function TaskChatThinkingBlock({ item }: { item: TaskChatThinkingItem }) {
  const [open, setOpen] = useState(!item.collapsed);
  const collapsedByDefault = item.collapsed === true;

  return (
    <div className="rounded-lg border border-dashed border-border/70 bg-muted/20 text-sm">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-muted-foreground"
      >
        <Brain className="h-3.5 w-3.5" />
        <span className="font-medium">
          {collapsedByDefault ? (item.summaryLabel ?? "Thought process") : item.streaming ? "Thinking…" : "Thought process"}
        </span>
        {open ? <ChevronDown className="ml-auto h-3.5 w-3.5" /> : <ChevronRight className="ml-auto h-3.5 w-3.5" />}
      </button>
      {open ? (
        <div className="space-y-1 px-3 pb-2">
          {item.lines.map((line, i) => (
            <p
              key={i}
              className={cn("tc-enter-cot-line text-xs italic text-muted-foreground")}
              style={{ animationDelay: `calc(var(--motion-cot-line-stagger) * ${i})` }}
            >
              {line}
            </p>
          ))}
          {item.streaming ? (
            <span className="tc-cursor inline-block h-3 w-1.5 bg-muted-foreground align-baseline" />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
