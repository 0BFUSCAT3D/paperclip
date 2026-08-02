// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TaskChatTurn, liveTurnFoldedIds, turnSummaryText } from "./TaskChatTurn";
import { buildTurnSummary } from "./transcript-adapter";
import type { TranscriptEntry } from "@/adapters";
import type { TaskChatToolStatus, TaskChatTurnChildItem, TaskChatTurnItem } from "./task-chat-model";

const tool = (id: string, status: TaskChatToolStatus = "completed"): TaskChatTurnChildItem => ({
  id,
  kind: "tool",
  name: "Read",
  status,
});

const thinking = (id: string): TaskChatTurnChildItem => ({ id, kind: "thinking", lines: ["hm"] });

const SETTLED: TaskChatTurnItem = {
  id: "t1",
  kind: "turn",
  settled: true,
  summary: { durationLabel: "38s", toolCount: 3, added: 34, removed: 3, tokensLabel: "12.3k tokens" },
  items: [{ id: "c1", kind: "tool", name: "read auth.ts", status: "completed" }],
};

describe("turnSummaryText", () => {
  it("joins the known parts with dots", () => {
    expect(turnSummaryText(SETTLED.summary)).toBe("Worked · 38s · 3 tools · +34 −3 · 12.3k tokens");
  });

  it("omits unknown parts and singularizes one tool", () => {
    expect(turnSummaryText({ toolCount: 1, added: 0, removed: 0 })).toBe("Worked · 1 tool");
  });

  it("labels failed turns Stopped", () => {
    expect(turnSummaryText({ toolCount: 0, added: 0, removed: 0, failed: true })).toBe("Stopped");
  });
});

describe("buildTurnSummary", () => {
  it("counts tools, diff lines and result tokens from a transcript", () => {
    const entries: TranscriptEntry[] = [
      { kind: "tool_call", ts: "2026-07-29T10:00:00Z", name: "edit", input: {} },
      { kind: "diff", ts: "2026-07-29T10:00:05Z", changeType: "add", text: "+a" },
      { kind: "diff", ts: "2026-07-29T10:00:05Z", changeType: "remove", text: "-b" },
      {
        kind: "result", ts: "2026-07-29T10:00:38Z", text: "done", inputTokens: 12000,
        outputTokens: 300, cachedTokens: 0, costUsd: 0.01, subtype: "success", isError: false, errors: [],
      },
    ];
    const summary = buildTurnSummary(entries);
    expect(summary.toolCount).toBe(1);
    expect(summary.added).toBe(1);
    expect(summary.removed).toBe(1);
    expect(summary.tokensLabel).toBe("12.3k tokens");
    expect(summary.durationLabel).toBe("38s");
  });

  it("prefers an explicit duration and flags failure", () => {
    const summary = buildTurnSummary([], { durationMs: 95_000, failed: true });
    expect(summary.durationLabel).toBe("1m 35s");
    expect(summary.failed).toBe(true);
  });
});

describe("liveTurnFoldedIds", () => {
  it("keeps everything visible while the window fits", () => {
    // 4 activity rows → only 1 would fold, below the 2-row minimum.
    expect(liveTurnFoldedIds(["a", "b", "c", "d"].map((id) => tool(id))).size).toBe(0);
  });

  it("folds finished rows past the 3-row tail window", () => {
    const ids = liveTurnFoldedIds(["a", "b", "c", "d", "e", "f"].map((id) => tool(id)));
    expect([...ids]).toEqual(["a", "b", "c"]);
  });

  it("counts thinking blocks as foldable activity", () => {
    const ids = liveTurnFoldedIds([thinking("t1"), tool("a"), tool("b"), tool("c"), tool("d"), tool("e")]);
    expect([...ids]).toEqual(["t1", "a", "b"]);
  });

  it("keeps the in-flight tool visible even past the window", () => {
    const items = [tool("a"), tool("b"), tool("c"), tool("d"), tool("e", "in_progress")];
    expect([...liveTurnFoldedIds(items)]).toEqual(["a", "b"]);
  });

  it("an early in-flight tool ends the foldable prefix", () => {
    const items = [tool("a"), tool("b", "in_progress"), tool("c"), tool("d"), tool("e"), tool("f"), tool("g")];
    // Only "a" precedes the in-flight row — below the fold minimum, nothing folds.
    expect(liveTurnFoldedIds(items).size).toBe(0);
  });

  it("non-activity rows end the foldable prefix", () => {
    const message: TaskChatTurnChildItem = { id: "m", kind: "message", author: "agent", text: "hi" };
    const items = [tool("a"), tool("b"), message, tool("c"), tool("d"), tool("e"), tool("f"), tool("g")];
    expect([...liveTurnFoldedIds(items)]).toEqual(["a", "b"]);
  });

  it("folds failed rows too — terminal is what matters", () => {
    const ids = liveTurnFoldedIds([tool("a", "failed"), tool("b"), tool("c"), tool("d"), tool("e"), tool("f")]);
    expect([...ids]).toEqual(["a", "b", "c"]);
  });
});

