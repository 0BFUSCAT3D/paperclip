import { useState } from "react";
import { cn } from "@/lib/utils";
import { Check, ChevronDown, Send } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { workModeMetaFor, workModeMetaList } from "@/lib/work-mode-meta";
import type { IssueWorkMode } from "@paperclipai/shared";

interface TaskChatComposerProps {
  onAdd: (body: string) => Promise<void> | void;
  workMode: IssueWorkMode;
  onWorkModeChange?: (mode: IssueWorkMode) => Promise<void> | void;
  disabled?: boolean;
  disabledReason?: string | null;
  placeholder?: string;
}

/**
 * Lightweight composer for the redesigned thread. Covers the baseline
 * essentials: optimistic send (delegates to the existing onAdd mutation, which
 * already echoes locally) and the three modes — Agent / Plan / Ask — reusing
 * the app's work-mode metadata. The selected mode is applied on submit, mirroring
 * the existing composer's semantics. Advanced affordances (attachments, reassign,
 * mentions, drafts) are deferred; they're demonstrated on the legacy composer and
 * layered on post-baseline.
 */
export function TaskChatComposer({
  onAdd,
  workMode,
  onWorkModeChange,
  disabled = false,
  disabledReason,
  placeholder = "Reply",
}: TaskChatComposerProps) {
  const [body, setBody] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [pendingMode, setPendingMode] = useState<IssueWorkMode>(workMode);
  const [menuOpen, setMenuOpen] = useState(false);
  const modeMeta = workModeMetaFor(pendingMode);
  const ModeIcon = modeMeta.icon;

  async function submit() {
    const trimmed = body.trim();
    if (!trimmed || submitting || disabled) return;
    setSubmitting(true);
    setBody("");
    try {
      if (pendingMode !== workMode && onWorkModeChange) {
        await onWorkModeChange(pendingMode);
      }
      await onAdd(trimmed);
    } catch {
      setBody(trimmed); // restore on failure
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className={cn(
        "rounded-xl border bg-card p-2 shadow-(--shadow-extract-7)",
        modeMeta.classes.container || "border-border",
      )}
    >
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            void submit();
          }
        }}
        disabled={disabled}
        placeholder={disabled ? (disabledReason ?? "Composer disabled") : placeholder}
        rows={2}
        className="w-full resize-none bg-transparent px-1 py-1 text-sm outline-none placeholder:text-muted-foreground disabled:opacity-60"
        data-testid="task-chat-composer-input"
      />
      <div className="mt-1 flex items-center gap-2">
        <Popover open={menuOpen} onOpenChange={setMenuOpen}>
          <PopoverTrigger asChild>
            <button
              type="button"
              className={cn(
                "flex items-center gap-1 rounded-md border px-2 py-1 text-xs font-medium transition-colors",
                modeMeta.classes.chip,
              )}
              disabled={!onWorkModeChange}
            >
              <ModeIcon className="h-3.5 w-3.5" />
              {modeMeta.shortLabel}
              <ChevronDown className="h-3 w-3" />
            </button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-44 p-1">
            {workModeMetaList().map((m) => {
              const Icon = m.icon;
              return (
                <button
                  key={m.value}
                  type="button"
                  onClick={() => {
                    setPendingMode(m.value);
                    setMenuOpen(false);
                  }}
                  className={cn(
                    "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent",
                    m.classes.menuItem,
                  )}
                >
                  <Icon className="h-4 w-4" />
                  <span className="flex-1">{m.label}</span>
                  {m.value === pendingMode ? <Check className="h-3.5 w-3.5" /> : null}
                </button>
              );
            })}
          </PopoverContent>
        </Popover>

        <button
          type="button"
          onClick={() => void submit()}
          disabled={disabled || submitting || body.trim().length === 0}
          className="ml-auto flex items-center gap-1 rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          data-testid="task-chat-composer-send"
        >
          <Send className="h-3.5 w-3.5" />
          {submitting ? "Sending…" : "Send"}
        </button>
      </div>
    </div>
  );
}
