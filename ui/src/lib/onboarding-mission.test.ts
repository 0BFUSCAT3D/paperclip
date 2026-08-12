import type { Goal } from "@paperclipai/shared";
import { describe, expect, it } from "vitest";
import { parseOnboardingGoalInput } from "./onboarding-goal";
import {
  isExistingCompanyMissionUnresolved,
  planMissionPersistence,
  selectExistingCompanyMission,
} from "./onboarding-mission";

function goal(overrides: Partial<Goal> & Pick<Goal, "id" | "title">): Goal {
  return {
    companyId: "company-1",
    description: null,
    level: "company",
    status: "active",
    parentId: null,
    ownerAgentId: null,
    createdAt: new Date("2026-03-02T00:00:00Z"),
    updatedAt: new Date("2026-03-02T00:00:00Z"),
    ...overrides,
  };
}

describe("selectExistingCompanyMission", () => {
  it("reads the company goal back into the mission textarea", () => {
    expect(
      selectExistingCompanyMission([
        goal({ id: "goal-1", title: "Ship the cloud onboarding walk" }),
      ]),
    ).toEqual({
      goalId: "goal-1",
      goalInput: "Ship the cloud onboarding walk",
    });
  });

  it("includes the goal description below the title", () => {
    expect(
      selectExistingCompanyMission([
        goal({
          id: "goal-1",
          title: "Ship the cloud onboarding walk",
          description: "End to end, across all four apps.",
        }),
      ]),
    ).toEqual({
      goalId: "goal-1",
      goalInput:
        "Ship the cloud onboarding walk\n\nEnd to end, across all four apps.",
    });
  });

  it("round-trips through the mission textarea's own parser", () => {
    const mission = selectExistingCompanyMission([
      goal({
        id: "goal-1",
        title: "Ship the cloud onboarding walk",
        description: "End to end, across all four apps.",
      }),
    ]);

    expect(parseOnboardingGoalInput(mission.goalInput)).toEqual({
      title: "Ship the cloud onboarding walk",
      description: "End to end, across all four apps.",
    });
  });

  it("reports no mission when the company has no company-level goal", () => {
    expect(
      selectExistingCompanyMission([
        goal({ id: "team-goal", title: "Nested", level: "team" }),
      ]),
    ).toEqual({ goalId: null, goalInput: "" });
  });

  it("reports no mission for a company with no goals at all", () => {
    expect(selectExistingCompanyMission([])).toEqual({
      goalId: null,
      goalInput: "",
    });
  });
});

describe("planMissionPersistence", () => {
  // Confirming the mission on a company that already exists used to early-return
  // without writing anything, silently discarding what was typed.
  it("updates the existing company goal instead of discarding the mission", () => {
    expect(
      planMissionPersistence({
        goalInput: "Ship the cloud onboarding walk",
        existingGoalId: "goal-1",
      }),
    ).toEqual({
      kind: "update",
      goalId: "goal-1",
      payload: { title: "Ship the cloud onboarding walk", description: null },
    });
  });

  it("splits a multi-line mission into title and description on update", () => {
    expect(
      planMissionPersistence({
        goalInput: "Ship the walk\n\nEnd to end, across all four apps.",
        existingGoalId: "goal-1",
      }),
    ).toEqual({
      kind: "update",
      goalId: "goal-1",
      payload: {
        title: "Ship the walk",
        description: "End to end, across all four apps.",
      },
    });
  });

  it("clears a removed description rather than leaving the old one", () => {
    expect(
      planMissionPersistence({
        goalInput: "Ship the walk",
        existingGoalId: "goal-1",
      }),
    ).toMatchObject({ payload: { description: null } });
  });

  it("creates a company-level goal when the company has none yet", () => {
    expect(
      planMissionPersistence({
        goalInput: "Ship the walk\n\nEnd to end.",
        existingGoalId: null,
      }),
    ).toEqual({
      kind: "create",
      payload: {
        title: "Ship the walk",
        description: "End to end.",
        level: "company",
        status: "active",
      },
    });
  });

  it("omits an empty description when creating", () => {
    expect(
      planMissionPersistence({ goalInput: "Ship the walk", existingGoalId: null }),
    ).toEqual({
      kind: "create",
      payload: { title: "Ship the walk", level: "company", status: "active" },
    });
  });

  it("writes nothing when no mission was entered", () => {
    expect(
      planMissionPersistence({ goalInput: "   \n  ", existingGoalId: "goal-1" }),
    ).toEqual({ kind: "skip" });
  });
});

describe("isExistingCompanyMissionUnresolved", () => {
  it("holds the hire until the existing company's goals have been read", () => {
    expect(
      isExistingCompanyMissionUnresolved({
        existingCompanyId: "company-1",
        goalsLoaded: false,
      }),
    ).toBe(true);
  });

  it("releases the hire once they land", () => {
    expect(
      isExistingCompanyMissionUnresolved({
        existingCompanyId: "company-1",
        goalsLoaded: true,
      }),
    ).toBe(false);
  });

  it("holds the hire while a cached read is being superseded", () => {
    expect(
      isExistingCompanyMissionUnresolved({
        existingCompanyId: "company-1",
        goalsLoaded: true,
        goalsFetching: true,
      }),
    ).toBe(true);
  });

  it("still ignores an in-flight read for a company created in this run", () => {
    expect(
      isExistingCompanyMissionUnresolved({
        existingCompanyId: null,
        goalsLoaded: false,
        goalsFetching: true,
      }),
    ).toBe(false);
  });

  it("never holds a company created in this run — step 2 typed its mission", () => {
    expect(
      isExistingCompanyMissionUnresolved({
        existingCompanyId: undefined,
        goalsLoaded: false,
      }),
    ).toBe(false);
    expect(
      isExistingCompanyMissionUnresolved({ existingCompanyId: null, goalsLoaded: false }),
    ).toBe(false);
  });
});
