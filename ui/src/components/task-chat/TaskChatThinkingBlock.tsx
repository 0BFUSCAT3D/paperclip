import { useState } from "react";
import { cn } from "@/lib/utils";
import { ChevronRight } from "lucide-react";
import type { TaskChatThinkingItem } from "./task-chat-model";
import { statusLabelIcon } from "./tool-taxonomy";

/**
 * Chain-of-thought (ACP agent_thought_chunk) in nested tool-row grammar
 * (PAP-359): a Brain-led header at the same level as tool rows — no rail or
 * extra indent on the header itself — whose label shimmers while streaming
 * ("Thinking…") and settles to "Thought for Ns". Clicking toggles the recessed
 * pre-wrap thought body (left-rail inset, like tool detail). Streams open;
 * settled history arrives collapsed and re-expands on click. No card chrome —
 * thinking is activity metadata, subordinate to real content.
 */
export function TaskChatThinkingBlock({ item }: { item: TaskChatThinkingItem }) {
  const [open, setOpen] = useState(!item.collapsed);
  const settledLabel = item.summaryLabel ?? "Thought process";
  const BrainIcon = statusLabelIcon("Thinking");

  return (
    <div className="flex flex-col text-xs text-muted-foreground">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="group/think -mx-1.5 flex min-w-0 items-center gap-2 rounded-sm px-1.5 py-0.5 text-left transition-colors hover:bg-muted/60 hover:text-foreground"
      >
        {BrainIcon ? <BrainIcon className="h-3.5 w-3.5 shrink-0" aria-hidden /> : null}
        {item.streaming ? (
          <span className="shimmer-text shimmer-text-muted font-medium">Thinking…</span>
        ) : (
          <span className="font-medium">{settledLabel}</span>
        )}
        <ChevronRight
          className={cn(
            "ml-auto h-3 w-3 shrink-0 opacity-0 transition-[opacity,transform] group-hover/think:opacity-80",
            open ? "rotate-90 opacity-80" : null,
          )}
          aria-hidden
        />
      </button>
      {open ? (
        <div className="ml-2.5 mt-0.5 space-y-1 border-l-2 border-border py-1 pl-2.5">
          {item.lines.map((line, i) => (
            <p
              key={i}
              className="tc-enter-cot-line whitespace-pre-wrap"
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
