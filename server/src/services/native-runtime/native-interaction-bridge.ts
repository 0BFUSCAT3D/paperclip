import type { Db } from "@paperclipai/db";
import type { NativeInteractionResponseEnvelope } from "@paperclipai/paperclip-runner";
import { and, eq, inArray } from "drizzle-orm";
import { heartbeatRuns, issues, issueThreadInteractions, nativeRunFinalizations } from "@paperclipai/db";
import { issueThreadInteractionService } from "../issue-thread-interactions.js";
import {
  NATIVE_STATUS_ARBITER_POLICY_VERSION,
  type NativeAuthoritativeIssueStatus,
  type NativeGovernanceGate,
  type NativeStatusDecision,
  type NativeStatusEffect,
} from "./status-arbiter.js";

export class NativeInteractionBridgeError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "NativeInteractionBridgeError";
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export type NativeAttentionMaterializedTarget = {
  effectKind: string;
  targetType: "issue_thread_interaction" | "native_run_finalization";
  targetId: string;
};

/**
 * Applies audit-only attention outcomes that intentionally create no status
 * decision. The durable interaction/coordinator mutation is the proof; a
 * synthetic delivered effect row is neither created nor accepted.
 */
export async function applyNativeAttentionStatusDecision(input: {
  db: Db;
  companyId: string;
  issueId: string;
  runId: string;
  decision: NativeStatusDecision;
  targetInteractionId?: string;
  canonicalRequestId?: string;
}): Promise<NativeAttentionMaterializedTarget[]> {
  if (input.decision.statusAction !== "preserve") {
    throw new NativeInteractionBridgeError("native_attention_status_authority_invalid", "Audit-only attention cannot change issue status");
  }
  return input.db.transaction(async (tx) => {
    const targets: NativeAttentionMaterializedTarget[] = [];
    for (const effect of input.decision.effects) {
      if (effect.kind === "link_canonical_request") {
        const boundIds = [input.canonicalRequestId, input.targetInteractionId]
          .filter((id): id is string => typeof id === "string");
        const interactions = await tx.select({ id: issueThreadInteractions.id })
          .from(issueThreadInteractions).where(and(
            eq(issueThreadInteractions.companyId, input.companyId),
            eq(issueThreadInteractions.issueId, input.issueId),
            ...(boundIds.length > 0 ? [inArray(issueThreadInteractions.id, boundIds)] : []),
          )).limit(2);
        const canonical = input.canonicalRequestId
          ? interactions.find((interaction) => interaction.id === input.canonicalRequestId)
          : interactions[0];
        const duplicate = input.targetInteractionId
          ? interactions.find((interaction) => interaction.id === input.targetInteractionId)
          : interactions.find((interaction) => interaction.id !== canonical?.id);
        if (!canonical || !duplicate || canonical.id === duplicate.id) {
          throw new NativeInteractionBridgeError("native_attention_canonical_pair_missing", "Canonical and duplicate requests are required");
        }
        await tx.update(issueThreadInteractions).set({
          summary: `Canonical native attention request: ${canonical.id}`,
          updatedAt: new Date(),
        }).where(eq(issueThreadInteractions.id, duplicate.id));
        targets.push({ effectKind: effect.kind, targetType: "issue_thread_interaction", targetId: duplicate.id });
        continue;
      }
      if (effect.kind === "record_stale_response") {
        const interaction = await tx.select({ id: issueThreadInteractions.id })
          .from(issueThreadInteractions).where(and(
            eq(issueThreadInteractions.companyId, input.companyId),
            eq(issueThreadInteractions.issueId, input.issueId),
            ...(input.targetInteractionId ? [eq(issueThreadInteractions.id, input.targetInteractionId)] : []),
          )).limit(1).then((rows) => rows[0] ?? null);
        if (!interaction) throw new NativeInteractionBridgeError("native_stale_response_missing", "Stale response is not durable");
        await tx.update(issueThreadInteractions).set({
          summary: "Response retained for audit after native supersession.",
          updatedAt: new Date(),
        }).where(eq(issueThreadInteractions.id, interaction.id));
        targets.push({ effectKind: effect.kind, targetType: "issue_thread_interaction", targetId: interaction.id });
        continue;
      }
      if (effect.kind === "record_finalization_error") {
        const [coordinator] = await tx.update(nativeRunFinalizations).set({
          phase: "terminal_failure",
          failureCode: effect.cause,
          failureDetail: { nextAction: effect.nextAction, recoveryOwner: { kind: "agent", agentId: effect.agentId } },
          nextAttemptAt: null,
          updatedAt: new Date(),
        }).where(and(
          eq(nativeRunFinalizations.runId, input.runId),
          eq(nativeRunFinalizations.companyId, input.companyId),
          eq(nativeRunFinalizations.issueId, input.issueId),
        )).returning({ runId: nativeRunFinalizations.runId });
        if (!coordinator) throw new NativeInteractionBridgeError("native_finalization_coordinator_missing", "Native coordinator is required");
        await tx.update(heartbeatRuns).set({
          status: "failed",
          finishedAt: new Date(),
          nativePhase: "terminal_failure",
          nativePhaseUpdatedAt: new Date(),
          errorCode: effect.cause,
          updatedAt: new Date(),
        }).where(and(eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.companyId, input.companyId)));
        targets.push({ effectKind: effect.kind, targetType: "native_run_finalization", targetId: coordinator.runId });
        continue;
      }
      throw new NativeInteractionBridgeError("native_attention_effect_unimplemented", effect.kind);
    }
    return targets;
  });
}

