import type { NativeEvidenceAssessment } from "./evidence-classifier.js";

export const NATIVE_STATUS_ARBITER_POLICY_VERSION = "phase6-v1";

export interface NativeStatusDecision {
  policyVersion: typeof NATIVE_STATUS_ARBITER_POLICY_VERSION;
  toStatus: "in_progress" | "done" | "blocked";
  reasonCode: string;
  unblockDescriptor: { owner: { agentId: string } | "board"; action: string } | null;
}

/** Pure authority boundary: model prose is evidence, never a status command. */
export function arbitrateNativeStatus(input: {
  assessment: NativeEvidenceAssessment;
  terminalState: "succeeded" | "failed" | "cancelled";
  workspaceFinalizeStatus: "succeeded" | "failed";
  approvalGateSatisfied?: boolean;
  agentId: string;
}): NativeStatusDecision {
  if (input.workspaceFinalizeStatus !== "succeeded") {
    return {
      policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
      toStatus: "blocked",
      reasonCode: "workspace_finalization_failed",
      unblockDescriptor: { owner: { agentId: input.agentId }, action: "Repair and re-verify workspace finalization." },
    };
  }
  if (input.terminalState !== "succeeded") {
    return {
      policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
      toStatus: "in_progress",
      reasonCode: input.terminalState === "cancelled" ? "native_run_cancelled" : "native_run_failed",
      unblockDescriptor: null,
    };
  }
  if (input.approvalGateSatisfied === false) {
    return {
      policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
      toStatus: "in_progress",
      reasonCode: "approval_gate_pending",
      unblockDescriptor: null,
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
    };
  }
  if (input.assessment.reportedDisposition === "blocked" && input.assessment.blocker) {
    return {
      policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
      toStatus: "blocked",
      reasonCode: "native_reported_blocker",
      unblockDescriptor: {
        owner: input.assessment.blocker.boardOwned ? "board" : { agentId: input.agentId },
        action: input.assessment.blocker.unblockAction,
      },
    };
  }
  return {
    policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
    toStatus: "in_progress",
    reasonCode: input.assessment.reportedDisposition === "needs_review"
      ? "native_review_path_required"
      : input.assessment.reportedDisposition === "yielded"
        ? "native_continuation_required"
        : "native_completion_incomplete",
    unblockDescriptor: null,
  };
}
