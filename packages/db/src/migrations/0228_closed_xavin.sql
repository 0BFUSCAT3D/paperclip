CREATE TABLE "heartbeat_run_execution_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"issue_id" uuid,
	"binding_version" integer NOT NULL,
	"agent_execution_profile_revision" bigint NOT NULL,
	"issue_assignee_profile_revision" bigint,
	"digest" text NOT NULL,
	"attempt_token" uuid DEFAULT gen_random_uuid() NOT NULL,
	"projection" jsonb NOT NULL,
	"authority_identity" jsonb NOT NULL,
	"authority_fingerprint" text NOT NULL,
	"transition_kind" text NOT NULL,
	"transition_reason" text NOT NULL,
	"parent_run_id" uuid,
	"parent_profile_id" uuid,
	"validated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "execution_profile_revision" bigint DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "assignee_profile_revision" bigint DEFAULT 1 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "agents_scoped_identity_uq" ON "agents" USING btree ("id","company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "heartbeat_runs_scoped_identity_uq" ON "heartbeat_runs" USING btree ("id","company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "heartbeat_runs_scoped_agent_identity_uq" ON "heartbeat_runs" USING btree ("id","company_id","agent_id");--> statement-breakpoint
ALTER TABLE "heartbeat_run_execution_profiles" ADD CONSTRAINT "heartbeat_run_execution_profiles_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "heartbeat_run_execution_profiles" ADD CONSTRAINT "heartbeat_run_execution_profiles_run_scope_fk" FOREIGN KEY ("run_id","company_id","agent_id") REFERENCES "public"."heartbeat_runs"("id","company_id","agent_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "heartbeat_run_execution_profiles" ADD CONSTRAINT "heartbeat_run_execution_profiles_agent_scope_fk" FOREIGN KEY ("agent_id","company_id") REFERENCES "public"."agents"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "heartbeat_run_execution_profiles" ADD CONSTRAINT "heartbeat_run_execution_profiles_issue_scope_fk" FOREIGN KEY ("issue_id","company_id") REFERENCES "public"."issues"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "heartbeat_run_execution_profiles_run_uq" ON "heartbeat_run_execution_profiles" USING btree ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "heartbeat_run_execution_profiles_parent_identity_uq" ON "heartbeat_run_execution_profiles" USING btree ("id","run_id","company_id","agent_id");--> statement-breakpoint
ALTER TABLE "heartbeat_run_execution_profiles" ADD CONSTRAINT "heartbeat_run_execution_profiles_parent_scope_fk" FOREIGN KEY ("parent_profile_id","parent_run_id","company_id","agent_id") REFERENCES "public"."heartbeat_run_execution_profiles"("id","run_id","company_id","agent_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "heartbeat_run_execution_profiles" ADD CONSTRAINT "heartbeat_run_execution_profiles_transition_shape_check" CHECK ((
	"transition_kind" = 'fresh'
	AND "transition_reason" IN ('governed_activation', 'provider_quota_recovery', 'missing_comment_retry', 'bounded_retry', 'execution_review_recovery', 'assignment_recovery', 'continuation_recovery', 'normal_enqueue')
	AND "parent_run_id" IS NULL
	AND "parent_profile_id" IS NULL
) OR (
	"transition_kind" = 'preserve'
	AND "transition_reason" IN ('process_loss', 'deferred_promotion')
	AND "parent_run_id" IS NOT NULL
	AND "parent_profile_id" IS NOT NULL
	AND "parent_run_id" <> "run_id"
	AND "parent_profile_id" <> "id"
));--> statement-breakpoint
ALTER TABLE "heartbeat_run_execution_profiles" ADD CONSTRAINT "heartbeat_run_execution_profiles_binding_version_check" CHECK ("binding_version" = 1);--> statement-breakpoint
CREATE INDEX "heartbeat_run_execution_profiles_company_agent_idx" ON "heartbeat_run_execution_profiles" USING btree ("company_id","agent_id");--> statement-breakpoint
CREATE OR REPLACE FUNCTION bump_agent_execution_profile_revision()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF TG_OP = 'INSERT' THEN
		NEW."execution_profile_revision" := 1;
		RETURN NEW;
	END IF;
	IF ROW(
		NEW."role",
		NEW."capabilities",
		NEW."adapter_type",
		NEW."adapter_config",
		NEW."runtime_config",
		NEW."default_environment_id",
		NEW."permissions"
	) IS DISTINCT FROM ROW(
		OLD."role",
		OLD."capabilities",
		OLD."adapter_type",
		OLD."adapter_config",
		OLD."runtime_config",
		OLD."default_environment_id",
		OLD."permissions"
	) THEN
		NEW."execution_profile_revision" := OLD."execution_profile_revision" + 1;
	ELSE
		NEW."execution_profile_revision" := OLD."execution_profile_revision";
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "agents_bump_execution_profile_revision"
BEFORE INSERT OR UPDATE ON "agents"
FOR EACH ROW
EXECUTE FUNCTION bump_agent_execution_profile_revision();--> statement-breakpoint
CREATE OR REPLACE FUNCTION bump_issue_assignee_profile_revision()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF TG_OP = 'INSERT' THEN
		NEW."assignee_profile_revision" := 1;
		RETURN NEW;
	END IF;
	IF ROW(
		NEW."assignee_agent_id",
		NEW."assignee_user_id",
		NEW."assignee_adapter_overrides"
	) IS DISTINCT FROM ROW(
		OLD."assignee_agent_id",
		OLD."assignee_user_id",
		OLD."assignee_adapter_overrides"
	) THEN
		NEW."assignee_profile_revision" := OLD."assignee_profile_revision" + 1;
	ELSE
		NEW."assignee_profile_revision" := OLD."assignee_profile_revision";
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "issues_bump_assignee_profile_revision"
BEFORE INSERT OR UPDATE ON "issues"
FOR EACH ROW
EXECUTE FUNCTION bump_issue_assignee_profile_revision();--> statement-breakpoint
CREATE OR REPLACE FUNCTION enforce_heartbeat_run_execution_profile_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
	current_agent_revision bigint;
	current_issue_revision bigint;
	parent_profile "heartbeat_run_execution_profiles"%ROWTYPE;
