import { cn } from "@/lib/utils";
import { MarkdownBody } from "@/components/MarkdownBody";
import type { TaskChatMessageItem } from "./task-chat-model";

interface TaskChatBubbleProps {
  item: TaskChatMessageItem;
}

/** Brand agent-gradient count (mirrors AgentCapsule's token pairs in index.css). */
const GRADIENT_COUNT = 10;

function capsuleGradient(index: number | undefined): string {
  const n = Math.trunc(index ?? 1);
  const idx = ((((n - 1) % GRADIENT_COUNT) + GRADIENT_COUNT) % GRADIENT_COUNT) + 1;
  return `linear-gradient(to bottom, var(--agent-${idx}a), var(--agent-${idx}b))`;
}

/**
 * Author-typed message row — the primary legibility signal. Human messages sit
 * right in a solid accent bubble; agent messages sit left in a neutral card
 * bubble with a capsule-avatar author header (textless vertical brand-gradient
 * capsule + name · mode chip, per the v3/v6 prototype decisions); system
 * notices are centered and recede.
 */
export function TaskChatBubble({ item }: TaskChatBubbleProps) {
  if (item.author === "system") {
    return (
      <div className="tc-enter-bubble flex justify-center py-1">
        <p className="max-w-(--pct-85) text-center text-xs text-muted-foreground">{item.text}</p>
      </div>
    );
  }

  const isHuman = item.author === "human";
  return (
    <div className={cn("tc-enter-bubble group flex w-full flex-col gap-1", isHuman ? "items-end" : "items-start")}>
      {!isHuman && item.authorName ? (
        <span className="flex items-center gap-2 px-1">
          <span
            aria-hidden="true"
            data-testid="task-chat-agent-capsule"
            className="inline-block h-6 w-2.5 shrink-0 rounded-full"
            style={{ background: capsuleGradient(item.agentGradient) }}
          />
          <span className="text-sm font-semibold text-foreground">{item.authorName}</span>
          {item.modeLabel ? (
            <span className="rounded-full border border-border px-2 py-px text-(length:--text-micro) font-medium text-muted-foreground">
              {item.modeLabel}
            </span>
          ) : null}
        </span>
      ) : null}
      <div
        className={cn(
          "max-w-(--pct-85) break-words px-3.5 py-2 text-sm",
          isHuman
            ? "rounded-2xl rounded-br-sm bg-(--liveness-blue) text-white"
            : "rounded-2xl rounded-bl-sm bg-(--bubble-agent) text-foreground",
          item.optimistic ? "opacity-80" : null,
        )}
      >
        <MarkdownBody softBreaks linkIssueReferences>
          {item.text}
        </MarkdownBody>
        {item.streaming ? (
          <span className="tc-cursor ml-0.5 inline-block h-3.5 w-1.5 translate-y-0.5 bg-current align-baseline" />
        ) : null}
      </div>
      {item.optimistic ? (
        <span className="px-1 text-(length:--text-micro) text-muted-foreground">
          {item.optimistic === "queued" ? "Queued" : "Sending…"}
        </span>
      ) : item.timestamp ? (
        <span className="px-1 text-(length:--text-micro) text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100">
          {item.timestamp}
        </span>
      ) : null}
    </div>
  );
}
