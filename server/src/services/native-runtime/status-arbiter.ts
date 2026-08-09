import type { NativeEvidenceAssessment } from "./evidence-classifier.js";

export const NATIVE_STATUS_ARBITER_POLICY_VERSION = "phase6-v2";

export type NativeAuthoritativeIssueStatus =
  | "backlog"
  | "todo"
  | "in_progress"
  | "in_review"
  | "blocked"
  | "done"
  | "cancelled";

export type NativeGovernanceGate = {
  kind: "approval" | "interaction" | "execution_stage";
  id: string;
};

export type NativeStatusEffect =
  | { kind: "bind_governance"; gate: NativeGovernanceGate }
  | { kind: "create_review_interaction"; prompt: string }
  | {
      kind: "enqueue_continuation";
      continuationKind: "same_agent" | "retry" | "delegated_issue" | "response_wake" | "monitor";
      summary: string;
      idempotencyKey: string;
      agentId: string;
    }
  | { kind: "bind_blocker"; owner: { agentId: string } | "board"; action: string }
  | { kind: "record_recovery"; cause: string; nextAction: string; agentId: string }
  | { kind: "release_checkout" };

export interface NativeStatusDecision {
  policyVersion: typeof NATIVE_STATUS_ARBITER_POLICY_VERSION;
  toStatus: NativeAuthoritativeIssueStatus;
  reasonCode: string;
  unblockDescriptor: { owner: { agentId: string } | "board"; action: string } | null;
  effects: NativeStatusEffect[];
}

/** Pure authority boundary: model prose is evidence, never a status command. */
export function arbitrateNativeStatus(input: {
  assessment: NativeEvidenceAssessment;
  terminalState: "succeeded" | "failed" | "cancelled";
  workspaceFinalizeStatus: "succeeded" | "failed";
  governanceGate?: NativeGovernanceGate | null;
  agentId: string;
  priorIssueStatus: NativeAuthoritativeIssueStatus;
}): NativeStatusDecision {
  if (["done", "cancelled"].includes(input.priorIssueStatus)) {
    return {
      policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
      toStatus: input.priorIssueStatus,
      reasonCode: "terminal_status_preserved",
      unblockDescriptor: null,
      effects: [],
    };
  }
  if (input.workspaceFinalizeStatus !== "succeeded") {
    return {
      policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
      toStatus: input.priorIssueStatus,
      reasonCode: "workspace_finalization_retry_required",
      unblockDescriptor: null,
      effects: [{
        kind: "record_recovery",
        cause: "workspace_finalization_failed",
        nextAction: "Repair and re-run workspace finalization for the persisted native result.",
        agentId: input.agentId,
      }],
    };
  }
  if (input.terminalState !== "succeeded") {
    const cause = input.terminalState === "cancelled" ? "native_run_cancelled" : "native_run_failed";
    return {
      policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
      toStatus: "in_progress",
      reasonCode: cause,
      unblockDescriptor: null,
      effects: [{
        kind: "record_recovery",
        cause,
        nextAction: "Resume the persisted native run without opening a second provider session.",
        agentId: input.agentId,
      }],
    };
  }
  if (input.governanceGate) {
    return {
      policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
      toStatus: "in_review",
      reasonCode: "governance_gate_pending",
      unblockDescriptor: null,
      effects: [{ kind: "bind_governance", gate: input.governanceGate }],
    };
  }
  const complete =
    input.assessment.reportedDisposition === "done" &&
    input.assessment.objectiveSatisfied &&
    input.assessment.allCriteriaSatisfied &&
    input.assessment.verificationPassed &&
    !input.assessment.hasBlockingRemainingWork;
  if (complete) {
    return {
      policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
      toStatus: "done",
      reasonCode: "completion_contract_satisfied",
      unblockDescriptor: null,
      effects: [{ kind: "release_checkout" }],
    };
  }
  if (input.assessment.reportedDisposition === "needs_review") {
    return {
      policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
      toStatus: "in_review",
      reasonCode: "native_review_path_required",
      unblockDescriptor: null,
      effects: [{
        kind: "create_review_interaction",
        prompt: "Review the persisted native-run evidence and confirm whether this issue may be completed.",
      }],
    };
  }
  if (input.assessment.reportedDisposition === "blocked" && input.assessment.blocker) {
    const owner = input.assessment.blocker.boardOwned ? "board" as const : { agentId: input.agentId };
    if (input.assessment.blocker.scope === "task_wide") {
      return {
        policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
        toStatus: "blocked",
        reasonCode: "native_task_wide_blocker",
        unblockDescriptor: { owner, action: input.assessment.blocker.unblockAction },
        effects: [{ kind: "bind_blocker", owner, action: input.assessment.blocker.unblockAction }],
      };
    }
    return {
      policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
      toStatus: "in_progress",
      reasonCode: "native_track_blocked_continuation",
      unblockDescriptor: null,
      effects: [{
        kind: "enqueue_continuation",
        continuationKind: "same_agent",
        summary: `Continue another productive track while resolving: ${input.assessment.blocker.unblockAction}`,
        idempotencyKey: `native-track-blocked:${input.assessment.blocker.unblockAction}`,
        agentId: input.agentId,
      }],
    };
  }
  if (input.assessment.reportedDisposition === "yielded" && input.assessment.continuation) {
    return {
      policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
      toStatus: "in_progress",
      reasonCode: "native_continuation_required",
      unblockDescriptor: null,
      effects: [{
        kind: "enqueue_continuation",
        continuationKind: input.assessment.continuation.kind,
        summary: input.assessment.continuation.summary,
        idempotencyKey: input.assessment.continuation.idempotencyKey,
        agentId: input.agentId,
      }],
    };
  }
  return {
    policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
    toStatus: "in_progress",
    reasonCode: "native_completion_incomplete",
    unblockDescriptor: null,
    effects: [{
      kind: "enqueue_continuation",
      continuationKind: "same_agent",
      summary: "Continue work on the missing or unverifiable completion-contract evidence.",
      idempotencyKey: "native-completion-incomplete",
      agentId: input.agentId,
    }],
  };
}
