import path from "node:path";
import { describe, expect, it } from "vitest";
import { detectInvokedSkill, type SkillInvocationContext } from "./skill-invocation.js";

const skillRoot = path.resolve("/runtime/.claude/skills");
const coach = {
  key: "company/coaching/coach",
  runtimeName: "coach--a1b2c3",
  source: "/source/coach",
  versionId: "version-1",
};
const context: SkillInvocationContext = { skillRoot, entries: [coach] };

describe("detectInvokedSkill", () => {
  it.each([coach.runtimeName, coach.key])("maps a Skill call using %s", (skill) => {
    expect(detectInvokedSkill({
      type: "tool_call",
      text: "Using skill",
      title: "Skill",
      rawInput: { skill },
    }, context)).toEqual(coach);
  });

  it("maps a contained Read call to its materialized skill", () => {
    expect(detectInvokedSkill({
      type: "tool_call",
      text: "Reading",
      title: "Read",
      rawInput: { file_path: path.join(skillRoot, coach.runtimeName, "SKILL.md") },
    }, context)).toEqual(coach);
  });

  it.each([
    ["unknown skill", { title: "Skill", rawInput: { skill: "missing" } }],
    ["sibling path", { title: "Read", rawInput: { file_path: path.resolve(skillRoot, "../secret") } }],
    ["root itself", { title: "Read", rawInput: { file_path: skillRoot } }],
    ["other tool", { title: "Grep", rawInput: { path: path.join(skillRoot, coach.runtimeName, "SKILL.md") } }],
    ["missing input", { title: "Read" }],
  ])("does not count %s", (_label, fixture) => {
    expect(detectInvokedSkill({
      type: "tool_call",
      text: "tool call",
      ...fixture,
    }, context)).toBeNull();
  });
});
