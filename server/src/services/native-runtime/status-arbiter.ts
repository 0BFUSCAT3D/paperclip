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
  | { kind: "create_interaction"; gate?: NativeGovernanceGate; prompt?: string }
  | { kind: "bind_reviewer"; prompt: string }
  | { kind: "notify_owner"; agentId: string; reason: string }
  | {
      kind: "enqueue_continuation";
      continuationKind: "same_agent" | "retry" | "delegated_issue" | "response_wake" | "monitor";
      summary: string;
      idempotencyKey: string;
      agentId: string;
    }
  | { kind: "bind_blocker"; owner: { agentId: string } | "board"; action: string }
  | { kind: "schedule_retry"; cause: string; summary: string; agentId: string }
  | { kind: "record_finalization_error"; cause: string; nextAction: string; agentId: string }
  | { kind: "release_run_resources" }
  | { kind: "create_delegated_issue"; agentId: string; summary: string }
  | { kind: "accept_replacement_turn" }
  | { kind: "cancel_continuations" }
  | { kind: "append_superseding_assessment" }
  | { kind: "dispatch_pending_effect" }
  | { kind: "increment_status_version" }
  | { kind: "schedule_reconciliation" }
  | { kind: "record_shadow_decision" }
  | { kind: "render_four_layers" }
  | { kind: "materialize_contract" }
  | { kind: "record_mode_labeled_divergence" }
  | { kind: "record_mode_native" }
  | { kind: "record_policy_version" }
  | { kind: "finish_as_native" }
  | { kind: "stop_new_native_dispatch" }
  | { kind: "resume_workspace_operation" }
  | { kind: "record_expiry" }
  | { kind: "record_stale_response" }
  | { kind: "link_canonical_request" }
  | { kind: "record_recovery"; cause: string; nextAction: string; agentId: string }
  | { kind: "release_checkout" };

export interface NativeStatusDecision {
  policyVersion: typeof NATIVE_STATUS_ARBITER_POLICY_VERSION;
  statusAction: NativeAuthoritativeIssueStatus | "preserve";
  toStatus: NativeAuthoritativeIssueStatus;
  reasonCode: string | null;
  unblockDescriptor: { owner: { agentId: string } | "board"; action: string } | null;
  effects: NativeStatusEffect[];
}

export type NativeStatusAuthorityScenario =
  | "mechanically_satisfied"
  | "low_risk_policy_claim"
  | "missing_required_test"
  | "no_durable_continuation"
  | "named_reviewer_required"
  | "governed_gate_pending"
  | "review_required"
  | "safe_partial_parse"
  | "valid_continuation"
  | "alternate_track_runnable"
  | "task_wide_owner_action_bound"
  | "context_answer_current"
  | "ordinary_domain_expertise"
  | "intentional_human_judgment"
  | "equivalent_attention_family"
  | "resolver_budget_exhausted"
  | "partial_evidence_persisted"
  | "claim_before_workspace_failure"
  | "turn_scope"
  | "run_scope"
  | "issue_scope_authorized"
  | "new_evidence_satisfies_contract"
  | "dependency_now_done"
  | "explicit_resume_capability"
  | "replacement_turn_accepted"
  | "transient_retry_then_success"
  | "cross_company_target"
  | "response_after_supersession"
  | "interaction_expired"
  | "identical_result_before_ack"
  | "reused_id_changed_material"
  | "result_preserved"
  | "decision_committed_delivery_pending"
  | "board_cancelled_before_cas"
  | "new_policy_requires_review"
  | "shadow_application_disabled"
  | "mixed_ledger"
  | "authorized_writer_incremented_version"
  | "shadow_compute"
  | "classified_native_legacy_divergence"
  | "allowlisted_company_adapter_policy"
  | "cohort_policy_pinned"
  | "kill_switch_during_active_native_run";

/**
 * Versioned cross-trigger policy used by the live finalizer and by the
 * attention/reconciliation/migration consumers. Scenario names are
 * server-classified facts; callers cannot supply an expected outcome.
 */
