import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { issueExecutionDecisions } from "./schema/issue_execution_decisions.js";
import { issueWorkProducts } from "./schema/issue_work_products.js";

type PgTable = Parameters<typeof getTableConfig>[0];

function index(table: PgTable, name: string) {
  return getTableConfig(table).indexes.find((candidate) => candidate.config.name === name);
}

function indexColumns(table: PgTable, name: string) {
  return index(table, name)?.config.columns.map((column) => (column as { name: string }).name) ?? [];
}

describe("artifact-bound issue execution review evidence schema", () => {
  it("enforces one idempotency receipt per company issue and request key", () => {
    const receiptIndex = index(
      issueExecutionDecisions,
      "issue_execution_decisions_request_idempotency_uq",
    );
    expect(receiptIndex?.config.unique).toBe(true);
    expect(receiptIndex?.config.where).toBeDefined();
    expect(indexColumns(
      issueExecutionDecisions,
      "issue_execution_decisions_request_idempotency_uq",
    )).toEqual(["company_id", "issue_id", "request_idempotency_key"]);
  });

  it("keeps the artifact evidence tuple all-or-none", () => {
    const evidenceCheck = getTableConfig(issueExecutionDecisions).checks.find(
      (candidate) => candidate.name === "issue_execution_decisions_artifact_evidence_shape_check",
    );
    expect(evidenceCheck).toBeDefined();
    const checkSql = new PgDialect().sqlToQuery(evidenceCheck!.value).sql;
    expect(checkSql).toContain('"actor_agent_id" is not null');
    expect(checkSql.match(/is not distinct from/g)).toHaveLength(8);
    expect(checkSql).not.toMatch(/artifact_snapshot[^\n]+ = /);
  });

  it("binds an evidence artifact to a work product from the same company and issue", () => {
    expect(index(issueWorkProducts, "issue_work_products_scoped_identity_uq")?.config.unique).toBe(true);
    expect(indexColumns(issueWorkProducts, "issue_work_products_scoped_identity_uq")).toEqual([
      "id",
      "company_id",
      "issue_id",
    ]);

    const scopedForeignKey = getTableConfig(issueExecutionDecisions).foreignKeys.find((foreignKey) => {
      const reference = foreignKey.reference();
      return reference.name === "issue_execution_decisions_artifact_work_product_scope_fk";
    });
    const reference = scopedForeignKey?.reference();
    expect(reference?.columns.map((column) => column.name)).toEqual([
      "artifact_work_product_id",
      "company_id",
      "issue_id",
    ]);
    expect(reference?.foreignColumns.map((column) => column.name)).toEqual([
      "id",
      "company_id",
      "issue_id",
    ]);
    expect(reference?.foreignTable).toBe(issueWorkProducts);
  });
});
