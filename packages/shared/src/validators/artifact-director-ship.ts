import { z } from "zod";
import {
  ARTIFACT_DIRECTOR_SHIP_STATES,
  ARTIFACT_DIRECTOR_SHIP_VERSION,
} from "../types/artifact-director-ship.js";
import { governedIssueLifecycleIssueV1Schema } from "./issue.js";

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const gitRevisionSchema = z.string().trim().toLowerCase().regex(/^[0-9a-f]{40,64}$/);
const githubNameSchema = z.string().trim().min(1).max(100).regex(/^[A-Za-z0-9_.-]+$/);

export const artifactDirectorShipStateSchema = z.enum(ARTIFACT_DIRECTOR_SHIP_STATES);

export const artifactDirectorShipCandidateV1Schema = z.object({
  candidateSha256: sha256Schema,
  policySha256: sha256Schema,
  issue: z.object({
    id: z.string().uuid(),
    identifier: z.string().trim().min(1).max(255),
    status: z.literal("in_review"),
    executionFingerprint: sha256Schema,
    currentStageId: z.string().uuid(),
  }).strict(),
  review: z.object({
    decisionId: z.string().uuid(),
    reviewCycleId: z.string().uuid(),
    stageId: z.string().uuid(),
    workProductId: z.string().uuid(),
    headSha: gitRevisionSchema,
    locatorFingerprint: sha256Schema,
    reviewerAgentId: z.string().uuid(),
    reviewerRunId: z.string().uuid(),
    reviewerActorSource: z.enum(["agent_key", "agent_jwt"]),
  }).strict(),
  artifact: z.object({
    kind: z.literal("github_pull_request"),
    canonicalRef: z.string().trim().min(1).max(512),
    owner: githubNameSchema,
    repo: githubNameSchema,
    number: z.number().int().positive(),
    headRef: z.string().trim().min(1).max(255),
    headSha: gitRevisionSchema,
    workProductTrust: z.enum(["implicit_standard", "promoted"]),
  }).strict(),
  director: z.object({
    userId: z.string().trim().min(1).max(255),
    actorSource: z.enum(["local_implicit", "session", "board_key", "cloud_tenant"]),
  }).strict(),
}).strict().superRefine((value, ctx) => {
  if (value.review.headSha !== value.artifact.headSha) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Reviewed and artifact head revisions must match",
      path: ["artifact", "headSha"],
    });
  }
});

export const artifactDirectorShipCandidateResponseV1Schema = z.object({
  version: z.literal(ARTIFACT_DIRECTOR_SHIP_VERSION),
  candidate: artifactDirectorShipCandidateV1Schema,
}).strict();

export const confirmArtifactDirectorShipV1Schema = z.object({
  version: z.literal(ARTIFACT_DIRECTOR_SHIP_VERSION),
  candidateSha256: sha256Schema,
  expectedReviewDecisionId: z.string().uuid(),
  expectedReviewCycleId: z.string().uuid(),
  expectedWorkProductId: z.string().uuid(),
  expectedHeadSha: gitRevisionSchema,
  comment: z.string().trim().min(1).max(20_000),
}).strict();

export const artifactDirectorShipOperationV1Schema = z.object({
  version: z.literal(ARTIFACT_DIRECTOR_SHIP_VERSION),
  shipmentId: z.string().uuid(),
  issueId: z.string().uuid(),
  idempotencyKey: z.string().uuid(),
  candidateSha256: sha256Schema,
  state: artifactDirectorShipStateSchema,
  attemptCount: z.number().int().nonnegative(),
  preparedAt: z.string().datetime(),
  mergeAttemptedAt: z.string().datetime().nullable(),
  providerRequestStartedAt: z.string().datetime().nullable(),
  providerObservedAt: z.string().datetime().nullable(),
  nextAttemptAt: z.string().datetime().nullable(),
  leaseExpiresAt: z.string().datetime().nullable(),
  completedAt: z.string().datetime().nullable(),
  staleAt: z.string().datetime().nullable(),
  lastErrorCode: z.string().trim().min(1).max(160).nullable(),
}).strict();

export const artifactDirectorShipReceiptV1Schema = z.object({
  version: z.literal(ARTIFACT_DIRECTOR_SHIP_VERSION),
  shipmentId: z.string().uuid(),
  issueId: z.string().uuid(),
  reviewDecisionId: z.string().uuid(),
  reviewCycleId: z.string().uuid(),
  policySha256: sha256Schema,
  approvalDecisionId: z.string().uuid(),
  workProductId: z.string().uuid(),
  artifactRevision: gitRevisionSchema,
  locatorFingerprint: sha256Schema,
  canonicalRef: z.string().trim().min(1).max(512),
  provider: z.literal("github"),
  mergeMethod: z.literal("merge"),
  mergeCommitSha: gitRevisionSchema,
  directorUserId: z.string().trim().min(1).max(255),
  reviewerActorSource: z.enum(["agent_key", "agent_jwt"]),
  directorActorSource: z.enum(["local_implicit", "session", "board_key", "cloud_tenant"]),
  providerObservedAt: z.string().datetime(),
  completedAt: z.string().datetime(),
  completedIssueUpdatedAt: z.string().datetime(),
}).strict();

const activeShipIssueV1Schema = governedIssueLifecycleIssueV1Schema.extend({
  status: z.literal("in_review"),
}).strict();
const completedShipIssueV1Schema = governedIssueLifecycleIssueV1Schema.extend({
  status: z.literal("done"),
}).strict();
const staleShipIssueV1Schema = governedIssueLifecycleIssueV1Schema.extend({
  status: z.enum(["backlog", "todo", "in_progress", "in_review", "blocked", "cancelled"]),
}).strict();

function activeShipResponseMember(state: "prepared" | "merge_in_flight" | "reconcile_required" | "merge_observed") {
  return z.object({
    version: z.literal(ARTIFACT_DIRECTOR_SHIP_VERSION),
    replayed: z.boolean(),
    state: z.literal(state),
    operation: artifactDirectorShipOperationV1Schema.extend({ state: z.literal(state) }).strict(),
    receipt: z.null(),
    issue: activeShipIssueV1Schema,
  }).strict();
}

export const artifactDirectorShipReconciliationResponseV1Schema = z.discriminatedUnion("state", [
  activeShipResponseMember("prepared"),
  activeShipResponseMember("merge_in_flight"),
  activeShipResponseMember("reconcile_required"),
  activeShipResponseMember("merge_observed"),
]);

export const artifactDirectorShipResponseV1Schema = z.discriminatedUnion("state", [
  activeShipResponseMember("prepared"),
  activeShipResponseMember("merge_in_flight"),
  activeShipResponseMember("reconcile_required"),
  activeShipResponseMember("merge_observed"),
  z.object({
    version: z.literal(ARTIFACT_DIRECTOR_SHIP_VERSION),
    replayed: z.boolean(),
    state: z.literal("completed"),
    operation: artifactDirectorShipOperationV1Schema.extend({ state: z.literal("completed") }).strict(),
    receipt: artifactDirectorShipReceiptV1Schema,
    issue: completedShipIssueV1Schema,
  }).strict(),
  z.object({
    version: z.literal(ARTIFACT_DIRECTOR_SHIP_VERSION),
    replayed: z.boolean(),
    state: z.literal("stale"),
    operation: artifactDirectorShipOperationV1Schema.extend({ state: z.literal("stale") }).strict(),
    receipt: z.null(),
    issue: staleShipIssueV1Schema,
  }).strict(),
]);

export type ConfirmArtifactDirectorShipV1Input = z.infer<typeof confirmArtifactDirectorShipV1Schema>;
