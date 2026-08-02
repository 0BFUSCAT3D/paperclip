import { describe, expect, it } from "vitest";
import type { TranscriptEntry } from "@/adapters";
import {
  buildTurnSummary,
  deriveRunStatusLabel,
  flattenSelfTalk,
  isNestableLiveChild,
  normalizeCommentBody,
  settledRunChildren,
  toolDisplayName,
  transcriptToTaskChatItems,
} from "./transcript-adapter";
import type { TaskChatItem } from "./task-chat-model";

const TS = "2026-07-31T12:00:00.000Z";

function toolCall(name: string, input?: unknown): TranscriptEntry {
  return { kind: "tool_call", ts: TS, name, toolUseId: `tool-${name}`, input } as TranscriptEntry;
}

describe("deriveRunStatusLabel", () => {
  it("labels a tail tool_call with the taxonomy verb and tool · target detail", () => {
    const status = deriveRunStatusLabel([toolCall("Grep", { pattern: "ui/src/components" })]);
    expect(status.label).toBe("Grepping");
    expect(status.detail).toBe("Grep · ui/src/components");
    expect(status.toolName).toBe("Grep");
  });

  it("uses family verbs per tool", () => {
    expect(deriveRunStatusLabel([toolCall("Bash", { command: "pnpm test" })]).label).toBe(
      "Running a command",
    );
    expect(deriveRunStatusLabel([toolCall("Edit", { file_path: "a.ts" })]).label).toBe(
      "Editing files",
    );
    expect(deriveRunStatusLabel([toolCall("mcp__linear__search_issues")]).label).toBe(
      "Using Search_issues",
    );
  });

  it("omits the target from the detail when the input has none", () => {
    const status = deriveRunStatusLabel([toolCall("Read")]);
    expect(status.detail).toBe("Read");
  });

  it("keeps Thinking / Responding / Running fallbacks", () => {
    expect(
      deriveRunStatusLabel([{ kind: "thinking", ts: TS, text: "hmm" } as TranscriptEntry]).label,
    ).toBe("Thinking");
    expect(
      deriveRunStatusLabel([{ kind: "assistant", ts: TS, text: "done" } as TranscriptEntry]).label,
    ).toBe("Responding");
    expect(deriveRunStatusLabel([]).label).toBe("Running");
    // A settled tool (tool_result at the tail) means "between tools" → Running.
    expect(
      deriveRunStatusLabel([
        toolCall("Bash", { command: "ls" }),
        { kind: "tool_result", ts: TS, toolUseId: "tool-Bash", content: "ok" } as TranscriptEntry,
      ]).label,
    ).toBe("Running");
  });
});

describe("toolDisplayName", () => {
  it("collapses mcp names the same way the taxonomy does", () => {
    expect(toolDisplayName("mcp__linear-server__search_issues")).toBe("Search_issues");
    expect(toolDisplayName("bash")).toBe("Bash");
    expect(toolDisplayName("")).toBe("Tool");
    expect(toolDisplayName("tool")).toBe("Tool");
  });

  it("maps acpx placeholder names to the generic Tool label", () => {
    expect(toolDisplayName("tool call")).toBe("Tool");
    expect(toolDisplayName("tool call (completed)")).toBe("Tool");
    expect(toolDisplayName("acp_tool")).toBe("Tool");
  });
});