describe("TaskChatTurn", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    flushSync(() => root.unmount());
    container.remove();
  });

  const renderTurn = (item: TaskChatTurnItem) => {
    flushSync(() => {
      root.render(<TaskChatTurn item={item} renderChild={(c) => <span>{c.id}</span>} />);
    });
  };

  const fold = () => container.querySelector(".tc-turn-fold");
  const summaryBtn = () =>
    container.querySelector<HTMLButtonElement>('[data-testid="task-chat-turn-summary"]');

  it("renders a settled turn folded with its summary line", () => {
    renderTurn(SETTLED);
    // Label and mono metrics are adjacent spans (v7 runsum grammar).
    expect(summaryBtn()?.textContent).toContain("Worked");
    expect(summaryBtn()?.textContent).toContain("38s · 3 tools · +34 −3 · 12.3k tokens");
    expect(fold()?.getAttribute("data-folded")).toBe("true");
  });

  it("toggles open on summary click", () => {
    renderTurn(SETTLED);
    flushSync(() => summaryBtn()!.click());
    expect(fold()?.getAttribute("data-folded")).toBe("false");
  });

  it("renders a live turn expanded with no summary line", () => {
    renderTurn({ ...SETTLED, settled: false });
    expect(summaryBtn()).toBeNull();
    expect(fold()?.getAttribute("data-folded")).toBe("false");
  });

  it("folds when the item settles while mounted", () => {
    renderTurn({ ...SETTLED, settled: false });
    renderTurn({ ...SETTLED, animateFold: true });
    expect(fold()?.getAttribute("data-folded")).toBe("true");
  });

  const liveTurn = (children: TaskChatTurnChildItem[]): TaskChatTurnItem => ({
    ...SETTLED,
    settled: false,
    items: children,
  });
  const stepsBtn = () =>
    container.querySelector<HTMLButtonElement>('[data-testid="task-chat-earlier-steps"]');
  const foldedRows = () =>
    container.querySelectorAll('[data-testid="task-chat-live-row"][data-folded="true"]');

  it("shows no earlier-steps line while the live window fits", () => {
    renderTurn(liveTurn(["a", "b", "c", "d"].map((id) => tool(id))));
    expect(stepsBtn()).toBeNull();
    expect(foldedRows().length).toBe(0);
  });

  it("folds older completed rows behind an earlier-steps line", () => {
    renderTurn(liveTurn(["a", "b", "c", "d", "e", "f"].map((id) => tool(id))));
    expect(stepsBtn()?.textContent).toContain("3 earlier steps");
    expect(foldedRows().length).toBe(3);
  });

  it("expands the folded group in place on click", () => {
    renderTurn(liveTurn(["a", "b", "c", "d", "e", "f"].map((id) => tool(id))));
    flushSync(() => stepsBtn()!.click());
    expect(stepsBtn()?.getAttribute("aria-expanded")).toBe("true");
    expect(foldedRows().length).toBe(0);
  });

  it("a newly arriving row pushes the oldest visible row into the fold", () => {
    const ids = ["a", "b", "c", "d", "e", "f"];
    renderTurn(liveTurn(ids.map((id) => tool(id))));
    expect(foldedRows().length).toBe(3);
    renderTurn(liveTurn([...ids, "g"].map((id) => tool(id))));
    expect(foldedRows().length).toBe(4);
  });

  it("never renders the earlier-steps line on a settled turn", () => {
    renderTurn({ ...SETTLED, items: ["a", "b", "c", "d", "e", "f"].map((id) => tool(id)) });
    expect(stepsBtn()).toBeNull();
  });
});
