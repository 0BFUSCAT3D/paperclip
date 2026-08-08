import type {
  PrpEvent,
  PrpStructuredRunResult,
} from "../protocol/phase1-contract.js";
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

export class HarnessOperationAlreadyTerminalError extends Error {
  readonly code = "already_terminal" as const;

  constructor(operation: string) {
    super(`${operation} lost a race with the committed turn terminal`);
    this.name = "HarnessOperationAlreadyTerminalError";
  }
}

export class HarnessStaleTurnError extends Error {
  readonly code = "stale_turn" as const;

  constructor(turnId: string) {
    super(`turn ${turnId} is not the active turn`);
    this.name = "HarnessStaleTurnError";
  }
}

export type HarnessRuntimeRequestKind =
  | "command_approval"
  | "file_approval"
  | "permission_approval"
  | "user_input"
  | "elicitation";

export interface HarnessRuntimeRequest {
  requestId: string;
  requestKind: HarnessRuntimeRequestKind;
  method: string;
  turnId: string;
  itemId: string;
  status: "pending";
  prompt: string;
  details: Record<string, unknown>;
}

export type HarnessRuntimeRequestResolution =
  | { action: "accept" | "accept_for_session" | "decline" | "cancel" }
  | {
      action: "submit";
      answers: Record<string, { answers: string[] }>;
    }
  | {
      action: "submit";
      content: Record<string, unknown>;
    };

export interface HarnessThreadGoal {
  threadId: string;
  objective: string;
  status: "active" | "paused" | "blocked" | "usageLimited" | "budgetLimited" | "complete";
  tokenBudget: number | null;
  tokensUsed: number;
  timeUsedSeconds: number;
  createdAt: number;
  updatedAt: number;
}

export type HarnessGoalOperation =
  | { action: "get" }
  | { action: "set"; objective: string; tokenBudget?: number | null }
  | { action: "pause" | "resume" | "clear" };

export interface HarnessThreadLineageEntry {
  threadId: string;
  providerSessionId: string | null;
  parentThreadId: string | null;
  depth: number;
  nickname: string | null;
  role: string | null;
  status: string;
}

export interface PersistedHarnessSemanticResult {
  result: PrpStructuredRunResult;
  fingerprint: string;
  callId?: string | null;
  turnId: string;
}

export interface PersistedHarnessTurnTerminal {
  turnId: string;
  fingerprint: string;
}

export interface PersistedHarnessSession {
  driverKind: string;
  driverSessionId: string;
  providerSessionId?: string | null;
  runId?: string;
  normalizedSessionId?: string;
  activeTurnId?: string | null;
  semanticResult?: PersistedHarnessSemanticResult | null;
  terminalTurns?: PersistedHarnessTurnTerminal[];
  pendingRuntimeRequests?: HarnessRuntimeRequest[];
  goal?: HarnessThreadGoal | null;
  lineage?: HarnessThreadLineageEntry[];
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
  interrupt?(input: { turnId?: string; reason?: string }): Promise<void>;
  pendingRuntimeRequests?(): HarnessRuntimeRequest[];
  resolveRuntimeRequest?(input: {
    requestId: string;
    turnId: string;
    resolution: HarnessRuntimeRequestResolution;
  }): Promise<void>;
  goal?(input: HarnessGoalOperation): Promise<HarnessThreadGoal | null>;
  lineage?(): HarnessThreadLineageEntry[];
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
