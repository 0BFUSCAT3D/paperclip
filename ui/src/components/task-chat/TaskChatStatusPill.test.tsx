// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lineScrollOffset, TaskChatStatusPill } from "./TaskChatStatusPill";
import { whimsyWord, WHIMSY_ROTATE_MS } from "./status-whimsy";
import type { TaskChatStatusItem } from "./task-chat-model";

function liveStatus(overrides: Partial<TaskChatStatusItem> = {}): TaskChatStatusItem {
  return {
    id: "run-42:status",
    kind: "status",
    status: "running",
    label: "Running",
    startedAtMs: Date.now(),
    ...overrides,
  };
}

describe("TaskChatStatusPill whimsy", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  const render = (item: TaskChatStatusItem) => {
    act(() => {
      root.render(<TaskChatStatusPill item={item} />);
    });
  };

  it("swaps the generic Running label for a deterministic whimsical word", () => {
    const item = liveStatus();
    render(item);
    const expected = whimsyWord(item.id, 0);
    expect(container.textContent).toContain(`${expected}…`);
    expect(container.textContent).not.toContain("Running…");
  });

  it("rotates the word roughly every 10s while live", () => {
    const item = liveStatus();
    render(item);
    const first = whimsyWord(item.id, 0);
    expect(container.textContent).toContain(`${first}…`);
    act(() => {
      vi.advanceTimersByTime(WHIMSY_ROTATE_MS + 100);
    });
    const second = whimsyWord(item.id, WHIMSY_ROTATE_MS + 100);
    expect(second).not.toBe(first);
    expect(container.textContent).toContain(`${second}…`);
    expect(container.textContent).not.toContain(`${first}…`);
  });

  it("keeps the informative taxonomy verb when the tail identifies a real tool", () => {
    render(
      liveStatus({
        label: "Running a command",
        detail: "Terminal · ls -la",
        toolName: "Bash",
      }),
    );
    expect(container.textContent).toContain("Running a command…");
    expect(container.textContent).toContain("Terminal · ls -la");
  });

  it("keeps Queued copy untouched", () => {
    render(liveStatus({ label: "Queued", detail: "Waiting to start" }));
    expect(container.textContent).toContain("Queued…");
  });

  it("keeps elapsed and token readouts alongside the whimsical word", () => {
    const item = liveStatus({ tokens: { used: 18240, size: 200000 } });
    render(item);
    act(() => {
      vi.advanceTimersByTime(1200);
    });
    expect(container.textContent).toContain("1.2s");
    expect(container.textContent).toContain("18,240/200,000 ctx");
  });

  it("permanently reserves the interstitial row while live so layout never jumps (round 9)", () => {
    const item = liveStatus({ tokens: { used: 18240, size: 200000 } });
    render(item);
    // No message streaming: the row is still mounted as an empty one-line
    // slot (same height as when text occupies it) — nothing above shifts when
    // a message later appears.
    const row = container.querySelector('[data-testid="task-chat-interstitial-row"]');
    expect(row).not.toBeNull();
    expect(container.querySelector('[data-testid="task-chat-live-self-talk"]')).toBeNull();
    // The empty slot keeps the 1lh viewport height.
    expect(row?.querySelector(".tc-line-scroll")).not.toBeNull();
  });

  it("mounts a streaming interstitial as its own row above the status line (PAP-361 amended)", () => {
    const item = liveStatus({
      label: "Responding",
      selfTalk: "I'll extend the ipRateLimit helper with a per-account bucket.",
      tokens: { used: 18240, size: 200000 },
    });
    render(item);
    act(() => {
      vi.advanceTimersByTime(1200);
    });
    const row = container.querySelector('[data-testid="task-chat-interstitial-row"]');
    const line = container.querySelector('[data-testid="task-chat-live-self-talk"]');
    expect(row).not.toBeNull();
    expect(line?.textContent).toBe("I'll extend the ipRateLimit helper with a per-account bucket.");
    // The row sits DIRECTLY ABOVE the status line — never sharing it: the
    // gerund rotation runs uninterrupted below (no "Responding…" copy), with
    // meta and pulse dot in place.
    expect(row?.nextElementSibling?.textContent).toContain(`${whimsyWord(item.id, 1200)}…`);
    expect(row?.contains(line)).toBe(true);
    expect(container.textContent).not.toContain("Responding…");
    expect(container.textContent).toContain("1.2s");
    expect(container.textContent).toContain("18,240/200,000 ctx");
    expect(container.querySelector(".animate-pulse")).not.toBeNull();
    // Viewport + transition classes: 1lh clip outside, transform-only inner.
    expect(line?.className).toContain("tc-line-scroll");
    expect(line?.firstElementChild?.className).toContain("tc-line-scroll-inner");
  });

  it("slides the text out but keeps the reserved row once the interstitial completes", () => {
    const item = liveStatus({ tokens: { used: 18240, size: 200000 } });
    render(liveStatus({ label: "Responding", selfTalk: "Almost there." }));
    expect(container.querySelector('[data-testid="task-chat-live-self-talk"]')).not.toBeNull();
    render(item);
    // selfTalk gone → the text is briefly held for its slide-out…
    const held = container.querySelector('[data-testid="task-chat-interstitial-row"]');
    expect(held?.textContent).toContain("Almost there.");
    // …then the TEXT unmounts after the motion-token hold (0ms in jsdom — no
    // computed token value) while the reserved row stays in layout (round 9:
    // no jump); gerund + dot carry on below.
    act(() => {
      vi.advanceTimersByTime(50);
    });
    expect(container.querySelector('[data-testid="task-chat-interstitial-row"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="task-chat-live-self-talk"]')).toBeNull();
    expect(container.textContent).toContain(`${whimsyWord(item.id, 0)}…`);
    expect(container.querySelector(".animate-pulse")).not.toBeNull();
  });
});

describe("lineScrollOffset", () => {
  it("translates up one line-height per wrapped line", () => {
    expect(lineScrollOffset(16, 16)).toBe(0); // one line — no shift
    expect(lineScrollOffset(32, 16)).toBe(1);
    expect(lineScrollOffset(48.5, 16)).toBe(2); // sub-pixel scrollHeight rounds
  });

  it("never goes negative and guards bad measurements", () => {
    expect(lineScrollOffset(0, 16)).toBe(0);
    expect(lineScrollOffset(32, 0)).toBe(0);
    expect(lineScrollOffset(Number.NaN, 16)).toBe(0);
  });
});