describe("transcriptToTaskChatItems tool_call updates", () => {
  const opts = { runId: "run-1", running: false };

  function update(toolUseId: string, status: string): TranscriptEntry {
    // Mirrors what a persisted acpx tool_call_update line parses to: the
    // literal placeholder name plus a synthesized { text, status } input.
    return {
      kind: "tool_call",
      ts: TS,
      name: "tool call",
      toolUseId,
      input: { text: `tool call (${status})`, status },
    } as TranscriptEntry;
  }

  it("keeps the initial real name and target when a generic update arrives", () => {
    const items = transcriptToTaskChatItems(
      [
        toolCall("Terminal", { command: "pnpm test" }),
        update("tool-Terminal", "completed"),
        {
          kind: "tool_result",
          ts: TS,
          toolUseId: "tool-Terminal",
          toolName: "tool call",
          content: "ok",
        } as TranscriptEntry,
      ],
      opts,
    );
    expect(items).toHaveLength(1);
    const tool = items[0];
    expect(tool.kind).toBe("tool");
    if (tool.kind !== "tool") return;
    expect(tool.name).toBe("Terminal");
    expect(tool.rawName).toBe("Terminal");
    expect(tool.target).toBe("pnpm test");
    expect(tool.status).toBe("completed");
  });

  it("keeps identity on retitle and uses the invocation as the target", () => {
    // Real stored sequence: "Terminal" (pending) → retitle to the command →
    // generic "tool call" completion updates.
    const items = transcriptToTaskChatItems(
      [
        { kind: "tool_call", ts: TS, name: "Terminal", toolUseId: "tc-2" } as TranscriptEntry,
        { kind: "tool_call", ts: TS, name: "ls -la", toolUseId: "tc-2" } as TranscriptEntry,
        update("tc-2", "completed"),
      ],
      opts,
    );
    expect(items).toHaveLength(1);
    if (items[0].kind !== "tool") return;
    expect(items[0].name).toBe("Terminal");
    expect(items[0].rawName).toBe("Terminal");
    expect(items[0].target).toBe("ls -la");
  });

  it("never renders the synthesized { text, status } input as a target", () => {
    const items = transcriptToTaskChatItems([update("tc-orphan", "pending")], opts);
    expect(items).toHaveLength(1);
    if (items[0].kind !== "tool") return;
    expect(items[0].target).toBeUndefined();
  });

  it("upgrades a generic-named call when a later entry carries the real name", () => {
    const items = transcriptToTaskChatItems(
      [
        { kind: "tool_call", ts: TS, name: "tool call", toolUseId: "tc-1" } as TranscriptEntry,
        { kind: "tool_call", ts: TS, name: "Read", toolUseId: "tc-1" } as TranscriptEntry,
      ],
      opts,
    );
    expect(items).toHaveLength(1);
    if (items[0].kind !== "tool") return;
    expect(items[0].name).toBe("Read");
  });
});

describe("buildTurnSummary tool counting", () => {
  function statusEntry(toolUseId: string | undefined, status: string): TranscriptEntry {
    return {
      kind: "tool_call",
      ts: TS,
      name: "Bash",
      toolUseId,
      input: { text: `tool call (${status})`, status },
    } as TranscriptEntry;
  }

  it("counts unique tool calls, not per-status transcript entries", () => {
    // 4 real calls × 4 status changes each = 16 entries; the summary must
    // match the 4 rows the expanded list renders.
    const entries = ["tc-1", "tc-2", "tc-3", "tc-4"].flatMap((id) =>
      ["pending", "in_progress", "in_progress", "completed"].map((status) =>
        statusEntry(id, status),
      ),
    );
    expect(entries).toHaveLength(16);
    expect(buildTurnSummary(entries).toolCount).toBe(4);
  });

  it("counts id-less legacy entries once each", () => {
    const entries = [
      statusEntry(undefined, "completed"),
      statusEntry(undefined, "completed"),
      toolCall("Read"),
    ];
    expect(buildTurnSummary(entries).toolCount).toBe(3);
  });
});

describe("deriveRunStatusLabel with generic tail updates", () => {
  it("recovers the real tool name from the call's initial entry", () => {
    const status = deriveRunStatusLabel([
      toolCall("Terminal", { command: "ls -la" }),
      {
        kind: "tool_call",
        ts: TS,
        name: "tool call",
        toolUseId: "tool-Terminal",
      } as TranscriptEntry,
    ]);
    expect(status.label).toBe("Running a command");
    expect(status.toolName).toBe("Terminal");
  });

  it("treats a tail retitle as the invocation, not the identity", () => {
    const status = deriveRunStatusLabel([
      { kind: "tool_call", ts: TS, name: "Terminal", toolUseId: "tc-3" } as TranscriptEntry,
      { kind: "tool_call", ts: TS, name: "pnpm test", toolUseId: "tc-3" } as TranscriptEntry,
    ]);
    expect(status.label).toBe("Running a command");
    expect(status.toolName).toBe("Terminal");
    expect(status.detail).toBe("Terminal · pnpm test");
  });
});

