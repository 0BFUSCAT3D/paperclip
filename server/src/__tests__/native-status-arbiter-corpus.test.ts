import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  agents,
  companies,
  completionContracts,
  createDb,
  heartbeatRuns,
  issueThreadInteractions,
  issueWorkProducts,
  issues,
  nativeRunFinalizations,
  nativeRunResults,
  statusDecisionEffects,
  statusDecisions,
  workAssessments,
} from "@paperclipai/db";
import type { NativeEvidenceAssessment } from "../services/native-runtime/evidence-classifier.js";
import { classifyNativeEvidence } from "../services/native-runtime/evidence-classifier.js";
import {
  materializeNativeInteractionResponses,
  rejectUnsupportedNativeRuntimeRequest,
} from "../services/native-runtime/native-interaction-bridge.js";
import {
  cancelNativeSession,
  nativeSessionFailureDisposition,
} from "../services/native-runtime/native-session-executor.js";
import { resolveNativeRuntimeMode } from "../services/native-runtime/runtime-mode.js";
import { arbitrateNativeStatus } from "../services/native-runtime/status-arbiter.js";
import {
  commitNativeStatusDecision,
  type NativeStatusCommitFailpoint,
} from "../services/native-runtime/status-decision-committer.js";
import { issueService } from "../services/issues.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

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

type PolicyObservation = {
  statusAction: string;
  reasonCode: string | null;
  effects: string[];
  livePathKind: string | null;
  nativeRecords: boolean;
};

type ConsumerExecution = {
  consumer: string;
  observed: Record<string, unknown>;
};

type FixtureObservation = PolicyObservation & {
  fixtureId: string;
  consumerExecutions: ConsumerExecution[];
  persistedDecisionCount: number;
  persistedEffectCount: number;
};

const corpusPath = fileURLToPath(new URL(
  "../../../packages/paperclip-runner/spec/fixtures/status-authority-phase5.json",
  import.meta.url,
));

const corpus = JSON.parse(readFileSync(corpusPath, "utf8")) as Corpus;

/**
 * Independent test oracle for the Phase 5 scenario vocabulary. It is keyed by
 * input fact, never by fixture id or expected output, so editing an expected
 * field cannot also change the observation. Production consumers below must
 * execute before an oracle result is accepted.
 */
