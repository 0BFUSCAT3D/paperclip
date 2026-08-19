import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  executionWorkspaces,
  issueArtifactDirectorShipments,
  issueExecutionDecisions,
  issueWorkProducts,
  issues,
} from "@paperclipai/db";
import { conflict } from "../errors.js";
import { parseIssueExecutionState } from "./issue-execution-policy.js";

export const ACTIVE_ARTIFACT_DIRECTOR_SHIP_STATES = [
  "prepared",
  "merge_in_flight",
  "reconcile_required",
  "merge_observed",
] as const;

/**
 * Global Ship/mutation serialization primitive. Callers must pass a transaction;
 * the sorted per-issue xact locks are retained until that transaction commits.
 */
export async function acquireArtifactDirectorShipIssueLocks(dbOrTx: Db, issueIds: readonly string[]) {
  for (const issueId of [...new Set(issueIds)].sort()) {
    await dbOrTx.execute(sql`
      select pg_advisory_xact_lock(
        hashtextextended(${`artifact-director-ship-issue:${issueId}`}, 0)
      )
    `);
  }
}

async function activeShipmentForIssue(dbOrTx: Db, issueId: string) {
  return dbOrTx.select({ id: issueArtifactDirectorShipments.id, state: issueArtifactDirectorShipments.state })
    .from(issueArtifactDirectorShipments)
    .where(and(
      eq(issueArtifactDirectorShipments.issueId, issueId),
      inArray(issueArtifactDirectorShipments.state, [...ACTIVE_ARTIFACT_DIRECTOR_SHIP_STATES]),
    ))
    .limit(1)
    .then((rows) => rows[0] ?? null);
}

export async function assertArtifactDirectorShipIssueMutationsAllowed(
  dbOrTx: Db,
  issueIds: readonly string[],
) {
  const sortedIssueIds = [...new Set(issueIds)].sort();
  await acquireArtifactDirectorShipIssueLocks(dbOrTx, sortedIssueIds);
  for (const issueId of sortedIssueIds) {
    const active = await activeShipmentForIssue(dbOrTx, issueId);
    if (active) {
      throw conflict("The issue is locked by an active artifact director Ship operation.", {
        code: "artifact_director_ship_in_progress",
        issueId,
        shipmentId: active.id,
        state: active.state,
      });
    }
  }
}

export async function assertIssueArtifactDirectorShipMutationAllowed(
  dbOrTx: Db,
  issueId: string,
  patch: { status?: unknown },
) {
  await acquireArtifactDirectorShipIssueLocks(dbOrTx, [issueId]);
  const active = await activeShipmentForIssue(dbOrTx, issueId);
  if (active) {
    throw conflict("The issue is locked by an active artifact director Ship operation.", {
      code: "artifact_director_ship_in_progress",
      shipmentId: active.id,
      state: active.state,
    });
  }
  if (patch.status !== "done") return;
  const issue = await dbOrTx.select({ executionState: issues.executionState })
    .from(issues)
    .where(eq(issues.id, issueId))
    .then((rows) => rows[0] ?? null);
  const decisionId = parseIssueExecutionState(issue?.executionState)?.lastDecisionId ?? null;
  if (!decisionId) return;
  const artifactReview = await dbOrTx.select({ id: issueExecutionDecisions.id })
    .from(issueExecutionDecisions)
    .where(and(
      eq(issueExecutionDecisions.id, decisionId),
      eq(issueExecutionDecisions.issueId, issueId),
      isNotNull(issueExecutionDecisions.artifactWorkProductId),
      isNotNull(issueExecutionDecisions.artifactRevision),
    ))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (artifactReview) {
    throw conflict("Artifact-bound final approval must use the director Ship endpoint.", {
      code: "artifact_director_ship_required",
      reviewDecisionId: artifactReview.id,
    });
  }
}

