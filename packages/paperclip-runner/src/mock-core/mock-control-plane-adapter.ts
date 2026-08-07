import type {
  AppendedEventReceipt,
  ControlPlanePort,
  OpenControlPlaneRunInput,
} from "../contracts/control-plane-port.js";
import type { NativeRunEvent, NativeRunResult } from "../contracts/types.js";

export interface MockControlPlaneSnapshot {
  lifecycle: "stopped" | "running";
  openedRun: OpenControlPlaneRunInput | null;
  events: NativeRunEvent[];
  result: NativeRunResult | null;
}

/** In-memory control-plane shell used by standalone tests and tutorials. */
export class MockControlPlaneAdapter implements ControlPlanePort {
  #lifecycle: "stopped" | "running" = "stopped";
  #openedRun: OpenControlPlaneRunInput | null = null;
  #events: NativeRunEvent[] = [];
  #result: NativeRunResult | null = null;

  async start(): Promise<void> {
    if (this.#lifecycle === "running") {
      throw new Error("mock control plane is already running");
    }
    this.#lifecycle = "running";
  }

  async stop(): Promise<void> {
    this.#lifecycle = "stopped";
  }

  async openRun(input: OpenControlPlaneRunInput): Promise<void> {
    this.#assertRunning();
    if (this.#openedRun !== null) {
      throw new Error("mock control plane accepts one Phase 0 run");
    }
    this.#openedRun = structuredClone(input);
  }

  async appendEvent(event: NativeRunEvent): Promise<AppendedEventReceipt> {
    const runId = this.#requireRunId();
    if (event.runId !== runId) {
      throw new Error("event runId does not match the opened run");
    }
    const expectedSequence = this.#events.length + 1;
    if (event.sequence !== expectedSequence) {
      throw new Error(`event sequence must be ${expectedSequence}`);
    }
    this.#events.push(structuredClone(event));
    return { cursor: event.sequence };
  }

  async completeRun(result: NativeRunResult): Promise<void> {
    const runId = this.#requireRunId();
    if (result.runId !== runId) {
      throw new Error("result runId does not match the opened run");
    }
    if (this.#events.at(-1)?.type !== "run.completed") {
      throw new Error("run.completed must be ingested before the result");
    }
    if (this.#result !== null) {
      throw new Error("mock control plane accepts one terminal result");
    }
    this.#result = structuredClone(result);
  }

  snapshot(): MockControlPlaneSnapshot {
    return {
      lifecycle: this.#lifecycle,
      openedRun: this.#openedRun === null ? null : structuredClone(this.#openedRun),
      events: structuredClone(this.#events),
      result: this.#result === null ? null : structuredClone(this.#result),
    };
  }

  #assertRunning(): void {
    if (this.#lifecycle !== "running") {
      throw new Error("mock control plane must be started first");
    }
  }

  #requireRunId(): string {
    this.#assertRunning();
    if (this.#openedRun === null) {
      throw new Error("a run must be opened first");
    }
    return this.#openedRun.identity.runId;
  }
}
