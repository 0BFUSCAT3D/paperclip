import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  agents,
  agentWakeupRequests,
  companies,
  completionContracts,
  createDb,
  heartbeatRuns,
  issueThreadInteractions,
  issueRecoveryActions,
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
  resolveNativeAttentionStatus,
} from "../services/native-runtime/native-interaction-bridge.js";
import {
  cancelNativeSession,
  nativeSessionFailureDisposition,
  resolveNativeCancellationStatus,
} from "../services/native-runtime/native-session-executor.js";
import {
  inspectNativeCompatibilityState,
  inspectNativeMigrationState,
  resolveNativeCompatibilityStatus,
  resolveNativeMigrationStatus,
  resolveNativeRuntimeMode,
} from "../services/native-runtime/runtime-mode.js";
import {
  arbitrateNativeStatus,
  type NativeStatusAuthorityScenario,
} from "../services/native-runtime/status-arbiter.js";
import {
  commitNativeStatusDecision,
  type NativeStatusCommitFailpoint,
} from "../services/native-runtime/status-decision-committer.js";
import {
  projectNativeTerminalRunStatus,
  recordNativeFinalizationFailure,
  resolveNativeFinalizerStatus,
} from "../services/native-runtime/native-run-finalizer.js";
import { resolveNativeReconciliationStatus } from "../services/native-runtime/native-finalization-reconciler.js";
import { issueService } from "../services/issues.js";
import { issueThreadInteractionService } from "../services/issue-thread-interactions.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

type Fixture = {
  id: string;
  mode: "native" | "legacy";
  covers: Record<string, string[]>;
  given: Record<string, unknown>;
  expected: {
    statusAction: string;
    runStatus: string;
    reasonCode: string | null;
    requiredEffects: string[];
    forbiddenEffects: string[];
    livePathKind: string | null;
    preserveClaim: boolean;
    nativeRecords: boolean;
    decisionCount: number;
    maxWakeCount: number;
    maxNotificationCount: number;
  };
};

type Corpus = { schema: string; corpusRevision: number; fixtures: Fixture[] };

type PolicyObservation = {
  runStatus: string;
  statusAction: string;
  reasonCode: string | null;
  effects: string[];
  livePathKind: string | null;
  preserveClaim: boolean;
  nativeRecords: boolean;
  decisionCount: number;
  wakeCount: number;
  notificationCount: number;
};

type ConsumerExecution = {
  consumer: string;
  observed: Record<string, unknown>;
};

type FixtureObservation = PolicyObservation & {
  fixtureId: string;
  consumerExecutions: ConsumerExecution[];
  consumerEvidenceByRow: Map<string, string>;
};

const corpusPath = fileURLToPath(new URL(
  "../../../packages/paperclip-runner/spec/fixtures/status-authority-phase5.json",
  import.meta.url,
));

const corpus = JSON.parse(readFileSync(corpusPath, "utf8")) as Corpus;

