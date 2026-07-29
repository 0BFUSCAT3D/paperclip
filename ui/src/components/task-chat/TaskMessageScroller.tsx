import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { ArrowDown } from "lucide-react";

const PIN_THRESHOLD_PX = 48;

interface TaskMessageScrollerProps {
  children: ReactNode;
  /** Value that changes whenever content that could grow the thread updates. */
  contentKey: unknown;
  className?: string;
}

/**
 * Scroll container that owns the redesign's auto-follow vs. hold-position rule.
 *
 * Explicit rule: while the viewport is pinned to the bottom (within a small
 * threshold) new content auto-follows; the moment the user scrolls up we hold
 * their position and surface a "Jump to latest" affordance instead of yanking
 * them down. Scrolling is INSTANT (not smooth) so a scroll listener cannot
 * unpin mid-animation — a known stick-to-bottom failure mode. No reflow/jump is
 * introduced during streaming because we only ever scroll when already pinned.
 */
export function TaskMessageScroller({ children, contentKey, className }: TaskMessageScrollerProps) {
  const ref = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  const [showJump, setShowJump] = useState(false);

  const isPinned = useCallback(() => {
    const el = ref.current;
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight <= PIN_THRESHOLD_PX;
  }, []);

  const scrollToBottom = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight; // instant, never smooth
  }, []);

  const handleScroll = useCallback(() => {
    const pinned = isPinned();
    pinnedRef.current = pinned;
    setShowJump(!pinned);
  }, [isPinned]);

  // Follow new content only when already pinned; otherwise hold position.
  useLayoutEffect(() => {
    if (pinnedRef.current) scrollToBottom();
  }, [contentKey, scrollToBottom]);

  useEffect(() => {
    scrollToBottom();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={ref}
        onScroll={handleScroll}
        className={cn("h-full overflow-y-auto", className)}
        data-testid="task-chat-scroller"
      >
        {children}
      </div>
      {showJump ? (
        <button
          type="button"
          onClick={() => {
            scrollToBottom();
            pinnedRef.current = true;
            setShowJump(false);
          }}
          className="tc-enter-status absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full border border-border bg-card px-3 py-1 text-xs shadow-sm hover:bg-accent/50"
        >
          <ArrowDown className="h-3.5 w-3.5" />
          Jump to latest
        </button>
      ) : null}
    </div>
  );
}
