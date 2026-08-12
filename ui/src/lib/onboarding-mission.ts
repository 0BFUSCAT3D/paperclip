import type { Goal } from "@paperclipai/shared";

import { formatOnboardingGoalInput, parseOnboardingGoalInput } from "./onboarding-goal";
import { selectDefaultCompanyGoalId } from "./onboarding-launch";

export type ExistingCompanyMission = {
  goalId: string | null;
  goalInput: string;
};

/**
 * Read an existing company's mission back out of its goals, in the shape the
 * wizard's mission textarea edits.
 *
 * The wizard can be entered on a company that already exists — the
 * /{prefix}/onboarding route, or an in-app "add agent" entry. On those paths
 * step 1 and step 2 never run, so the mission has to come from the company
 * rather than from the form. Both the Review step and the lead agent's
 * instructions bundle read it.
 */
export function selectExistingCompanyMission(goals: Goal[]): ExistingCompanyMission {
  const goalId = selectDefaultCompanyGoalId(goals);
  if (!goalId) return { goalId: null, goalInput: "" };

  const goal = goals.find((entry) => entry.id === goalId) ?? null;

  return {
    goalId,
    goalInput: goal ? formatOnboardingGoalInput(goal.title, goal.description) : "",
  };
}

export type MissionGoalPayload = {
  title: string;
  description?: string | null;
  level?: "company";
  status?: "active";
};

export type MissionPersistencePlan =
  | { kind: "skip" }
  | { kind: "create"; payload: MissionGoalPayload }
  | { kind: "update"; goalId: string; payload: MissionGoalPayload };

/**
 * Decide what confirming the mission has to write.
 *
 * The wizard used to early-return whenever a company id was already present,
 * so a mission typed on an existing company was silently discarded. An existing
 * company still needs no `companies.create` — but its mission must land on the
 * company-level goal, updating the goal the company already has rather than
 * creating a second one.
 */
export function planMissionPersistence(params: {
  goalInput: string;
  existingGoalId: string | null;
}): MissionPersistencePlan {
  const parsed = parseOnboardingGoalInput(params.goalInput);
  if (!parsed.title) return { kind: "skip" };

  if (params.existingGoalId) {
    return {
      kind: "update",
      goalId: params.existingGoalId,
      payload: { title: parsed.title, description: parsed.description },
    };
  }

  return {
    kind: "create",
    payload: {
      title: parsed.title,
      ...(parsed.description ? { description: parsed.description } : {}),
      level: "company",
      status: "active",
    },
  };
}
