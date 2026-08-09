import { describe, expect, it } from "vitest";
import { classifyNativeEvidence } from "./evidence-classifier.js";
import { arbitrateNativeStatus } from "./status-arbiter.js";

function result(overrides: Record<string, unknown> = {}) {
  return {
    reportedWorkDisposition: "done",
    summary: "Complete",
    completionClaim: {
      objectiveSatisfied: true,
      criteria: [{ criterionId: "objective", status: "satisfied", evidenceRefs: ["test"] }],
      remainingWork: [],
    },
    verification: [{ commandOrCheck: "test", status: "passed" }],
    ...overrides,
  };
}

describe("native status authority", () => {
  it("marks done only from successful finalization and complete evidence", () => {
    const assessment = classifyNativeEvidence(result());
    expect(arbitrateNativeStatus({
      assessment,
      terminalState: "succeeded",
      workspaceFinalizeStatus: "succeeded",
      agentId: "agent",
    }).toStatus).toBe("done");
  });

  it("keeps incomplete, review, cancelled, and yielded work non-terminal", () => {
    for (const reportedWorkDisposition of ["needs_review", "yielded"] as const) {
      expect(arbitrateNativeStatus({
        assessment: classifyNativeEvidence(result({ reportedWorkDisposition })),
        terminalState: "succeeded",
        workspaceFinalizeStatus: "succeeded",
        agentId: "agent",
      }).toStatus).toBe("in_progress");
    }
    expect(arbitrateNativeStatus({
      assessment: classifyNativeEvidence(result()),
      terminalState: "cancelled",
      workspaceFinalizeStatus: "succeeded",
      agentId: "agent",
    }).toStatus).toBe("in_progress");
    expect(arbitrateNativeStatus({
      assessment: classifyNativeEvidence(result()),
      terminalState: "succeeded",
      workspaceFinalizeStatus: "succeeded",
      approvalGateSatisfied: false,
      agentId: "agent",
    })).toEqual(expect.objectContaining({
      toStatus: "in_progress",
      reasonCode: "approval_gate_pending",
    }));
  });

  it("blocks only on a first-class blocker or failed workspace finalization", () => {
    const explicitBlocker = classifyNativeEvidence(result({
      reportedWorkDisposition: "blocked",
      blocker: { owner: { kind: "board" }, unblockAction: "Approve access" },
    }));
    expect(arbitrateNativeStatus({
      assessment: explicitBlocker,
      terminalState: "succeeded",
      workspaceFinalizeStatus: "succeeded",
      agentId: "agent",
    })).toEqual(expect.objectContaining({
      toStatus: "blocked",
      unblockDescriptor: { owner: "board", action: "Approve access" },
    }));
  });
});