/**
 * Materialize only interactions that authorized this run's wake. Resolution
 * remains owned by the existing interaction service; this bridge is a
 * read-only, identity-bound projection and never receives credentials.
 */
export async function materializeNativeInteractionResponses(input: {
  db: Db;
  companyId: string;
  issueId: string;
  runId: string;
  agentId: string;
  interactionIds: string[];
}): Promise<NativeInteractionResponseEnvelope[]> {
  const requestedIds = new Set(input.interactionIds.filter(Boolean));
  if (requestedIds.size === 0) return [];
  const [interactions, issue] = await Promise.all([
    issueThreadInteractionService(input.db).listForIssue(input.issueId),
    input.db.select({ status: issues.status }).from(issues).where(and(
      eq(issues.id, input.issueId),
      eq(issues.companyId, input.companyId),
    )).limit(1).then((rows) => rows[0] ?? null),
  ]);
  if (!issue) throw new NativeInteractionBridgeError("native_interaction_binding_mismatch", "Issue binding not found");
  const responses: NativeInteractionResponseEnvelope[] = [];

  for (const interaction of interactions) {
    if (!requestedIds.has(interaction.id)) continue;
    if (interaction.companyId !== input.companyId || interaction.issueId !== input.issueId) {
      throw new NativeInteractionBridgeError(
        "native_interaction_binding_mismatch",
        `Interaction ${interaction.id} is not bound to the native company and issue`,
      );
    }
    const interactionResult = record(interaction.result);
    const supersessionOutcome = interaction.status === "expired"
      && ["superseded_by_newer_request", "superseded_by_comment", "stale_target"].includes(String(interactionResult.outcome));
    if (supersessionOutcome) {
      const duplicate = interactionResult.outcome === "superseded_by_newer_request";
      const decision = resolveNativeAttentionStatus({
        facts: duplicate
          ? {
              companyScopeValid: true,
              responseState: "none",
              route: "duplicate",
              summary: interaction.summary ?? interaction.title ?? "Duplicate native attention request",
            }
          : {
              companyScopeValid: true,
              responseState: "stale",
              route: "context",
              summary: interaction.summary ?? interaction.title ?? "Stale native attention response",
            },
        priorIssueStatus: issue.status as NativeAuthoritativeIssueStatus,
        agentId: input.agentId,
      });
      await applyNativeAttentionStatusDecision({
        db: input.db,
        companyId: input.companyId,
        issueId: input.issueId,
        runId: input.runId,
        decision,
        targetInteractionId: interaction.id,
        canonicalRequestId: typeof interactionResult.supersededByInteractionId === "string"
          ? interactionResult.supersededByInteractionId
          : undefined,
      });
      continue;
    }
    if (
      interaction.resolvedByRunId === input.runId
      || (
        interaction.resolvedByAgentId === input.agentId
        && interaction.createdByAgentId === input.agentId
      )
    ) {
      throw new NativeInteractionBridgeError(
        "native_interaction_self_approval",
        `Run ${input.runId} cannot consume a response it resolved itself`,
      );
    }
    if (!interaction.resolvedByUserId && !interaction.resolvedByAgentId) {
      throw new NativeInteractionBridgeError(
        "native_interaction_unresolved",
        `Interaction ${interaction.id} has no authorized resolver`,
      );
    }

    if (interaction.kind === "request_confirmation") {
      if (interaction.resolvedByAgentId === input.agentId) {
        throw new NativeInteractionBridgeError(
          "native_interaction_self_approval",
          `Agent ${input.agentId} cannot consume a confirmation it resolved`,
        );
      }
      if (interaction.payload.toolAction !== undefined) {
        throw new NativeInteractionBridgeError(
          "native_interaction_governed_request_unsupported",
          "Governed tool-action confirmations cannot enter a native model envelope",
        );
      }
      if (
        (interaction.status !== "accepted" && interaction.status !== "rejected")
        || !interaction.result
        || (interaction.result.outcome !== "accepted" && interaction.result.outcome !== "rejected")
      ) {
        throw new NativeInteractionBridgeError(
          "native_interaction_unresolved",
          `Confirmation ${interaction.id} is not authoritatively resolved`,
        );
      }
      const resolution = resolveNativeAttentionStatus({
        facts: {
          companyScopeValid: true,
          responseState: "resolved",
          route: "context",
          summary: interaction.summary ?? interaction.title ?? "Resolved native interaction",
        },
        priorIssueStatus: issue.status as NativeAuthoritativeIssueStatus,
        agentId: input.agentId,
      });
      if (resolution.reasonCode !== "attention_resolved_from_context") {
        throw new NativeInteractionBridgeError("native_attention_resolution_invalid", "Resolved interaction has no continuation policy");
      }
      responses.push({
        interactionId: interaction.id,
        kind: interaction.kind,
        response: {
          status: interaction.status,
          result: structuredClone(interaction.result) as unknown as Record<string, unknown>,
        },
      });
      continue;
    }

    if (interaction.kind === "ask_user_questions") {
      if (interaction.status !== "answered" || !interaction.result || interaction.result.cancelled === true) {
        throw new NativeInteractionBridgeError(
          "native_interaction_unresolved",
          `Question interaction ${interaction.id} is not authoritatively answered`,
        );
      }
      const resolution = resolveNativeAttentionStatus({
        facts: {
          companyScopeValid: true,
          responseState: "resolved",
          route: "context",
          summary: interaction.summary ?? interaction.title ?? "Answered native interaction",
        },
        priorIssueStatus: issue.status as NativeAuthoritativeIssueStatus,
        agentId: input.agentId,
      });
      if (resolution.reasonCode !== "attention_resolved_from_context") {
        throw new NativeInteractionBridgeError("native_attention_resolution_invalid", "Answered interaction has no continuation policy");
      }
      responses.push({
        interactionId: interaction.id,
        kind: interaction.kind,
        response: {
          status: interaction.status,
          result: structuredClone(interaction.result) as unknown as Record<string, unknown>,
        },
      });
      continue;
    }

    throw new NativeInteractionBridgeError(
      "native_runtime_request_unsupported",
      `Interaction kind ${interaction.kind} is not supported by the native input contract`,
    );
  }

  const missing = [...requestedIds].filter((id) => !responses.some((response) => response.interactionId === id));
  if (missing.length > 0) {
    throw new NativeInteractionBridgeError(
      "native_interaction_missing",
      `Native interaction response not found: ${missing.join(", ")}`,
    );
  }
  return responses.sort((left, right) => left.interactionId.localeCompare(right.interactionId));
}

