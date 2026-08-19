import type { GovernedIssueLifecycleIssueV1 } from "../validators/issue.js";

export const ARTIFACT_DIRECTOR_SHIP_VERSION = 1 as const;
export const ARTIFACT_DIRECTOR_SHIP_RECONCILIATION_HTTP_STATUS = 202 as const;

export const ARTIFACT_DIRECTOR_SHIP_STATES = [
  "prepared",
  "merge_in_flight",
  "reconcile_required",
  "merge_observed",
  "completed",
  "stale",
] as const;

export type ArtifactDirectorShipState = (typeof ARTIFACT_DIRECTOR_SHIP_STATES)[number];

export const ARTIFACT_DIRECTOR_SHIP_ERROR_CODES = [
  "artifact_director_ship_required",
  "artifact_director_ship_in_progress",
  "artifact_director_ship_director_mismatch",
  "artifact_director_ship_evidence_invalid",
  "artifact_director_ship_artifact_drift",
  "artifact_director_ship_revision_stale",
  "artifact_director_ship_preintent_merge_rejected",
  "artifact_director_ship_idempotency_conflict",
  "artifact_director_ship_review_cycle_conflict",
  "artifact_director_ship_corrupt",
] as const;

export type ArtifactDirectorShipErrorCode = (typeof ARTIFACT_DIRECTOR_SHIP_ERROR_CODES)[number];

export const ARTIFACT_DIRECTOR_SHIP_CANDIDATE_API_PATH =
  "/api/v1/issues/:issueId/artifact-director-ship-candidate" as const;
export const ARTIFACT_DIRECTOR_SHIP_OPERATION_API_PATH =
  "/api/v1/issues/:issueId/artifact-director-ships/:idempotencyKey" as const;
export const ARTIFACT_DIRECTOR_SHIP_CANDIDATE_ENDPOINT =
  "/api/v1/issues/{issueId}/artifact-director-ship-candidate" as const;
export const ARTIFACT_DIRECTOR_SHIP_OPERATION_ENDPOINT =
  "/api/v1/issues/{issueId}/artifact-director-ships/{idempotencyKey}" as const;

export interface ArtifactDirectorShipCandidateV1 {
  candidateSha256: string;
  policySha256: string;
  issue: {
    id: string;
    identifier: string;
    status: "in_review";
    executionFingerprint: string;
    currentStageId: string;
  };
  review: {
    decisionId: string;
    reviewCycleId: string;
    stageId: string;
    workProductId: string;
    headSha: string;
    locatorFingerprint: string;
    reviewerAgentId: string;
    reviewerRunId: string;
    reviewerActorSource: "agent_key" | "agent_jwt";
  };
  artifact: {
    kind: "github_pull_request";
    canonicalRef: string;
    owner: string;
    repo: string;
    number: number;
    headRef: string;
    headSha: string;
    workProductTrust: "implicit_standard" | "promoted";
  };
  director: {
    userId: string;
    actorSource: "local_implicit" | "session" | "board_key" | "cloud_tenant";
  };
}

export type ArtifactDirectorShipCandidateHashInputV1 = Omit<
  ArtifactDirectorShipCandidateV1,
  "candidateSha256"
>;

export function artifactDirectorShipCandidateHashInputV1(
  candidate: ArtifactDirectorShipCandidateV1,
): ArtifactDirectorShipCandidateHashInputV1 {
  const { candidateSha256: _candidateSha256, ...input } = candidate;
  return input;
}

export interface ArtifactDirectorShipCandidateResponseV1 {
  version: typeof ARTIFACT_DIRECTOR_SHIP_VERSION;
  candidate: ArtifactDirectorShipCandidateV1;
}

export interface ConfirmArtifactDirectorShipV1 {
  version: typeof ARTIFACT_DIRECTOR_SHIP_VERSION;
  candidateSha256: string;
  expectedReviewDecisionId: string;
  expectedReviewCycleId: string;
  expectedWorkProductId: string;
  expectedHeadSha: string;
  comment: string;
}

export interface ArtifactDirectorShipOperationV1 {
  version: typeof ARTIFACT_DIRECTOR_SHIP_VERSION;
  shipmentId: string;
  issueId: string;
  idempotencyKey: string;
  candidateSha256: string;
  state: ArtifactDirectorShipState;
  attemptCount: number;
  preparedAt: string;
  mergeAttemptedAt: string | null;
  providerRequestStartedAt: string | null;
  providerObservedAt: string | null;
  nextAttemptAt: string | null;
  leaseExpiresAt: string | null;
  completedAt: string | null;
  staleAt: string | null;
  lastErrorCode: string | null;
}

export interface ArtifactDirectorShipReceiptV1 {
  version: typeof ARTIFACT_DIRECTOR_SHIP_VERSION;
  shipmentId: string;
  issueId: string;
  reviewDecisionId: string;
  reviewCycleId: string;
  policySha256: string;
  approvalDecisionId: string;
  workProductId: string;
  artifactRevision: string;
  locatorFingerprint: string;
  canonicalRef: string;
  provider: "github";
  mergeMethod: "merge";
  mergeCommitSha: string;
  directorUserId: string;
  reviewerActorSource: "agent_key" | "agent_jwt";
  directorActorSource: "local_implicit" | "session" | "board_key" | "cloud_tenant";
  providerObservedAt: string;
  completedAt: string;
  completedIssueUpdatedAt: string;
}

interface ArtifactDirectorShipResponseBaseV1 {
  version: typeof ARTIFACT_DIRECTOR_SHIP_VERSION;
  replayed: boolean;
}

type ArtifactDirectorShipActiveState = Exclude<ArtifactDirectorShipState, "completed" | "stale">;
type ArtifactDirectorShipNonDoneIssueStatus = Exclude<GovernedIssueLifecycleIssueV1["status"], "done">;

export type ArtifactDirectorShipResponseV1 = ArtifactDirectorShipResponseBaseV1 & (
  | {
      state: "completed";
      operation: ArtifactDirectorShipOperationV1 & { state: "completed" };
      receipt: ArtifactDirectorShipReceiptV1;
      issue: GovernedIssueLifecycleIssueV1 & { status: "done" };
    }
  | {
      state: ArtifactDirectorShipActiveState;
      operation: ArtifactDirectorShipOperationV1 & { state: ArtifactDirectorShipActiveState };
      receipt: null;
      issue: GovernedIssueLifecycleIssueV1 & { status: "in_review" };
    }
  | {
      state: "stale";
      operation: ArtifactDirectorShipOperationV1 & { state: "stale" };
      receipt: null;
      issue: GovernedIssueLifecycleIssueV1 & { status: ArtifactDirectorShipNonDoneIssueStatus };
    }
);