export async function assertWorkProductArtifactDirectorShipMutationAllowed(
  dbOrTx: Db,
  input: { issueId?: string | null; workProductId?: string | null },
) {
  let issueId = input.issueId ?? (input.workProductId
    ? await dbOrTx.select({ issueId: issueWorkProducts.issueId })
      .from(issueWorkProducts)
      .where(eq(issueWorkProducts.id, input.workProductId))
      .then((rows) => rows[0]?.issueId ?? null)
    : null);
  if (!issueId) return;
  await acquireArtifactDirectorShipIssueLocks(dbOrTx, [issueId]);
  if (input.workProductId) {
    issueId = await dbOrTx.select({ issueId: issueWorkProducts.issueId })
      .from(issueWorkProducts)
      .where(eq(issueWorkProducts.id, input.workProductId))
      .then((rows) => rows[0]?.issueId ?? null);
    if (!issueId) return;
  }
  const active = await activeShipmentForIssue(dbOrTx, issueId);
  if (active) {
    throw conflict("The work product is locked by an active artifact director Ship operation.", {
      code: "artifact_director_ship_in_progress",
      shipmentId: active.id,
      state: active.state,
    });
  }
}

export async function assertWorkspaceArtifactDirectorShipMutationAllowed(dbOrTx: Db, workspaceId: string) {
  let workspace = await dbOrTx.select({ sourceIssueId: executionWorkspaces.sourceIssueId })
    .from(executionWorkspaces)
    .where(eq(executionWorkspaces.id, workspaceId))
    .then((rows) => rows[0] ?? null);
  if (!workspace) return;
  const linkedIssueIds = await dbOrTx.select({ id: issues.id }).from(issues)
    .where(eq(issues.executionWorkspaceId, workspaceId))
    .then((rows) => rows.map((row) => row.id));
  const issueIds = [...linkedIssueIds, ...(workspace.sourceIssueId ? [workspace.sourceIssueId] : [])];
  await acquireArtifactDirectorShipIssueLocks(dbOrTx, issueIds);
  workspace = await dbOrTx.select({ sourceIssueId: executionWorkspaces.sourceIssueId })
    .from(executionWorkspaces)
    .where(eq(executionWorkspaces.id, workspaceId))
    .then((rows) => rows[0] ?? null);
  if (!workspace) return;
  await assertArtifactDirectorShipIssueMutationsAllowed(dbOrTx, issueIds);
}

export async function assertProjectWorkspaceArtifactDirectorShipMutationAllowed(
  dbOrTx: Db,
  projectWorkspaceId: string,
) {
  const issueIds = await dbOrTx.select({ id: issues.id }).from(issues)
    .where(eq(issues.projectWorkspaceId, projectWorkspaceId))
    .then((rows) => rows.map((row) => row.id));
  await acquireArtifactDirectorShipIssueLocks(dbOrTx, issueIds);
  const active = await dbOrTx.select({
    id: issueArtifactDirectorShipments.id,
    state: issueArtifactDirectorShipments.state,
  }).from(issueArtifactDirectorShipments)
    .innerJoin(issues, and(
      eq(issues.id, issueArtifactDirectorShipments.issueId),
      eq(issues.companyId, issueArtifactDirectorShipments.companyId),
    ))
    .where(and(
      eq(issues.projectWorkspaceId, projectWorkspaceId),
      inArray(issueArtifactDirectorShipments.state, [...ACTIVE_ARTIFACT_DIRECTOR_SHIP_STATES]),
    ))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (active) {
    throw conflict("The project workspace is locked by an active artifact director Ship operation.", {
      code: "artifact_director_ship_in_progress",
      shipmentId: active.id,
      state: active.state,
    });
  }
}

export async function assertProjectWorkspaceFanoutArtifactDirectorShipMutationAllowed(
  dbOrTx: Db,
  projectWorkspaceIds: readonly string[],
) {
  if (projectWorkspaceIds.length === 0) return;
  const issueIds = await dbOrTx.select({ id: issues.id }).from(issues)
    .where(inArray(issues.projectWorkspaceId, [...new Set(projectWorkspaceIds)]))
    .then((rows) => rows.map((row) => row.id));
  await assertArtifactDirectorShipIssueMutationsAllowed(dbOrTx, issueIds);
}
