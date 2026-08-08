import type {
  NativeRunEvent,
  NativeRunIdentity,
  NativeRunResult,
  NativeSessionCapabilities,
  NativeUserMessage,
} from "./types.js";

export interface NativeSessionBackendDescriptor {
  kind: "runner" | "remote" | "mock";
  name: string;
  version: string;
  capabilities: NativeSessionCapabilities;
}

export interface OpenNativeSessionInput {
  identity: NativeRunIdentity;
  workingDirectory?: string;
}

export interface PersistedNativeSession {
  backendKind: NativeSessionBackendDescriptor["kind"];
  sessionId: string;
  providerSessionId?: string | null;
  cursor?: string | null;
}

export interface NativeSessionRecoveryResult {
  recovered: boolean;
  session?: NativeSession;
  reason?: string;
}

export interface NativeSession {
  identity(): NativeRunIdentity;
  capabilities(): Promise<NativeSessionCapabilities>;
  events(input?: { afterCursor?: string | null }): AsyncIterable<NativeRunEvent>;
  startTurn(input: { message: NativeUserMessage }): Promise<{ turnId: string }>;
  steer?(input: { turnId: string; message: NativeUserMessage }): Promise<void>;
  interrupt?(input: { turnId?: string; reason?: string }): Promise<void>;
  cancel?(input: { reason: string }): Promise<void>;
  result(): Promise<NativeRunResult | null>;
  snapshot(): Promise<PersistedNativeSession>;
  close(input: { reason: string }): Promise<void>;
}

/** Normalized control-plane boundary shared by runner and hosted backends. */
export interface NativeSessionBackend {
  descriptor(): Promise<NativeSessionBackendDescriptor>;
  openSession(input: OpenNativeSessionInput): Promise<NativeSession>;
  recoverSession?(
    snapshot: PersistedNativeSession,
  ): Promise<NativeSessionRecoveryResult>;
}
