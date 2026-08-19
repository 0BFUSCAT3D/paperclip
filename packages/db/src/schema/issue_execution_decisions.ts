import { sql } from "drizzle-orm";
import { check, foreignKey, index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type { IssueExecutionArtifactSnapshot } from "@paperclipai/shared";
import { companies } from "./companies.js";
import { issues } from "./issues.js";
import { agents } from "./agents.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { issueWorkProducts } from "./issue_work_products.js";

export const issueExecutionDecisions = pgTable(
  "issue_execution_decisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    issueId: uuid("issue_id").notNull(),
    stageId: uuid("stage_id").notNull(),
    stageType: text("stage_type").notNull(),
    actorAgentId: uuid("actor_agent_id").references(() => agents.id),
    actorUserId: text("actor_user_id"),
    outcome: text("outcome").notNull(),
    body: text("body").notNull(),
    reviewCycleId: uuid("review_cycle_id"),
    requestIdempotencyKey: uuid("request_idempotency_key"),
    artifactWorkProductId: uuid("artifact_work_product_id"),
    artifactRevision: text("artifact_revision"),
    artifactLocatorFingerprint: text("artifact_locator_fingerprint"),
    reviewerAgentIdSnapshot: uuid("reviewer_agent_id_snapshot"),
    reviewerRunIdSnapshot: uuid("reviewer_run_id_snapshot"),
    reviewerActorSourceSnapshot: text("reviewer_actor_source_snapshot"),
    directorUserIdSnapshot: text("director_user_id_snapshot"),
    artifactSnapshot: jsonb("artifact_snapshot").$type<IssueExecutionArtifactSnapshot | null>(),
    createdByRunId: uuid("created_by_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIssueIdx: index("issue_execution_decisions_company_issue_idx").on(table.companyId, table.issueId),
    stageIdx: index("issue_execution_decisions_stage_idx").on(table.issueId, table.stageId, table.createdAt),
    requestIdempotencyUq: uniqueIndex("issue_execution_decisions_request_idempotency_uq")
      .on(table.companyId, table.issueId, table.requestIdempotencyKey)
      .where(sql`${table.requestIdempotencyKey} is not null`),
    artifactRevisionIdx: index("issue_execution_decisions_artifact_revision_idx").on(
      table.issueId,
      table.artifactWorkProductId,
      table.artifactRevision,
    ),
    artifactEvidenceShapeCheck: check("issue_execution_decisions_artifact_evidence_shape_check", sql`(
      ${table.reviewCycleId} is null
      and ${table.requestIdempotencyKey} is null
      and ${table.artifactWorkProductId} is null
      and ${table.artifactRevision} is null
      and ${table.artifactLocatorFingerprint} is null
      and ${table.reviewerAgentIdSnapshot} is null
      and ${table.reviewerRunIdSnapshot} is null
      and ${table.reviewerActorSourceSnapshot} is null
      and ${table.directorUserIdSnapshot} is null
      and ${table.artifactSnapshot} is null
    ) or (
      ${table.reviewCycleId} is not null
      and ${table.requestIdempotencyKey} is not null
      and ${table.artifactWorkProductId} is not null
      and ${table.artifactRevision} is not null
      and ${table.artifactLocatorFingerprint} is not null
      and ${table.reviewerAgentIdSnapshot} is not null
      and ${table.reviewerRunIdSnapshot} is not null
      and ${table.reviewerActorSourceSnapshot} is not null
      and ${table.reviewerActorSourceSnapshot} in ('agent_key', 'agent_jwt')
      and ${table.directorUserIdSnapshot} is not null
      and ${table.artifactSnapshot} is not null
      and ${table.stageType} = 'review'
      and ${table.outcome} = 'approved'
      and ${table.actorAgentId} is not null
      and ${table.actorAgentId} is not distinct from ${table.reviewerAgentIdSnapshot}
      and ${table.actorUserId} is null
      and (${table.createdByRunId} is null or ${table.createdByRunId} is not distinct from ${table.reviewerRunIdSnapshot})
      and ${table.artifactSnapshot} ->> 'headSha' is not distinct from ${table.artifactRevision}
      and ${table.artifactSnapshot} ->> 'locatorFingerprint' is not distinct from ${table.artifactLocatorFingerprint}
      and ${table.artifactSnapshot} -> 'reviewer' ->> 'agentId' is not distinct from ${table.reviewerAgentIdSnapshot}::text
      and ${table.artifactSnapshot} -> 'reviewer' ->> 'runId' is not distinct from ${table.reviewerRunIdSnapshot}::text
      and ${table.artifactSnapshot} -> 'reviewer' ->> 'actorSource' is not distinct from ${table.reviewerActorSourceSnapshot}
      and ${table.artifactSnapshot} -> 'director' ->> 'userId' is not distinct from ${table.directorUserIdSnapshot}
    )`),
    issueScopeFk: foreignKey({
      columns: [table.issueId, table.companyId],
      foreignColumns: [issues.id, issues.companyId],
      name: "issue_execution_decisions_issue_scope_fk",
    }).onDelete("cascade"),
    artifactWorkProductScopeFk: foreignKey({
      columns: [table.artifactWorkProductId, table.companyId, table.issueId],
      foreignColumns: [issueWorkProducts.id, issueWorkProducts.companyId, issueWorkProducts.issueId],
      name: "issue_execution_decisions_artifact_work_product_scope_fk",
    }).onDelete("restrict"),
  }),
);