const matrixRowConsumers: Record<string, string> = {
  "SD-01": "native-finalizer-status",
  "SD-02": "native-finalizer-status",
  "SD-03": "native-finalizer-status",
  "SD-04": "native-finalizer-status",
  "SD-05": "native-finalizer-status",
  "SD-06": "native-finalizer-status",
  "SD-07": "native-finalizer-status",
  "SD-08": "native-finalizer-status",
  "SD-09": "native-attention-resolver",
  "SD-10": "native-attention-resolver",
  "SD-11": "native-attention-resolver",
  "SD-12": "native-attention-resolver",
  "SD-13": "native-attention-resolver",
  "SD-14": "native-finalizer-status",
  "SD-15": "native-finalizer-status",
  "SD-16": "native-cancellation-authority",
  "SD-17": "native-cancellation-authority",
  "SD-18": "native-cancellation-authority",
  "SD-19": "native-reconciliation-consumer",
  "TC-01": "native-run-terminal-projection",
  "TC-02": "native-run-terminal-projection",
  "TC-03": "native-run-terminal-projection",
  "TC-04": "native-run-terminal-projection",
  "TC-05": "native-run-terminal-projection",
  "TC-06": "native-run-terminal-projection",
  "TC-07": "native-run-terminal-projection",
  "TC-08": "native-run-terminal-projection",
  "ATT-01": "native-attention-resolver",
  "ATT-02": "native-attention-resolver",
  "ATT-03": "native-attention-resolver",
  "ATT-04": "native-attention-resolver",
  "ATT-05": "native-attention-resolver",
  "ATT-06": "native-attention-resolver",
  "ATT-07": "native-attention-resolver",
  "ATT-08": "native-attention-resolver",
  "ATT-09": "native-attention-resolver",
  "ATT-10": "native-attention-resolver",
  "ATT-11": "native-attention-resolver",
  "ATT-12": "native-attention-resolver",
  "LIVE-01": "status-decision-committer",
  "LIVE-02": "status-decision-committer",
  "LIVE-03": "status-decision-committer",
  "LIVE-04": "status-decision-committer",
  "LIVE-05": "status-decision-committer",
  "LIVE-06": "status-decision-committer",
  "REC-01": "native-reconciliation-consumer",
  "REC-02": "native-reconciliation-consumer",
  "REC-03": "native-reconciliation-consumer",
  "REC-04": "native-reconciliation-consumer",
  "REC-05": "native-reconciliation-consumer",
  "REC-06": "native-reconciliation-consumer",
  "REC-07": "native-reconciliation-consumer",
  "REC-08": "native-reconciliation-consumer",
  "COMP-01": "native-compatibility-read-model",
  "COMP-02": "native-compatibility-status",
  "COMP-03": "native-compatibility-read-model",
  "COMP-04": "native-compatibility-read-model",
  "COMP-05": "native-compatibility-status",
  "COMP-06": "native-compatibility-status",
  "COMP-07": "native-compatibility-read-model",
  "COMP-08": "native-compatibility-status",
  "MIG-01": "native-migration-read-model",
  "MIG-02": "native-migration-read-model",
  "MIG-03": "native-migration-read-model",
  "MIG-04": "native-migration-status",
  "MIG-05": "native-migration-status",
  "MIG-06": "native-migration-status",
  "MIG-07": "native-migration-status",
  "MIG-08": "native-migration-status",
  "MIG-09": "native-migration-read-model",
};

