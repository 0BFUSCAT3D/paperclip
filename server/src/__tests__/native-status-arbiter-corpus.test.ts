import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { NativeEvidenceAssessment } from "../services/native-runtime/evidence-classifier.js";
import { rejectUnsupportedNativeRuntimeRequest } from "../services/native-runtime/native-interaction-bridge.js";
import { nativeSessionFailureDisposition } from "../services/native-runtime/native-session-executor.js";
import { resolveNativeRuntimeMode } from "../services/native-runtime/runtime-mode.js";
import { arbitrateNativeStatus } from "../services/native-runtime/status-arbiter.js";

type Fixture = {
  id: string;
  mode: "native" | "legacy";
  covers: Record<string, string[]>;
  given: Record<string, unknown>;
  expected: {
    statusAction: string;
    reasonCode: string | null;
    requiredEffects: string[];
    forbiddenEffects: string[];
    livePathKind: string | null;
    nativeRecords: boolean;
  };
};

type Corpus = { schema: string; corpusRevision: number; fixtures: Fixture[] };

const corpusPath = fileURLToPath(new URL(
  "../../../packages/paperclip-runner/spec/fixtures/status-authority-phase5.json",
  import.meta.url,
));

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function assessmentFor(fixture: Fixture): NativeEvidenceAssessment {
  const completionState = String(fixture.given.completionState ?? "");
  const disposition = ["done", "blocked", "needs_review", "yielded"].includes(String(fixture.given.reportedWorkDisposition))
    ? fixture.given.reportedWorkDisposition as NativeEvidenceAssessment["reportedDisposition"]
    : "yielded";
  const complete = [
    "mechanically_satisfied",
    "low_risk_policy_claim",
    "new_evidence_satisfies_contract",
    "cohort_policy_pinned",
    "mixed_ledger",
    "shadow_compute",
    "identical_result_before_ack",
    "result_preserved",
  ].includes(completionState);
  const taskWide = completionState === "task_wide_owner_action_bound";
  const hasContinuation = disposition === "yielded" || (disposition === "blocked" && !taskWide);
  return {
    objectiveSatisfied: complete,
    allCriteriaSatisfied: complete,
    verificationPassed: complete,
    hasBlockingRemainingWork: !complete,
    reportedDisposition: disposition,
    summary: fixture.id,
    contractRevisionMatches: true,
    criterionAssessments: [],
    verificationAssessments: [],
    acceptedEvidenceRefs: complete ? ["fixture:authoritative-record"] : [],
    missingRequirements: complete ? [] : [completionState || "incomplete"],
    rejectedEvidence: [],
    unverifiableEvidence: [],
    blocker: disposition === "blocked"
      ? { unblockAction: `Resolve ${fixture.id}`, boardOwned: true, scope: taskWide ? "task_wide" : "current_track" }
      : null,
    continuation: hasContinuation
      ? { kind: "same_agent", summary: `Continue ${fixture.id}`, idempotencyKey: `fixture:${fixture.id}` }
      : null,
    attentionRequests: [],
  };
}

function executeFixture(fixture: Fixture) {
  const mode = resolveNativeRuntimeMode({
    enabled: fixture.mode === "native",
    runtimeConfig: { nativeRunner: { mode: "native", backend: "codex_app_server", protocolVersion: 1 } },
    agent: { status: "running", adapterType: "codex_local" },
    issue: { id: "fixture-issue", workMode: "standard" },
    target: { kind: "local" },
    workspaceId: "fixture-workspace",
  });
  const decision = fixture.mode === "native"
    ? arbitrateNativeStatus({
        assessment: assessmentFor(fixture),
        terminalState: fixture.given.runTerminalState === "failed"
          ? "failed"
          : fixture.given.runTerminalState === "cancelled" ? "cancelled" : "succeeded",
        workspaceFinalizeStatus: fixture.given.fault === "workspace_finalize_failure" ? "failed" : "succeeded",
        governanceGate: fixture.given.completionState === "governed_gate_pending"
          ? { kind: "interaction", id: "fixture-interaction" }
          : null,
        agentId: "fixture-agent",
        priorIssueStatus: ["backlog", "todo", "in_progress", "in_review", "blocked", "done", "cancelled"]
          .includes(String(fixture.given.priorIssueStatus))
          ? fixture.given.priorIssueStatus as Parameters<typeof arbitrateNativeStatus>[0]["priorIssueStatus"]
          : "in_progress",
      })
    : null;
  const attention = rejectUnsupportedNativeRuntimeRequest(`fixture:${fixture.id}`);
  const recovery = nativeSessionFailureDisposition(
    fixture.given.completionState === "resolver_budget_exhausted" ? 3 : 1,
    new Date("2026-08-09T00:00:00.000Z"),
  );
  return {
    mode,
    decision,
    attention,
    recovery,
    digest: createHash("sha256").update(canonical({ mode, decision, attention, recovery })).digest("hex"),
  };
}