BEGIN
	PERFORM 1
	FROM "heartbeat_runs"
	WHERE "id" = NEW."run_id"
		AND "company_id" = NEW."company_id"
		AND "agent_id" = NEW."agent_id"
	FOR KEY SHARE;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'execution profile run scope is invalid'
			USING ERRCODE = 'foreign_key_violation';
	END IF;

	IF NEW."transition_kind" = 'fresh' THEN
		SELECT "execution_profile_revision"
		INTO current_agent_revision
		FROM "agents"
		WHERE "id" = NEW."agent_id" AND "company_id" = NEW."company_id"
		FOR SHARE;
		IF NOT FOUND THEN
			RAISE EXCEPTION 'execution profile agent scope is invalid'
				USING ERRCODE = 'foreign_key_violation';
		END IF;
		IF NEW."agent_execution_profile_revision" IS DISTINCT FROM current_agent_revision THEN
			RAISE EXCEPTION 'execution profile agent revision is stale or forged'
				USING ERRCODE = 'check_violation';
		END IF;

		IF NEW."issue_id" IS NULL THEN
			IF NEW."issue_assignee_profile_revision" IS NOT NULL THEN
				RAISE EXCEPTION 'execution profile issue revision requires issue identity'
					USING ERRCODE = 'check_violation';
			END IF;
		ELSE
			SELECT "assignee_profile_revision"
			INTO current_issue_revision
			FROM "issues"
			WHERE "id" = NEW."issue_id" AND "company_id" = NEW."company_id"
			FOR SHARE;
			IF NOT FOUND THEN
				RAISE EXCEPTION 'execution profile issue scope is invalid'
					USING ERRCODE = 'foreign_key_violation';
			END IF;
			IF NEW."issue_assignee_profile_revision" IS NULL
				OR NEW."issue_assignee_profile_revision" IS DISTINCT FROM current_issue_revision THEN
				RAISE EXCEPTION 'execution profile issue revision is stale, forged, or missing'
					USING ERRCODE = 'check_violation';
			END IF;
		END IF;
	END IF;

	IF jsonb_typeof(NEW."authority_identity") IS DISTINCT FROM 'object'
		OR jsonb_typeof(NEW."authority_identity" -> 'profile') IS DISTINCT FROM 'object' THEN
		RAISE EXCEPTION 'execution profile authority identity requires an object profile'
			USING ERRCODE = 'check_violation';
	END IF;
	NEW."authority_identity" := jsonb_build_object(
		'schema', 'paperclip.execution-profile-authority',
		'version', 1,
		'companyId', NEW."company_id",
		'agentId', NEW."agent_id",
		'issueId', NEW."issue_id",
		'agentExecutionProfileRevision', NEW."agent_execution_profile_revision",
		'issueAssigneeProfileRevision', NEW."issue_assignee_profile_revision",
		'profile', NEW."authority_identity" -> 'profile'
	);
	NEW."authority_fingerprint" := encode(
		sha256(convert_to(NEW."authority_identity"::text, 'UTF8')),
		'hex'
	);

	IF NEW."transition_kind" = 'preserve' THEN
		SELECT *
		INTO parent_profile
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
		IF parent_profile."binding_version" IS DISTINCT FROM NEW."binding_version"
			OR parent_profile."agent_execution_profile_revision" IS DISTINCT FROM NEW."agent_execution_profile_revision"
			OR parent_profile."issue_id" IS DISTINCT FROM NEW."issue_id"
			OR parent_profile."issue_assignee_profile_revision" IS DISTINCT FROM NEW."issue_assignee_profile_revision"
			OR parent_profile."authority_identity" IS DISTINCT FROM NEW."authority_identity"
			OR parent_profile."authority_fingerprint" IS DISTINCT FROM NEW."authority_fingerprint" THEN
			RAISE EXCEPTION 'execution profile preserve authority does not match parent'
				USING ERRCODE = 'check_violation';
		END IF;
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "heartbeat_run_execution_profiles_enforce_insert"
BEFORE INSERT ON "heartbeat_run_execution_profiles"
FOR EACH ROW
EXECUTE FUNCTION enforce_heartbeat_run_execution_profile_insert();--> statement-breakpoint
CREATE OR REPLACE FUNCTION reject_heartbeat_run_execution_profile_authority_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF TG_OP = 'DELETE' THEN
		PERFORM 1
		FROM "heartbeat_runs"
		WHERE "id" = OLD."run_id"
			AND "company_id" = OLD."company_id"
			AND "agent_id" = OLD."agent_id";
		IF FOUND THEN
			RAISE EXCEPTION 'heartbeat run execution profile evidence is append-only'
				USING ERRCODE = 'check_violation';
		END IF;
		RETURN OLD;
	END IF;
	IF ROW(
		NEW."id",
		NEW."company_id",
		NEW."run_id",
		NEW."agent_id",
		NEW."issue_id",
		NEW."binding_version",
		NEW."agent_execution_profile_revision",
		NEW."issue_assignee_profile_revision",
		NEW."digest",
		NEW."attempt_token",
		NEW."projection",
		NEW."authority_identity",
		NEW."authority_fingerprint",
		NEW."transition_kind",
		NEW."transition_reason",
		NEW."parent_run_id",
		NEW."parent_profile_id",
		NEW."created_at"
	) IS DISTINCT FROM ROW(
		OLD."id",
		OLD."company_id",
		OLD."run_id",
		OLD."agent_id",
		OLD."issue_id",
		OLD."binding_version",
		OLD."agent_execution_profile_revision",
		OLD."issue_assignee_profile_revision",
		OLD."digest",
		OLD."attempt_token",
		OLD."projection",
		OLD."authority_identity",
		OLD."authority_fingerprint",
		OLD."transition_kind",
		OLD."transition_reason",
		OLD."parent_run_id",
		OLD."parent_profile_id",
		OLD."created_at"
	) THEN
		RAISE EXCEPTION 'heartbeat run execution profile authority is immutable'
			USING ERRCODE = 'check_violation';
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "heartbeat_run_execution_profiles_reject_authority_update"
BEFORE UPDATE OR DELETE ON "heartbeat_run_execution_profiles"
FOR EACH ROW
EXECUTE FUNCTION reject_heartbeat_run_execution_profile_authority_update();
