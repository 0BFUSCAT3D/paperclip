import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { ChevronRight, Loader2, ShieldQuestion, OctagonX, Ban, Scissors } from "lucide-react";
import type { TaskChatStatusItem } from "./task-chat-model";
import { statusLabelIcon, toolTaxonomy } from "./tool-taxonomy";
import { isGenericStatusLabel, whimsyWord } from "./status-whimsy";

function elapsedLabel(ms?: number): string | null {
  if (ms == null) return null;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

/** Tenths-precision elapsed ("24.3s", "1m 24.3s") so the readout visibly moves. */
function liveElapsedLabel(ms?: number): string | null {
  if (ms == null) return null;
  const s = Math.max(0, ms) / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  return `${Math.floor(s / 60)}m ${(s % 60).toFixed(1)}s`;
}

/** Elapsed ms since `startedAtMs`, ticking ten times a second while `live`. */
function useLiveElapsedMs(startedAtMs: number | undefined, live: boolean): number | undefined {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (startedAtMs == null || !live) return;
    const id = window.setInterval(() => setNow(Date.now()), 100);
    return () => window.clearInterval(id);
  }, [startedAtMs, live]);
  return startedAtMs == null ? undefined : Math.max(0, now - startedAtMs);
}

/**
 * How many line-heights the streaming interstitial block is shifted up so only
 * its LAST line shows in the 1lh viewport: lines − 1 (never negative).
 */
export function lineScrollOffset(scrollHeight: number, lineHeightPx: number): number {
  if (!Number.isFinite(scrollHeight) || !Number.isFinite(lineHeightPx) || lineHeightPx <= 0) {
    return 0;
  }
  return Math.max(0, Math.round(scrollHeight / lineHeightPx) - 1);
}

/**
 * A streaming interstitial update inside a one-line-height clipped viewport.
 * One transform transition (--motion-line-scroll, transform-only, snaps under
 * reduced motion) does all the y work: the text enters by sliding up from
 * below the 1lh clip; when it wraps, the inner block translates up by whole
 * line-heights so the completed line slides out the top while the stream
 * continues on the fresh line; and when the message ends (`leaving`) it shifts
 * one further line so the last line slides out before the row unmounts. Line
 * count is measured from scrollHeight / line-height, re-checked on resize.
 */