function requiredConsumerForMatrixRow(matrixRow: string) {
  const consumer = matrixRowConsumers[matrixRow];
  if (!consumer) throw new Error(`No production consumer assertion for ${matrixRow}`);
  return consumer;
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

const scenarioStates = new Set<NativeStatusAuthorityScenario>([
  "mechanically_satisfied", "low_risk_policy_claim", "missing_required_test",
  "no_durable_continuation", "named_reviewer_required", "governed_gate_pending",
  "review_required", "safe_partial_parse", "valid_continuation",
  "alternate_track_runnable", "task_wide_owner_action_bound", "context_answer_current",
  "ordinary_domain_expertise", "intentional_human_judgment", "equivalent_attention_family",
  "resolver_budget_exhausted", "partial_evidence_persisted", "claim_before_workspace_failure",
  "turn_scope", "run_scope", "issue_scope_authorized", "new_evidence_satisfies_contract",
  "dependency_now_done", "explicit_resume_capability", "transient_retry_then_success",
  "replacement_turn_accepted",
  "cross_company_target", "response_after_supersession", "interaction_expired",
  "identical_result_before_ack", "reused_id_changed_material", "result_preserved",
  "decision_committed_delivery_pending", "board_cancelled_before_cas", "new_policy_requires_review",
  "shadow_application_disabled", "mixed_ledger", "authorized_writer_incremented_version",
  "shadow_compute", "classified_native_legacy_divergence", "allowlisted_company_adapter_policy",
  "cohort_policy_pinned", "kill_switch_during_active_native_run",
]);

const zeroDecisionStates = new Set([
  "safe_partial_parse", "equivalent_attention_family", "cross_company_target",
  "response_after_supersession", "reused_id_changed_material",
]);

const supersedingDecisionStates = new Set([
  "new_evidence_satisfies_contract", "dependency_now_done", "explicit_resume_capability",
  "board_cancelled_before_cas", "new_policy_requires_review", "authorized_writer_incremented_version",
]);

function initialRunStatus(fixture: Fixture) {
  const terminalState = fixture.given.runTerminalState;
  if (["succeeded", "failed", "cancelled", "active"].includes(String(terminalState))) {
    return projectNativeTerminalRunStatus(terminalState as "succeeded" | "failed" | "cancelled" | "active");
  }
  return projectNativeTerminalRunStatus(
    fixture.given.nativeFinalization === "present" ? "succeeded" : "active",
  );
}

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

function comparisonFailures(fixture: Fixture, observed: FixtureObservation): string[] {
  const failures: string[] = [];
  if (observed.runStatus !== fixture.expected.runStatus) failures.push("runStatus");
  if (observed.statusAction !== fixture.expected.statusAction) failures.push("statusAction");
  if (observed.reasonCode !== fixture.expected.reasonCode) failures.push("reasonCode");
  for (const effect of fixture.expected.requiredEffects) {
    if (!observed.effects.includes(effect)) failures.push(`requiredEffects:${effect}`);
  }
  for (const effect of fixture.expected.forbiddenEffects) {
    if (observed.effects.includes(effect)) failures.push(`forbiddenEffects:${effect}`);
  }
  if (observed.livePathKind !== fixture.expected.livePathKind) failures.push("livePathKind");
  if (observed.preserveClaim !== fixture.expected.preserveClaim) failures.push("preserveClaim");
  if (observed.nativeRecords !== fixture.expected.nativeRecords) failures.push("nativeRecords");
  if (observed.decisionCount !== fixture.expected.decisionCount) failures.push("decisionCount");
  if (observed.wakeCount > fixture.expected.maxWakeCount) failures.push("maxWakeCount");
  if (observed.notificationCount > fixture.expected.maxNotificationCount) failures.push("maxNotificationCount");
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
    if (!nativeRecords) return {
      issueId,
      runId,
      workProductId,
      nativeRecords,
      assessmentId,
      contractId: null,
      resultId: null,
    };

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: initialRunStatus(fixture),
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
      resultJson: {
        fixtureId: fixture.id,
        ...(fixture.given.reportedWorkDisposition === null && fixture.given.nativeFinalization !== "invalid"
          ? {}
          : { completionClaim: { fixtureId: fixture.id, preserved: true } }),
      },
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
    return { issueId, runId, workProductId, nativeRecords, assessmentId, contractId, resultId };
  }

  async function executeFixture(fixture: Fixture): Promise<FixtureObservation> {
    const completionState = String(fixture.given.completionState ?? "");
    const seeded = await seedFixture(fixture);
    const consumerExecutions: ConsumerExecution[] = [];
    const priorIssueStatus = String(fixture.given.priorIssueStatus ?? "in_progress") as Parameters<typeof arbitrateNativeStatus>[0]["priorIssueStatus"];
    const mode = resolveNativeRuntimeMode({
      enabled: fixture.mode === "native",
      runtimeConfig: { nativeRunner: { mode: "native", backend: "codex_app_server", protocolVersion: 1 } },
      agent: { status: "running", adapterType: "codex_local" },
      issue: { id: seeded.issueId, workMode: "standard" },
      target: { kind: "local" },
      workspaceId: "fixture-workspace",
    });
    consumerExecutions.push({ consumer: "runtime-mode", observed: { kind: mode.kind, reason: mode.reason } });

    let governanceGate: { kind: "interaction"; id: string } | null = null;
    if (seeded.nativeRecords && completionState === "governed_gate_pending") {
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

    const scenario = scenarioStates.has(completionState as NativeStatusAuthorityScenario)
      ? completionState as NativeStatusAuthorityScenario
      : null;
    const decisionArgs = scenario ? {
      scenario,
      priorIssueStatus,
      agentId,
      governanceGate,
      blockerAction: `Resolve ${fixture.id}`,
    } : null;
    const pushDecisionConsumer = (
      consumer: string,
      decision: ReturnType<typeof resolveNativeFinalizerStatus>,
    ) => {
      consumerExecutions.push({
        consumer,
        observed: {
          statusAction: decision.statusAction,
          toStatus: decision.toStatus,
          reasonCode: decision.reasonCode,
          effects: decision.effects.map((effect) => effect.kind),
        },
      });
      return decision;
    };

    let semanticConsumer: string | null = null;
    let scenarioDecision: ReturnType<typeof resolveNativeFinalizerStatus> | null = null;
    if (scenario && decisionArgs) {
      if (["turn_scope", "run_scope", "issue_scope_authorized"].includes(completionState)) {
        semanticConsumer = "native-cancellation-authority";
        const scope = completionState === "turn_scope" ? "turn" : completionState === "run_scope" ? "run" : "issue";
        scenarioDecision = pushDecisionConsumer(semanticConsumer, resolveNativeCancellationStatus({ scope, priorIssueStatus, agentId }));
      } else if (
        supersedingDecisionStates.has(completionState)
        || (fixture.covers.reconciliationRows ?? []).length > 0
        || String(fixture.given.trigger) === "dependency"
      ) {
        semanticConsumer = "native-reconciliation-consumer";
        scenarioDecision = pushDecisionConsumer(semanticConsumer, resolveNativeReconciliationStatus(decisionArgs));
      } else if (["attention_response", "attention_candidate", "interaction", "monitor"].includes(String(fixture.given.trigger))) {
        semanticConsumer = "native-attention-resolver";
        scenarioDecision = pushDecisionConsumer(semanticConsumer, resolveNativeAttentionStatus(decisionArgs));
      } else if ((fixture.covers.migrationRows ?? []).length > 0 && (fixture.covers.decisionRows ?? []).length === 0) {
        semanticConsumer = "native-migration-status";
        scenarioDecision = pushDecisionConsumer(semanticConsumer, resolveNativeMigrationStatus(decisionArgs));
      } else if ((fixture.covers.compatibilityRows ?? []).length > 0 && (fixture.covers.decisionRows ?? []).length === 0) {
        semanticConsumer = "native-compatibility-status";
        scenarioDecision = pushDecisionConsumer(semanticConsumer, resolveNativeCompatibilityStatus(decisionArgs));
      } else {
        semanticConsumer = "native-finalizer-status";
        scenarioDecision = pushDecisionConsumer(semanticConsumer, resolveNativeFinalizerStatus(decisionArgs));
      }

      if ((fixture.covers.attentionRows ?? []).length > 0 && semanticConsumer !== "native-attention-resolver") {
        pushDecisionConsumer("native-attention-resolver", resolveNativeAttentionStatus(decisionArgs));
      }
      if ((fixture.covers.reconciliationRows ?? []).length > 0 && semanticConsumer !== "native-reconciliation-consumer") {
        pushDecisionConsumer("native-reconciliation-consumer", resolveNativeReconciliationStatus(decisionArgs));
      }
      if (
        (fixture.covers.compatibilityRows ?? []).some((row) => ["COMP-02", "COMP-05", "COMP-06", "COMP-07", "COMP-08"].includes(row))
        && semanticConsumer !== "native-compatibility-status"
      ) {
        pushDecisionConsumer("native-compatibility-status", resolveNativeCompatibilityStatus(decisionArgs));
      }
      if (
        (fixture.covers.migrationRows ?? []).some((row) => ["MIG-04", "MIG-05", "MIG-06", "MIG-07", "MIG-08"].includes(row))
        && semanticConsumer !== "native-migration-status"
      ) {
        pushDecisionConsumer("native-migration-status", resolveNativeMigrationStatus(decisionArgs));
      }
    }

    let assessment: NativeEvidenceAssessment | null = null;
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

      const liveDecision = arbitrateNativeStatus({
        assessment,
        terminalState: fixture.given.runTerminalState === "failed"
          ? "failed"
          : fixture.given.runTerminalState === "cancelled" ? "cancelled" : "succeeded",
        workspaceFinalizeStatus: fixture.given.fault === "workspace_finalize_failure" ? "failed" : "succeeded",
        governanceGate,
        completionClaimPolicyAccepted: completionState === "low_risk_policy_claim",
        allowIncompleteContinuation: completionState !== "no_durable_continuation",
        agentId,
        priorIssueStatus,
      });
      consumerExecutions.push({
        consumer: "status-arbiter",
        observed: {
          toStatus: liveDecision.toStatus,
          reasonCode: liveDecision.reasonCode,
          effects: liveDecision.effects.map((effect) => effect.kind),
        },
      });
    }

    let rolledBack = false;
    if (
      seeded.nativeRecords
      && scenarioDecision
      && scenarioDecision.reasonCode !== null
      && completionState !== "replacement_turn_accepted"
      && !zeroDecisionStates.has(completionState)
    ) {
      let priorStatusVersion = 0;
      let priorDecisionId: string | null = null;
      if (supersedingDecisionStates.has(completionState)) {
        const priorAssessmentId = randomUUID();
        await db.insert(workAssessments).values({
          id: priorAssessmentId,
          companyId,
          issueId: seeded.issueId,
          runId: seeded.runId,
          contractId: seeded.contractId!,
          resultId: seeded.resultId!,
          triggerKind: "prior_fixture_fact",
          triggerActorCompanyId: companyId,
          priorIssueStatus,
          priorStatusVersion: 0,
          policyVersion: "phase6-v1",
          assessmentJson: { fixtureId: fixture.id, superseded: true },
          inputDigest: `prior-assessment:${fixture.id}`,
        });
        const [priorDecision] = await db.insert(statusDecisions).values({
          companyId,
          issueId: seeded.issueId,
          assessmentId: priorAssessmentId,
          decisionVersion: 1,
          policyVersion: "phase6-v1",
          fromStatus: priorIssueStatus,
          toStatus: priorIssueStatus,
          reasonCode: "prior_fixture_decision",
          decisionJson: { superseded: true },
          decisionDigest: `prior-decision:${fixture.id}`,
          applicationState: "applied",
          appliedAt: new Date(),
        }).returning({ id: statusDecisions.id });
        priorDecisionId = priorDecision!.id;
        priorStatusVersion = 1;
        await db.update(issues).set({
          statusVersion: priorStatusVersion,
          lastStatusDecisionId: priorDecisionId,
        }).where(eq(issues.id, seeded.issueId));
      }

      const failpoint = failpointFor(fixture);
      try {
        const committed = await commitNativeStatusDecision({
          db,
          companyId,
          issueId: seeded.issueId,
          runId: seeded.runId,
          assessmentId: seeded.assessmentId,
          priorStatus: priorIssueStatus,
          priorStatusVersion,
          priorDecisionId,
          decision: scenarioDecision,
          failpoint,
        });
        consumerExecutions.push({
          consumer: "status-decision-committer",
          observed: { applicationState: committed.decision.applicationState, failpoint: null },
        });
      } catch (error) {
        if (!failpoint) throw error;
        rolledBack = true;
        consumerExecutions.push({
          consumer: "status-decision-committer",
          observed: { applicationState: "rolled_back", failpoint, error: String(error) },
        });
      }
    }

    if (seeded.nativeRecords && (rolledBack || completionState === "safe_partial_parse")) {
      const failure = await recordNativeFinalizationFailure({
        db,
        runId: seeded.runId,
        error: new Error(rolledBack ? "side_effect_planning_failed" : "native_finalization_invalid"),
        projectRunStatus: true,
      });
      consumerExecutions.push({
        consumer: "native-finalization-failure",
        observed: { phase: failure.phase, failureCode: failure.failureCode },
      });
    } else if (seeded.nativeRecords && scenarioDecision?.effects.some((effect) => effect.kind === "record_finalization_error")) {
      await db.update(heartbeatRuns).set({
        status: projectNativeTerminalRunStatus("failed"),
        finishedAt: new Date(),
      }).where(eq(heartbeatRuns.id, seeded.runId));
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
      const currentVersion = await db.select({ statusVersion: issues.statusVersion })
        .from(issues).where(eq(issues.id, seeded.issueId))
        .then((rows) => Number(rows[0]?.statusVersion ?? 0));
      const updated = await issueService(db).update(seeded.issueId, {
        status: boardTarget,
        statusVersion: currentVersion + 1,
        actorUserId: "status-corpus-board",
        actorAgentId: null,
      });
      consumerExecutions.push({
        consumer: "authorized-issue-writer",
        observed: { status: updated.status, statusVersion: updated.statusVersion },
      });
      if (completionState === "authorized_status_write") {
        const reviewer = await issueThreadInteractionService(db).create(
          updated,
          {
            kind: "request_confirmation",
            idempotencyKey: `migration-review:${fixture.id}`,
            sourceRunId: null,
            title: "Migration writer review",
            summary: "Preserve the existing review liveness path.",
            continuationPolicy: "wake_assignee",
            payload: {
              version: 1,
              prompt: "Review the migrated issue status.",
              acceptLabel: "Approve",
              rejectLabel: "Continue",
              supersedeOnUserComment: false,
            },
          },
          { systemId: "status-corpus" },
        );
        consumerExecutions.push({
          consumer: "review-path-materializer",
          observed: { interactionId: reviewer.id, status: reviewer.status },
        });
      }
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

    const [decisionRows, effectRows, nativeRows, wakeRows, recoveryRows, interactionRows, persistedIssue, persistedRun] = await Promise.all([
      db.select({ id: statusDecisions.id }).from(statusDecisions).where(eq(statusDecisions.issueId, seeded.issueId)),
      db.select({
        id: statusDecisionEffects.id,
        effectKind: statusDecisionEffects.effectKind,
        targetType: statusDecisionEffects.targetType,
      }).from(statusDecisionEffects).where(eq(statusDecisionEffects.issueId, seeded.issueId)),
      db.select({ id: nativeRunResults.id, resultJson: nativeRunResults.resultJson })
        .from(nativeRunResults).where(eq(nativeRunResults.issueId, seeded.issueId)),
      db.select({ id: agentWakeupRequests.id, payload: agentWakeupRequests.payload })
        .from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId)),
      db.select({ id: issueRecoveryActions.id }).from(issueRecoveryActions)
        .where(eq(issueRecoveryActions.sourceIssueId, seeded.issueId)),
      db.select({ id: issueThreadInteractions.id, status: issueThreadInteractions.status })
        .from(issueThreadInteractions).where(eq(issueThreadInteractions.issueId, seeded.issueId)),
      db.select({ status: issues.status, statusVersion: issues.statusVersion })
        .from(issues).where(eq(issues.id, seeded.issueId)).then((rows) => rows[0] ?? null),
      db.select({ status: heartbeatRuns.status }).from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, seeded.runId)).then((rows) => rows[0] ?? null),
    ]);
    const observedNativeRecords = nativeRows.length > 0;
    const persistedEffects = effectRows
      .map((row) => row.effectKind)
      .filter((effect) => effect !== "issue_status_projection");
    const compatibilityState = (fixture.covers.compatibilityRows ?? []).length > 0
      ? inspectNativeCompatibilityState({
          resolution: mode,
          nativeRecordCount: nativeRows.length,
          decisionCount: decisionRows.length,
          issueStatus: persistedIssue?.status ?? priorIssueStatus,
          statusVersion: Number(persistedIssue?.statusVersion ?? 0),
          persistedEffectKinds: persistedEffects,
        })
      : null;
    const migrationState = (fixture.covers.migrationRows ?? []).length > 0
      ? inspectNativeMigrationState({
          resolution: mode,
          nativeRecordCount: nativeRows.length,
          decisionCount: decisionRows.length,
          issueStatusBefore: priorIssueStatus,
          issueStatusAfter: persistedIssue?.status ?? priorIssueStatus,
          statusVersion: Number(persistedIssue?.statusVersion ?? 0),
          hasPendingReview: interactionRows.some((row) => row.status === "pending"),
        })
      : null;
    let effects = persistedEffects.length > 0
      ? persistedEffects
      : scenarioDecision?.effects.map((effect) => effect.kind) ?? [];
    if (rolledBack) effects = ["record_finalization_error"];
    if (!scenarioDecision) {
      effects = migrationState?.effects.length
        ? [...migrationState.effects]
        : compatibilityState?.effects.length ? [...compatibilityState.effects] : [];
    }

    const issueWakeRows = wakeRows.filter((row) => {
      const payload = row.payload && typeof row.payload === "object" ? row.payload : {};
      return payload.issueId === seeded.issueId || payload.taskId === seeded.issueId;
    });
    const statusAction = rolledBack
      ? "preserve"
      : scenarioDecision
        ? scenarioDecision.statusAction
        : migrationState?.statusAction ?? compatibilityState?.statusAction ?? "preserve";
    const livePathKind = rolledBack
      ? null
      : effects.includes("create_delegated_issue") ? "delegated_issue"
      : effects.includes("bind_reviewer") ? "review"
      : effects.includes("create_interaction") ? "interaction"
      : effects.includes("bind_blocker") ? "blocker"
      : effects.includes("schedule_retry") ? "retry"
      : effects.includes("enqueue_continuation") || effects.includes("accept_replacement_turn") ? "continuation"
      : recoveryRows.length > 0 ? "recovery"
      : completionState === "preexisting_open_issue" && persistedIssue?.status === "in_review" ? "review"
      : null;
    if ((fixture.covers.terminalRows ?? []).length > 0) {
      const terminalInput = persistedRun?.status === "running"
        ? "active"
        : persistedRun?.status === "cancelled"
          ? "cancelled"
          : persistedRun?.status === "failed" ? "failed" : "succeeded";
      consumerExecutions.push({
        consumer: "native-run-terminal-projection",
        observed: { status: projectNativeTerminalRunStatus(terminalInput) },
      });
    }
    if (compatibilityState) {
      consumerExecutions.push({
        consumer: "native-compatibility-read-model",
        observed: compatibilityState,
      });
    }
    if (migrationState) {
      consumerExecutions.push({
        consumer: "native-migration-read-model",
        observed: migrationState,
      });
    }
    const consumerEvidenceByRow = new Map<string, string>();
    for (const matrixRow of Object.values(fixture.covers).flat()) {
      const consumer = requiredConsumerForMatrixRow(matrixRow);
      const execution = consumerExecutions.find((candidate) => candidate.consumer === consumer);
      if (!execution) continue;
      const semanticRow = matrixRow.startsWith("SD-")
        || matrixRow.startsWith("ATT-")
        || matrixRow.startsWith("REC-")
        || consumer.endsWith("-status");
      if (semanticRow) {
        const returnedEffects = Array.isArray(execution.observed.effects)
          ? execution.observed.effects.map(String)
          : [];
        const returnedStatusAction = execution.observed.statusAction
          ?? (execution.observed.toStatus === priorIssueStatus ? "preserve" : execution.observed.toStatus);
        if (
          returnedStatusAction !== statusAction
          || execution.observed.reasonCode !== (rolledBack ? "side_effect_planning_failed" : scenarioDecision?.reasonCode ?? null)
          || !effects.every((effect) => returnedEffects.includes(effect))
        ) continue;
      } else if (matrixRow.startsWith("TC-")) {
        if (execution.observed.status !== (persistedRun?.status ?? initialRunStatus(fixture))) continue;
      } else if (consumer.endsWith("-read-model")) {
        const returnedEffects = Array.isArray(execution.observed.effects)
          ? execution.observed.effects.map(String)
          : [];
        if (
          execution.observed.statusAction !== statusAction
          || execution.observed.native !== observedNativeRecords
          || !effects.every((effect) => returnedEffects.includes(effect))
        ) continue;
      } else if (consumer === "status-decision-committer") {
        const expectedApplicationState = rolledBack ? "rolled_back" : "applied";
        if (execution.observed.applicationState !== expectedApplicationState) continue;
      }
      consumerEvidenceByRow.set(matrixRow, consumer);
    }
    consumerExecutions.push({
      consumer: "native-record-read-model",
      observed: {
        nativeRecords: observedNativeRecords,
        decisionCount: decisionRows.length,
        effectCount: effectRows.length,
        wakeCount: issueWakeRows.length,
        recoveryCount: recoveryRows.length,
      },
    });
    if (consumerExecutions.length < 2) throw new Error(`${fixture.id} did not execute a concern consumer`);

    return {
      fixtureId: fixture.id,
      runStatus: mode.kind === "legacy"
        ? "legacy_derived"
        : persistedRun?.status ?? initialRunStatus(fixture),
      statusAction,
      reasonCode: rolledBack ? "side_effect_planning_failed" : scenarioDecision?.reasonCode ?? null,
      effects,
      livePathKind,
      preserveClaim: nativeRows.some((row) => {
        const result = row.resultJson && typeof row.resultJson === "object" ? row.resultJson : {};
        return result.completionClaim !== undefined;
      }),
      nativeRecords: observedNativeRecords,
      decisionCount: decisionRows.length,
      wakeCount: issueWakeRows.length,
      notificationCount: effectRows.filter((row) => ["notify_owner", "create_delegated_issue", "cancel_continuations"].includes(row.effectKind)).length,
      consumerExecutions,
      consumerEvidenceByRow,
    };
  }

  it("executes all 52 fixtures in their production consumers and joins all 70 matrix rows", async () => {
    expect(corpus.schema).toBe("paperclip.status-authority-conformance.v1");
    expect(corpus.fixtures).toHaveLength(52);

    const observations = new Map<string, FixtureObservation>();
    for (const fixture of corpus.fixtures) observations.set(fixture.id, await executeFixture(fixture));

    const semanticFailures: string[] = [];
    for (const fixture of corpus.fixtures) {
      const observed = observations.get(fixture.id)!;
      semanticFailures.push(...comparisonFailures(fixture, observed).map((failure) => `${fixture.id}:${failure}`));
      expect(observed.consumerExecutions.length, `${fixture.id} consumer execution`).toBeGreaterThan(1);
      for (const matrixRow of Object.values(fixture.covers).flat()) {
        expect(observed.consumerEvidenceByRow.get(matrixRow), `${fixture.id}:${matrixRow}`)
          .toBe(requiredConsumerForMatrixRow(matrixRow));
      }
    }
    expect(semanticFailures).toEqual([]);

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
        expect(joined.observation.consumerEvidenceByRow.get(result.matrixRow), result.matrixRow)
          .toBe(requiredConsumerForMatrixRow(result.matrixRow));
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
        ["runStatus", { ...fixture.expected, runStatus: `mutated:${fixture.expected.runStatus}` }],
        ["statusAction", { ...fixture.expected, statusAction: `mutated:${fixture.expected.statusAction}` }],
        ["reasonCode", { ...fixture.expected, reasonCode: fixture.expected.reasonCode === null ? "mutated" : null }],
        ["requiredEffects", { ...fixture.expected, requiredEffects: [...fixture.expected.requiredEffects, "__missing_effect__"] }],
        ["forbiddenEffects", { ...fixture.expected, forbiddenEffects: [...fixture.expected.forbiddenEffects, observedEffect] }],
        ["livePathKind", { ...fixture.expected, livePathKind: fixture.expected.livePathKind === null ? "continuation" : null }],
        ["preserveClaim", { ...fixture.expected, preserveClaim: !fixture.expected.preserveClaim }],
        ["nativeRecords", { ...fixture.expected, nativeRecords: !fixture.expected.nativeRecords }],
        ["decisionCount", { ...fixture.expected, decisionCount: fixture.expected.decisionCount + 1 }],
        ["maxWakeCount", { ...fixture.expected, maxWakeCount: observed.wakeCount - 1 }],
        ["maxNotificationCount", { ...fixture.expected, maxNotificationCount: observed.notificationCount - 1 }],
      ];
      for (const [field, expected] of mutations) {
        const mutated = { ...fixture, expected };
        expect(comparisonFailures(mutated, observed), `${fixture.id}:${field}`).not.toEqual([]);
      }
    }
  }, 60_000);
});
