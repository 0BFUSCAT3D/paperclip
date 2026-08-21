ALTER TABLE "governed_issue_reservations" ADD COLUMN "execution_profile_intent_sha256" text;--> statement-breakpoint
ALTER TABLE "governed_issue_reservations" ADD COLUMN "execution_profile_intent" jsonb;--> statement-breakpoint
ALTER TABLE "governed_issue_reservations" ADD COLUMN "execution_profile_receipt" jsonb;--> statement-breakpoint
ALTER TABLE "governed_issue_reservations" ADD CONSTRAINT "governed_issue_reservations_version_shape_check" CHECK ((
        "governed_issue_reservations"."contract_version" = 1
        AND "governed_issue_reservations"."execution_profile_intent_sha256" IS NULL
        AND "governed_issue_reservations"."execution_profile_intent" IS NULL
        AND "governed_issue_reservations"."execution_profile_receipt" IS NULL
      ) OR (
        "governed_issue_reservations"."contract_version" = 2
        AND "governed_issue_reservations"."execution_profile_intent_sha256" IS NOT NULL
        AND "governed_issue_reservations"."execution_profile_intent" IS NOT NULL
        AND (
          ("governed_issue_reservations"."activated_at" IS NULL AND "governed_issue_reservations"."execution_profile_receipt" IS NULL)
          OR ("governed_issue_reservations"."activated_at" IS NOT NULL AND "governed_issue_reservations"."execution_profile_receipt" IS NOT NULL)
        )
      ));--> statement-breakpoint
CREATE OR REPLACE FUNCTION enforce_heartbeat_run_execution_profile_preserved_payload()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
	parent_digest text;
	parent_projection jsonb;
BEGIN
	IF NEW."transition_kind" <> 'preserve' THEN
		RETURN NEW;
	END IF;
	SELECT "digest", "projection"
	INTO parent_digest, parent_projection
	FROM "heartbeat_run_execution_profiles"
	WHERE "id" = NEW."parent_profile_id"
		AND "run_id" = NEW."parent_run_id"
		AND "company_id" = NEW."company_id"
		AND "agent_id" = NEW."agent_id"
	FOR KEY SHARE;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'execution profile preserve parent is invalid'
			USING ERRCODE = 'foreign_key_violation';
	END IF;
	IF parent_digest IS DISTINCT FROM NEW."digest"
		OR parent_projection IS DISTINCT FROM NEW."projection" THEN
		RAISE EXCEPTION 'execution profile preserve payload does not match parent'
			USING ERRCODE = 'check_violation';
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "heartbeat_run_execution_profiles_enforce_preserved_payload"
BEFORE INSERT ON "heartbeat_run_execution_profiles"
FOR EACH ROW
EXECUTE FUNCTION enforce_heartbeat_run_execution_profile_preserved_payload();
