/**
 * Normalized presentation model for the Task Chat Redesign (flag:
 * enableTaskChatRedesign).
 *
 * This is a deliberately small, protocol-agnostic model that the new render
 * layer consumes. Two producers feed it:
 *   1. The dev harness, via synthetic fixtures (task-chat-fixtures.ts).
 *   2. The live thread, via an adapter over the existing comment/run props.
 *
 * Every field traces to a real agent-protocol concept (ACP SessionUpdate /
 * acpx AcpRuntimeEvent / TranscriptEntry). See DESIGN.md and the plan's state
 * inventory for the mapping. No timing/motion values live here — those are
 * CSS motion tokens in ui/src/index.css.
 */

/** Who authored a thread row — the primary legibility signal. */
export type TaskChatAuthorKind = "human" | "agent" | "system";

/** ACP ToolCallStatus. */
export type TaskChatToolStatus = "pending" | "in_progress" | "completed" | "failed";

/** ACP PermissionOptionKind. */
export type TaskChatApprovalOptionKind =
  | "allow_once"
  | "allow_always"
  | "reject_once"
  | "reject_always";

/** ACP PlanEntryStatus. */
export type TaskChatPlanEntryStatus = "pending" | "in_progress" | "completed";

/** ACP PlanEntryPriority. */
export type TaskChatPlanEntryPriority = "high" | "medium" | "low";

export interface TaskChatApprovalOption {
  id: string;
  label: string;
  kind: TaskChatApprovalOptionKind;
}

export interface TaskChatDiff {
  path?: string;
  added: number;
  removed: number;
  /** Optional unified-diff-ish lines for display only. */
  lines?: Array<{ kind: "add" | "remove" | "context"; text: string }>;
}

export interface TaskChatTokenUsage {
  /** ACP UsageUpdate.used — tokens in context. */
  used: number;
  /** ACP UsageUpdate.size — context window size. */
  size: number;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
}

/** A human/agent/system message bubble. */
export interface TaskChatMessageItem {
  id: string;
  kind: "message";
  author: TaskChatAuthorKind;
  authorName?: string;
  text: string;
  timestamp?: string;
  /** Show a streaming cursor and suppress collapse while true. */
  streaming?: boolean;
  /** Optimistic local echo state (matches IssueChatComment.clientStatus). */
  optimistic?: "pending" | "queued";
}

/** Collapsed chain-of-thought (ACP agent_thought_chunk). */
export interface TaskChatThinkingItem {
  id: string;
  kind: "thinking";
  lines: string[];
  streaming?: boolean;
  /** When true, render collapsed ("Worked for N") with an expand affordance. */
  collapsed?: boolean;
  /** Human-readable elapsed label for the collapsed header. */
  summaryLabel?: string;
}

/** A tool invocation card (ACP tool_call / tool_call_update). */
export interface TaskChatToolItem {
  id: string;
  kind: "tool";
  name: string;
  /** ACP ToolKind. */
  toolKind?: string;
  status: TaskChatToolStatus;
  detail?: string;
  diff?: TaskChatDiff;
  /** Resolved permission decision badge, when one applied. */
  decision?: "allowed" | "rejected";
}

/**
 * A lifecycle state rendered as a status affordance — never a bubble.
 * Covers both LIVE (running/working) and Tier-B (awaiting_approval,
 * interrupted, refused, truncated) states.
 */
export interface TaskChatStatusItem {
  id: string;
  kind: "status";
  status:
    | "running"
    | "working"
    | "awaiting_approval"
    | "interrupted"
    | "refused"
    | "truncated";
  label: string;
  detail?: string;
  elapsedMs?: number;
  tokens?: TaskChatTokenUsage;
  /** Present for awaiting_approval (ACP RequestPermissionRequest). */
  approval?: { toolName: string; options: TaskChatApprovalOption[] };
}

/** A lifecycle divider (session start, interruption, turn boundary). */
export interface TaskChatMarkerItem {
  id: string;
  kind: "marker";
  variant: "session_start" | "interrupted" | "turn_boundary";
  label: string;
  detail?: string;
}

/** A second-tier live token/cost readout (ACP UsageUpdate). */
export interface TaskChatUsageItem {
  id: string;
  kind: "usage";
  usage: TaskChatTokenUsage;
}

export type TaskChatItem =
  | TaskChatMessageItem
  | TaskChatThinkingItem
  | TaskChatToolItem
  | TaskChatStatusItem
  | TaskChatMarkerItem
  | TaskChatUsageItem;

/** A structured plan entry (ACP PlanEntry) for the Plans tab. */
export interface TaskChatPlanEntry {
  id: string;
  content: string;
  status: TaskChatPlanEntryStatus;
  priority: TaskChatPlanEntryPriority;
}

export interface TaskChatPlan {
  /** Revision index (1-based); higher supersedes. */
  revision: number;
  entries: TaskChatPlanEntry[];
  updatedAt?: string;
}
