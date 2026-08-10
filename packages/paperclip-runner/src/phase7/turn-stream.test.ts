import { describe, expect, it } from "vitest";

import type {
  CodexAppServerTransport,
  CodexRpcNotification,
  CodexServerRequestHandler,
} from "../drivers/codex/app-server-transport.js";
import { projectPhase7IssueThread } from "../issue-thread/live-projection.js";
import type { Phase7IssueThreadSnapshot } from "../issue-thread/types.js";
import { createPhase7CleanRoomSessionInput } from "./clean-room.js";
import {
  Phase7LiveSessionService,
  type Phase7LiveSession,
  type Phase7LiveTransportFactory,
  type Phase7LiveTurnEvent,
} from "./live-session.js";
import {
  createPhase7TurnStreamDecoder,
  encodePhase7TurnStreamFrame,
  PHASE7_TURN_STREAM_MAX_FRAME_BYTES,
  PHASE7_TURN_STREAM_SCHEMA,
  Phase7TurnStreamError,
  phase7Utf8ByteLength,
  readPhase7TurnStream,
  type Phase7TurnStreamFrame,
} from "./turn-stream.js";

/**
 * Transport-level proof that a turn streams (track 7Q).
 *
 * Three assistant deltas are released one at a time, so nothing here depends on
 * a delay, a poll, or the order the event loop happens to choose. What is under
 * test is the whole path a frame takes — live session event, projected view,
 * NDJSON encode, chunked decode — against the two properties the board's
 * complaint reduces to: the reply is visible while it is still being written,
 * and what it finally says is exactly what was streamed.
 */

const DELTAS = ["Reading the ", "clean-room issue ", "and recording a status."] as const;
const FINAL_TEXT = DELTAS.join("");

/** Single-slot signal: the test releases one provider step at a time. */
class Gate {
  #waiters: Array<() => void> = [];
  #ready = 0;

  wait(): Promise<void> {
    if (this.#ready > 0) {
      this.#ready -= 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.#waiters.push(resolve));
  }

  release(): void {
    const waiter = this.#waiters.shift();
    if (waiter === undefined) this.#ready += 1;
    else waiter();
  }
}

class AsyncNotifications implements AsyncIterable<CodexRpcNotification> {
  #values: CodexRpcNotification[] = [];
  #waiters: Array<(value: IteratorResult<CodexRpcNotification>) => void> = [];
  #closed = false;

  push(value: CodexRpcNotification): void {
    const waiter = this.#waiters.shift();
    if (waiter) waiter({ value, done: false });
    else this.#values.push(value);
  }

