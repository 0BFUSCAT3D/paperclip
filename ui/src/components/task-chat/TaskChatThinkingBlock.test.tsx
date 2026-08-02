// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TaskChatThinkingBlock } from "./TaskChatThinkingBlock";
import type { TaskChatThinkingItem } from "./task-chat-model";

function thinking(overrides: Partial<TaskChatThinkingItem> = {}): TaskChatThinkingItem {
  return {
    id: "run-42:thought-1",
    kind: "thinking",
    lines: ["First, look at the failing test.", "The mock is stale."],
    ...overrides,
  };
}

describe("TaskChatThinkingBlock (PAP-359 tool-row grammar)", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render(item: TaskChatThinkingItem) {
    act(() => {
      root.render(<TaskChatThinkingBlock item={item} />);
    });
  }

  it("leads the header with the Brain icon in the tool-icon slot, no rail on the header", () => {
    render(thinking({ collapsed: true, summaryLabel: "Thought for 4s" }));
    const header = container.querySelector("button");
    expect(header).not.toBeNull();
    // Brain icon fills the same h-3.5/w-3.5 lead slot as tool-row icons.
    const icon = header?.querySelector("svg.lucide-brain");
    expect(icon).not.toBeNull();
    expect(icon?.getAttribute("class")).toContain("h-3.5");
    // The old left rail is gone from the header level.
    expect(header?.className).not.toContain("border-l-2");
    expect(container.firstElementChild?.className).not.toContain("border-l-2");
    expect(container.textContent).toContain("Thought for 4s");
  });

  it("streams open with the shimmering Thinking… label and rails only the body", () => {
    render(thinking({ streaming: true }));
    const shimmer = container.querySelector(".shimmer-text");
    expect(shimmer?.textContent).toBe("Thinking…");
    // Body is expanded and keeps the recessed inset rail.
    expect(container.textContent).toContain("First, look at the failing test.");
    const body = container.querySelector("div.border-l-2");
    expect(body).not.toBeNull();
    expect(body?.contains(container.querySelector("button"))).toBe(false);
  });

  it("settled history arrives collapsed and toggles on click with aria-expanded", () => {
    render(thinking({ collapsed: true, summaryLabel: "Thought for 4s" }));
    const header = container.querySelector("button")!;
    expect(header.getAttribute("aria-expanded")).toBe("false");
    expect(container.textContent).not.toContain("The mock is stale.");
    act(() => {
      header.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(header.getAttribute("aria-expanded")).toBe("true");
    expect(container.textContent).toContain("The mock is stale.");
    act(() => {
      header.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(header.getAttribute("aria-expanded")).toBe("false");
    expect(container.textContent).not.toContain("The mock is stale.");
  });
});
