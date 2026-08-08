import type { PrpEvent } from "../protocol/phase1-contract.js";
import type { NativeSessionCapabilities, NativeUserMessage } from "./types.js";

export interface HarnessDriverDescriptor {
  kind: string;
  displayName: string;
  version: string;
  protocolVersion?: string;
  capabilities: NativeSessionCapabilities;
}

export interface OpenHarnessSessionInput {
  runId: string;
  normalizedSessionId: string;
  workingDirectory: string;
}

export class HarnessCapabilityUnavailableError extends Error {
  readonly operation: string;

  constructor(operation: string, detail: string) {
    super(`${operation} is unavailable: ${detail}`);
    this.name = "HarnessCapabilityUnavailableError";
    this.operation = operation;
  }
}

export class HarnessReconciliationError extends Error {
  readonly recoverable = true;

  constructor(message: string) {
    super(message);
    this.name = "HarnessReconciliationError";
  }
}

export interface PersistedHarnessSession {
  driverKind: string;
  driverSessionId: string;
  providerSessionId?: string | null;
  runId?: string;
  normalizedSessionId?: string;
  activeTurnId?: string | null;
  lastSourceSequence?: number;
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
  events(): AsyncIterable<PrpEvent>;
  startTurn(input: { message: NativeUserMessage }): Promise<{ turnId: string }>;
  steer?(input: { turnId: string; message: NativeUserMessage }): Promise<void>;
  interrupt?(input: { turnId: string; reason?: string }): Promise<void>;
  read?(): Promise<Record<string, unknown>>;
  reconcile?(): Promise<Record<string, unknown>>;
  usage?(): Promise<Record<string, unknown> | null>;
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
