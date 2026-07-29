import { cn } from "@/lib/utils";
import { Check, Loader2, X, Wrench, ShieldCheck, ShieldX } from "lucide-react";
import type { TaskChatToolItem } from "./task-chat-model";

const STATUS_ICON = {
  pending: { Icon: Loader2, spin: false, tone: "text-muted-foreground" },
  in_progress: { Icon: Loader2, spin: true, tone: "text-(--status-agent-running)" },
  completed: { Icon: Check, spin: false, tone: "text-(--status-task-icon-done)" },
  failed: { Icon: X, spin: false, tone: "text-destructive" },
} as const;

/**
 * Tool invocation card. Renders the tool name + live status glyph, an optional
 * resolved permission-decision badge, and an inline diff when present.
 */
export function TaskChatToolCard({ item }: { item: TaskChatToolItem }) {
  const { Icon, spin, tone } = STATUS_ICON[item.status];
  return (
    <div className="tc-enter-tool rounded-lg border border-border bg-card/60 text-sm">
      <div className="flex min-w-0 items-center gap-2 px-3 py-2">
        <Wrench className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate font-mono text-xs">{item.name}</span>
        {item.decision ? (
          <span
            className={cn(
              "flex shrink-0 items-center gap-1 text-(length:--text-micro)",
              item.decision === "allowed" ? "text-(--status-task-icon-done)" : "text-destructive",
            )}
          >
            {item.decision === "allowed" ? <ShieldCheck className="h-3 w-3" /> : <ShieldX className="h-3 w-3" />}
            {item.decision}
          </span>
        ) : null}
        <Icon className={cn("ml-auto h-4 w-4 shrink-0", tone, spin && "animate-spin")} />
      </div>
      {item.detail ? <p className="px-3 pb-2 text-xs text-muted-foreground">{item.detail}</p> : null}
      {item.diff ? (
        <div className="tc-reveal-diff border-t border-border px-3 py-2">
          <div className="mb-1 flex items-center gap-2 text-(length:--text-micro) text-muted-foreground">
            {item.diff.path ? <span className="truncate font-mono">{item.diff.path}</span> : null}
            <span className="ml-auto shrink-0">
              <span className="text-(--status-task-icon-done)">+{item.diff.added}</span>{" "}
              <span className="text-destructive">−{item.diff.removed}</span>
            </span>
          </div>
          {item.diff.lines?.length ? (
            <pre className="overflow-x-auto rounded bg-muted/50 p-2 text-(length:--text-micro) leading-relaxed">
              {item.diff.lines.map((l, i) => (
                <div
                  key={i}
                  className={cn(
                    l.kind === "add" && "text-(--status-task-icon-done)",
                    l.kind === "remove" && "text-destructive",
                    l.kind === "context" && "text-muted-foreground",
                  )}
                >
                  {l.kind === "add" ? "+" : l.kind === "remove" ? "−" : " "} {l.text}
                </div>
              ))}
            </pre>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