describe("isNestableLiveChild", () => {
  const items: TaskChatItem[] = [
    { id: "t", kind: "tool", name: "Read", status: "completed" },
    { id: "th", kind: "thinking", lines: ["hm"] },
    { id: "u", kind: "usage", usage: { used: 1, size: 2 } },
    { id: "m", kind: "message", author: "agent", text: "finished self-talk", interstitial: true },
    { id: "mk", kind: "marker", variant: "session_start", label: "Session started" },
    { id: "s", kind: "status", status: "running", label: "Running" },
    { id: "i", kind: "interaction", interaction: {} as never },
  ];

  it("nests tool, thinking, usage and finished interstitial rows inside the live parent row", () => {
    expect(items.filter(isNestableLiveChild).map((it) => it.kind)).toEqual([
      "tool",
      "thinking",
      "usage",
      "message",
    ]);
  });

  it("keeps markers, statuses and interactions in the thread", () => {
    for (const kind of ["marker", "status", "interaction"]) {
      const item = items.find((it) => it.kind === kind)!;
      expect(isNestableLiveChild(item)).toBe(false);
    }
  });

  it("keeps the still-streaming interstitial out — it lives on the parent row's line", () => {
    expect(
      isNestableLiveChild({
        id: "m2",
        kind: "message",
        author: "agent",
        text: "typing…",
        interstitial: true,
        streaming: true,
      }),
    ).toBe(false);
  });

  it("never nests a non-interstitial message (the final reply keeps its bubble)", () => {
    expect(
      isNestableLiveChild({ id: "m3", kind: "message", author: "agent", text: "Final reply." }),
    ).toBe(false);
  });
});

describe("interstitial self-talk classification (PAP-355)", () => {
  const stream: TranscriptEntry[] = [
    { kind: "assistant", ts: TS, text: "Let me check the adapter." } as TranscriptEntry,
    toolCall("Read", { file_path: "a.ts" }),
    { kind: "assistant", ts: "2026-07-31T12:00:05.000Z", text: "Found it — fixing now." } as TranscriptEntry,
  ];

  it("tags agent messages streamed inside a live run turn as interstitial", () => {
    const messages = transcriptToTaskChatItems(stream, { runId: "run-1", running: true }).filter(
      (it) => it.kind === "message",
    );
    expect(messages).toHaveLength(2);
    for (const m of messages) {
      if (m.kind !== "message") continue;
      expect(m.interstitial).toBe(true);
    }
  });

  it("marks only the message still open at the tail as streaming", () => {
    const items = transcriptToTaskChatItems(stream, { runId: "run-1", running: true });
    const messages = items.filter((it) => it.kind === "message");
    if (messages[0].kind !== "message" || messages[1].kind !== "message") return;
    // The first message was closed by the tool call — finished self-talk that
    // nests as a settled row even while the run continues.
    expect(messages[0].streaming).toBe(false);
    expect(messages[1].streaming).toBe(true);
  });

  it("marks no message streaming when the tail is a tool call", () => {
    const items = transcriptToTaskChatItems(
      [...stream, toolCall("Bash", { command: "pnpm test" })],
      { runId: "run-1", running: true },
    );
    for (const m of items) {
      if (m.kind === "message") expect(m.streaming).toBe(false);
    }
  });

  it("tags settled-history messages interstitial too, so live and history agree", () => {
    const messages = transcriptToTaskChatItems(stream, { runId: "run-1", running: false }).filter(
      (it) => it.kind === "message",
    );
    expect(messages).toHaveLength(2);
    for (const m of messages) {
      if (m.kind !== "message") continue;
      expect(m.interstitial).toBe(true);
      expect(m.streaming).toBe(false);
    }
  });

  it("stamps atMs from the first streamed chunk for history interleaving", () => {
    const messages = transcriptToTaskChatItems(stream, { runId: "run-1", running: false }).filter(
      (it) => it.kind === "message",
    );
    if (messages[0].kind !== "message" || messages[1].kind !== "message") return;
    expect(messages[0].atMs).toBe(Date.parse(TS));
    expect(messages[1].atMs).toBe(Date.parse("2026-07-31T12:00:05.000Z"));
  });
});

