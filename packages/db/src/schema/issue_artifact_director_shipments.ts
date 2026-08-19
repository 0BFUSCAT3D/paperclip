import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type {
  ArtifactDirectorShipCandidateV1,
  ArtifactDirectorShipReceiptV1,
} from "@paperclipai/shared";
import { companies } from "./companies.js";
import { issueExecutionDecisions } from "./issue_execution_decisions.js";
import { issueWorkProducts } from "./issue_work_products.js";
import { issues } from "./issues.js";

/**
 * Durable intent and reconciliation authority for one director-confirmed Ship.
 *
 * The row must exist before any provider mutation. Candidate, review, artifact,
 * and director snapshots are immutable service-layer inputs; restrictive
 * provenance foreign keys keep their source rows available for audit.
 */
export const issueArtifactDirectorShipments = pgTable(
  "issue_artifact_director_shipments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "restrict" }),
    issueId: uuid("issue_id").notNull(),
    idempotencyKey: uuid("idempotency_key").notNull(),
    contractVersion: integer("contract_version").notNull().default(1),
    state: text("state").notNull().default("prepared"),
    candidateSha256: text("candidate_sha256").notNull(),
    policySha256: text("policy_sha256").notNull(),
    reviewDecisionId: uuid("review_decision_id").notNull(),
    reviewCycleId: uuid("review_cycle_id").notNull(),
    artifactWorkProductId: uuid("artifact_work_product_id").notNull(),
    artifactRevision: text("artifact_revision").notNull(),
    artifactLocatorFingerprint: text("artifact_locator_fingerprint").notNull(),
    reviewerActorSource: text("reviewer_actor_source").notNull(),
    candidateSnapshot: jsonb("candidate_snapshot").$type<ArtifactDirectorShipCandidateV1>().notNull(),
    reviewEvidenceSnapshot: jsonb("review_evidence_snapshot").$type<ArtifactDirectorShipCandidateV1["review"]>().notNull(),
    artifactSnapshot: jsonb("artifact_snapshot").$type<ArtifactDirectorShipCandidateV1["artifact"]>().notNull(),
    directorUserIdSnapshot: text("director_user_id_snapshot").notNull(),
    directorActorSource: text("director_actor_source").notNull(),
    directorSnapshot: jsonb("director_snapshot").$type<ArtifactDirectorShipCandidateV1["director"]>().notNull(),
    requestComment: text("request_comment").notNull(),
    provider: text("provider").notNull().default("github"),
    mergeMethod: text("merge_method").notNull().default("merge"),
    attemptCount: integer("attempt_count").notNull().default(0),
    leaseToken: uuid("lease_token"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    mergeAttemptedAt: timestamp("merge_attempted_at", { withTimezone: true }),
    providerRequestStartedAt: timestamp("provider_request_started_at", { withTimezone: true }),
    providerObservedAt: timestamp("provider_observed_at", { withTimezone: true }),
    mergeCommitSha: text("merge_commit_sha"),
    providerOutcome: jsonb("provider_outcome").$type<Record<string, unknown>>(),
    approvalDecisionId: uuid("approval_decision_id"),
    completionReceipt: jsonb("completion_receipt").$type<ArtifactDirectorShipReceiptV1>(),
    completedIssueUpdatedAt: timestamp("completed_issue_updated_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    staleAt: timestamp("stale_at", { withTimezone: true }),
    lastErrorCode: text("last_error_code"),
    lastErrorAt: timestamp("last_error_at", { withTimezone: true }),
    preparedAt: timestamp("prepared_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIssueIdempotencyUq: uniqueIndex("artifact_shipments_company_issue_idempotency_uq").on(
      table.companyId,
      table.issueId,
      table.idempotencyKey,
    ),
    companyIssueCandidateUq: uniqueIndex("artifact_shipments_company_issue_candidate_uq").on(
      table.companyId,
      table.issueId,
      table.candidateSha256,
    ),
    companyIssueReviewCycleUq: uniqueIndex("artifact_shipments_company_issue_review_cycle_uq").on(
      table.companyId,
      table.issueId,
      table.reviewCycleId,
    ),
    reconciliationKeysetIdx: index("artifact_shipments_reconciliation_keyset_idx").on(
      table.nextAttemptAt,
      table.id,
    ).where(sql`${table.state} = 'reconcile_required'`),
    leaseExpiryKeysetIdx: index("artifact_shipments_lease_expiry_keyset_idx").on(
      table.leaseExpiresAt,
      table.id,
    ).where(sql`${table.state} = 'merge_in_flight'`),
    mergeObservedKeysetIdx: index("artifact_shipments_merge_observed_keyset_idx").on(
      table.id,
    ).where(sql`${table.state} = 'merge_observed'`),
    companyIssueCreatedIdx: index("artifact_shipments_company_issue_created_idx").on(
      table.companyId,
      table.issueId,
      table.createdAt,
    ),
    reviewDecisionIdx: index("artifact_shipments_review_decision_idx").on(table.reviewDecisionId),
    approvalDecisionIdx: index("artifact_shipments_approval_decision_idx").on(table.approvalDecisionId),
    contractVersionCheck: check("artifact_shipments_contract_version_check", sql`${table.contractVersion} = 1`),
    stateCheck: check("artifact_shipments_state_check", sql`${table.state} in (
      'prepared',
      'merge_in_flight',
      'reconcile_required',
      'merge_observed',
      'completed',
      'stale'
    )`),
    candidateHashCheck: check(
      "artifact_shipments_candidate_hash_check",
      sql`${table.candidateSha256} ~ '^[0-9a-f]{64}$' and ${table.policySha256} ~ '^[0-9a-f]{64}$'`,
    ),
    revisionCheck: check(
      "artifact_shipments_revision_check",
      sql`${table.artifactRevision} ~ '^[0-9a-f]{40,64}$'
        and ${table.artifactLocatorFingerprint} ~ '^[0-9a-f]{64}$'
        and (${table.mergeCommitSha} is null or ${table.mergeCommitSha} ~ '^[0-9a-f]{40,64}$')`,
    ),
    providerCheck: check(
      "artifact_shipments_provider_check",
      sql`${table.provider} = 'github' and ${table.mergeMethod} = 'merge'`,
    ),
    actorSourceCheck: check("artifact_shipments_actor_source_check", sql`
      ${table.reviewerActorSource} in ('agent_key', 'agent_jwt')
      and ${table.directorActorSource} in ('local_implicit', 'session', 'board_key', 'cloud_tenant')
    `),
    attemptCountCheck: check("artifact_shipments_attempt_count_check", sql`${table.attemptCount} >= 0`),
    leaseShapeCheck: check(
      "artifact_shipments_lease_shape_check",
      sql`(
        ${table.state} = 'merge_in_flight'
        and ${table.leaseToken} is not null
        and ${table.leaseExpiresAt} is not null
        and ${table.attemptCount} > 0
        and ${table.mergeAttemptedAt} is not null
      ) or (
        ${table.state} <> 'merge_in_flight'
        and ${table.leaseToken} is null
        and ${table.leaseExpiresAt} is null
      )`,
    ),
    retryShapeCheck: check("artifact_shipments_retry_shape_check", sql`
      ${table.state} <> 'reconcile_required'
      or (
        ${table.attemptCount} > 0
        and ${table.mergeAttemptedAt} is not null
        and ${table.nextAttemptAt} is not null
        and ${table.lastErrorCode} is not null
        and ${table.lastErrorAt} is not null
      )
    `),
    candidateSnapshotCheck: check("artifact_shipments_candidate_snapshot_check", sql`
      ${table.candidateSnapshot} ->> 'candidateSha256' is not distinct from ${table.candidateSha256}
      and ${table.candidateSnapshot} ->> 'policySha256' is not distinct from ${table.policySha256}
      and ${table.candidateSnapshot} -> 'issue' ->> 'id' is not distinct from ${table.issueId}::text
      and ${table.candidateSnapshot} -> 'review' ->> 'decisionId' is not distinct from ${table.reviewDecisionId}::text
      and ${table.candidateSnapshot} -> 'review' ->> 'reviewCycleId' is not distinct from ${table.reviewCycleId}::text
      and ${table.candidateSnapshot} -> 'review' ->> 'workProductId' is not distinct from ${table.artifactWorkProductId}::text
      and ${table.candidateSnapshot} -> 'review' ->> 'headSha' is not distinct from ${table.artifactRevision}
      and ${table.candidateSnapshot} -> 'review' ->> 'locatorFingerprint' is not distinct from ${table.artifactLocatorFingerprint}
      and ${table.candidateSnapshot} -> 'review' ->> 'reviewerActorSource' is not distinct from ${table.reviewerActorSource}
      and ${table.candidateSnapshot} -> 'artifact' ->> 'headSha' is not distinct from ${table.artifactRevision}
      and ${table.candidateSnapshot} -> 'director' ->> 'userId' is not distinct from ${table.directorUserIdSnapshot}
      and ${table.candidateSnapshot} -> 'director' ->> 'actorSource' is not distinct from ${table.directorActorSource}
      and ${table.reviewEvidenceSnapshot} is not distinct from ${table.candidateSnapshot} -> 'review'
      and ${table.artifactSnapshot} is not distinct from ${table.candidateSnapshot} -> 'artifact'
      and ${table.directorSnapshot} is not distinct from ${table.candidateSnapshot} -> 'director'
    `),
    terminalShapeCheck: check("artifact_shipments_terminal_shape_check", sql`(
      ${table.state} = 'completed'
      and ${table.approvalDecisionId} is not null
      and ${table.providerObservedAt} is not null
      and ${table.mergeCommitSha} is not null
      and ${table.completionReceipt} is not null
      and ${table.completedIssueUpdatedAt} is not null
      and ${table.completedAt} is not null
      and ${table.staleAt} is null
      and ${table.leaseToken} is null
    ) or (
      ${table.state} = 'stale'
      and ${table.staleAt} is not null
      and ${table.approvalDecisionId} is null
      and ${table.completionReceipt} is null
      and ${table.completedAt} is null
      and ${table.leaseToken} is null
    ) or (
      ${table.state} not in ('completed', 'stale')
      and ${table.approvalDecisionId} is null
      and ${table.completionReceipt} is null
      and ${table.completedAt} is null
      and ${table.staleAt} is null
    )`),
    observationShapeCheck: check("artifact_shipments_observation_shape_check", sql`
      ${table.state} not in ('merge_observed', 'completed')
      or (
        ${table.providerRequestStartedAt} is not null
        and ${table.providerObservedAt} is not null
        and ${table.mergeCommitSha} is not null
      )
    `),
    providerRequestShapeCheck: check("artifact_shipments_provider_request_shape_check", sql`
      ${table.providerRequestStartedAt} is null
      or (
        ${table.attemptCount} > 0
        and ${table.mergeAttemptedAt} is not null
      )
    `),
    completionReceiptCheck: check("artifact_shipments_completion_receipt_check", sql`
      ${table.completionReceipt} is null
      or (
        ${table.completionReceipt} ->> 'version' = '1'
        and ${table.completionReceipt} ->> 'shipmentId' is not distinct from ${table.id}::text
        and ${table.completionReceipt} ->> 'issueId' is not distinct from ${table.issueId}::text
        and ${table.completionReceipt} ->> 'reviewDecisionId' is not distinct from ${table.reviewDecisionId}::text
        and ${table.completionReceipt} ->> 'reviewCycleId' is not distinct from ${table.reviewCycleId}::text
        and ${table.completionReceipt} ->> 'policySha256' is not distinct from ${table.policySha256}
        and ${table.completionReceipt} ->> 'approvalDecisionId' is not distinct from ${table.approvalDecisionId}::text
        and ${table.completionReceipt} ->> 'workProductId' is not distinct from ${table.artifactWorkProductId}::text
        and ${table.completionReceipt} ->> 'artifactRevision' is not distinct from ${table.artifactRevision}
        and ${table.completionReceipt} ->> 'locatorFingerprint' is not distinct from ${table.artifactLocatorFingerprint}
        and ${table.completionReceipt} ->> 'canonicalRef' is not distinct from ${table.artifactSnapshot} ->> 'canonicalRef'
        and ${table.completionReceipt} ->> 'provider' is not distinct from ${table.provider}
        and ${table.completionReceipt} ->> 'mergeMethod' is not distinct from ${table.mergeMethod}
        and ${table.completionReceipt} ->> 'mergeCommitSha' is not distinct from ${table.mergeCommitSha}
        and ${table.completionReceipt} ->> 'directorUserId' is not distinct from ${table.directorUserIdSnapshot}
        and ${table.completionReceipt} ->> 'reviewerActorSource' is not distinct from ${table.reviewerActorSource}
        and ${table.completionReceipt} ->> 'directorActorSource' is not distinct from ${table.directorActorSource}
        and (${table.completionReceipt} ->> 'providerObservedAt')::timestamptz is not distinct from ${table.providerObservedAt}
        and (${table.completionReceipt} ->> 'completedAt')::timestamptz is not distinct from ${table.completedAt}
        and (${table.completionReceipt} ->> 'completedIssueUpdatedAt')::timestamptz is not distinct from ${table.completedIssueUpdatedAt}
      )
    `),
    issueScopeFk: foreignKey({
      columns: [table.issueId, table.companyId],
      foreignColumns: [issues.id, issues.companyId],
      name: "artifact_shipments_issue_scope_fk",
    }).onDelete("restrict"),
    reviewDecisionScopeFk: foreignKey({
      columns: [table.reviewDecisionId, table.companyId, table.issueId],
      foreignColumns: [issueExecutionDecisions.id, issueExecutionDecisions.companyId, issueExecutionDecisions.issueId],
      name: "artifact_shipments_review_decision_scope_fk",
    }).onDelete("restrict"),
    approvalDecisionScopeFk: foreignKey({
      columns: [table.approvalDecisionId, table.companyId, table.issueId],
      foreignColumns: [issueExecutionDecisions.id, issueExecutionDecisions.companyId, issueExecutionDecisions.issueId],
      name: "artifact_shipments_approval_decision_scope_fk",
    }).onDelete("restrict"),
    artifactWorkProductScopeFk: foreignKey({
      columns: [table.artifactWorkProductId, table.companyId, table.issueId],
      foreignColumns: [issueWorkProducts.id, issueWorkProducts.companyId, issueWorkProducts.issueId],
      name: "artifact_shipments_work_product_scope_fk",
    }).onDelete("restrict"),
  }),
);
