import { describe, expect, it } from "vitest";
import {
  ARTIFACT_DIRECTOR_SHIP_ERROR_CODES,
  ARTIFACT_DIRECTOR_SHIP_STATES,
} from "../types/artifact-director-ship.js";
import { ARTIFACT_BOUND_DIRECTOR_SHIP_CAPABILITY_V1 } from "../capabilities.js";
import {
  artifactDirectorShipCandidateV1Schema,
  artifactDirectorShipReconciliationResponseV1Schema,
  artifactDirectorShipResponseV1Schema,
  confirmArtifactDirectorShipV1Schema,
} from "./artifact-director-ship.js";
import { artifactDirectorShipCandidateHashInputV1 } from "../types/artifact-director-ship.js";

const candidate = {
  candidateSha256: "1".repeat(64),
  policySha256: "4".repeat(64),
  issue: {
    id: "11111111-1111-4111-8111-111111111111",
    identifier: "PC-42",
    status: "in_review" as const,
    executionFingerprint: "2".repeat(64),
    currentStageId: "22222222-2222-4222-8222-222222222222",
  },
  review: {
    decisionId: "33333333-3333-4333-8333-333333333333",
    reviewCycleId: "44444444-4444-4444-8444-444444444444",
    stageId: "55555555-5555-4555-8555-555555555555",
    workProductId: "66666666-6666-4666-8666-666666666666",
    headSha: "a".repeat(40),
    locatorFingerprint: "3".repeat(64),
    reviewerAgentId: "77777777-7777-4777-8777-777777777777",
    reviewerRunId: "88888888-8888-4888-8888-888888888888",
    reviewerActorSource: "agent_key" as const,
  },
  artifact: {
    kind: "github_pull_request" as const,
    canonicalRef: "paperclipai/paperclip#42",
    owner: "paperclipai",
    repo: "paperclip",
    number: 42,
    headRef: "codex/director-ship",
    headSha: "a".repeat(40),
    workProductTrust: "implicit_standard" as const,
  },
  director: { userId: "local-board", actorSource: "local_implicit" as const },
};

const issue = {
  id: candidate.issue.id,
  companyId: "99999999-9999-4999-8999-999999999999",
  projectId: null,
  projectWorkspaceId: null,
  goalId: null,
  parentId: null,
  title: "Ship the reviewed pull request",
  description: null,
  status: "in_review" as const,
  workMode: "standard" as const,
  harnessKind: null,
  priority: "medium" as const,
  reviewPolicy: "not_creator" as const,
  assigneeAgentId: null,
  assigneeUserId: "local-board",
  createdByAgentId: null,
  createdByUserId: "local-board",
  responsibleUserId: "local-board",
  issueNumber: 42,
  identifier: "PC-42",
  requestDepth: 0,
  billingCode: null,
  assigneeAdapterOverrides: null,
  executionPolicy: {
    commentRequired: true as const,
    stages: [{
      id: candidate.issue.currentStageId,
      type: "approval" as const,
      approvalsNeeded: 1 as const,
      participants: [{
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        type: "user" as const,
        agentId: null,
        userId: "local-board",
      }],
    }],
  },
  executionState: null,
  executionWorkspaceId: null,
  executionWorkspacePreference: null,
  executionWorkspaceSettings: null,
  createdAt: "2026-08-19T12:00:00.000Z",
  updatedAt: "2026-08-19T12:01:00.000Z",
};

const operation = {
  version: 1 as const,
  shipmentId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  issueId: issue.id,
  idempotencyKey: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  candidateSha256: candidate.candidateSha256,
  state: "reconcile_required" as const,
  attemptCount: 1,
  preparedAt: "2026-08-19T12:02:00.000Z",
  mergeAttemptedAt: "2026-08-19T12:03:00.000Z",
  providerRequestStartedAt: "2026-08-19T12:03:01.000Z",
  providerObservedAt: null,
  nextAttemptAt: "2026-08-19T12:04:00.000Z",
  leaseExpiresAt: null,
  completedAt: null,
  staleAt: null,
  lastErrorCode: "provider_outcome_unknown",
};

const receipt = {
  version: 1 as const,
  shipmentId: operation.shipmentId,
  issueId: issue.id,
  reviewDecisionId: candidate.review.decisionId,
  reviewCycleId: candidate.review.reviewCycleId,
  policySha256: candidate.policySha256,
  approvalDecisionId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  workProductId: candidate.review.workProductId,
  artifactRevision: candidate.artifact.headSha,
  locatorFingerprint: candidate.review.locatorFingerprint,
  canonicalRef: candidate.artifact.canonicalRef,
  provider: "github" as const,
  mergeMethod: "merge" as const,
  mergeCommitSha: "e".repeat(40),
  directorUserId: candidate.director.userId,
  reviewerActorSource: candidate.review.reviewerActorSource,
  directorActorSource: candidate.director.actorSource,
  providerObservedAt: "2026-08-19T12:05:00.000Z",
  completedAt: "2026-08-19T12:06:00.000Z",
  completedIssueUpdatedAt: "2026-08-19T12:06:00.000Z",
};

