import { cn } from "@/lib/utils";
import { Loader2, ShieldQuestion, OctagonX, Ban, Scissors } from "lucide-react";
import type { TaskChatStatusItem } from "./task-chat-model";

function elapsedLabel(ms?: number): string | null {
  if (ms == null) return null;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

const CONFIG = {
  running: { Icon: Loader2, spin: true, tone: "text-(--status-agent-running)" },
  working: { Icon: Loader2, spin: true, tone: "text-(--status-agent-running)" },
  awaiting_approval: { Icon: ShieldQuestion, spin: false, tone: "text-primary" },
  interrupted: { Icon: OctagonX, spin: false, tone: "text-destructive" },
  refused: { Icon: Ban, spin: false, tone: "text-destructive" },
  truncated: { Icon: Scissors, spin: false, tone: "text-(--status-agent-paused)" },
} as const;

interface TaskChatStatusPillProps {
  item: TaskChatStatusItem;
  onApprovalDecision?: (optionId: string) => void;
}

/**
 * Lifecycle state as a status affordance (never a bubble), with a defined
 * enter transition. Live running/working states render the v7 flat statusline
 * (pulse dot + shimmering label + mono meta); Tier-B attention states keep
 * card chrome — awaiting-approval elevates with an attention pulse and
 * exposes the ACP permission options as actions.
 */
export function TaskChatStatusPill({ item, onApprovalDecision }: TaskChatStatusPillProps) {
  const { Icon, spin, tone } = CONFIG[item.status];
  const awaiting = item.status === "awaiting_approval";
  const elapsed = elapsedLabel(item.elapsedMs);

  if (item.status === "running" || item.status === "working") {
    return (
      <div className="tc-enter-status flex items-center gap-2 py-0.5 text-xs text-muted-foreground">
        <span
          aria-hidden
          className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-(--status-agent-running)"
        />
        <span className="shimmer-text shimmer-text-muted font-medium">{item.label}…</span>
        {item.detail ? (
          <span className="min-w-0 truncate font-mono text-(length:--text-micro)">{item.detail}</span>
        ) : null}
        <span className="ml-auto flex shrink-0 items-center gap-2 font-mono text-(length:--text-micro)">
          {elapsed ? <span>{elapsed}</span> : null}
          {item.tokens ? (
            <span>
              {item.tokens.used.toLocaleString()}/{item.tokens.size.toLocaleString()} ctx
            </span>
          ) : null}
        </span>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "tc-enter-status flex flex-col gap-2 rounded-lg border px-3 py-2 text-sm",
        awaiting ? "tc-approval border-primary/40 bg-primary/5" : "border-border bg-muted/40",
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        <Icon className={cn("h-4 w-4 shrink-0", tone, spin && "animate-spin")} />
        <span className="min-w-0 truncate font-medium">{item.label}</span>
        <span className="ml-auto flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
          {elapsed ? <span>{elapsed}</span> : null}
          {item.tokens ? (
            <span>
              {item.tokens.used.toLocaleString()}/{item.tokens.size.toLocaleString()} ctx
            </span>
          ) : null}
        </span>
      </div>
      {item.detail ? <p className="text-xs text-muted-foreground">{item.detail}</p> : null}
      {awaiting && item.approval ? (
        <div className="flex flex-wrap justify-end gap-2 pt-1">
          {item.approval.options.map((opt) => {
            const reject = opt.kind.startsWith("reject");
            return (
              <button
                key={opt.id}
                type="button"
                onClick={() => onApprovalDecision?.(opt.id)}
                className={cn(
                  "rounded-md border px-2.5 py-1 text-xs font-medium transition-colors",
                  reject
                    ? "border-border text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                    : "border-primary bg-primary text-primary-foreground hover:bg-primary/90",
                )}
              >
                {opt.label}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
