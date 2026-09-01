ALTER TABLE "governed_issue_reservations" ADD COLUMN "terminal_observation_intent_sha256" text;--> statement-breakpoint
ALTER TABLE "governed_issue_reservations" ADD COLUMN "terminal_observation_sha256" text;--> statement-breakpoint
ALTER TABLE "governed_issue_reservations" ADD COLUMN "terminal_observation_receipt" jsonb;--> statement-breakpoint
ALTER TABLE "governed_issue_reservations" ADD COLUMN "terminal_observed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "governed_issue_reservations" ADD COLUMN "release_intent_sha256" text;--> statement-breakpoint
ALTER TABLE "governed_issue_reservations" ADD COLUMN "release_sha256" text;--> statement-breakpoint
ALTER TABLE "governed_issue_reservations" ADD COLUMN "release_receipt" jsonb;--> statement-breakpoint
ALTER TABLE "governed_issue_reservations" ADD COLUMN "completion_work_product_id" uuid;--> statement-breakpoint
ALTER TABLE "governed_issue_reservations" ADD COLUMN "released_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "governed_issue_reservations" ADD CONSTRAINT "governed_issue_reservations_completion_work_product_id_issue_work_products_id_fk" FOREIGN KEY ("completion_work_product_id") REFERENCES "public"."issue_work_products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "governed_issue_reservations" ADD CONSTRAINT "governed_issue_reservations_terminal_observation_shape_check" CHECK ((
        "governed_issue_reservations"."terminal_observation_intent_sha256" IS NULL
        AND "governed_issue_reservations"."terminal_observation_sha256" IS NULL
        AND "governed_issue_reservations"."terminal_observation_receipt" IS NULL
        AND "governed_issue_reservations"."terminal_observed_at" IS NULL
      ) OR (
        "governed_issue_reservations"."contract_version" = 2
        AND "governed_issue_reservations"."activated_at" IS NOT NULL
        AND "governed_issue_reservations"."retired_at" IS NULL
        AND "governed_issue_reservations"."terminal_observation_intent_sha256" ~ '^[0-9a-f]{64}$'
        AND "governed_issue_reservations"."terminal_observation_sha256" ~ '^[0-9a-f]{64}$'
        AND "governed_issue_reservations"."terminal_observation_receipt" IS NOT NULL
        AND "governed_issue_reservations"."terminal_observed_at" IS NOT NULL
      ));--> statement-breakpoint
ALTER TABLE "governed_issue_reservations" ADD CONSTRAINT "governed_issue_reservations_release_shape_check" CHECK ((
        "governed_issue_reservations"."release_intent_sha256" IS NULL
        AND "governed_issue_reservations"."release_sha256" IS NULL
        AND "governed_issue_reservations"."release_receipt" IS NULL
        AND "governed_issue_reservations"."completion_work_product_id" IS NULL
        AND "governed_issue_reservations"."released_at" IS NULL
      ) OR (
        "governed_issue_reservations"."contract_version" = 2
        AND "governed_issue_reservations"."retired_at" IS NULL
        AND "governed_issue_reservations"."terminal_observed_at" IS NOT NULL
        AND "governed_issue_reservations"."release_intent_sha256" ~ '^[0-9a-f]{64}$'
        AND "governed_issue_reservations"."release_sha256" ~ '^[0-9a-f]{64}$'
        AND "governed_issue_reservations"."release_receipt" IS NOT NULL
        AND "governed_issue_reservations"."completion_work_product_id" IS NOT NULL
        AND "governed_issue_reservations"."released_at" IS NOT NULL
      ));--> statement-breakpoint

CREATE OR REPLACE FUNCTION enforce_governed_issue_completion_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.terminal_observed_at IS NOT NULL AND (
    NEW.company_id IS DISTINCT FROM OLD.company_id
    OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
    OR NEW.issue_id IS DISTINCT FROM OLD.issue_id
    OR NEW.contract_version IS DISTINCT FROM OLD.contract_version
    OR NEW.envelope_sha256 IS DISTINCT FROM OLD.envelope_sha256
    OR NEW.activation_sha256 IS DISTINCT FROM OLD.activation_sha256
    OR NEW.builder_agent_id IS DISTINCT FROM OLD.builder_agent_id
    OR NEW.activated_at IS DISTINCT FROM OLD.activated_at
    OR NEW.heartbeat_run_id IS DISTINCT FROM OLD.heartbeat_run_id
    OR NEW.execution_workspace_id IS DISTINCT FROM OLD.execution_workspace_id
    OR NEW.terminal_observation_intent_sha256 IS DISTINCT FROM OLD.terminal_observation_intent_sha256
    OR NEW.terminal_observation_sha256 IS DISTINCT FROM OLD.terminal_observation_sha256
    OR NEW.terminal_observation_receipt IS DISTINCT FROM OLD.terminal_observation_receipt
    OR NEW.terminal_observed_at IS DISTINCT FROM OLD.terminal_observed_at
  ) THEN
    RAISE EXCEPTION 'governed issue terminal observation receipt is immutable'
      USING ERRCODE = '55000', DETAIL = 'reservation_id=' || OLD.id::text;
  END IF;
  IF OLD.released_at IS NOT NULL AND (
    NEW.release_intent_sha256 IS DISTINCT FROM OLD.release_intent_sha256
    OR NEW.release_sha256 IS DISTINCT FROM OLD.release_sha256
    OR NEW.release_receipt IS DISTINCT FROM OLD.release_receipt
    OR NEW.completion_work_product_id IS DISTINCT FROM OLD.completion_work_product_id
    OR NEW.released_at IS DISTINCT FROM OLD.released_at
  ) THEN
    RAISE EXCEPTION 'governed issue draft pull request release receipt is immutable'
      USING ERRCODE = '55000', DETAIL = 'reservation_id=' || OLD.id::text;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER "governed_issue_completion_immutable"
BEFORE UPDATE OF "company_id", "idempotency_key", "issue_id", "contract_version", "envelope_sha256", "activation_sha256", "builder_agent_id", "activated_at", "heartbeat_run_id", "execution_workspace_id", "terminal_observation_intent_sha256", "terminal_observation_sha256", "terminal_observation_receipt", "terminal_observed_at", "release_intent_sha256", "release_sha256", "release_receipt", "completion_work_product_id", "released_at"
ON "governed_issue_reservations"
FOR EACH ROW
EXECUTE FUNCTION enforce_governed_issue_completion_immutable();--> statement-breakpoint

CREATE OR REPLACE FUNCTION enforce_governed_executor_launch_receipt_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'governed executor launch receipt is immutable'
    USING ERRCODE = '55000', DETAIL = 'receipt_id=' || OLD.id::text;
END;
$$;--> statement-breakpoint

CREATE TRIGGER "governed_executor_launch_receipt_immutable"
BEFORE UPDATE ON "governed_executor_launch_receipts"
FOR EACH ROW
EXECUTE FUNCTION enforce_governed_executor_launch_receipt_immutable();