function LiveSelfTalkLine({ text, leaving }: { text: string; leaving?: boolean }) {
  const innerRef = useRef<HTMLSpanElement | null>(null);
  const [offset, setOffset] = useState(0);
  const [entered, setEntered] = useState(false);
  useLayoutEffect(() => {
    const el = innerRef.current;
    if (!el) return;
    const measure = () => {
      const lineHeight = parseFloat(window.getComputedStyle(el).lineHeight);
      setOffset(lineScrollOffset(el.scrollHeight, lineHeight));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [text]);
  useEffect(() => {
    const id = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(id);
  }, []);
  const shift = !entered ? 1 : -offset - (leaving ? 1 : 0);
  return (
    <span className="tc-line-scroll min-w-0 flex-1" data-testid="task-chat-live-self-talk">
      <span
        ref={innerRef}
        className="tc-line-scroll-inner block"
        style={shift !== 0 ? { transform: `translateY(calc(${shift} * 1lh))` } : undefined}
      >
        {text}
      </span>
    </span>
  );
}

/**
 * Holds the streaming interstitial text briefly after it clears so the row can
 * slide out before unmounting. The hold duration is read from the same motion
 * token the slide transition uses (0 under reduced motion → instant unmount).
 */
function useHeldSelfTalk(selfTalk: string | undefined): { text: string; leaving: boolean } | null {
  const [held, setHeld] = useState<string | null>(selfTalk ?? null);
  useEffect(() => {
    if (selfTalk) {
      setHeld(selfTalk);
      return;
    }
    if (held == null) return;
    const raw = getComputedStyle(document.documentElement).getPropertyValue("--motion-line-scroll");
    const ms = Number.parseFloat(raw);
    const id = window.setTimeout(() => setHeld(null), Number.isFinite(ms) ? ms : 0);
    return () => window.clearTimeout(id);
  }, [selfTalk, held]);
  if (selfTalk) return { text: selfTalk, leaving: false };
  return held != null ? { text: held, leaving: true } : null;
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
  /**
   * When set, the live line is the header of an expandable parent row
   * (TaskChatTurn): render a trailing chevron reflecting the open state —
   * the same expand grammar as tool rows and the settled "Worked ·" line.
   */
  chevronOpen?: boolean;
}

/**
 * Lifecycle state as a status affordance (never a bubble), with a defined
 * enter transition. Live running/working states render the v7 flat statusline
 * (pulse dot + shimmering label + mono meta); Tier-B attention states keep
 * card chrome — awaiting-approval elevates with an attention pulse and
 * exposes the ACP permission options as actions.
 */
export function TaskChatStatusPill({ item, onApprovalDecision, chevronOpen }: TaskChatStatusPillProps) {
  const { Icon, spin, tone } = CONFIG[item.status];
  const awaiting = item.status === "awaiting_approval";
  const live = item.status === "running" || item.status === "working";
  const liveElapsedMs = useLiveElapsedMs(item.startedAtMs, live);
  const heldSelfTalk = useHeldSelfTalk(live ? item.selfTalk : undefined);
  const elapsed = elapsedLabel(item.elapsedMs);

  if (live) {
    const liveElapsed = liveElapsedLabel(liveElapsedMs ?? item.elapsedMs);
    // While an interstitial streams, its text lives on its OWN row above; the
    // status line below keeps the uninterrupted gerund rotation ("Responding"
    // never takes the line, and no Responding icon appears here).
    const streamingInterstitial = item.selfTalk != null;
    const ToolIcon = item.toolName
      ? toolTaxonomy(item.toolName).icon
      : streamingInterstitial
        ? null
        : statusLabelIcon(item.label);
    // Whimsy fills gaps, never replaces signal: only the generic
    // "Running"/"Working" labels — and the interstitial-streaming state, whose
    // text renders on the row above — swap for a deterministic whimsical
    // gerund (seeded by the run-scoped item id, rotating ~10s via the live
    // tick).
    const label = streamingInterstitial || isGenericStatusLabel(item.label)
      ? whimsyWord(item.id, liveElapsedMs ?? item.elapsedMs ?? 0)
      : item.label;
    const SelfTalkIcon = statusLabelIcon("Responding");
    const statusLine = (
      <div className="tc-enter-status flex items-center gap-2 py-0.5 text-xs text-muted-foreground">
        {/* Fixed-size lead slot keeps the label from moving as tool icons
            come and go; the pulse dot renders unconditionally. */}
        <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
          <span
            aria-hidden
            className="h-2 w-2 animate-pulse rounded-full bg-(--status-agent-running)"
          />
        </span>
        {ToolIcon ? <ToolIcon className="h-3.5 w-3.5 shrink-0" aria-hidden /> : null}
        {/* Text cells share a baseline row so the smaller mono readouts don't
            float above the label's baseline. */}
        <span className="flex min-w-0 flex-1 items-baseline gap-2">
          <span className="shimmer-text shimmer-text-muted shrink-0 font-medium">
            {label}…
          </span>
          {liveElapsed ? (
            <span className="shrink-0 font-mono tabular-nums text-(length:--text-micro)">
              {liveElapsed}
            </span>
          ) : null}
          {item.detail ? (
            <span className="min-w-0 truncate font-mono text-(length:--text-micro)">{item.detail}</span>
          ) : null}
          {item.tokens ? (
            <span className="ml-auto shrink-0 font-mono text-(length:--text-micro)">
              {item.tokens.used.toLocaleString()}/{item.tokens.size.toLocaleString()} ctx
            </span>
          ) : null}
        </span>
        {chevronOpen !== undefined ? (
          <ChevronRight
            className={cn("h-3 w-3 shrink-0 transition-transform", chevronOpen ? "rotate-90" : null)}
            aria-hidden
          />
        ) : null}
      </div>
    );
    if (!heldSelfTalk) return statusLine;
    // A streaming interstitial gets its own bubble-less single-line row
    // DIRECTLY ABOVE the status line — the two never share a line. The row
    // slides into / out of the 1lh viewport (LiveSelfTalkLine) when a message
    // starts/ends and unmounts after the slide-out; the empty lead slot keeps
    // its text column-aligned with the status label below.
    return (
      <div className="flex flex-col">
        <div
          className="flex items-center gap-2 py-0.5 text-xs text-muted-foreground"
          data-testid="task-chat-interstitial-row"
        >
          <span aria-hidden className="h-3.5 w-3.5 shrink-0" />
          {SelfTalkIcon ? <SelfTalkIcon className="h-3.5 w-3.5 shrink-0" aria-hidden /> : null}
          <LiveSelfTalkLine text={heldSelfTalk.text} leaving={heldSelfTalk.leaving} />
        </div>
        {statusLine}
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
