import { useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Check, ChevronRight, X } from "lucide-react";
import type { TaskChatTurnItem, TaskChatTurnChildItem } from "./task-chat-model";

interface TaskChatTurnProps {
  item: TaskChatTurnItem;
  renderChild: (child: TaskChatTurnChildItem) => ReactNode;
}

/** Live-turn window: how many recent activity rows stay visible unfolded. */
export const LIVE_TURN_VISIBLE_ACTIVITY = 3;
/** Don't bother folding fewer rows than this — the fold line wouldn't save space. */
const LIVE_TURN_FOLD_MIN = 2;

function isActivityRow(child: TaskChatTurnChildItem): boolean {
  return child.kind === "tool" || child.kind === "thinking";
}

/**
 * Which rows of a LIVE (unsettled) turn fold into the "> N earlier steps"
 * group. Folds the contiguous leading run of finished activity rows —
 * completed/failed tools and thinking blocks — while keeping the most recent
 * LIVE_TURN_VISIBLE_ACTIVITY activity rows visible. Pending/in-progress tool
 * rows (including a tool still streaming its diff) never fold and end the
 * prefix, as does any non-activity row (message/status/marker/usage).
 * Thinking blocks need no own "finished" check: the adapter coalesces
 * consecutive thinking, so any block with ≥ LIVE_TURN_VISIBLE_ACTIVITY
 * activity rows after it can no longer grow.
 */
export function liveTurnFoldedIds(items: readonly TaskChatTurnChildItem[]): Set<string> {
  const eligible = items.filter(isActivityRow).length - LIVE_TURN_VISIBLE_ACTIVITY;
  const folded = new Set<string>();
  if (eligible < LIVE_TURN_FOLD_MIN) return folded;
  for (const child of items) {
    if (folded.size >= eligible) break;
    if (!isActivityRow(child)) break;
    if (child.kind === "tool" && child.status !== "completed" && child.status !== "failed") break;
    folded.add(child.id);
  }
  if (folded.size < LIVE_TURN_FOLD_MIN) folded.clear();
  return folded;
}

/** Metric segments after the label: "38s · 3 tools · +34 −3 · 12.3k tokens". */
export function turnSummaryMetrics(summary: TaskChatTurnItem["summary"]): string {
  const parts: string[] = [];
  if (summary.durationLabel) parts.push(summary.durationLabel);
  if (summary.toolCount > 0) parts.push(`${summary.toolCount} tool${summary.toolCount === 1 ? "" : "s"}`);
  if (summary.added > 0 || summary.removed > 0) parts.push(`+${summary.added} −${summary.removed}`);
  if (summary.tokensLabel) parts.push(summary.tokensLabel);
  return parts.join(" · ");
}

/** "✓ Worked · 38s · 3 tools · +34 −3 · 12.3k tokens" (parts omitted when unknown). */
export function turnSummaryText(summary: TaskChatTurnItem["summary"]): string {
  const metrics = turnSummaryMetrics(summary);
  const label = summary.failed ? "Stopped" : "Worked";
  return metrics ? `${label} · ${metrics}` : label;
}

/**
 * A live turn's activity list with the older-steps window (PAP-352). Each row
 * sits in its own .tc-turn-fold wrapper so a row entering the folded group
 * plays the same grid-rows collapse (--motion-turn-fold, zeroed under
 * prefers-reduced-motion) the settled turn uses — new rows arriving visibly
 * push the oldest visible row into the fold. The "> N earlier steps" line
 * expands the group in place. Row spacing comes from per-row inner padding
 * (not flex gap) so zero-height folded rows contribute no gaps.
 */
function LiveTurnActivity({ items, renderChild }: {
  items: TaskChatTurnChildItem[];
  renderChild: (child: TaskChatTurnChildItem) => ReactNode;
}) {
  const [stepsOpen, setStepsOpen] = useState(false);
  const foldedIds = liveTurnFoldedIds(items);
  const foldedCount = foldedIds.size;
  return (
    <div className="flex flex-col pt-1">
      {foldedCount > 0 ? (
        <button
          type="button"
          onClick={() => setStepsOpen((o) => !o)}
          aria-expanded={stepsOpen}
          className="flex items-center gap-2 px-1 py-0.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
          data-testid="task-chat-earlier-steps"
        >
          <ChevronRight className={cn("h-3 w-3 shrink-0 transition-transform", stepsOpen ? "rotate-90" : null)} />
          <span>
            {foldedCount} earlier step{foldedCount === 1 ? "" : "s"}
          </span>
        </button>
      ) : null}
      {items.map((child, index) => {
        const rowFolded = !stepsOpen && foldedIds.has(child.id);
        return (
          <div
            key={child.id}
            className="tc-turn-fold"
            data-folded={rowFolded ? "true" : "false"}
            aria-hidden={rowFolded}
            data-testid="task-chat-live-row"
          >
            <div>
              <div className={index === 0 ? undefined : "pt-2"}>{renderChild(child)}</div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/**
 * One agent turn's activity, foldable to a one-line summary once settled.
 *
 * While the turn is live it renders interleaved with no summary line, but
 * older finished activity rows fold behind "> N earlier steps" (see
 * LiveTurnActivity / liveTurnFoldedIds) so a long-running turn stays compact.
 * When it settles the activity folds behind a "✓ Worked · …" line — animated
 * (grid-rows via .tc-turn-fold, --motion-turn-fold) when the settle happens
 * on-screen, instant for turns that load already settled (the fold class only
 * transitions on state CHANGE, so first paint in the folded state never
 * animates). Clicking the summary folds/unfolds with the same motion.
 * prefers-reduced-motion zeroes the transition in CSS.
 */
export function TaskChatTurn({ item, renderChild }: TaskChatTurnProps) {
  const [open, setOpen] = useState(!item.settled);
  const [prevSettled, setPrevSettled] = useState(item.settled);

  // Live → settled transition observed while mounted: fold (animated via CSS
  // unless reduced motion). Adjusted during render (not in an effect) so the
  // fold state lands in the same commit — no unfolded flash. Turns mounted
  // already-settled start folded via the useState initializers.
  if (item.settled !== prevSettled) {
    setPrevSettled(item.settled);
    if (item.settled) setOpen(false);
  }

  const folded = item.settled && !open;
  const SummaryIcon = item.summary.failed ? X : Check;

  return (
    <div data-testid="task-chat-turn" data-settled={item.settled ? "true" : "false"}>
      {item.settled ? (
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="group flex items-center gap-2 px-1 py-0.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
          data-testid="task-chat-turn-summary"
        >
          <SummaryIcon className="h-3.5 w-3.5 shrink-0" />
          <span>{item.summary.failed ? "Stopped" : "Worked"}</span>
          {turnSummaryMetrics(item.summary) ? (
            <span className="font-mono text-(length:--text-micro)">{turnSummaryMetrics(item.summary)}</span>
          ) : null}
          <ChevronRight className={cn("h-3 w-3 shrink-0 transition-transform", open ? "rotate-90" : null)} />
        </button>
      ) : null}
      <div className="tc-turn-fold" data-folded={folded ? "true" : "false"} aria-hidden={folded}>
        <div>
          {item.settled ? (
            <div className="flex flex-col gap-2 pt-1">
              {item.items.map((child) => (
                <div key={child.id}>{renderChild(child)}</div>
              ))}
            </div>
          ) : (
            <LiveTurnActivity items={item.items} renderChild={renderChild} />
          )}
        </div>
      </div>
    </div>
  );
}