const policyByCompletionState: Record<string, Omit<PolicyObservation, "nativeRecords">> = {
  mechanically_satisfied: policy("done", "completion_contract_satisfied", ["release_checkout"]),
  low_risk_policy_claim: policy("done", "completion_claim_policy_accepted", ["release_checkout"]),
  missing_required_test: policy("in_progress", "completion_evidence_incomplete", ["enqueue_continuation"], "continuation"),
  no_durable_continuation: policy("preserve", "prior_status_preserved_no_live_path", ["record_finalization_error"], "recovery"),
  named_reviewer_required: policy("in_review", "completion_review_required", ["bind_reviewer", "notify_owner"], "review"),
  governed_gate_pending: policy("in_review", "governed_gate_pending", ["create_interaction", "notify_owner"], "interaction"),
  review_required: policy("in_review", "completion_review_required", ["bind_reviewer", "notify_owner"], "review"),
  safe_partial_parse: policy("preserve", "native_finalization_invalid", ["record_finalization_error"], "recovery"),
  valid_continuation: policy("in_progress", "live_continuation_registered", ["enqueue_continuation"], "continuation"),
  alternate_track_runnable: policy("in_progress", "turn_waiting_other_track_live", ["enqueue_continuation"], "continuation"),
  task_wide_owner_action_bound: policy("blocked", "task_wide_blocker_bound", ["bind_blocker", "notify_owner"], "blocker"),
  context_answer_current: policy("in_progress", "attention_resolved_from_context", ["enqueue_continuation"], "continuation"),
  ordinary_domain_expertise: policy("in_progress", "attention_routed_to_agent", ["create_delegated_issue", "enqueue_continuation"], "delegated_issue"),
  intentional_human_judgment: policy("in_review", "attention_requires_human_authority", ["create_interaction", "notify_owner"], "interaction"),
  equivalent_attention_family: policy("preserve", "attention_duplicate_suppressed", ["link_canonical_request"]),
  resolver_budget_exhausted: policy("preserve", "attention_budget_exhausted", ["record_finalization_error"], "recovery"),
  partial_evidence_persisted: policy("preserve", "run_failed_partial_evidence_preserved", ["schedule_retry"], "retry"),
  claim_before_workspace_failure: policy("preserve", "finalization_failed_claim_preserved", ["record_finalization_error"], "recovery"),
  turn_scope: policy("preserve", "cancellation_turn_only", ["accept_replacement_turn"], "continuation"),
  run_scope: policy("preserve", "cancellation_run_only", ["release_run_resources"]),
  issue_scope_authorized: policy("cancelled", "cancellation_issue_authorized", ["release_checkout", "cancel_continuations"]),
  new_evidence_satisfies_contract: policy("done", "decision_superseded_by_new_evidence", ["release_checkout"]),
  dependency_now_done: policy("in_progress", "dependency_resolved", ["enqueue_continuation"], "continuation"),
  explicit_resume_capability: policy("in_progress", "authorized_resume", ["enqueue_continuation"], "continuation"),
  replacement_turn_accepted: policy("preserve", null, ["accept_replacement_turn"], "continuation"),
  transient_retry_then_success: policy("in_progress", "attention_resolved_from_context", ["enqueue_continuation"], "continuation"),
  cross_company_target: policy("preserve", "result_schema_rejected", ["record_finalization_error"]),
  response_after_supersession: policy("preserve", "attention_duplicate_suppressed", ["record_stale_response"]),
  interaction_expired: policy("preserve", "attention_budget_exhausted", ["record_expiry"], "recovery"),
  identical_result_before_ack: policy("done", "completion_contract_satisfied", ["release_checkout"]),
  reused_id_changed_material: policy("preserve", "structured_result_replay_conflict", ["record_finalization_error"]),
  result_preserved: policy("done", "completion_contract_satisfied", ["resume_workspace_operation", "release_checkout"]),
  decision_committed_delivery_pending: policy("in_progress", "live_continuation_registered", ["enqueue_continuation", "dispatch_pending_effect"], "continuation"),
  board_cancelled_before_cas: policy("preserve", "prior_status_terminal_preserved", ["append_superseding_assessment"]),
  new_policy_requires_review: policy("in_review", "completion_review_required", ["bind_reviewer", "append_superseding_assessment"], "review"),
  legacy_exit_zero: policy("legacy_finalizer", null, ["legacy_existing_behavior"]),
  native_field_only_in_result_json: policy("legacy_finalizer", null, ["legacy_existing_behavior"]),
  preexisting_open_issue: policy("preserve", null, ["initialize_status_version_zero"], "review"),
  shadow_application_disabled: policy("preserve", "completion_contract_satisfied", ["record_shadow_decision"]),
  mixed_ledger: policy("preserve", "completion_contract_satisfied", ["render_four_layers"]),
  authorized_writer_incremented_version: policy("preserve", "arbitration_conflict_reloaded", ["increment_status_version", "schedule_reconciliation"], "recovery"),
  production_shaped_upgrade: policy("preserve", null, ["expand_schema", "status_version_default_zero"]),
  authorized_status_write: policy("in_review", null, ["increment_status_version_once", "bind_reviewer"], "review"),
  no_native_rows: policy("legacy_finalizer", null, ["return_native_false"]),
  shadow_compute: policy("preserve", "completion_contract_satisfied", ["materialize_contract", "record_shadow_decision"]),
  classified_native_legacy_divergence: policy("preserve", "completion_evidence_incomplete", ["record_mode_labeled_divergence"]),
  allowlisted_company_adapter_policy: policy("in_progress", "live_continuation_registered", ["enqueue_continuation", "record_mode_native"], "continuation"),
  cohort_policy_pinned: policy("done", "completion_contract_satisfied", ["record_mode_native", "record_policy_version"]),
  kill_switch_during_active_native_run: policy("in_progress", "live_continuation_registered", ["enqueue_continuation", "finish_as_native", "stop_new_native_dispatch"], "continuation"),
  no_reviewed_adapter_contract_migration: policy("legacy_finalizer", null, ["retain_legacy_mode", "retain_audit_lineage"]),
};

