ALTER TABLE "governed_issue_reservations" ADD COLUMN "retirement_sha256" text;--> statement-breakpoint
ALTER TABLE "governed_issue_reservations" ADD COLUMN "retirement_receipt" jsonb;--> statement-breakpoint
ALTER TABLE "governed_issue_reservations" ADD COLUMN "retired_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "governed_issue_reservations" ADD CONSTRAINT "governed_issue_reservations_retirement_shape_check" CHECK ((
        "governed_issue_reservations"."retirement_sha256" IS NULL
        AND "governed_issue_reservations"."retirement_receipt" IS NULL
        AND "governed_issue_reservations"."retired_at" IS NULL
      ) OR (
        "governed_issue_reservations"."contract_version" = 2
        AND "governed_issue_reservations"."retirement_sha256" ~ '^[0-9a-f]{64}$'
        AND "governed_issue_reservations"."retirement_receipt" IS NOT NULL
        AND "governed_issue_reservations"."retired_at" IS NOT NULL
      ));--> statement-breakpoint

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
      AND reservation.retired_at IS NULL
  ) AND current_setting('paperclip.governed_activation_issue_id', true) IS DISTINCT FROM OLD.id::text THEN
    RAISE EXCEPTION 'governed issue reservation requires versioned activation'
      USING ERRCODE = '55000',
            DETAIL = 'issue_id=' || OLD.id::text;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

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
    AND reservation.retired_at IS NULL
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

CREATE OR REPLACE FUNCTION enforce_governed_issue_reservation_retirement_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.retired_at IS NOT NULL AND (
    NEW.company_id IS DISTINCT FROM OLD.company_id
    OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
    OR NEW.issue_id IS DISTINCT FROM OLD.issue_id
    OR NEW.contract_version IS DISTINCT FROM OLD.contract_version
    OR NEW.envelope_sha256 IS DISTINCT FROM OLD.envelope_sha256
    OR NEW.activated_at IS DISTINCT FROM OLD.activated_at
    OR NEW.heartbeat_run_id IS DISTINCT FROM OLD.heartbeat_run_id
    OR NEW.retirement_sha256 IS DISTINCT FROM OLD.retirement_sha256
    OR NEW.retirement_receipt IS DISTINCT FROM OLD.retirement_receipt
    OR NEW.retired_at IS DISTINCT FROM OLD.retired_at
  ) THEN
    RAISE EXCEPTION 'governed issue reservation retirement receipt is immutable'
      USING ERRCODE = '55000',
            DETAIL = 'reservation_id=' || OLD.id::text;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

DROP TRIGGER IF EXISTS "governed_issue_reservation_retirement_immutable" ON "governed_issue_reservations";--> statement-breakpoint
CREATE TRIGGER "governed_issue_reservation_retirement_immutable"
BEFORE UPDATE OF "company_id", "idempotency_key", "issue_id", "contract_version", "envelope_sha256", "activated_at", "heartbeat_run_id", "retirement_sha256", "retirement_receipt", "retired_at"
ON "governed_issue_reservations"
FOR EACH ROW
EXECUTE FUNCTION enforce_governed_issue_reservation_retirement_immutable();