/** Native runtimes never receive credentials and never auto-approve requests. */
export function rejectUnsupportedNativeRuntimeRequest(requestKind: string) {
  return {
    accepted: false as const,
    code: "native_runtime_request_unsupported" as const,
    requestKind,
    credentialsInjected: false as const,
    selfApproval: false as const,
  };
}

export type NativeAttentionFacts = {
  companyScopeValid: boolean;
  responseState: "none" | "resolved" | "stale" | "expired";
  route: "alternate_track" | "context" | "retry" | "agent" | "human" | "duplicate" | "recovery";
  summary: string;
  budgetExhausted?: boolean;
  governanceGate?: NativeGovernanceGate | null;
};

/** Server-owned attention resolution from canonical routing facts. */
export function resolveNativeAttentionStatus(input: {
  facts: NativeAttentionFacts;
  priorIssueStatus: NativeAuthoritativeIssueStatus;
  agentId: string;
}): NativeStatusDecision {
  const preserve = (reasonCode: string, effects: NativeStatusEffect[]): NativeStatusDecision => ({
    policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
    statusAction: "preserve",
    toStatus: input.priorIssueStatus,
    reasonCode,
    unblockDescriptor: null,
    effects,
  });
  const continuation = (reasonCode: string): NativeStatusDecision => ({
    policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
    statusAction: "in_progress",
    toStatus: "in_progress",
    reasonCode,
    unblockDescriptor: null,
    effects: [{
      kind: "enqueue_continuation",
      continuationKind: input.facts.route === "agent" ? "response_wake" : "same_agent",
      summary: input.facts.summary,
      idempotencyKey: `native-attention:${input.facts.route}:${input.facts.summary}`,
      agentId: input.agentId,
    }],
  });

  if (!input.facts.companyScopeValid) {
    return preserve("result_schema_rejected", [{
      kind: "record_finalization_error",
      cause: "result_schema_rejected",
      nextAction: "Remove the cross-company attention target.",
      agentId: input.agentId,
    }]);
  }
  if (input.facts.responseState === "stale") {
    return preserve("attention_duplicate_suppressed", [{ kind: "record_stale_response" }]);
  }
  if (input.facts.responseState === "expired") {
    return preserve("attention_budget_exhausted", [{ kind: "record_expiry" }]);
  }
  if (input.facts.budgetExhausted || input.facts.route === "recovery") {
    return preserve("attention_budget_exhausted", [{
      kind: "record_finalization_error",
      cause: "attention_budget_exhausted",
      nextAction: "Assign a named recovery owner.",
      agentId: input.agentId,
    }]);
  }
  if (input.facts.route === "duplicate") {
    return preserve("attention_duplicate_suppressed", [{ kind: "link_canonical_request" }]);
  }
  if (input.facts.governanceGate) {
    return {
      policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
      statusAction: "in_review",
      toStatus: "in_review",
      reasonCode: "governed_gate_pending",
      unblockDescriptor: null,
      effects: [
        { kind: "create_interaction", gate: input.facts.governanceGate },
        { kind: "notify_owner", agentId: input.agentId, reason: "governed_gate_pending" },
      ],
    };
  }
  if (input.facts.route === "alternate_track") {
    return continuation("turn_waiting_other_track_live");
  }
  if (input.facts.route === "context" || input.facts.route === "retry") {
    return continuation("attention_resolved_from_context");
  }
  if (input.facts.route === "agent") {
    const decision = continuation("attention_routed_to_agent");
    return {
      ...decision,
      effects: [
        { kind: "create_delegated_issue", agentId: input.agentId, summary: input.facts.summary },
        ...decision.effects,
      ],
    };
  }
  if (input.facts.route === "human") {
    return {
      policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
      statusAction: "in_review",
      toStatus: "in_review",
      reasonCode: "attention_requires_human_authority",
      unblockDescriptor: null,
      effects: [
        { kind: "create_interaction", prompt: input.facts.summary },
        { kind: "notify_owner", agentId: input.agentId, reason: "attention_requires_human_authority" },
      ],
    };
  }
  throw new NativeInteractionBridgeError("native_attention_facts_invalid", "Attention facts do not select a route");
}