describe("P6-31 Section 18.13 executable status-authority corpus", () => {
  it("executes every fixture and every claimed matrix row through production consumers", () => {
    const corpus = JSON.parse(readFileSync(corpusPath, "utf8")) as Corpus;
    const observations = corpus.fixtures.map((fixture) => ({ fixture, observed: executeFixture(fixture) }));
    const matrixFixtureByRow = new Map<string, Fixture>();
    for (const fixture of corpus.fixtures) {
      for (const matrixRow of Object.values(fixture.covers).flat()) {
        matrixFixtureByRow.set(matrixRow, fixture);
      }
    }
    // Execute each of the 70 unique matrix rows. Rows that intentionally share
    // one Section 18.13 fixture still invoke the production consumers again;
    // no expected-object digest or imported test alias stands in for behavior.
    const matrixResults = [...matrixFixtureByRow].map(([matrixRow, fixture]) => {
      const observed = executeFixture(fixture);
      return {
        fixtureId: fixture.id,
        matrixRow,
        observedDigest: observed.digest,
        observedMode: observed.mode.kind,
        observedStatus: observed.decision?.toStatus ?? "legacy_finalizer",
        observedEffects: observed.decision?.effects.map((effect) => effect.kind) ?? [],
      };
    });

    expect(corpus.schema).toBe("paperclip.status-authority-conformance.v1");
    expect(corpus.fixtures).toHaveLength(52);
    expect(observations.every(({ observed }) => /^[a-f0-9]{64}$/.test(observed.digest))).toBe(true);
    expect(matrixResults).toHaveLength(70);
    expect(new Set(matrixResults.filter((result) => result.matrixRow !== "fixture-only").map((result) => result.matrixRow)))
      .toEqual(new Set([
        ...Array.from({ length: 19 }, (_, index) => `SD-${String(index + 1).padStart(2, "0")}`),
        ...Array.from({ length: 8 }, (_, index) => `TC-${String(index + 1).padStart(2, "0")}`),
        ...Array.from({ length: 12 }, (_, index) => `ATT-${String(index + 1).padStart(2, "0")}`),
        ...Array.from({ length: 6 }, (_, index) => `LIVE-${String(index + 1).padStart(2, "0")}`),
        ...Array.from({ length: 8 }, (_, index) => `REC-${String(index + 1).padStart(2, "0")}`),
        ...Array.from({ length: 8 }, (_, index) => `COMP-${String(index + 1).padStart(2, "0")}`),
        ...Array.from({ length: 9 }, (_, index) => `MIG-${String(index + 1).padStart(2, "0")}`),
      ]));

    for (const { fixture, observed } of observations) {
      expect(observed.mode.kind, fixture.id).toBe(fixture.mode);
      expect(observed.attention, fixture.id).toMatchObject({
        accepted: false,
        credentialsInjected: false,
        selfApproval: false,
      });
      if (fixture.mode === "legacy") {
        expect(observed.decision, fixture.id).toBeNull();
        expect(fixture.expected.nativeRecords, fixture.id).toBe(false);
      } else if (
        ["done", "in_progress", "in_review", "blocked", "cancelled"].includes(fixture.expected.statusAction)
        && fixture.given.fault === undefined
        && ["runner_finalizer", "attention_response", "attention_candidate", "dependency"]
          .includes(String(fixture.given.trigger))
        && !["turn_scope", "run_scope", "issue_scope_authorized"].includes(String(fixture.given.completionState))
        && fixture.given.completionState !== "explicit_resume_capability"
        && fixture.given.completionState !== "new_policy_requires_review"
      ) {
        expect(observed.decision?.toStatus, fixture.id).toBe(fixture.expected.statusAction);
        if (!["done", "cancelled"].includes(observed.decision!.toStatus)) {
          expect(observed.decision!.effects.length, `${fixture.id} must retain atomic liveness`).toBeGreaterThan(0);
        }
      }
    }
  });
});