describe("flattenSelfTalk", () => {
  it("strips markdown markers to one plain line", () => {
    expect(
      flattenSelfTalk("## Plan\n\nI'll **extend** the `ipRateLimit` helper:\n- read it\n- patch it"),
    ).toBe("Plan I'll extend the ipRateLimit helper: read it patch it");
  });

  it("keeps link text, drops the url, and is stream-safe on unclosed markers", () => {
    expect(flattenSelfTalk("see [the docs](https://x) for **bol")).toBe("see the docs for bol");
    expect(flattenSelfTalk("```ts\nconst a = 1;")).toBe("const a = 1;");
  });
});

describe("deriveRunStatusLabel streaming self-talk (PAP-356)", () => {
  it("returns the trailing message's flattened text with the Responding label", () => {
    const status = deriveRunStatusLabel([
      { kind: "assistant", ts: TS, text: "I'll **extend** " } as TranscriptEntry,
      { kind: "assistant", ts: TS, text: "the `ipRateLimit` helper." } as TranscriptEntry,
    ]);
    expect(status.label).toBe("Responding");
    expect(status.selfTalk).toBe("I'll extend the ipRateLimit helper.");
  });

  it("only accumulates the trailing message, not one closed by a tool call", () => {
    const status = deriveRunStatusLabel([
      { kind: "assistant", ts: TS, text: "Earlier note." } as TranscriptEntry,
      toolCall("Read", { file_path: "a.ts" }),
      { kind: "assistant", ts: TS, text: "Fresh line." } as TranscriptEntry,
    ]);
    expect(status.selfTalk).toBe("Fresh line.");
  });

  it("carries no selfTalk for tool or thinking tails", () => {
    expect(deriveRunStatusLabel([toolCall("Read")]).selfTalk).toBeUndefined();
    expect(
      deriveRunStatusLabel([{ kind: "thinking", ts: TS, text: "hm" } as TranscriptEntry]).selfTalk,
    ).toBeUndefined();
  });
});

describe("settledRunChildren (PAP-356, accepted §5.4)", () => {
  const parsed = transcriptToTaskChatItems(
    [
      { kind: "assistant", ts: TS, text: "Checking the adapter first." } as TranscriptEntry,
      toolCall("Read", { file_path: "a.ts" }),
      { kind: "assistant", ts: TS, text: "Done — the limiter is wired in." } as TranscriptEntry,
    ],
    { runId: "run-1", running: false },
  );

  it("nests self-talk between the tool rows in transcript order", () => {
    const children = settledRunChildren(parsed, { succeeded: true });
    expect(children.map((c) => c.kind)).toEqual(["message", "tool", "message"]);
  });

  it("drops messages matching a posted comment body (dedup preserved)", () => {
    const children = settledRunChildren(parsed, {
      commentBodies: new Set([normalizeCommentBody("Done —  the limiter is wired\nin.")]),
      succeeded: true,
    });
    expect(children.map((c) => c.kind)).toEqual(["message", "tool"]);
  });

  it("drops a succeeded run's trailing message when the run posted any comment", () => {
    const children = settledRunChildren(parsed, {
      commentBodies: new Set([normalizeCommentBody("A transformed version of the reply.")]),
      succeeded: true,
    });
    expect(children.map((c) => c.kind)).toEqual(["message", "tool"]);
  });

  it("keeps the trailing message for failed runs", () => {
    const children = settledRunChildren(parsed, {
      commentBodies: new Set(["unrelated"]),
      succeeded: false,
    });
    expect(children.map((c) => c.kind)).toEqual(["message", "tool", "message"]);
  });
});