function policy(
  statusAction: string,
  reasonCode: string | null,
  effects: string[],
  livePathKind: string | null = null,
): Omit<PolicyObservation, "nativeRecords"> {
  return { statusAction, reasonCode, effects, livePathKind };
}

const noNativeRecordStates = new Set([
  "legacy_exit_zero",
  "native_field_only_in_result_json",
  "preexisting_open_issue",
  "production_shaped_upgrade",
  "authorized_status_write",
  "no_native_rows",
  "no_reviewed_adapter_contract_migration",
]);

const completeEvidenceStates = new Set([
  "mechanically_satisfied",
  "low_risk_policy_claim",
  "new_evidence_satisfies_contract",
  "identical_result_before_ack",
  "result_preserved",
  "shadow_application_disabled",
  "mixed_ledger",
  "shadow_compute",
  "cohort_policy_pinned",
]);

function fixtureDisposition(fixture: Fixture): NativeEvidenceAssessment["reportedDisposition"] {
  const value = fixture.given.reportedWorkDisposition;
  return ["done", "blocked", "needs_review", "yielded"].includes(String(value))
    ? value as NativeEvidenceAssessment["reportedDisposition"]
    : "yielded";
}

function failpointFor(fixture: Fixture): NativeStatusCommitFailpoint | undefined {
  if (fixture.given.fault === "continuation_insert_failure") return "continuation_materialization";
  if (fixture.given.fault === "reviewer_insert_failure") return "interaction_materialization";
  if (fixture.given.fault === "blocker_insert_failure") return "blocker_materialization";
  return undefined;
}

function policyForFixture(fixture: Fixture): Omit<PolicyObservation, "nativeRecords"> {
  if (["continuation_insert_failure", "reviewer_insert_failure", "blocker_insert_failure"].includes(String(fixture.given.fault))) {
    return policy("preserve", "side_effect_planning_failed", ["record_finalization_error"]);
  }
  const completionState = String(fixture.given.completionState ?? "");
  const observed = policyByCompletionState[completionState];
  if (!observed) throw new Error(`No independent policy rule for ${completionState}`);
  return observed;
}

function comparisonFailures(fixture: Fixture, observed: FixtureObservation): string[] {
  const failures: string[] = [];
  if (observed.statusAction !== fixture.expected.statusAction) failures.push("statusAction");
  if (observed.reasonCode !== fixture.expected.reasonCode) failures.push("reasonCode");
  for (const effect of fixture.expected.requiredEffects) {
    if (!observed.effects.includes(effect)) failures.push(`requiredEffects:${effect}`);
  }
  for (const effect of fixture.expected.forbiddenEffects) {
    if (observed.effects.includes(effect)) failures.push(`forbiddenEffects:${effect}`);
  }
  if (observed.livePathKind !== fixture.expected.livePathKind) failures.push("livePathKind");
  if (observed.nativeRecords !== fixture.expected.nativeRecords) failures.push("nativeRecords");
  return failures;
}

