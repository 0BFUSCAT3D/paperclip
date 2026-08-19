ALTER TABLE "issue_execution_decisions" DROP CONSTRAINT "issue_execution_decisions_issue_id_issues_id_fk";
--> statement-breakpoint
ALTER TABLE "issue_work_products" DROP CONSTRAINT "issue_work_products_issue_id_issues_id_fk";
--> statement-breakpoint
ALTER TABLE "issue_execution_decisions" ADD COLUMN "review_cycle_id" uuid;--> statement-breakpoint
ALTER TABLE "issue_execution_decisions" ADD COLUMN "request_idempotency_key" uuid;--> statement-breakpoint
ALTER TABLE "issue_execution_decisions" ADD COLUMN "artifact_work_product_id" uuid;--> statement-breakpoint
ALTER TABLE "issue_execution_decisions" ADD COLUMN "artifact_revision" text;--> statement-breakpoint
ALTER TABLE "issue_execution_decisions" ADD COLUMN "artifact_locator_fingerprint" text;--> statement-breakpoint
ALTER TABLE "issue_execution_decisions" ADD COLUMN "reviewer_agent_id_snapshot" uuid;--> statement-breakpoint
ALTER TABLE "issue_execution_decisions" ADD COLUMN "reviewer_run_id_snapshot" uuid;--> statement-breakpoint
ALTER TABLE "issue_execution_decisions" ADD COLUMN "reviewer_actor_source_snapshot" text;--> statement-breakpoint
ALTER TABLE "issue_execution_decisions" ADD COLUMN "director_user_id_snapshot" text;--> statement-breakpoint
ALTER TABLE "issue_execution_decisions" ADD COLUMN "artifact_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "issue_work_products" ADD COLUMN "last_modified_by_run_id" uuid;--> statement-breakpoint
ALTER TABLE "issue_work_products" ADD CONSTRAINT "issue_work_products_last_modified_by_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("last_modified_by_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "issue_execution_decisions_request_idempotency_uq" ON "issue_execution_decisions" USING btree ("company_id","issue_id","request_idempotency_key") WHERE "issue_execution_decisions"."request_idempotency_key" is not null;--> statement-breakpoint
CREATE INDEX "issue_execution_decisions_artifact_revision_idx" ON "issue_execution_decisions" USING btree ("issue_id","artifact_work_product_id","artifact_revision");--> statement-breakpoint
CREATE UNIQUE INDEX "issue_work_products_scoped_identity_uq" ON "issue_work_products" USING btree ("id","company_id","issue_id");--> statement-breakpoint
CREATE UNIQUE INDEX "issues_scoped_identity_uq" ON "issues" USING btree ("id","company_id");--> statement-breakpoint
ALTER TABLE "issue_execution_decisions" ADD CONSTRAINT "issue_execution_decisions_issue_scope_fk" FOREIGN KEY ("issue_id","company_id") REFERENCES "public"."issues"("id","company_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_execution_decisions" ADD CONSTRAINT "issue_execution_decisions_artifact_work_product_scope_fk" FOREIGN KEY ("artifact_work_product_id","company_id","issue_id") REFERENCES "public"."issue_work_products"("id","company_id","issue_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_work_products" ADD CONSTRAINT "issue_work_products_issue_scope_fk" FOREIGN KEY ("issue_id","company_id") REFERENCES "public"."issues"("id","company_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_execution_decisions" ADD CONSTRAINT "issue_execution_decisions_artifact_evidence_shape_check" CHECK ((
      "issue_execution_decisions"."review_cycle_id" is null
      and "issue_execution_decisions"."request_idempotency_key" is null
      and "issue_execution_decisions"."artifact_work_product_id" is null
      and "issue_execution_decisions"."artifact_revision" is null
      and "issue_execution_decisions"."artifact_locator_fingerprint" is null
      and "issue_execution_decisions"."reviewer_agent_id_snapshot" is null
      and "issue_execution_decisions"."reviewer_run_id_snapshot" is null
      and "issue_execution_decisions"."reviewer_actor_source_snapshot" is null
      and "issue_execution_decisions"."director_user_id_snapshot" is null
      and "issue_execution_decisions"."artifact_snapshot" is null
    ) or (
      "issue_execution_decisions"."review_cycle_id" is not null
      and "issue_execution_decisions"."request_idempotency_key" is not null
      and "issue_execution_decisions"."artifact_work_product_id" is not null
      and "issue_execution_decisions"."artifact_revision" is not null
      and "issue_execution_decisions"."artifact_locator_fingerprint" is not null
      and "issue_execution_decisions"."reviewer_agent_id_snapshot" is not null
      and "issue_execution_decisions"."reviewer_run_id_snapshot" is not null
      and "issue_execution_decisions"."reviewer_actor_source_snapshot" is not null
      and "issue_execution_decisions"."reviewer_actor_source_snapshot" in ('agent_key', 'agent_jwt')
      and "issue_execution_decisions"."director_user_id_snapshot" is not null
      and "issue_execution_decisions"."artifact_snapshot" is not null
      and "issue_execution_decisions"."stage_type" = 'review'
      and "issue_execution_decisions"."outcome" = 'approved'
      and "issue_execution_decisions"."actor_agent_id" is not null
      and "issue_execution_decisions"."actor_agent_id" is not distinct from "issue_execution_decisions"."reviewer_agent_id_snapshot"
      and "issue_execution_decisions"."actor_user_id" is null
      and ("issue_execution_decisions"."created_by_run_id" is null or "issue_execution_decisions"."created_by_run_id" is not distinct from "issue_execution_decisions"."reviewer_run_id_snapshot")
      and "issue_execution_decisions"."artifact_snapshot" ->> 'headSha' is not distinct from "issue_execution_decisions"."artifact_revision"
      and "issue_execution_decisions"."artifact_snapshot" ->> 'locatorFingerprint' is not distinct from "issue_execution_decisions"."artifact_locator_fingerprint"
      and "issue_execution_decisions"."artifact_snapshot" -> 'reviewer' ->> 'agentId' is not distinct from "issue_execution_decisions"."reviewer_agent_id_snapshot"::text
      and "issue_execution_decisions"."artifact_snapshot" -> 'reviewer' ->> 'runId' is not distinct from "issue_execution_decisions"."reviewer_run_id_snapshot"::text
      and "issue_execution_decisions"."artifact_snapshot" -> 'reviewer' ->> 'actorSource' is not distinct from "issue_execution_decisions"."reviewer_actor_source_snapshot"
      and "issue_execution_decisions"."artifact_snapshot" -> 'director' ->> 'userId' is not distinct from "issue_execution_decisions"."director_user_id_snapshot"
    ));