export function arbitrateNativeStatusScenario(input: {
  scenario: NativeStatusAuthorityScenario;
  priorIssueStatus: NativeAuthoritativeIssueStatus;
  agentId: string;
  governanceGate?: NativeGovernanceGate | null;
  blockerAction?: string;
}): NativeStatusDecision {
  const preserve = (
    reasonCode: string,
    effects: NativeStatusEffect[],
  ): NativeStatusDecision => ({
    policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
    statusAction: "preserve",
    toStatus: input.priorIssueStatus,
    reasonCode,
    unblockDescriptor: null,
    effects,
  });
  const continuation = (
    reasonCode: string,
    effects: NativeStatusEffect[] = [],
  ): NativeStatusDecision => ({
    policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
    statusAction: "in_progress",
    toStatus: "in_progress",
    reasonCode,
    unblockDescriptor: null,
    effects: [{
      kind: "enqueue_continuation",
      continuationKind: "same_agent",
      summary: `Continue after ${input.scenario}.`,
      idempotencyKey: `native-status:${input.scenario}`,
      agentId: input.agentId,
    }, ...effects],
  });
  const review = (
    effects: NativeStatusEffect[] = [],
  ): NativeStatusDecision => ({
    policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
    statusAction: "in_review",
    toStatus: "in_review",
    reasonCode: "completion_review_required",
    unblockDescriptor: null,
    effects: [
      { kind: "bind_reviewer", prompt: `Review native status scenario ${input.scenario}.` },
      ...effects,
    ],
  });

  switch (input.scenario) {
    case "mechanically_satisfied":
    case "identical_result_before_ack":
      return { policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION, statusAction: "done", toStatus: "done", reasonCode: "completion_contract_satisfied", unblockDescriptor: null, effects: [{ kind: "release_checkout" }] };
    case "low_risk_policy_claim":
      return { policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION, statusAction: "done", toStatus: "done", reasonCode: "completion_claim_policy_accepted", unblockDescriptor: null, effects: [{ kind: "release_checkout" }] };
    case "missing_required_test":
      return continuation("completion_evidence_incomplete");
    case "no_durable_continuation":
      return preserve("prior_status_preserved_no_live_path", [{ kind: "record_finalization_error", cause: "completion_evidence_incomplete", nextAction: "Bind a durable continuation or recovery owner.", agentId: input.agentId }]);
    case "named_reviewer_required":
    case "review_required":
      return review([{ kind: "notify_owner", agentId: input.agentId, reason: "completion_review_required" }]);
    case "governed_gate_pending":
      return {
        policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
        statusAction: "in_review",
        toStatus: "in_review",
        reasonCode: "governed_gate_pending",
        unblockDescriptor: null,
        effects: [
          { kind: "create_interaction", gate: input.governanceGate ?? undefined, prompt: "Complete the governed review." },
          { kind: "notify_owner", agentId: input.agentId, reason: "governed_gate_pending" },
        ],
      };
    case "safe_partial_parse":
      return preserve("native_finalization_invalid", [{ kind: "record_finalization_error", cause: "native_finalization_invalid", nextAction: "Repair the persisted native result.", agentId: input.agentId }]);
    case "valid_continuation":
    case "decision_committed_delivery_pending":
    case "allowlisted_company_adapter_policy":
    case "kill_switch_during_active_native_run": {
      const effects: NativeStatusEffect[] = [];
      if (input.scenario === "decision_committed_delivery_pending") effects.push({ kind: "dispatch_pending_effect" });
      if (input.scenario === "allowlisted_company_adapter_policy") effects.push({ kind: "record_mode_native" });
      if (input.scenario === "kill_switch_during_active_native_run") effects.push({ kind: "finish_as_native" }, { kind: "stop_new_native_dispatch" });
      return continuation("live_continuation_registered", effects);
    }
    case "alternate_track_runnable":
      return continuation("turn_waiting_other_track_live");
    case "task_wide_owner_action_bound": {
      const action = input.blockerAction ?? "Resolve the task-wide blocker.";
      return {
        policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
        statusAction: "blocked",
        toStatus: "blocked",
        reasonCode: "task_wide_blocker_bound",
        unblockDescriptor: { owner: "board", action },
        effects: [
          { kind: "bind_blocker", owner: "board", action },
          { kind: "notify_owner", agentId: input.agentId, reason: "task_wide_blocker_bound" },
        ],
      };
    }
    case "context_answer_current":
    case "transient_retry_then_success":
      return continuation("attention_resolved_from_context");
    case "cross_company_target":
      return preserve("result_schema_rejected", [{ kind: "record_finalization_error", cause: "result_schema_rejected", nextAction: "Remove the cross-company target.", agentId: input.agentId }]);
    case "ordinary_domain_expertise":
      return {
        ...continuation("attention_routed_to_agent"),
        effects: [
          { kind: "create_delegated_issue", agentId: input.agentId, summary: "Resolve the routed expertise request." },
          ...continuation("attention_routed_to_agent").effects,
        ],
      };
    case "intentional_human_judgment":
      return {
        policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
        statusAction: "in_review",
        toStatus: "in_review",
        reasonCode: "attention_requires_human_authority",
        unblockDescriptor: null,
        effects: [
          { kind: "create_interaction", prompt: "Provide the required human judgment." },
          { kind: "notify_owner", agentId: input.agentId, reason: "attention_requires_human_authority" },
        ],
      };
    case "equivalent_attention_family":
      return preserve("attention_duplicate_suppressed", [{ kind: "link_canonical_request" }]);
    case "resolver_budget_exhausted":
      return preserve("attention_budget_exhausted", [{ kind: "record_finalization_error", cause: "attention_budget_exhausted", nextAction: "Assign a named recovery owner.", agentId: input.agentId }]);
    case "partial_evidence_persisted":
      return preserve("run_failed_partial_evidence_preserved", [{ kind: "schedule_retry", cause: "native_run_failed", summary: "Resume from partial evidence.", agentId: input.agentId }]);
    case "claim_before_workspace_failure":
      return preserve("finalization_failed_claim_preserved", [{ kind: "record_finalization_error", cause: "workspace_finalization_failed", nextAction: "Repair workspace finalization.", agentId: input.agentId }]);
    case "turn_scope":
      return preserve("cancellation_turn_only", [{ kind: "accept_replacement_turn" }]);
    case "run_scope":
      return preserve("cancellation_run_only", [{ kind: "release_run_resources" }]);
    case "issue_scope_authorized":
      return { policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION, statusAction: "cancelled", toStatus: "cancelled", reasonCode: "cancellation_issue_authorized", unblockDescriptor: null, effects: [{ kind: "release_checkout" }, { kind: "cancel_continuations" }] };
    case "new_evidence_satisfies_contract":
      return { policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION, statusAction: "done", toStatus: "done", reasonCode: "decision_superseded_by_new_evidence", unblockDescriptor: null, effects: [{ kind: "release_checkout" }] };
    case "dependency_now_done":
      return continuation("dependency_resolved");
    case "explicit_resume_capability":
      return continuation("authorized_resume");
    case "replacement_turn_accepted":
      return {
        policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
        statusAction: "preserve",
        toStatus: input.priorIssueStatus,
        reasonCode: null,
        unblockDescriptor: null,
        effects: [{ kind: "accept_replacement_turn" }],
      };
    case "response_after_supersession":
      return preserve("attention_duplicate_suppressed", [{ kind: "record_stale_response" }]);
    case "interaction_expired":
      return preserve("attention_budget_exhausted", [{ kind: "record_expiry" }]);
    case "reused_id_changed_material":
      return preserve("structured_result_replay_conflict", [{ kind: "record_finalization_error", cause: "structured_result_replay_conflict", nextAction: "Use a fresh canonical result identity.", agentId: input.agentId }]);
    case "result_preserved":
      return { policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION, statusAction: "done", toStatus: "done", reasonCode: "completion_contract_satisfied", unblockDescriptor: null, effects: [{ kind: "resume_workspace_operation" }, { kind: "release_checkout" }] };
    case "board_cancelled_before_cas":
      return preserve("prior_status_terminal_preserved", [{ kind: "append_superseding_assessment" }]);
    case "new_policy_requires_review":
      return review([{ kind: "append_superseding_assessment" }]);
    case "shadow_application_disabled":
      return preserve("completion_contract_satisfied", [{ kind: "record_shadow_decision" }]);
    case "mixed_ledger":
      return preserve("completion_contract_satisfied", [{ kind: "render_four_layers" }]);
    case "authorized_writer_incremented_version":
      return preserve("arbitration_conflict_reloaded", [{ kind: "increment_status_version" }, { kind: "schedule_reconciliation" }]);
    case "shadow_compute":
      return preserve("completion_contract_satisfied", [{ kind: "materialize_contract" }, { kind: "record_shadow_decision" }]);
    case "classified_native_legacy_divergence":
      return preserve("completion_evidence_incomplete", [{ kind: "record_mode_labeled_divergence" }]);
    case "cohort_policy_pinned":
      return { policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION, statusAction: "done", toStatus: "done", reasonCode: "completion_contract_satisfied", unblockDescriptor: null, effects: [{ kind: "record_mode_native" }, { kind: "record_policy_version" }] };
  }
}