  close(): void {
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) waiter({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<CodexRpcNotification> {
    return {
      next: async () => {
        const value = this.#values.shift();
        if (value) return { value, done: false };
        if (this.#closed) return { value: undefined, done: true };
        return new Promise((resolve) => this.#waiters.push(resolve));
      },
    };
  }
}

class GatedTransport implements CodexAppServerTransport {
  readonly queue = new AsyncNotifications();
  #closed = false;

  constructor(readonly gate: Gate) {}

  async request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (method === "initialize") return { user: { sessionId: "provider-session" } };
    if (method === "thread/start" || method === "thread/read" || method === "thread/resume") {
      return { thread: { id: "provider-thread", sessionId: "provider-session" } };
    }
    if (method === "turn/start") {
      void this.#runTurn("turn-1");
      return { turn: { id: "turn-1", status: "inProgress" } };
    }
    if (method === "turn/interrupt") {
      this.queue.push({
        method: "turn/completed",
        params: { threadId: "provider-thread", turn: { id: String(params.turnId), status: "interrupted" } },
      });
      return {};
    }
    throw new Error(`unsupported gated Codex method ${method}`);
  }

  notify(): void {}

  notifications(): AsyncIterable<CodexRpcNotification> {
    return this.queue;
  }

  setServerRequestHandler(_handler: CodexServerRequestHandler): void {}

  async close(): Promise<void> {
    this.#closed = true;
    this.queue.close();
  }

  processInfo() {
    return { pid: 7100, processGroupId: 7100, exited: this.#closed, exitCode: null, signal: null };
  }

  async #runTurn(turnId: string): Promise<void> {
    this.queue.push({
      method: "turn/started",
      params: { threadId: "provider-thread", turn: { id: turnId, status: "inProgress" } },
    });
    for (const delta of DELTAS) {
      await this.gate.wait();
      this.queue.push({
        method: "item/agentMessage/delta",
        params: { threadId: "provider-thread", turnId, delta },
      });
    }
    await this.gate.wait();
    this.queue.push({
      method: "item/completed",
      params: {
        threadId: "provider-thread",
        turnId,
        item: { id: "message-1", type: "agentMessage", text: FINAL_TEXT },
      },
    });
    this.queue.push({
      method: "turn/completed",
      params: { threadId: "provider-thread", turn: { id: turnId, status: "completed" } },
    });
  }
}

function gatedTransportFactory(gate: Gate): Phase7LiveTransportFactory {
  return (options) => {
    const evidence = {
      runnerPid: 7100,
      runnerProcessGroupId: 7100,
      codexPid: 7200,
      runnerExited: false,
      runnerExitCode: null,
      runnerSignal: null,
      childEnvironmentKeys: ["CODEX_HOME", "HOME", "PATH"],
      diagnostics: [],
    };
    options.onEvidence?.(evidence);
    return { transport: new GatedTransport(gate), evidence: () => ({ ...evidence }) };
  };
}

async function openGatedSession(gate: Gate): Promise<{
  session: Phase7LiveSession;
  close: () => Promise<void>;
}> {
  const service = new Phase7LiveSessionService({ transportFactory: gatedTransportFactory(gate) });
  const { input } = createPhase7CleanRoomSessionInput({ workingDirectory: process.cwd() });
  const session = await service.create(input);
  return { session, close: () => service.shutdown(session.id, "test complete") };
}

/** Runs the event loop until `ready` holds, so no assertion waits on a delay. */
async function settle(ready: () => boolean, attempts = 200): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (ready()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("the stream never reached the expected state");
}

/** Assistant text the projected view renders, which is what a reader sees. */
function assistantText(view: Phase7IssueThreadSnapshot): string {
  return view.turns
    .flatMap((turn) => turn.items)
    .filter((item) => item.kind === "agent_message")
    .map((item) => (item.kind === "agent_message" ? item.body : ""))
    .join("");
}

describe("Phase 7 turn stream framing", () => {
  it("round-trips frames split across arbitrary chunk boundaries", () => {
    const frames: Array<Phase7TurnStreamFrame<{ text: string }, { done: boolean }>> = [
      { schema: PHASE7_TURN_STREAM_SCHEMA, type: "frame", seq: 1, reason: "open", turnId: null, view: { text: "" } },
      { schema: PHASE7_TURN_STREAM_SCHEMA, type: "frame", seq: 2, reason: "delta", turnId: "t", view: { text: "ab\ncd" } },
      { schema: PHASE7_TURN_STREAM_SCHEMA, type: "settled", seq: 3, payload: { done: true } },
    ];
    const wire = frames.map(encodePhase7TurnStreamFrame).join("");
    const decoder = createPhase7TurnStreamDecoder<{ text: string }, { done: boolean }>();
    const decoded = [];
    // One character at a time is the worst case a socket can produce.
    for (const character of wire) decoded.push(...decoder.push(character));
    decoded.push(...decoder.flush());

    expect(decoded).toEqual(frames);
  });

  it("refuses a replayed frame, a frame after the terminal, and a truncated stream", () => {
    const frame = (seq: number): string =>
      encodePhase7TurnStreamFrame({
        schema: PHASE7_TURN_STREAM_SCHEMA,
        type: "frame",
        seq,
        reason: "delta",
        turnId: "t",
        view: {},
      });
    const settled = encodePhase7TurnStreamFrame({
      schema: PHASE7_TURN_STREAM_SCHEMA,
      type: "settled",
      seq: 5,
      payload: {},
    });

    const replayed = createPhase7TurnStreamDecoder();
    replayed.push(frame(2));
    expect(() => replayed.push(frame(2))).toThrow(Phase7TurnStreamError);

    const late = createPhase7TurnStreamDecoder();
    late.push(settled);
    expect(() => late.push(frame(6))).toThrow(/after the terminal/);

    const truncated = createPhase7TurnStreamDecoder();
    truncated.push(frame(1));
    expect(() => truncated.flush()).toThrow(/before a terminal frame/);
  });


  /**
   * The buffered-frame limit is named in bytes. It used to be enforced with
   * `String#length`, so a frame of three-byte characters could reach about
   * three times the stated cap before the decoder objected (track 7U).
   */
  it("enforces the frame limit in encoded bytes, not code units", () => {
    // Well under the cap by code units, well over it by encoded bytes.
    const multiByte = "€".repeat(Math.ceil((PHASE7_TURN_STREAM_MAX_FRAME_BYTES / 3) * 1.2));

    expect(multiByte.length).toBeLessThan(PHASE7_TURN_STREAM_MAX_FRAME_BYTES);
    expect(phase7Utf8ByteLength(multiByte)).toBeGreaterThan(PHASE7_TURN_STREAM_MAX_FRAME_BYTES);
    expect(() => createPhase7TurnStreamDecoder().push(multiByte)).toThrow(/frame limit/);
  });

  it("counts encoded bytes the way TextEncoder does, including surrogate pairs", () => {
    for (const sample of ["", "ascii", "é", "€", "𝄞", "a€𝄞z", "\u{1F600}\u{1F601}"]) {
      expect(phase7Utf8ByteLength(sample)).toBe(new TextEncoder().encode(sample).length);
    }
    // A lone surrogate is what a chunk boundary can leave in the buffer; it
    // must be counted, not crash the count.
    expect(phase7Utf8ByteLength("\uD83D")).toBe(3);
  });

  it("streams three gated deltas into growing client states that match the final text", async () => {
    const gate = new Gate();
    const { session, close } = await openGatedSession(gate);
    try {
      const events: Phase7LiveTurnEvent[] = [];
      // The wire between the server and the client: every live event is
      // projected, framed, and handed back through the decoder, so what the
      // assertions inspect is what a browser would have received.
      const decoder = createPhase7TurnStreamDecoder<Phase7IssueThreadSnapshot, { text: string }>();
      const clientStates: string[] = [];
      let terminalSeen = false;
      let statesBeforeTerminal = 0;
      let seq = 0;

      const unsubscribe = session.subscribe((event) => {
        events.push(event);
        if (event.kind !== "delta") return;
        seq += 1;
        const wire = encodePhase7TurnStreamFrame({
          schema: PHASE7_TURN_STREAM_SCHEMA,
          type: "frame",
          seq,
          reason: "delta",
          turnId: event.turnId,
          view: projectPhase7IssueThread({ snapshot: session.snapshot() }),
        });
        // Split every frame so the decoder is exercised on partial chunks.
        const half = Math.floor(wire.length / 2);
        for (const frame of [...decoder.push(wire.slice(0, half)), ...decoder.push(wire.slice(half))]) {
          if (frame.type !== "frame") continue;
          clientStates.push(assistantText(frame.view));
          if (!terminalSeen) statesBeforeTerminal += 1;
        }
      });

      const turn = session.sendMessage("Read the issue and record a status.");
      // One delta at a time, each observed by the client before the next is
      // produced. This is the property the board asked for: a reply that is
      // readable while it is still being written, not one revealed at the end.
      for (const [index, _delta] of DELTAS.entries()) {
        const before = clientStates.length;
        gate.release();
        await settle(() => clientStates.length > before);
        expect(clientStates.at(-1)).toBe(DELTAS.slice(0, index + 1).join(""));
        expect(session.snapshot().activeTurnId).not.toBeNull();
      }
      gate.release();
      const result = await turn;
      terminalSeen = true;
      unsubscribe();

      const nonEmpty = clientStates.filter((text) => text.length > 0);
      expect(statesBeforeTerminal).toBeGreaterThanOrEqual(2);
      expect(nonEmpty.length).toBeGreaterThanOrEqual(2);
      for (let index = 1; index < nonEmpty.length; index += 1) {
        // Monotonic: a later state always contains its predecessor as a prefix.
        expect(nonEmpty[index]!.startsWith(nonEmpty[index - 1]!)).toBe(true);
        expect(nonEmpty[index]!.length).toBeGreaterThanOrEqual(nonEmpty[index - 1]!.length);
      }
      // The intermediate states are real prefixes of the reply, not one
      // finished block delivered late.
      expect(nonEmpty[0]).toBe(DELTAS[0]);
      expect(nonEmpty.at(-1)).toBe(FINAL_TEXT);
      expect(DELTAS.join("")).toBe(result.assistantText);

      const terminal = events.at(-1);
      expect(terminal?.kind).toBe("terminal");
      if (terminal?.kind === "terminal") {
        expect(terminal.status).toBe("completed");
        expect(terminal.assistantText).toBe(FINAL_TEXT);
      }
      // Ordered: sequence numbers never repeat or go backwards.
      const sequences = events.map((event) => event.seq);
      expect(sequences).toEqual([...sequences].sort((left, right) => left - right));
      expect(new Set(sequences).size).toBe(sequences.length);

      // The settled transcript holds exactly one assistant entry, so the
      // streamed draft was finalised rather than duplicated.
      const finalView = projectPhase7IssueThread({ snapshot: result.snapshot });
      const messages = finalView.turns
        .flatMap((turn) => turn.items)
        .filter((item) => item.kind === "agent_message");
      expect(messages).toHaveLength(1);
      expect(assistantText(finalView)).toBe(FINAL_TEXT);
    } finally {
      await close();
    }
  });

  it("keeps the partial reply when a stopped turn never finishes its message", async () => {
    const gate = new Gate();
    const { session, close } = await openGatedSession(gate);
    try {
      const turn = session.sendMessage("Start writing, then I will stop you.");
      gate.release();
      // Wait for the first delta to reach the transcript before interrupting.
      await new Promise((resolve) => setTimeout(resolve, 5));
      await session.interrupt("operator stopped the turn");
      const result = await turn;

      expect(result.status).toBe("interrupted");
      expect(result.assistantText).toBe(DELTAS[0]!.trim());
      const view = projectPhase7IssueThread({ snapshot: result.snapshot });
      expect(assistantText(view)).toBe(DELTAS[0]!.trim());
      expect(view.turns.at(-1)?.stoppedByUser).toBe(true);
      // Nothing further is appended once the turn is terminal.
      gate.release();
      gate.release();
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(assistantText(projectPhase7IssueThread({ snapshot: session.snapshot() }))).toBe(
        DELTAS[0]!.trim(),
      );
    } finally {
      await close();
    }
  });

  it("reads a whole stream body into its settled payload", async () => {
    const wire = [
      encodePhase7TurnStreamFrame({
        schema: PHASE7_TURN_STREAM_SCHEMA,
        type: "frame",
        seq: 1,
        reason: "delta",
        turnId: "t",
        view: { text: "partial" },
      }),
      encodePhase7TurnStreamFrame({
        schema: PHASE7_TURN_STREAM_SCHEMA,
        type: "settled",
        seq: 2,
        payload: { text: "final" },
      }),
    ].join("");
    const body = new Response(wire);
    const views: string[] = [];
    const payload = await readPhase7TurnStream<{ text: string }, { text: string }>(
      body as unknown as { body: never },
      (frame) => views.push(frame.view.text),
    );

    expect(views).toEqual(["partial"]);
    expect(payload).toEqual({ text: "final" });
  });

  it("raises a server error frame as a typed stream error", async () => {
    const wire = encodePhase7TurnStreamFrame({
      schema: PHASE7_TURN_STREAM_SCHEMA,
      type: "error",
      seq: 1,
      error: "turn_failed",
      message: "the provider went away",
    });

    await expect(
      readPhase7TurnStream(new Response(wire) as unknown as { body: never }, () => undefined),
    ).rejects.toThrow(/the provider went away/);
  });
});
