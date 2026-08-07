import type {
  NativeRunEvent,
  NativeSessionCapabilities,
  NativeUserMessage,
} from "./types.js";

export interface HarnessDriverDescriptor {
  kind: string;
  displayName: string;
  version: string;
  capabilities: NativeSessionCapabilities;
}

export interface OpenHarnessSessionInput {
  runId: string;
  workingDirectory: string;
}

export interface PersistedHarnessSession {
  driverKind: string;
  driverSessionId: string;
  providerSessionId?: string | null;
}

export interface HarnessSessionRecoveryResult {
  recovered: boolean;
  session?: HarnessSession;
  reason?: string;
}

export interface HarnessSession {
  ids(): {
    driverSessionId: string;
    providerSessionId?: string | null;
    displayId?: string | null;
  };
  events(): AsyncIterable<NativeRunEvent>;
  startTurn(input: { message: NativeUserMessage }): Promise<{ turnId: string }>;
  steer?(input: { turnId: string; message: NativeUserMessage }): Promise<void>;
  interrupt?(input: { turnId: string; reason?: string }): Promise<void>;
  snapshot(): Promise<PersistedHarnessSession>;
  close(input: { reason: string; force?: boolean }): Promise<void>;
}

/** A local harness implementation hidden behind the runner daemon boundary. */
export interface HarnessDriver {
  descriptor(): Promise<HarnessDriverDescriptor>;
  openSession(input: OpenHarnessSessionInput): Promise<HarnessSession>;
  recoverSession?(
    snapshot: PersistedHarnessSession,
  ): Promise<HarnessSessionRecoveryResult>;
}
