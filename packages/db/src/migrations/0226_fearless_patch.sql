ALTER TABLE "governed_issue_reservations" ADD COLUMN "request_intent_sha256" text;--> statement-breakpoint
-- paperclip:migration-safety-ignore large-update: 0225 introduced this table in the immediately preceding unreleased migration; this compatibility backfill only covers rows created between those two migrations.
UPDATE "governed_issue_reservations" SET "request_intent_sha256" = "envelope_sha256" WHERE "request_intent_sha256" IS NULL;--> statement-breakpoint
ALTER TABLE "governed_issue_reservations" ALTER COLUMN "request_intent_sha256" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "governed_issue_reservations" ADD COLUMN "activated_issue_snapshot" jsonb;--> statement-breakpoint
CREATE INDEX "issue_execution_decisions_company_actor_agent_idx" ON "issue_execution_decisions" USING btree ("company_id","actor_agent_id","created_at");--> statement-breakpoint
CREATE INDEX "issue_execution_decisions_company_reviewer_agent_snapshot_idx" ON "issue_execution_decisions" USING btree ("company_id","reviewer_agent_id_snapshot","created_at");--> statement-breakpoint
CREATE INDEX "issue_execution_decisions_company_artifact_work_product_idx" ON "issue_execution_decisions" USING btree ("company_id","artifact_work_product_id","created_at");--> statement-breakpoint
CREATE INDEX "issue_work_products_company_created_by_run_idx" ON "issue_work_products" USING btree ("company_id","created_by_run_id");--> statement-breakpoint
CREATE INDEX "issue_work_products_company_last_modified_by_run_idx" ON "issue_work_products" USING btree ("company_id","last_modified_by_run_id");--> statement-breakpoint
CREATE INDEX "issues_execution_policy_gin_idx" ON "issues" USING gin ("execution_policy" jsonb_path_ops);--> statement-breakpoint
CREATE INDEX "issues_execution_state_gin_idx" ON "issues" USING gin ("execution_state" jsonb_path_ops);--> statement-breakpoint

CREATE OR REPLACE FUNCTION enforce_governed_issue_reservation_activation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM governed_issue_reservations reservation
    WHERE reservation.issue_id = OLD.id
      AND reservation.activated_at IS NULL
  ) AND current_setting('paperclip.governed_activation_issue_id', true) IS DISTINCT FROM OLD.id::text THEN
    RAISE EXCEPTION 'governed issue reservation requires versioned activation'
      USING ERRCODE = '55000',
            DETAIL = 'issue_id=' || OLD.id::text;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER issues_governed_reservation_activation_guard
BEFORE UPDATE ON issues
FOR EACH ROW
EXECUTE FUNCTION enforce_governed_issue_reservation_activation();

CREATE OR REPLACE FUNCTION enforce_governed_issue_reservation_relation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  guarded_issue_id uuid;
BEGIN
  SELECT reservation.issue_id
  INTO guarded_issue_id
  FROM governed_issue_reservations reservation
  WHERE reservation.activated_at IS NULL
    AND reservation.issue_id IN (
      CASE WHEN TG_OP IN ('DELETE', 'UPDATE') THEN OLD.issue_id ELSE NULL END,
      CASE WHEN TG_OP IN ('DELETE', 'UPDATE') THEN OLD.related_issue_id ELSE NULL END,
      CASE WHEN TG_OP IN ('INSERT', 'UPDATE') THEN NEW.issue_id ELSE NULL END,
      CASE WHEN TG_OP IN ('INSERT', 'UPDATE') THEN NEW.related_issue_id ELSE NULL END
    )
  ORDER BY reservation.issue_id
  LIMIT 1
  FOR UPDATE;

  IF guarded_issue_id IS NOT NULL THEN
    RAISE EXCEPTION 'governed issue reservation relation requires prior activation'
      USING ERRCODE = '55000',
            DETAIL = 'issue_id=' || guarded_issue_id::text;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER issue_relations_governed_reservation_activation_guard
BEFORE INSERT OR UPDATE OR DELETE ON issue_relations
FOR EACH ROW
EXECUTE FUNCTION enforce_governed_issue_reservation_relation();
