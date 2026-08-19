import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, authUsers, companyMemberships } from "@paperclipai/db";
import {
  getAgentWorkEligibility,
  type IssueExecutionPolicy,
  type IssueExecutionStagePrincipal,
  type IssueExecutionState,
  type IssueReviewPolicy,
} from "@paperclipai/shared";
import { conflict, unprocessable } from "../errors.js";

type PrincipalOwner = {
  assigneeAgentId?: string | null;
  assigneeUserId?: string | null;
  createdByAgentId?: string | null;
  createdByUserId?: string | null;
};

export type IssueExecutionParticipantValidationInput = PrincipalOwner & {
  companyId: string;
  reviewPolicy?: IssueReviewPolicy | null;
  executionPolicy?: IssueExecutionPolicy | null;
  executionState?: IssueExecutionState | null;
};

function principalKey(principal: IssueExecutionStagePrincipal): string | null {
  if (principal.type === "agent") return principal.agentId ? `agent:${principal.agentId}` : null;
  return principal.userId ? `user:${principal.userId}` : null;
}

function independentAuthorKeys(input: IssueExecutionParticipantValidationInput) {
  const keys = new Set<string>();
  const currentParticipantKey = input.executionState?.currentParticipant
    ? principalKey(input.executionState.currentParticipant)
    : null;
  const activeReviewAssigneeIsParticipant =
    input.executionState?.status === "pending"
    && input.executionState.currentStageType === "review"
    && currentParticipantKey != null
    && (
      currentParticipantKey === (input.assigneeAgentId ? `agent:${input.assigneeAgentId}` : null)
      || currentParticipantKey === (input.assigneeUserId ? `user:${input.assigneeUserId}` : null)
    );
  // During an active review the workflow deliberately assigns the issue to the
  // reviewer. The author remains the creator/return assignee; treating the
  // workflow-controlled reviewer assignment as authorship would reject every
  // ordinary builder -> reviewer transition.
  if (!activeReviewAssigneeIsParticipant) {
    if (input.assigneeAgentId) keys.add(`agent:${input.assigneeAgentId}`);
    if (input.assigneeUserId) keys.add(`user:${input.assigneeUserId}`);
  }
  if (input.createdByAgentId) keys.add(`agent:${input.createdByAgentId}`);
  if (input.createdByUserId) keys.add(`user:${input.createdByUserId}`);
  const returnAssigneeKey = input.executionState?.returnAssignee
    ? principalKey(input.executionState.returnAssignee)
    : null;
  if (returnAssigneeKey) keys.add(returnAssigneeKey);
  return keys;
}

/**
 * Validate every typed execution-policy principal under row locks.
 *
 * Agent rows are locked FOR SHARE as a company set because work eligibility
 * includes the full reporting chain. This makes participant validation atomic
 * with lifecycle updates and agent deletion: a delete that wins first removes
 * the row and this check fails, while a policy write that wins first keeps the
 * row alive until the issue write commits.
 */
