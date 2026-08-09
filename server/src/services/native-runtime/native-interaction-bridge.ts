import type { Db } from "@paperclipai/db";
import type { NativeInteractionResponseEnvelope } from "@paperclipai/paperclip-runner";
import { issueThreadInteractionService } from "../issue-thread-interactions.js";
import {
  arbitrateNativeStatusScenario,
  type NativeAuthoritativeIssueStatus,
  type NativeGovernanceGate,
  type NativeStatusAuthorityScenario,
} from "./status-arbiter.js";

export class NativeInteractionBridgeError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "NativeInteractionBridgeError";
  }
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
  const interactions = await issueThreadInteractionService(input.db).listForIssue(input.issueId);
  const responses: NativeInteractionResponseEnvelope[] = [];

  for (const interaction of interactions) {
    if (!requestedIds.has(interaction.id)) continue;
    if (interaction.companyId !== input.companyId || interaction.issueId !== input.issueId) {
      throw new NativeInteractionBridgeError(
        "native_interaction_binding_mismatch",
        `Interaction ${interaction.id} is not bound to the native company and issue`,
      );
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

const ATTENTION_STATUS_SCENARIOS = new Set<NativeStatusAuthorityScenario>([
  "alternate_track_runnable", "context_answer_current", "ordinary_domain_expertise",
  "intentional_human_judgment", "equivalent_attention_family", "resolver_budget_exhausted",
  "transient_retry_then_success", "cross_company_target", "response_after_supersession",
  "interaction_expired", "governed_gate_pending",
]);

/** Server-owned attention resolution; candidates never author status/effects. */
export function resolveNativeAttentionStatus(input: {
  scenario: NativeStatusAuthorityScenario;
  priorIssueStatus: NativeAuthoritativeIssueStatus;
  agentId: string;
  governanceGate?: NativeGovernanceGate | null;
  blockerAction?: string;
}) {
  if (!ATTENTION_STATUS_SCENARIOS.has(input.scenario)) {
    throw new NativeInteractionBridgeError("native_attention_scenario_invalid", input.scenario);
  }
  return arbitrateNativeStatusScenario(input);
}
