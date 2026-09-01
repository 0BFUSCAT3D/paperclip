import {
  type AnyPgColumn,
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { companies } from "./companies.js";
import { issues } from "./issues.js";
import { projectWorkspaces } from "./project_workspaces.js";
import { projects } from "./projects.js";

export const executionWorkspaces = pgTable(
  "execution_workspaces",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    projectWorkspaceId: uuid("project_workspace_id").references(() => projectWorkspaces.id, { onDelete: "set null" }),
    sourceIssueId: uuid("source_issue_id").references((): AnyPgColumn => issues.id, { onDelete: "set null" }),
    mode: text("mode").notNull(),
    strategyType: text("strategy_type").notNull(),
    name: text("name").notNull(),
    status: text("status").notNull().default("active"),
    cwd: text("cwd"),
    repoUrl: text("repo_url"),
    baseRef: text("base_ref"),
    branchName: text("branch_name"),
    providerType: text("provider_type").notNull().default("local_fs"),
    providerRef: text("provider_ref"),
    custodyKind: text("custody_kind").notNull().default("paperclip"),
    externalConnectionId: text("external_connection_id"),
    externalLifecycleId: text("external_lifecycle_id"),
    externalTaskId: text("external_task_id"),
    preparedIdentitySha256: text("prepared_identity_sha256"),
    authorizedStartHeadSha: text("authorized_start_head_sha"),
    repositoryIdentitySha256: text("repository_identity_sha256"),
    inspectionReceiptSha256: text("inspection_receipt_sha256"),
    externalRoot: text("external_root"),
    externalCommonGitDirectory: text("external_common_git_directory"),
    derivedFromExecutionWorkspaceId: uuid("derived_from_execution_workspace_id")
      .references((): AnyPgColumn => executionWorkspaces.id, { onDelete: "set null" }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }).notNull().defaultNow(),
    openedAt: timestamp("opened_at", { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    cleanupEligibleAt: timestamp("cleanup_eligible_at", { withTimezone: true }),
    cleanupReason: text("cleanup_reason"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyProjectStatusIdx: index("execution_workspaces_company_project_status_idx").on(
      table.companyId,
      table.projectId,
      table.status,
    ),
    companyProjectWorkspaceStatusIdx: index("execution_workspaces_company_project_workspace_status_idx").on(
      table.companyId,
      table.projectWorkspaceId,
      table.status,
    ),
    companySourceIssueIdx: index("execution_workspaces_company_source_issue_idx").on(
      table.companyId,
      table.sourceIssueId,
    ),
    companyLastUsedIdx: index("execution_workspaces_company_last_used_idx").on(
      table.companyId,
      table.lastUsedAt,
    ),
    companyBranchIdx: index("execution_workspaces_company_branch_idx").on(
      table.companyId,
      table.branchName,
    ),
    externalLifecycleUq: uniqueIndex("execution_workspaces_external_lifecycle_uq").on(
      table.companyId,
      table.externalConnectionId,
      table.externalLifecycleId,
    ),
    externalCustodyShapeCheck: check(
      "execution_workspaces_external_custody_shape_check",
      sql`(
        ${table.custodyKind} = 'paperclip'
        AND ${table.externalConnectionId} IS NULL
        AND ${table.externalLifecycleId} IS NULL
        AND ${table.externalTaskId} IS NULL
        AND ${table.preparedIdentitySha256} IS NULL
        AND ${table.authorizedStartHeadSha} IS NULL
        AND ${table.repositoryIdentitySha256} IS NULL
        AND ${table.inspectionReceiptSha256} IS NULL
        AND ${table.externalRoot} IS NULL
        AND ${table.externalCommonGitDirectory} IS NULL
      ) OR (
        ${table.custodyKind} = 'external_prepared'
        AND ${table.mode} = 'isolated_workspace'
        AND ${table.strategyType} = 'git_worktree'
        AND ${table.providerType} = 'git_worktree'
        AND ${table.projectWorkspaceId} IS NOT NULL
        AND ${table.externalConnectionId} IS NOT NULL
        AND ${table.externalLifecycleId} IS NOT NULL
        AND ${table.externalTaskId} IS NOT NULL
        AND ${table.preparedIdentitySha256} ~ '^[0-9a-f]{64}$'
        AND ${table.authorizedStartHeadSha} ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'
        AND ${table.repositoryIdentitySha256} ~ '^[0-9a-f]{64}$'
        AND ${table.inspectionReceiptSha256} ~ '^[0-9a-f]{64}$'
        AND ${table.externalRoot} IS NOT NULL
        AND ${table.externalCommonGitDirectory} IS NOT NULL
      )`,
    ),
  }),
);
