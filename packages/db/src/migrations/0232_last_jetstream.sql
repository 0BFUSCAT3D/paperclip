ALTER TABLE "governed_issue_reservations" DROP CONSTRAINT "governed_issue_reservations_version_shape_check";--> statement-breakpoint
UPDATE "governed_issue_reservations"
SET "execution_workspace_id" = NULL,
    "updated_at" = NOW()
WHERE "contract_version" = 1
  AND "execution_workspace_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "governed_issue_reservations" ADD CONSTRAINT "governed_issue_reservations_version_shape_check" CHECK ((
        "governed_issue_reservations"."contract_version" = 1
        AND "governed_issue_reservations"."execution_profile_intent_sha256" IS NULL
        AND "governed_issue_reservations"."execution_profile_intent" IS NULL
        AND "governed_issue_reservations"."execution_profile_receipt" IS NULL
        AND "governed_issue_reservations"."execution_workspace_id" IS NULL
      ) OR (
        "governed_issue_reservations"."contract_version" = 2
        AND "governed_issue_reservations"."execution_profile_intent_sha256" IS NOT NULL
        AND "governed_issue_reservations"."execution_profile_intent" IS NOT NULL
        AND (
          ("governed_issue_reservations"."activated_at" IS NULL AND "governed_issue_reservations"."execution_profile_receipt" IS NULL)
          OR ("governed_issue_reservations"."activated_at" IS NOT NULL AND "governed_issue_reservations"."execution_profile_receipt" IS NOT NULL)
        )
      ));
