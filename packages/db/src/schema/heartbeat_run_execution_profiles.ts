import { sql } from "drizzle-orm";
import {
  bigint,
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
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { issues } from "./issues.js";

/**
 * Immutable queue-time execution-profile evidence for a heartbeat run.
 *
 * `projection` is deliberately typed as an opaque record at the DB boundary;
 * the server owns the versioned, non-secret domain type and canonical digest.
 * Legacy heartbeat rows may have no sidecar, but every newly executable row is
 * inserted through the server binding helper in the same transaction.
 */
export const heartbeatRunExecutionProfiles = pgTable(
  "heartbeat_run_execution_profiles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    runId: uuid("run_id").notNull(),
    agentId: uuid("agent_id").notNull(),
    issueId: uuid("issue_id"),
    bindingVersion: integer("binding_version").notNull(),
    agentExecutionProfileRevision: bigint("agent_execution_profile_revision", { mode: "number" }).notNull(),
    issueAssigneeProfileRevision: bigint("issue_assignee_profile_revision", { mode: "number" }),
    digest: text("digest").notNull(),
    attemptToken: uuid("attempt_token").notNull().defaultRandom(),
    projection: jsonb("projection").$type<Record<string, unknown>>().notNull(),
    authorityIdentity: jsonb("authority_identity").$type<Record<string, unknown>>().notNull(),
    authorityFingerprint: text("authority_fingerprint").notNull(),
    transitionKind: text("transition_kind").notNull(),
    transitionReason: text("transition_reason").notNull(),
    parentRunId: uuid("parent_run_id"),
    parentProfileId: uuid("parent_profile_id"),
    validatedAt: timestamp("validated_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    runUq: uniqueIndex("heartbeat_run_execution_profiles_run_uq").on(table.runId),
    parentIdentityUq: uniqueIndex("heartbeat_run_execution_profiles_parent_identity_uq").on(
      table.id,
      table.runId,
      table.companyId,
      table.agentId,
    ),
    companyAgentIdx: index("heartbeat_run_execution_profiles_company_agent_idx").on(
      table.companyId,
      table.agentId,
    ),
    runScopeFk: foreignKey({
      columns: [table.runId, table.companyId, table.agentId],
      foreignColumns: [heartbeatRuns.id, heartbeatRuns.companyId, heartbeatRuns.agentId],
      name: "heartbeat_run_execution_profiles_run_scope_fk",
    }).onDelete("cascade"),
    agentScopeFk: foreignKey({
      columns: [table.agentId, table.companyId],
      foreignColumns: [agents.id, agents.companyId],
      name: "heartbeat_run_execution_profiles_agent_scope_fk",
    }),
    issueScopeFk: foreignKey({
      columns: [table.issueId, table.companyId],
      foreignColumns: [issues.id, issues.companyId],
      name: "heartbeat_run_execution_profiles_issue_scope_fk",
    }),
    parentScopeFk: foreignKey({
      columns: [table.parentProfileId, table.parentRunId, table.companyId, table.agentId],
      foreignColumns: [table.id, table.runId, table.companyId, table.agentId],
      name: "heartbeat_run_execution_profiles_parent_scope_fk",
    }),
    transitionShapeCheck: check(
      "heartbeat_run_execution_profiles_transition_shape_check",
      sql`(
        ${table.transitionKind} = 'fresh'
        AND ${table.transitionReason} IN (
          'governed_activation',
          'provider_quota_recovery',
          'missing_comment_retry',
          'bounded_retry',
          'execution_review_recovery',
          'assignment_recovery',
          'continuation_recovery',
          'normal_enqueue'
        )
        AND ${table.parentRunId} IS NULL
        AND ${table.parentProfileId} IS NULL
      ) OR (
        ${table.transitionKind} = 'preserve'
        AND ${table.transitionReason} IN ('process_loss', 'deferred_promotion')
        AND ${table.parentRunId} IS NOT NULL
        AND ${table.parentProfileId} IS NOT NULL
        AND ${table.parentRunId} <> ${table.runId}
        AND ${table.parentProfileId} <> ${table.id}
      )`,
    ),
    bindingVersionCheck: check(
      "heartbeat_run_execution_profiles_binding_version_check",
      sql`${table.bindingVersion} = 1`,
    ),
  }),
);