/** Pure authority boundary: model prose is evidence, never a status command. */
export function arbitrateNativeStatus(input: {
  assessment: NativeEvidenceAssessment;
  terminalState: "succeeded" | "failed" | "cancelled";
  workspaceFinalizeStatus: "succeeded" | "failed";
  governanceGate?: NativeGovernanceGate | null;
  completionClaimPolicyAccepted?: boolean;
  allowIncompleteContinuation?: boolean;
  agentId: string;
  priorIssueStatus: NativeAuthoritativeIssueStatus;
}): NativeStatusDecision {
  if (["done", "cancelled"].includes(input.priorIssueStatus)) {
    return {
      policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
      statusAction: "preserve",
      toStatus: input.priorIssueStatus,
      reasonCode: "terminal_status_preserved",
      unblockDescriptor: null,
      effects: [],
    };
  }
  if (input.workspaceFinalizeStatus !== "succeeded") {
    return {
      policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
      statusAction: "preserve",
      toStatus: input.priorIssueStatus,
      reasonCode: "finalization_failed_claim_preserved",
      unblockDescriptor: null,
      effects: [{
        kind: "record_finalization_error",
        cause: "workspace_finalization_failed",
        nextAction: "Repair and re-run workspace finalization for the persisted native result.",
        agentId: input.agentId,
      }],
    };
  }
  if (input.terminalState !== "succeeded") {
    if (input.terminalState === "cancelled") {
      return {
        policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
        statusAction: "preserve",
        toStatus: input.priorIssueStatus,
        reasonCode: "cancellation_run_only",
        unblockDescriptor: null,
        effects: [{ kind: "release_run_resources" }],
      };
    }
    return {
      policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
      statusAction: "preserve",
      toStatus: input.priorIssueStatus,
      reasonCode: "run_failed_partial_evidence_preserved",
      unblockDescriptor: null,
      effects: [{
        kind: "schedule_retry",
        cause: "native_run_failed",
        summary: "Resume the persisted native run without opening a second provider session.",
        agentId: input.agentId,
      }],
    };
  }
  if (input.governanceGate) {
    return {
      policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
      statusAction: "in_review",
      toStatus: "in_review",
      reasonCode: "governed_gate_pending",
      unblockDescriptor: null,
      effects: [
        { kind: "create_interaction", gate: input.governanceGate },
        { kind: "notify_owner", agentId: input.agentId, reason: "governed_gate_pending" },
      ],
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
      statusAction: "done",
      toStatus: "done",
      reasonCode: input.completionClaimPolicyAccepted
        ? "completion_claim_policy_accepted"
        : "completion_contract_satisfied",
      unblockDescriptor: null,
      effects: [{ kind: "release_checkout" }],
    };
  }
  if (input.assessment.reportedDisposition === "needs_review") {
    return {
      policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
      statusAction: "in_review",
      toStatus: "in_review",
      reasonCode: "completion_review_required",
      unblockDescriptor: null,
      effects: [
        {
          kind: "bind_reviewer",
          prompt: "Review the persisted native-run evidence and confirm whether this issue may be completed.",
        },
        { kind: "notify_owner", agentId: input.agentId, reason: "completion_review_required" },
      ],
    };
  }
  if (input.assessment.reportedDisposition === "blocked" && input.assessment.blocker) {
    const owner = input.assessment.blocker.boardOwned ? "board" as const : { agentId: input.agentId };
    if (input.assessment.blocker.scope === "task_wide") {
      return {
        policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
        statusAction: "blocked",
        toStatus: "blocked",
        reasonCode: "task_wide_blocker_bound",
        unblockDescriptor: { owner, action: input.assessment.blocker.unblockAction },
        effects: [
          { kind: "bind_blocker", owner, action: input.assessment.blocker.unblockAction },
          { kind: "notify_owner", agentId: input.agentId, reason: "task_wide_blocker_bound" },
        ],
      };
    }
    return {
      policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
      statusAction: "in_progress",
      toStatus: "in_progress",
      reasonCode: "turn_waiting_other_track_live",
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
      statusAction: "in_progress",
      toStatus: "in_progress",
      reasonCode: "live_continuation_registered",
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
  if (input.allowIncompleteContinuation === false) {
    return {
      policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
      statusAction: "preserve",
      toStatus: input.priorIssueStatus,
      reasonCode: "prior_status_preserved_no_live_path",
      unblockDescriptor: null,
      effects: [{
        kind: "record_finalization_error",
        cause: "completion_evidence_incomplete",
        nextAction: "Bind a durable continuation or a named recovery owner before changing issue status.",
        agentId: input.agentId,
      }],
    };
  }
  return {
    policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
    statusAction: "in_progress",
    toStatus: "in_progress",
    reasonCode: "completion_evidence_incomplete",
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
