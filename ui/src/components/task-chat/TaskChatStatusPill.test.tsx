// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskChatStatusPill } from "./TaskChatStatusPill";
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

  it("keeps the gerund and glints while self-talk streams (PAP-357)", () => {
    const item = liveStatus({
      label: "Responding",
      narrating: true,
      tokens: { used: 18240, size: 200000 },
    });
    render(item);
    act(() => {
      vi.advanceTimersByTime(1200);
    });
    // Nothing new to read: the whimsy gerund holds the line (no streamed text,
    // no "Responding…" copy) and the right-side meta stays put.
    expect(container.textContent).toContain(`${whimsyWord(item.id, 1200)}…`);
    expect(container.textContent).not.toContain("Responding…");
    expect(container.textContent).toContain("1.2s");
    expect(container.textContent).toContain("18,240/200,000 ctx");
    // The status word glints via the narration shimmer class…
    const word = container.querySelector(".tc-shimmer-narrate");
    expect(word).not.toBeNull();
    expect(word?.textContent).toBe(`${whimsyWord(item.id, 1200)}…`);
    // …and the pulse dot swaps to the Responding icon for the duration.
    expect(container.querySelector('[data-testid="task-chat-narrating-icon"]')).not.toBeNull();
    expect(container.querySelector(".animate-pulse")).toBeNull();
  });

  it("carries no glint or icon swap when not narrating", () => {
    render(liveStatus({ tokens: { used: 18240, size: 200000 } }));
    expect(container.querySelector(".tc-shimmer-narrate")).toBeNull();
    expect(container.querySelector('[data-testid="task-chat-narrating-icon"]')).toBeNull();
    expect(container.querySelector(".animate-pulse")).not.toBeNull();
  });
});
