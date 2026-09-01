import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { agents } from "./agents.js";
import { agentWakeupRequests } from "./agent_wakeup_requests.js";
import { companies } from "./companies.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { issues } from "./issues.js";
import { executionWorkspaces } from "./execution_workspaces.js";
import { issueWorkProducts } from "./issue_work_products.js";

/**
 * Durable versioned reservation/activation contract for governed issues.
 *
 * The reservation row is both the create-idempotency authority and the
 * activation receipt/outbox. Activation writes the issue CAS, wake request,
 * queued run, and receipt references in one transaction, so an HTTP response
 * is never the only evidence that the builder wake was accepted.
 */
export const governedIssueReservations = pgTable(
  "governed_issue_reservations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    idempotencyKey: text("idempotency_key").notNull(),
    issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "restrict" }),
    contractVersion: integer("contract_version").notNull().default(1),
    requestIntentSha256: text("request_intent_sha256").notNull(),
    envelopeSha256: text("envelope_sha256").notNull(),
    envelope: jsonb("envelope").$type<Record<string, unknown>>().notNull(),
    executionProfileIntentSha256: text("execution_profile_intent_sha256"),
    executionProfileIntent: jsonb("execution_profile_intent").$type<Record<string, unknown>>(),
    reservedIssueSnapshot: jsonb("reserved_issue_snapshot").$type<Record<string, unknown>>().notNull(),
    reservedIssueUpdatedAt: timestamp("reserved_issue_updated_at", { withTimezone: true }).notNull(),
    activationSha256: text("activation_sha256"),
    builderAgentId: uuid("builder_agent_id").references(() => agents.id, { onDelete: "restrict" }),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
    activatedIssueUpdatedAt: timestamp("activated_issue_updated_at", { withTimezone: true }),
    activatedIssueSnapshot: jsonb("activated_issue_snapshot").$type<Record<string, unknown>>(),
    executionProfileReceipt: jsonb("execution_profile_receipt").$type<Record<string, unknown>>(),
    wakeupRequestId: uuid("wakeup_request_id").references(() => agentWakeupRequests.id, { onDelete: "restrict" }),
    heartbeatRunId: uuid("heartbeat_run_id").references(() => heartbeatRuns.id, { onDelete: "restrict" }),
    executionWorkspaceId: uuid("execution_workspace_id")
      .references(() => executionWorkspaces.id, { onDelete: "restrict" }),
    terminalObservationIntentSha256: text("terminal_observation_intent_sha256"),
    terminalObservationSha256: text("terminal_observation_sha256"),
    terminalObservationReceipt: jsonb("terminal_observation_receipt").$type<Record<string, unknown>>(),
    terminalObservedAt: timestamp("terminal_observed_at", { withTimezone: true }),
    releaseIntentSha256: text("release_intent_sha256"),
    releaseSha256: text("release_sha256"),
    releaseReceipt: jsonb("release_receipt").$type<Record<string, unknown>>(),
    completionWorkProductId: uuid("completion_work_product_id")
      .references(() => issueWorkProducts.id, { onDelete: "restrict" }),
    releasedAt: timestamp("released_at", { withTimezone: true }),
    retirementSha256: text("retirement_sha256"),
    retirementReceipt: jsonb("retirement_receipt").$type<Record<string, unknown>>(),
    retiredAt: timestamp("retired_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyKeyUq: uniqueIndex("governed_issue_reservations_company_key_uq").on(
      table.companyId,
      table.idempotencyKey,
    ),
    issueUq: uniqueIndex("governed_issue_reservations_issue_uq").on(table.issueId),
    builderIdx: index("governed_issue_reservations_builder_idx").on(table.builderAgentId),
    executionWorkspaceUq: uniqueIndex("governed_issue_reservations_execution_workspace_uq").on(
      table.executionWorkspaceId,
    ),
    companyCreatedIdx: index("governed_issue_reservations_company_created_idx").on(
      table.companyId,
      table.createdAt,
    ),
    versionShapeCheck: check(
      "governed_issue_reservations_version_shape_check",
      sql`(
        ${table.contractVersion} = 1
        AND ${table.executionProfileIntentSha256} IS NULL
        AND ${table.executionProfileIntent} IS NULL
        AND ${table.executionProfileReceipt} IS NULL
        AND ${table.executionWorkspaceId} IS NULL
      ) OR (
        ${table.contractVersion} = 2
        AND ${table.executionProfileIntentSha256} IS NOT NULL
        AND ${table.executionProfileIntent} IS NOT NULL
        AND (
          (${table.activatedAt} IS NULL AND ${table.executionProfileReceipt} IS NULL)
          OR (${table.activatedAt} IS NOT NULL AND ${table.executionProfileReceipt} IS NOT NULL)
        )
      )`,
    ),
    retirementShapeCheck: check(
      "governed_issue_reservations_retirement_shape_check",
      sql`(
        ${table.retirementSha256} IS NULL
        AND ${table.retirementReceipt} IS NULL
        AND ${table.retiredAt} IS NULL
      ) OR (
        ${table.contractVersion} = 2
        AND ${table.retirementSha256} ~ '^[0-9a-f]{64}$'
        AND ${table.retirementReceipt} IS NOT NULL
        AND ${table.retiredAt} IS NOT NULL
      )`,
    ),
    terminalObservationShapeCheck: check(
      "governed_issue_reservations_terminal_observation_shape_check",
      sql`(
        ${table.terminalObservationIntentSha256} IS NULL
        AND ${table.terminalObservationSha256} IS NULL
        AND ${table.terminalObservationReceipt} IS NULL
        AND ${table.terminalObservedAt} IS NULL
      ) OR (
        ${table.contractVersion} = 2
        AND ${table.activatedAt} IS NOT NULL
        AND ${table.retiredAt} IS NULL
        AND ${table.terminalObservationIntentSha256} ~ '^[0-9a-f]{64}$'
        AND ${table.terminalObservationSha256} ~ '^[0-9a-f]{64}$'
        AND ${table.terminalObservationReceipt} IS NOT NULL
        AND ${table.terminalObservedAt} IS NOT NULL
      )`,
    ),
    releaseShapeCheck: check(
      "governed_issue_reservations_release_shape_check",
      sql`(
        ${table.releaseIntentSha256} IS NULL
        AND ${table.releaseSha256} IS NULL
        AND ${table.releaseReceipt} IS NULL
        AND ${table.completionWorkProductId} IS NULL
        AND ${table.releasedAt} IS NULL
      ) OR (
        ${table.contractVersion} = 2
        AND ${table.retiredAt} IS NULL
        AND ${table.terminalObservedAt} IS NOT NULL
        AND ${table.releaseIntentSha256} ~ '^[0-9a-f]{64}$'
        AND ${table.releaseSha256} ~ '^[0-9a-f]{64}$'
        AND ${table.releaseReceipt} IS NOT NULL
        AND ${table.completionWorkProductId} IS NOT NULL
        AND ${table.releasedAt} IS NOT NULL
      )`,
    ),
  }),
);
