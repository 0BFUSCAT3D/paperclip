import { check, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { companies } from "./companies.js";
import { executionWorkspaces } from "./execution_workspaces.js";
import { governedIssueReservations } from "./governed_issue_reservations.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { issues } from "./issues.js";

/** Immutable host evidence written once after a governed local executor spawns. */
export const governedExecutorLaunchReceipts = pgTable(
  "governed_executor_launch_receipts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "restrict" }),
    reservationId: uuid("reservation_id").notNull()
      .references(() => governedIssueReservations.id, { onDelete: "restrict" }),
    issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "restrict" }),
    heartbeatRunId: uuid("heartbeat_run_id").notNull()
      .references(() => heartbeatRuns.id, { onDelete: "restrict" }),
    executionWorkspaceId: uuid("execution_workspace_id").notNull()
      .references(() => executionWorkspaces.id, { onDelete: "restrict" }),
    connectionId: text("connection_id").notNull(),
    lifecycleId: text("lifecycle_id").notNull(),
    taskId: text("task_id").notNull(),
    cwd: text("cwd").notNull(),
    branchName: text("branch_name").notNull(),
    headSha: text("head_sha").notNull(),
    pid: integer("pid").notNull(),
    startToken: text("start_token").notNull(),
    instanceId: uuid("instance_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    reservationUq: uniqueIndex("governed_executor_launch_receipts_reservation_uq").on(table.reservationId),
    runUq: uniqueIndex("governed_executor_launch_receipts_run_uq").on(table.heartbeatRunId),
    companyCreatedIdx: index("governed_executor_launch_receipts_company_created_idx").on(
      table.companyId,
      table.createdAt,
    ),
    identityCheck: check(
      "governed_executor_launch_receipts_identity_check",
      sql`${table.pid} > 0 AND ${table.startToken} ~ '^[0-9a-f]{64}$' AND ${table.headSha} ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'`,
    ),
  }),
);
