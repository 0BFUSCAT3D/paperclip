-- Preserve the newest declared primary when historical callers left more than one
-- primary of the same type. The existing issue/type index bounds this one-time
-- reconciliation before the database begins enforcing the invariant.
-- paperclip:migration-safety-ignore large-update: reconciliation is restricted to duplicate primary work products and is required before the unique partial index can be created safely.
WITH ranked_primaries AS (
  SELECT
    "id",
    row_number() OVER (
      PARTITION BY "company_id", "issue_id", "type"
      ORDER BY "updated_at" DESC, "id" DESC
    ) AS "rank"
  FROM "issue_work_products"
  WHERE "is_primary" = true
)
UPDATE "issue_work_products" AS "work_product"
SET "is_primary" = false, "updated_at" = now()
FROM ranked_primaries
WHERE "work_product"."id" = ranked_primaries."id"
  AND ranked_primaries."rank" > 1;--> statement-breakpoint

-- paperclip:migration-safety-ignore large-create-index-not-concurrently: Drizzle migrations run transactionally, so CONCURRENTLY is unavailable; this partial unique index is required to keep primary PR publication race-safe.
CREATE UNIQUE INDEX "issue_work_products_issue_type_primary_uq" ON "issue_work_products" USING btree ("company_id","issue_id","type") WHERE "issue_work_products"."is_primary" = true;
