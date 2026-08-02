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

  it("hands the line to streaming self-talk, keeping elapsed · tokens meta (PAP-356)", () => {
    const item = liveStatus({
      label: "Responding",
      selfTalk: "I'll extend the ipRateLimit helper with a per-account bucket.",
      tokens: { used: 18240, size: 200000 },
    });
    render(item);
    act(() => {
      vi.advanceTimersByTime(1200);
    });
    const line = container.querySelector('[data-testid="task-chat-live-self-talk"]');
    expect(line).not.toBeNull();
    expect(line?.textContent).toBe("I'll extend the ipRateLimit helper with a per-account bucket.");
    // The gerund/whimsy label yields the line; the right-side meta stays put.
    expect(container.textContent).not.toContain("Responding…");
    expect(container.textContent).not.toContain(`${whimsyWord(item.id, 1200)}…`);
    expect(container.textContent).toContain("1.2s");
    expect(container.textContent).toContain("18,240/200,000 ctx");
    // Viewport + transition classes: 1lh clip outside, transform-only inner.
    expect(line?.className).toContain("tc-line-scroll");
    expect(line?.firstElementChild?.className).toContain("tc-line-scroll-inner");
    expect(line?.firstElementChild?.className).toContain("tc-typewriter-line");
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
