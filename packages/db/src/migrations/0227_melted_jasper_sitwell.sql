CREATE TABLE "issue_artifact_director_shipments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"idempotency_key" uuid NOT NULL,
	"contract_version" integer DEFAULT 1 NOT NULL,
	"state" text DEFAULT 'prepared' NOT NULL,
	"candidate_sha256" text NOT NULL,
	"policy_sha256" text NOT NULL,
	"review_decision_id" uuid NOT NULL,
	"review_cycle_id" uuid NOT NULL,
	"artifact_work_product_id" uuid NOT NULL,
	"artifact_revision" text NOT NULL,
	"artifact_locator_fingerprint" text NOT NULL,
	"reviewer_actor_source" text NOT NULL,
	"candidate_snapshot" jsonb NOT NULL,
	"review_evidence_snapshot" jsonb NOT NULL,
	"artifact_snapshot" jsonb NOT NULL,
	"director_user_id_snapshot" text NOT NULL,
	"director_actor_source" text NOT NULL,
	"director_snapshot" jsonb NOT NULL,
	"request_comment" text NOT NULL,
	"provider" text DEFAULT 'github' NOT NULL,
	"merge_method" text DEFAULT 'merge' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"lease_token" uuid,
	"lease_expires_at" timestamp with time zone,
	"next_attempt_at" timestamp with time zone,
	"merge_attempted_at" timestamp with time zone,
	"provider_request_started_at" timestamp with time zone,
	"provider_observed_at" timestamp with time zone,
	"merge_commit_sha" text,
	"provider_outcome" jsonb,
	"approval_decision_id" uuid,
	"completion_receipt" jsonb,
	"completed_issue_updated_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"stale_at" timestamp with time zone,
	"last_error_code" text,
	"last_error_at" timestamp with time zone,
	"prepared_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "artifact_shipments_contract_version_check" CHECK ("issue_artifact_director_shipments"."contract_version" = 1),
	CONSTRAINT "artifact_shipments_state_check" CHECK ("issue_artifact_director_shipments"."state" in (
      'prepared',
      'merge_in_flight',
      'reconcile_required',
      'merge_observed',
      'completed',
      'stale'
    )),
	CONSTRAINT "artifact_shipments_candidate_hash_check" CHECK ("issue_artifact_director_shipments"."candidate_sha256" ~ '^[0-9a-f]{64}$' and "issue_artifact_director_shipments"."policy_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "artifact_shipments_revision_check" CHECK ("issue_artifact_director_shipments"."artifact_revision" ~ '^[0-9a-f]{40,64}$'
        and "issue_artifact_director_shipments"."artifact_locator_fingerprint" ~ '^[0-9a-f]{64}$'
        and ("issue_artifact_director_shipments"."merge_commit_sha" is null or "issue_artifact_director_shipments"."merge_commit_sha" ~ '^[0-9a-f]{40,64}$')),
	CONSTRAINT "artifact_shipments_provider_check" CHECK ("issue_artifact_director_shipments"."provider" = 'github' and "issue_artifact_director_shipments"."merge_method" = 'merge'),
	CONSTRAINT "artifact_shipments_actor_source_check" CHECK (
      "issue_artifact_director_shipments"."reviewer_actor_source" in ('agent_key', 'agent_jwt')
      and "issue_artifact_director_shipments"."director_actor_source" in ('local_implicit', 'session', 'board_key', 'cloud_tenant')
    ),
	CONSTRAINT "artifact_shipments_attempt_count_check" CHECK ("issue_artifact_director_shipments"."attempt_count" >= 0),
	CONSTRAINT "artifact_shipments_lease_shape_check" CHECK ((
        "issue_artifact_director_shipments"."state" = 'merge_in_flight'
        and "issue_artifact_director_shipments"."lease_token" is not null
        and "issue_artifact_director_shipments"."lease_expires_at" is not null
        and "issue_artifact_director_shipments"."attempt_count" > 0
        and "issue_artifact_director_shipments"."merge_attempted_at" is not null
      ) or (
        "issue_artifact_director_shipments"."state" <> 'merge_in_flight'
        and "issue_artifact_director_shipments"."lease_token" is null
        and "issue_artifact_director_shipments"."lease_expires_at" is null
      )),
	CONSTRAINT "artifact_shipments_retry_shape_check" CHECK (
      "issue_artifact_director_shipments"."state" <> 'reconcile_required'
      or (
        "issue_artifact_director_shipments"."attempt_count" > 0
        and "issue_artifact_director_shipments"."merge_attempted_at" is not null
        and "issue_artifact_director_shipments"."next_attempt_at" is not null
        and "issue_artifact_director_shipments"."last_error_code" is not null
        and "issue_artifact_director_shipments"."last_error_at" is not null
      )
    ),
	CONSTRAINT "artifact_shipments_candidate_snapshot_check" CHECK (
      "issue_artifact_director_shipments"."candidate_snapshot" ->> 'candidateSha256' is not distinct from "issue_artifact_director_shipments"."candidate_sha256"
      and "issue_artifact_director_shipments"."candidate_snapshot" ->> 'policySha256' is not distinct from "issue_artifact_director_shipments"."policy_sha256"
      and "issue_artifact_director_shipments"."candidate_snapshot" -> 'issue' ->> 'id' is not distinct from "issue_artifact_director_shipments"."issue_id"::text
      and "issue_artifact_director_shipments"."candidate_snapshot" -> 'review' ->> 'decisionId' is not distinct from "issue_artifact_director_shipments"."review_decision_id"::text
      and "issue_artifact_director_shipments"."candidate_snapshot" -> 'review' ->> 'reviewCycleId' is not distinct from "issue_artifact_director_shipments"."review_cycle_id"::text
      and "issue_artifact_director_shipments"."candidate_snapshot" -> 'review' ->> 'workProductId' is not distinct from "issue_artifact_director_shipments"."artifact_work_product_id"::text
      and "issue_artifact_director_shipments"."candidate_snapshot" -> 'review' ->> 'headSha' is not distinct from "issue_artifact_director_shipments"."artifact_revision"
      and "issue_artifact_director_shipments"."candidate_snapshot" -> 'review' ->> 'locatorFingerprint' is not distinct from "issue_artifact_director_shipments"."artifact_locator_fingerprint"
      and "issue_artifact_director_shipments"."candidate_snapshot" -> 'review' ->> 'reviewerActorSource' is not distinct from "issue_artifact_director_shipments"."reviewer_actor_source"
      and "issue_artifact_director_shipments"."candidate_snapshot" -> 'artifact' ->> 'headSha' is not distinct from "issue_artifact_director_shipments"."artifact_revision"
      and "issue_artifact_director_shipments"."candidate_snapshot" -> 'director' ->> 'userId' is not distinct from "issue_artifact_director_shipments"."director_user_id_snapshot"
      and "issue_artifact_director_shipments"."candidate_snapshot" -> 'director' ->> 'actorSource' is not distinct from "issue_artifact_director_shipments"."director_actor_source"
      and "issue_artifact_director_shipments"."review_evidence_snapshot" is not distinct from "issue_artifact_director_shipments"."candidate_snapshot" -> 'review'
      and "issue_artifact_director_shipments"."artifact_snapshot" is not distinct from "issue_artifact_director_shipments"."candidate_snapshot" -> 'artifact'
      and "issue_artifact_director_shipments"."director_snapshot" is not distinct from "issue_artifact_director_shipments"."candidate_snapshot" -> 'director'
    ),
	CONSTRAINT "artifact_shipments_terminal_shape_check" CHECK ((
      "issue_artifact_director_shipments"."state" = 'completed'
      and "issue_artifact_director_shipments"."approval_decision_id" is not null
      and "issue_artifact_director_shipments"."provider_observed_at" is not null
      and "issue_artifact_director_shipments"."merge_commit_sha" is not null
      and "issue_artifact_director_shipments"."completion_receipt" is not null
      and "issue_artifact_director_shipments"."completed_issue_updated_at" is not null
      and "issue_artifact_director_shipments"."completed_at" is not null
      and "issue_artifact_director_shipments"."stale_at" is null
      and "issue_artifact_director_shipments"."lease_token" is null
    ) or (
      "issue_artifact_director_shipments"."state" = 'stale'
      and "issue_artifact_director_shipments"."stale_at" is not null
      and "issue_artifact_director_shipments"."approval_decision_id" is null
      and "issue_artifact_director_shipments"."completion_receipt" is null
      and "issue_artifact_director_shipments"."completed_at" is null
      and "issue_artifact_director_shipments"."lease_token" is null
    ) or (
      "issue_artifact_director_shipments"."state" not in ('completed', 'stale')
      and "issue_artifact_director_shipments"."approval_decision_id" is null
      and "issue_artifact_director_shipments"."completion_receipt" is null
      and "issue_artifact_director_shipments"."completed_at" is null
      and "issue_artifact_director_shipments"."stale_at" is null
    )),
	CONSTRAINT "artifact_shipments_observation_shape_check" CHECK (
      "issue_artifact_director_shipments"."state" not in ('merge_observed', 'completed')
      or (
        "issue_artifact_director_shipments"."provider_request_started_at" is not null
        and "issue_artifact_director_shipments"."provider_observed_at" is not null
        and "issue_artifact_director_shipments"."merge_commit_sha" is not null
      )
    ),
	CONSTRAINT "artifact_shipments_provider_request_shape_check" CHECK (
      "issue_artifact_director_shipments"."provider_request_started_at" is null
      or (
        "issue_artifact_director_shipments"."attempt_count" > 0
        and "issue_artifact_director_shipments"."merge_attempted_at" is not null
      )
    ),
	CONSTRAINT "artifact_shipments_completion_receipt_check" CHECK (
      "issue_artifact_director_shipments"."completion_receipt" is null
      or (
        "issue_artifact_director_shipments"."completion_receipt" ->> 'version' = '1'
        and "issue_artifact_director_shipments"."completion_receipt" ->> 'shipmentId' is not distinct from "issue_artifact_director_shipments"."id"::text
        and "issue_artifact_director_shipments"."completion_receipt" ->> 'issueId' is not distinct from "issue_artifact_director_shipments"."issue_id"::text
        and "issue_artifact_director_shipments"."completion_receipt" ->> 'reviewDecisionId' is not distinct from "issue_artifact_director_shipments"."review_decision_id"::text
        and "issue_artifact_director_shipments"."completion_receipt" ->> 'reviewCycleId' is not distinct from "issue_artifact_director_shipments"."review_cycle_id"::text
        and "issue_artifact_director_shipments"."completion_receipt" ->> 'policySha256' is not distinct from "issue_artifact_director_shipments"."policy_sha256"
        and "issue_artifact_director_shipments"."completion_receipt" ->> 'approvalDecisionId' is not distinct from "issue_artifact_director_shipments"."approval_decision_id"::text
        and "issue_artifact_director_shipments"."completion_receipt" ->> 'workProductId' is not distinct from "issue_artifact_director_shipments"."artifact_work_product_id"::text
        and "issue_artifact_director_shipments"."completion_receipt" ->> 'artifactRevision' is not distinct from "issue_artifact_director_shipments"."artifact_revision"
        and "issue_artifact_director_shipments"."completion_receipt" ->> 'locatorFingerprint' is not distinct from "issue_artifact_director_shipments"."artifact_locator_fingerprint"
        and "issue_artifact_director_shipments"."completion_receipt" ->> 'canonicalRef' is not distinct from "issue_artifact_director_shipments"."artifact_snapshot" ->> 'canonicalRef'
        and "issue_artifact_director_shipments"."completion_receipt" ->> 'provider' is not distinct from "issue_artifact_director_shipments"."provider"
        and "issue_artifact_director_shipments"."completion_receipt" ->> 'mergeMethod' is not distinct from "issue_artifact_director_shipments"."merge_method"
        and "issue_artifact_director_shipments"."completion_receipt" ->> 'mergeCommitSha' is not distinct from "issue_artifact_director_shipments"."merge_commit_sha"
        and "issue_artifact_director_shipments"."completion_receipt" ->> 'directorUserId' is not distinct from "issue_artifact_director_shipments"."director_user_id_snapshot"
        and "issue_artifact_director_shipments"."completion_receipt" ->> 'reviewerActorSource' is not distinct from "issue_artifact_director_shipments"."reviewer_actor_source"
        and "issue_artifact_director_shipments"."completion_receipt" ->> 'directorActorSource' is not distinct from "issue_artifact_director_shipments"."director_actor_source"
        and ("issue_artifact_director_shipments"."completion_receipt" ->> 'providerObservedAt')::timestamptz is not distinct from "issue_artifact_director_shipments"."provider_observed_at"
        and ("issue_artifact_director_shipments"."completion_receipt" ->> 'completedAt')::timestamptz is not distinct from "issue_artifact_director_shipments"."completed_at"
        and ("issue_artifact_director_shipments"."completion_receipt" ->> 'completedIssueUpdatedAt')::timestamptz is not distinct from "issue_artifact_director_shipments"."completed_issue_updated_at"
      )
    )
);
--> statement-breakpoint
CREATE UNIQUE INDEX "issue_execution_decisions_scoped_identity_uq" ON "issue_execution_decisions" USING btree ("id","company_id","issue_id");--> statement-breakpoint
ALTER TABLE "issue_artifact_director_shipments" ADD CONSTRAINT "issue_artifact_director_shipments_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_artifact_director_shipments" ADD CONSTRAINT "artifact_shipments_issue_scope_fk" FOREIGN KEY ("issue_id","company_id") REFERENCES "public"."issues"("id","company_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_artifact_director_shipments" ADD CONSTRAINT "artifact_shipments_review_decision_scope_fk" FOREIGN KEY ("review_decision_id","company_id","issue_id") REFERENCES "public"."issue_execution_decisions"("id","company_id","issue_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_artifact_director_shipments" ADD CONSTRAINT "artifact_shipments_approval_decision_scope_fk" FOREIGN KEY ("approval_decision_id","company_id","issue_id") REFERENCES "public"."issue_execution_decisions"("id","company_id","issue_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_artifact_director_shipments" ADD CONSTRAINT "artifact_shipments_work_product_scope_fk" FOREIGN KEY ("artifact_work_product_id","company_id","issue_id") REFERENCES "public"."issue_work_products"("id","company_id","issue_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "artifact_shipments_company_issue_idempotency_uq" ON "issue_artifact_director_shipments" USING btree ("company_id","issue_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "artifact_shipments_company_issue_candidate_uq" ON "issue_artifact_director_shipments" USING btree ("company_id","issue_id","candidate_sha256");--> statement-breakpoint
CREATE UNIQUE INDEX "artifact_shipments_company_issue_review_cycle_uq" ON "issue_artifact_director_shipments" USING btree ("company_id","issue_id","review_cycle_id");--> statement-breakpoint
CREATE INDEX "artifact_shipments_reconciliation_keyset_idx" ON "issue_artifact_director_shipments" USING btree ("next_attempt_at","id") WHERE "issue_artifact_director_shipments"."state" = 'reconcile_required';--> statement-breakpoint
CREATE INDEX "artifact_shipments_lease_expiry_keyset_idx" ON "issue_artifact_director_shipments" USING btree ("lease_expires_at","id") WHERE "issue_artifact_director_shipments"."state" = 'merge_in_flight';--> statement-breakpoint
CREATE INDEX "artifact_shipments_merge_observed_keyset_idx" ON "issue_artifact_director_shipments" USING btree ("id") WHERE "issue_artifact_director_shipments"."state" = 'merge_observed';--> statement-breakpoint
CREATE INDEX "artifact_shipments_company_issue_created_idx" ON "issue_artifact_director_shipments" USING btree ("company_id","issue_id","created_at");--> statement-breakpoint
CREATE INDEX "artifact_shipments_review_decision_idx" ON "issue_artifact_director_shipments" USING btree ("review_decision_id");--> statement-breakpoint
CREATE INDEX "artifact_shipments_approval_decision_idx" ON "issue_artifact_director_shipments" USING btree ("approval_decision_id");
