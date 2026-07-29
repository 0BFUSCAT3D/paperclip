import { cn } from "@/lib/utils";
import type { TaskChatItem } from "./task-chat-model";
import { TaskChatBubble } from "./TaskChatBubble";
import { TaskChatMarker } from "./TaskChatMarker";
import { TaskChatStatusPill } from "./TaskChatStatusPill";
import { TaskChatToolCard } from "./TaskChatToolCard";
import { TaskChatThinkingBlock } from "./TaskChatThinkingBlock";
import { TaskChatUsageReadout } from "./TaskChatUsageReadout";
import { TaskMessageScroller } from "./TaskMessageScroller";

interface TaskChatThreadViewProps {
  items: TaskChatItem[];
  onApprovalDecision?: (statusItemId: string, optionId: string) => void;
  className?: string;
  /** When false, render the list without the scroll container (e.g. previews). */
  scroll?: boolean;
}

function renderItem(
  item: TaskChatItem,
  onApprovalDecision?: (statusItemId: string, optionId: string) => void,
) {
  switch (item.kind) {
    case "message":
      return <TaskChatBubble item={item} />;
    case "marker":
      return <TaskChatMarker item={item} />;
    case "thinking":
      return <TaskChatThinkingBlock item={item} />;
    case "tool":
      return <TaskChatToolCard item={item} />;
    case "status":
      return (
        <TaskChatStatusPill
          item={item}
          onApprovalDecision={(optionId) => onApprovalDecision?.(item.id, optionId)}
        />
      );
    case "usage":
      return <TaskChatUsageReadout item={item} />;
    default: {
      // Exhaustiveness guard: a new item kind must add a branch above.
      const _never: never = item;
      return _never;
    }
  }
}

/**
 * Presentational render layer for the redesigned task thread. Consumed by both
 * the live thread (adapter over comment/run props) and the dev harness
 * (synthetic fixtures). Owns no data fetching — it maps a normalized
 * TaskChatItem[] onto the primitives inside the auto-follow scroller.
 */
export function TaskChatThreadView({
  items,
  onApprovalDecision,
  className,
  scroll = true,
}: TaskChatThreadViewProps) {
  const body = (
    <div className={cn("flex flex-col gap-3 px-3 py-4", className)}>
      {items.map((item) => (
        <div key={item.id}>{renderItem(item, onApprovalDecision)}</div>
      ))}
    </div>
  );

  if (!scroll) return body;

  // Include a cheap content signature so streaming growth (text lengthening
  // without the item count changing) still advances the auto-follow key.
  const contentKey = items.reduce((acc, it) => {
    if (it.kind === "message") return acc + it.text.length;
    if (it.kind === "thinking") return acc + it.lines.reduce((n, l) => n + l.length, 0);
    if (it.kind === "tool") return acc + (it.diff?.lines?.length ?? 0) + (it.status === "completed" ? 1 : 0);
    return acc + 1;
  }, items.length);

  return <TaskMessageScroller contentKey={contentKey}>{body}</TaskMessageScroller>;
}