describe("artifact director Ship v1 contract", () => {
  it("accepts an exact open-head candidate projection", () => {
    expect(artifactDirectorShipCandidateV1Schema.parse(candidate)).toEqual(candidate);
  });

  it("rejects extension fields and mismatched reviewed heads", () => {
    expect(artifactDirectorShipCandidateV1Schema.safeParse({ ...candidate, extra: true }).success).toBe(false);
    expect(artifactDirectorShipCandidateV1Schema.safeParse({
      ...candidate,
      artifact: { ...candidate.artifact, headSha: "b".repeat(40) },
    }).success).toBe(false);
    const { policySha256: _policySha256, ...withoutPolicy } = candidate;
    expect(artifactDirectorShipCandidateV1Schema.safeParse(withoutPolicy).success).toBe(false);
    const { reviewerActorSource: _reviewerActorSource, ...reviewWithoutSource } = candidate.review;
    expect(artifactDirectorShipCandidateV1Schema.safeParse({
      ...candidate,
      review: reviewWithoutSource,
    }).success).toBe(false);
    const { actorSource: _directorActorSource, ...directorWithoutSource } = candidate.director;
    expect(artifactDirectorShipCandidateV1Schema.safeParse({
      ...candidate,
      director: directorWithoutSource,
    }).success).toBe(false);
  });

  it("includes policy and actor provenance in the candidate hash input", () => {
    expect(artifactDirectorShipCandidateHashInputV1(candidate)).toMatchObject({
      policySha256: candidate.policySha256,
      review: { reviewerActorSource: "agent_key" },
      director: { actorSource: "local_implicit" },
    });
    expect(artifactDirectorShipCandidateHashInputV1(candidate)).not.toHaveProperty("candidateSha256");
  });

  it("strictly validates and normalizes the director confirmation", () => {
    const parsed = confirmArtifactDirectorShipV1Schema.parse({
      version: 1,
      candidateSha256: candidate.candidateSha256,
      expectedReviewDecisionId: candidate.review.decisionId,
      expectedReviewCycleId: candidate.review.reviewCycleId,
      expectedWorkProductId: candidate.review.workProductId,
      expectedHeadSha: "A".repeat(40),
      comment: "  Ship this reviewed revision.  ",
    });
    expect(parsed.expectedHeadSha).toBe("a".repeat(40));
    expect(parsed.comment).toBe("Ship this reviewed revision.");
    expect(confirmArtifactDirectorShipV1Schema.safeParse({ ...parsed, mergeMethod: "squash" }).success).toBe(false);
  });

  it("locks the complete state and error-code vocabulary", () => {
    expect(ARTIFACT_DIRECTOR_SHIP_STATES).toEqual([
      "prepared",
      "merge_in_flight",
      "reconcile_required",
      "merge_observed",
      "completed",
      "stale",
    ]);
    expect(ARTIFACT_DIRECTOR_SHIP_ERROR_CODES).toContain("artifact_director_ship_preintent_merge_rejected");
    expect(ARTIFACT_DIRECTOR_SHIP_ERROR_CODES).toHaveLength(10);
  });

  it("retains the exact phase-2 capability descriptor without advertising it live", () => {
    expect(ARTIFACT_BOUND_DIRECTOR_SHIP_CAPABILITY_V1).toEqual({
      supported: true,
      version: 1,
      artifactKind: "github_pull_request",
      candidateEndpoint: "/api/v1/issues/{issueId}/artifact-director-ship-candidate",
      confirmationEndpoint: "/api/v1/issues/{issueId}/artifact-director-ships/{idempotencyKey}",
      lookupEndpoint: "/api/v1/issues/{issueId}/artifact-director-ships/{idempotencyKey}",
      confirmationMethod: "PUT",
      mergeMethod: "merge",
      exactHeadCas: true,
      durableIntentBeforeMerge: true,
      crossSystemReconciliation: true,
      preIntentMergedReceiptForbidden: true,
      genericFinalApprovalQuarantined: true,
      durableCompletionReceipt: true,
    });
  });

  it("accepts a strict receipt-free 202 reconciliation response", () => {
    expect(artifactDirectorShipReconciliationResponseV1Schema.safeParse({
      version: 1,
      replayed: false,
      state: "reconcile_required",
      operation,
      receipt: null,
      issue,
    }).success).toBe(true);
  });

  it("enforces completed iff receipt present and issue done", () => {
    const completed = {
      version: 1,
      replayed: false,
      state: "completed",
      operation: { ...operation, state: "completed", completedAt: receipt.completedAt, lastErrorCode: null },
      receipt,
      issue: { ...issue, status: "done", updatedAt: receipt.completedIssueUpdatedAt },
    };
    expect(artifactDirectorShipResponseV1Schema.safeParse(completed).success).toBe(true);
    const { policySha256: _receiptPolicySha256, ...receiptWithoutPolicy } = receipt;
    expect(artifactDirectorShipResponseV1Schema.safeParse({
      ...completed,
      receipt: receiptWithoutPolicy,
    }).success).toBe(false);
    const { reviewerActorSource: _receiptReviewerActorSource, ...receiptWithoutReviewerSource } = receipt;
    expect(artifactDirectorShipResponseV1Schema.safeParse({
      ...completed,
      receipt: receiptWithoutReviewerSource,
    }).success).toBe(false);
    const { directorActorSource: _receiptDirectorActorSource, ...receiptWithoutDirectorSource } = receipt;
    expect(artifactDirectorShipResponseV1Schema.safeParse({
      ...completed,
      receipt: receiptWithoutDirectorSource,
    }).success).toBe(false);
    expect(artifactDirectorShipResponseV1Schema.safeParse({ ...completed, receipt: null }).success).toBe(false);
    expect(artifactDirectorShipResponseV1Schema.safeParse({
      ...completed,
      issue: { ...completed.issue, status: "in_review" },
    }).success).toBe(false);
    expect(artifactDirectorShipResponseV1Schema.safeParse({
      version: 1,
      replayed: false,
      state: "reconcile_required",
      operation,
      receipt,
      issue,
    }).success).toBe(false);
    expect(artifactDirectorShipReconciliationResponseV1Schema.safeParse(completed).success).toBe(false);
  });
});