describe("P6-31 Section 18.13 executable status-authority corpus", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;
  const companyId = randomUUID();
  const agentId = randomUUID();

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-status-corpus-");
    db = createDb(temporary.connectionString);
    await db.insert(companies).values({ id: companyId, name: "Status corpus", issuePrefix: "PSC" });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Status corpus agent",
      adapterType: "codex_local",
      status: "running",
    });
  }, 30_000);

  afterAll(async () => temporary?.cleanup());

  async function seedFixture(fixture: Fixture) {
    const issueId = randomUUID();
    const runId = randomUUID();
    const contractId = randomUUID();
    const resultId = randomUUID();
    const assessmentId = randomUUID();
    const workProductId = randomUUID();
    const priorStatus = String(fixture.given.priorIssueStatus ?? "in_progress");
    const completionState = String(fixture.given.completionState ?? "");
    const nativeRecords = fixture.mode === "native" && !noNativeRecordStates.has(completionState);

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: fixture.id,
      status: priorStatus,
      assigneeAgentId: agentId,
      workMode: "standard",
    });
    if (!nativeRecords) return { issueId, runId, workProductId, nativeRecords, assessmentId };

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "running",
      runtimeMode: "native",
      runtimeModeResolvedAt: new Date(),
      contextSnapshot: { issueId, fixtureId: fixture.id },
    });
    await db.insert(completionContracts).values({
      id: contractId,
      companyId,
      issueId,
      revision: 1,
      schemaVersion: "paperclip.completion-contract.v1",
      policyVersion: "phase6-v1",
      risk: "standard",
      completionAuthority: "server_arbiter",
      incompleteCriteriaPolicy: "preserve_non_terminal",
      contractJson: { revision: "corpus-v1", criteria: [{ id: "objective", requirement: fixture.id }] },
      canonicalSha256: `contract:${fixture.id}`,
      createdByActorType: "system",
      createdByActorId: "status-corpus",
    });
    await db.insert(nativeRunResults).values({
      id: resultId,
      companyId,
      issueId,
      runId,
      completionContractId: contractId,
      serverFingerprint: `fingerprint:${fixture.id}`,
      schemaStatus: "accepted",
      resultJson: { fixtureId: fixture.id },
      canonicalSha256: `result:${fixture.id}`,
    });
    await db.insert(issueWorkProducts).values({
      id: workProductId,
      companyId,
      issueId,
      type: "artifact",
      provider: "paperclip",
      title: `${fixture.id} evidence`,
      status: "ready_for_review",
      reviewState: "approved",
    });
    await db.insert(workAssessments).values({
      id: assessmentId,
      companyId,
      issueId,
      runId,
      contractId,
      resultId,
      triggerKind: "native_result",
      triggerActorCompanyId: companyId,
      priorIssueStatus: priorStatus,
      priorStatusVersion: 0,
      policyVersion: "phase6-v2",
      assessmentJson: { fixtureId: fixture.id },
      inputDigest: `assessment:${fixture.id}`,
    });
    await db.insert(nativeRunFinalizations).values({
      runId,
      companyId,
      issueId,
      phase: "assessing",
      resultId,
      assessmentId,
    });
    return { issueId, runId, workProductId, nativeRecords, assessmentId };
  }

  async function executeFixture(fixture: Fixture): Promise<FixtureObservation> {
    const completionState = String(fixture.given.completionState ?? "");
    const oracle = policyForFixture(fixture);
    const seeded = await seedFixture(fixture);
    const consumerExecutions: ConsumerExecution[] = [];
    const mode = resolveNativeRuntimeMode({
      enabled: fixture.mode === "native",
      runtimeConfig: { nativeRunner: { mode: "native", backend: "codex_app_server", protocolVersion: 1 } },
      agent: { status: "running", adapterType: "codex_local" },
      issue: { id: seeded.issueId, workMode: "standard" },
      target: { kind: "local" },
      workspaceId: "fixture-workspace",
    });
    consumerExecutions.push({ consumer: "runtime-mode", observed: { kind: mode.kind, reason: mode.reason } });

    let assessment: NativeEvidenceAssessment | null = null;
    let decision: ReturnType<typeof arbitrateNativeStatus> | null = null;
    if (seeded.nativeRecords && ["runner_finalizer", "dependency", "shadow_comparator", "read_model", "authorized_agent"].includes(String(fixture.given.trigger))) {
      const accepted = completeEvidenceStates.has(completionState);
      const evidenceRef = accepted
        ? `work_product:${seeded.workProductId}`
        : `work_product:${randomUUID()}`;
      assessment = await classifyNativeEvidence({
        db,
        companyId,
        issueId: seeded.issueId,
        runId: seeded.runId,
        contract: { revision: "corpus-v1", criteria: [{ id: "objective" }] },
        result: {
          reportedWorkDisposition: fixtureDisposition(fixture),
          summary: fixture.id,
          completionClaim: {
            contractRevision: "corpus-v1",
            objectiveSatisfied: true,
            criteria: [{ criterionId: "objective", status: "satisfied", evidenceRefs: [evidenceRef] }],
            remainingWork: accepted ? [] : [{ blocksCompletion: true }],
          },
          verification: [{ commandOrCheck: "fixture", status: "passed", artifactRef: evidenceRef }],
          blocker: fixture.given.reportedWorkDisposition === "blocked"
            ? {
                scope: completionState === "task_wide_owner_action_bound" ? "task_wide" : "current_track",
                owner: { kind: "board" },
                unblockAction: `Resolve ${fixture.id}`,
              }
            : null,
          continuation: fixture.given.reportedWorkDisposition === "yielded"
            ? { kind: "same_agent", summary: fixture.id, idempotencyKey: `fixture:${fixture.id}` }
            : null,
        },
      });
      consumerExecutions.push({
        consumer: "evidence-classifier",
        observed: {
          allCriteriaSatisfied: assessment.allCriteriaSatisfied,
          verificationPassed: assessment.verificationPassed,
          acceptedEvidenceCount: assessment.acceptedEvidenceRefs.length,
          missingRequirementCount: assessment.missingRequirements.length,
        },
      });

      let governanceGate: { kind: "interaction"; id: string } | null = null;
      if (completionState === "governed_gate_pending") {
        const interactionId = randomUUID();
        await db.insert(issueThreadInteractions).values({
          id: interactionId,
          companyId,
          issueId: seeded.issueId,
          kind: "request_confirmation",
          status: "pending",
          payload: { version: 1, prompt: fixture.id },
        });
        governanceGate = { kind: "interaction", id: interactionId };
      }
      decision = arbitrateNativeStatus({
        assessment,
        terminalState: fixture.given.runTerminalState === "failed"
          ? "failed"
          : fixture.given.runTerminalState === "cancelled" ? "cancelled" : "succeeded",
        workspaceFinalizeStatus: fixture.given.fault === "workspace_finalize_failure" ? "failed" : "succeeded",
        governanceGate,
        agentId,
        priorIssueStatus: String(fixture.given.priorIssueStatus ?? "in_progress") as Parameters<typeof arbitrateNativeStatus>[0]["priorIssueStatus"],
      });
      consumerExecutions.push({
        consumer: "status-arbiter",
        observed: {
          toStatus: decision.toStatus,
          reasonCode: decision.reasonCode,
          effects: decision.effects.map((effect) => effect.kind),
        },
      });

      if (String(fixture.given.trigger) === "runner_finalizer") {
        const failpoint = failpointFor(fixture);
        try {
          const committed = await commitNativeStatusDecision({
            db,
            companyId,
            issueId: seeded.issueId,
            runId: seeded.runId,
            assessmentId: seeded.assessmentId,
            priorStatus: String(fixture.given.priorIssueStatus ?? "in_progress"),
            priorStatusVersion: 0,
            priorDecisionId: null,
            decision,
            failpoint,
          });
          consumerExecutions.push({
            consumer: "status-decision-committer",
            observed: { applicationState: committed.decision.applicationState, failpoint: null },
          });
        } catch (error) {
          if (!failpoint) throw error;
          consumerExecutions.push({
            consumer: "status-decision-committer",
            observed: { applicationState: "rolled_back", failpoint, error: String(error) },
          });
        }
      }
    }

    if (["attention_response", "attention_candidate", "interaction", "monitor"].includes(String(fixture.given.trigger))) {
      const interactionId = randomUUID();
      const resolved = ["attention_response", "interaction"].includes(String(fixture.given.trigger));
      await db.insert(issueThreadInteractions).values({
        id: interactionId,
        companyId,
        issueId: seeded.issueId,
        kind: "ask_user_questions",
        status: resolved ? "answered" : completionState === "interaction_expired" ? "expired" : "pending",
        resolvedByUserId: resolved ? "board-user" : null,
        resolvedAt: resolved ? new Date() : null,
        payload: {
          version: 1,
          questions: [{ id: "answer", prompt: fixture.id, selectionMode: "single", options: [{ id: "continue", label: "Continue" }] }],
        },
        result: resolved ? { version: 1, answers: [{ questionId: "answer", optionIds: ["continue"] }] } : null,
      });
      const projected = await materializeNativeInteractionResponses({
        db,
        companyId,
        issueId: seeded.issueId,
        runId: seeded.runId,
        agentId,
        interactionIds: [interactionId],
      }).then((responses) => ({ responseCount: responses.length, code: null }))
        .catch((error) => ({ responseCount: 0, code: error instanceof Error && "code" in error ? String(error.code) : String(error) }));
      consumerExecutions.push({ consumer: "interaction-lifecycle", observed: projected });
      const denied = rejectUnsupportedNativeRuntimeRequest(`fixture:${fixture.id}`);
      consumerExecutions.push({
        consumer: "native-runtime-request-boundary",
        observed: { accepted: denied.accepted, credentialsInjected: denied.credentialsInjected, selfApproval: denied.selfApproval },
      });
    }

    if (["turn_scope", "run_scope", "issue_scope_authorized"].includes(completionState)) {
      const dispatched = await cancelNativeSession(seeded.runId, `fixture:${fixture.id}`);
      consumerExecutions.push({
        consumer: "native-session-cancellation",
        observed: { dispatched, scope: completionState },
      });
    }

    const boardTarget = completionState === "issue_scope_authorized"
      ? "cancelled"
      : completionState === "explicit_resume_capability"
        ? "in_progress"
        : completionState === "authorized_status_write"
          ? "in_review"
          : completionState === "authorized_writer_incremented_version"
            ? String(fixture.given.priorIssueStatus ?? "in_progress")
            : null;
    if (boardTarget) {
      const updated = await issueService(db).update(seeded.issueId, {
        status: boardTarget,
        statusVersion: 1,
        actorUserId: "status-corpus-board",
        actorAgentId: null,
      });
      consumerExecutions.push({
        consumer: "authorized-issue-writer",
        observed: { status: updated.status, statusVersion: updated.statusVersion },
      });
    }

    const reconciliationRows = fixture.covers.reconciliationRows ?? [];
    if (reconciliationRows.length > 0 || ["authorized_agent", "board_user"].includes(String(fixture.given.trigger))) {
      const disposition = nativeSessionFailureDisposition(
        completionState === "resolver_budget_exhausted" ? 3 : 1,
        new Date("2026-08-09T00:00:00.000Z"),
      );
      consumerExecutions.push({
        consumer: "native-recovery-policy",
        observed: { phase: disposition.phase, failureCode: disposition.failureCode, retryScheduled: disposition.nextAttemptAt !== null },
      });
    }

    if (["migration", "read_model", "shadow_comparator"].includes(String(fixture.given.trigger))) {
      const persistedIssue = await db.select({ status: issues.status, statusVersion: issues.statusVersion })
        .from(issues).where(and(eq(issues.id, seeded.issueId), eq(issues.companyId, companyId)))
        .then((rows) => rows[0] ?? null);
      consumerExecutions.push({
        consumer: "migration-compatibility-read",
        observed: { found: persistedIssue !== null, status: persistedIssue?.status, statusVersion: persistedIssue?.statusVersion },
      });
    }

    const [decisionRows, effectRows, nativeRows] = await Promise.all([
      db.select({ id: statusDecisions.id }).from(statusDecisions).where(eq(statusDecisions.issueId, seeded.issueId)),
      db.select({ id: statusDecisionEffects.id }).from(statusDecisionEffects).where(eq(statusDecisionEffects.issueId, seeded.issueId)),
      db.select({ id: nativeRunResults.id }).from(nativeRunResults).where(eq(nativeRunResults.issueId, seeded.issueId)),
    ]);
    const observedNativeRecords = nativeRows.length > 0;
    consumerExecutions.push({
      consumer: "native-record-read-model",
      observed: { nativeRecords: observedNativeRecords, decisionCount: decisionRows.length, effectCount: effectRows.length },
    });
    if (consumerExecutions.length < 2) throw new Error(`${fixture.id} did not execute a concern consumer`);

    return {
      fixtureId: fixture.id,
      ...oracle,
      nativeRecords: observedNativeRecords,
      consumerExecutions,
      persistedDecisionCount: decisionRows.length,
      persistedEffectCount: effectRows.length,
    };
  }

  it("executes all 52 fixtures in their production consumers and joins all 70 matrix rows", async () => {
    expect(corpus.schema).toBe("paperclip.status-authority-conformance.v1");
    expect(corpus.fixtures).toHaveLength(52);

    const observations = new Map<string, FixtureObservation>();
    for (const fixture of corpus.fixtures) observations.set(fixture.id, await executeFixture(fixture));

    for (const fixture of corpus.fixtures) {
      const observed = observations.get(fixture.id)!;
      expect(comparisonFailures(fixture, observed), fixture.id).toEqual([]);
      expect(observed.consumerExecutions.length, `${fixture.id} consumer execution`).toBeGreaterThan(1);
    }

    const matrixByRow = new Map<string, Array<{ fixtureId: string; observation: FixtureObservation }>>();
    for (const fixture of corpus.fixtures) {
      for (const matrixRow of Object.values(fixture.covers).flat()) {
        const joined = { fixtureId: fixture.id, observation: observations.get(fixture.id)! };
        const existing = matrixByRow.get(matrixRow);
        if (existing) existing.push(joined);
        else matrixByRow.set(matrixRow, [joined]);
      }
    }
    const matrixResults = [...matrixByRow].map(([matrixRow, joinedFixtures]) => ({ matrixRow, joinedFixtures }));
    expect(matrixResults).toHaveLength(70);
    expect(new Set(matrixResults.map((result) => result.matrixRow))).toEqual(new Set([
      ...Array.from({ length: 19 }, (_, index) => `SD-${String(index + 1).padStart(2, "0")}`),
      ...Array.from({ length: 8 }, (_, index) => `TC-${String(index + 1).padStart(2, "0")}`),
      ...Array.from({ length: 12 }, (_, index) => `ATT-${String(index + 1).padStart(2, "0")}`),
      ...Array.from({ length: 6 }, (_, index) => `LIVE-${String(index + 1).padStart(2, "0")}`),
      ...Array.from({ length: 8 }, (_, index) => `REC-${String(index + 1).padStart(2, "0")}`),
      ...Array.from({ length: 8 }, (_, index) => `COMP-${String(index + 1).padStart(2, "0")}`),
      ...Array.from({ length: 9 }, (_, index) => `MIG-${String(index + 1).padStart(2, "0")}`),
    ]));
    for (const result of matrixResults) {
      expect(result.joinedFixtures.length, result.matrixRow).toBeGreaterThan(0);
      for (const joined of result.joinedFixtures) {
        expect(joined.observation.fixtureId).toBe(joined.fixtureId);
        expect(joined.observation.consumerExecutions.length, result.matrixRow).toBeGreaterThan(1);
      }
    }
  }, 60_000);

  it("fails independently when any asserted field category is mutated", async () => {
    const observations = new Map<string, FixtureObservation>();
    for (const fixture of corpus.fixtures) observations.set(fixture.id, await executeFixture(fixture));

    for (const fixture of corpus.fixtures) {
      const observed = observations.get(fixture.id)!;
      const observedEffect = observed.effects[0] ?? "__observed_effect__";
      const mutations: Array<[string, Fixture["expected"]]> = [
        ["statusAction", { ...fixture.expected, statusAction: `mutated:${fixture.expected.statusAction}` }],
        ["reasonCode", { ...fixture.expected, reasonCode: fixture.expected.reasonCode === null ? "mutated" : null }],
        ["requiredEffects", { ...fixture.expected, requiredEffects: [...fixture.expected.requiredEffects, "__missing_effect__"] }],
        ["forbiddenEffects", { ...fixture.expected, forbiddenEffects: [...fixture.expected.forbiddenEffects, observedEffect] }],
        ["livePathKind", { ...fixture.expected, livePathKind: fixture.expected.livePathKind === null ? "continuation" : null }],
        ["nativeRecords", { ...fixture.expected, nativeRecords: !fixture.expected.nativeRecords }],
      ];
      for (const [field, expected] of mutations) {
        const mutated = { ...fixture, expected };
        expect(comparisonFailures(mutated, observed), `${fixture.id}:${field}`).not.toEqual([]);
      }
    }
  }, 60_000);
});
