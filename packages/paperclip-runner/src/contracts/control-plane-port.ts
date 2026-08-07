import type {
  NativeRunEvent,
  NativeRunIdentity,
  NativeRunResult,
} from "./types.js";

export interface OpenControlPlaneRunInput {
  identity: NativeRunIdentity;
  backendKind: "runner" | "remote" | "mock";
}

export interface AppendedEventReceipt {
  cursor: number;
}

/**
 * The only control-plane surface the standalone runner may call.
 *
 * Production Paperclip implements this port in a later integration phase. The
 * runner package never imports the server, UI, or database that sits behind it.
 */
export interface ControlPlanePort {
  openRun(input: OpenControlPlaneRunInput): Promise<void>;
  appendEvent(event: NativeRunEvent): Promise<AppendedEventReceipt>;
  completeRun(result: NativeRunResult): Promise<void>;
}