export async function assertIssueExecutionPolicyParticipants(
  dbOrTx: Db,
  input: IssueExecutionParticipantValidationInput,
): Promise<void> {
  const policy = input.executionPolicy ?? null;
  if (!policy || policy.stages.length === 0) return;

  const participantAgentIds = new Set<string>();
  const participantUserIds = new Set<string>();
  for (const stage of policy.stages) {
    for (const participant of stage.participants) {
      if (participant.type === "agent" && participant.agentId) {
        participantAgentIds.add(participant.agentId);
      } else if (participant.type === "user" && participant.userId) {
        participantUserIds.add(participant.userId);
      }
    }
  }

  const governedAssigneeAgentIds = new Set<string>();
  if (input.assigneeAgentId) governedAssigneeAgentIds.add(input.assigneeAgentId);
  if (input.executionState?.returnAssignee?.type === "agent" && input.executionState.returnAssignee.agentId) {
    governedAssigneeAgentIds.add(input.executionState.returnAssignee.agentId);
  }

  const companyAgents = await dbOrTx
    .select({
      id: agents.id,
      companyId: agents.companyId,
      name: agents.name,
      status: agents.status,
      reportsTo: agents.reportsTo,
    })
    .from(agents)
    .where(eq(agents.companyId, input.companyId))
    .orderBy(agents.id)
    .for("share");
  const companyAgentById = new Map(companyAgents.map((agent) => [agent.id, agent]));

  for (const agentId of participantAgentIds) {
    const agent = companyAgentById.get(agentId);
    if (!agent) {
      throw unprocessable("Execution-policy agent participant must belong to the issue company", {
        code: "execution_policy_participant_agent_not_found",
        companyId: input.companyId,
        agentId,
      });
    }
    const eligibility = getAgentWorkEligibility({ agent, agents: companyAgents });
    if (!eligibility.invokable) {
      throw conflict("Execution-policy agent participant is not eligible to perform review work", {
        code: "execution_policy_participant_agent_ineligible",
        companyId: input.companyId,
        agentId,
        reason: eligibility.invokabilityReason,
        orgChainReason: eligibility.orgChainHealth.reason,
      });
    }
  }

  for (const agentId of governedAssigneeAgentIds) {
    const agent = companyAgentById.get(agentId);
    if (!agent) {
      throw unprocessable("Governed issue agent assignee must belong to the issue company", {
        code: "execution_policy_assignee_agent_not_found",
        companyId: input.companyId,
        agentId,
      });
    }
    const eligibility = getAgentWorkEligibility({ agent, agents: companyAgents });
    if (!eligibility.invokable) {
      throw conflict("Governed issue agent assignee must be eligible to execute work", {
        code: "execution_policy_assignee_agent_ineligible",
        companyId: input.companyId,
        agentId,
        reason: eligibility.invokabilityReason,
        orgChainReason: eligibility.orgChainHealth.reason,
      });
    }
  }

  if (participantUserIds.size > 0) {
    const userIds = [...participantUserIds].sort();
    const existingUsers = await dbOrTx
      .select({ id: authUsers.id })
      .from(authUsers)
      .where(inArray(authUsers.id, userIds))
      .orderBy(authUsers.id)
      .for("share");
    const existingUserIds = new Set(existingUsers.map((user) => user.id));
    const memberships = await dbOrTx
      .select({ id: companyMemberships.id, principalId: companyMemberships.principalId })
      .from(companyMemberships)
      .where(and(
        eq(companyMemberships.companyId, input.companyId),
        eq(companyMemberships.principalType, "user"),
        eq(companyMemberships.status, "active"),
        inArray(companyMemberships.principalId, userIds),
      ))
      .orderBy(companyMemberships.principalId)
      .for("share");
    const memberUserIds = new Set(memberships.map((membership) => membership.principalId));
    for (const userId of userIds) {
      if (!existingUserIds.has(userId) || !memberUserIds.has(userId)) {
        throw unprocessable("Execution-policy user participant must be an active member of the issue company", {
          code: "execution_policy_participant_user_not_found",
          companyId: input.companyId,
          userId,
        });
      }
    }
  }

  if (input.reviewPolicy !== "not_creator") return;
  const authorKeys = independentAuthorKeys(input);
  for (const stage of policy.stages) {
    if (stage.type !== "review") continue;
    for (const participant of stage.participants) {
      const key = principalKey(participant);
      if (!key || !authorKeys.has(key)) continue;
      throw unprocessable(
        "not_creator execution review requires every reviewer to be independent of the creator and return assignee",
        {
          code: "execution_policy_review_participant_not_independent",
          stageId: stage.id,
          participantId: participant.id,
          participantType: participant.type,
          agentId: participant.agentId ?? null,
          userId: participant.userId ?? null,
        },
      );
    }
  }
}
