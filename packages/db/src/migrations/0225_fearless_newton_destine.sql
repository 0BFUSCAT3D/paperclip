CREATE TABLE "governed_issue_reservations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"issue_id" uuid NOT NULL,
	"contract_version" integer DEFAULT 1 NOT NULL,
	"envelope_sha256" text NOT NULL,
	"envelope" jsonb NOT NULL,
	"reserved_issue_snapshot" jsonb NOT NULL,
	"reserved_issue_updated_at" timestamp with time zone NOT NULL,
	"activation_sha256" text,
	"builder_agent_id" uuid,
	"activated_at" timestamp with time zone,
	"activated_issue_updated_at" timestamp with time zone,
	"wakeup_request_id" uuid,
	"heartbeat_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "governed_issue_reservations" ADD CONSTRAINT "governed_issue_reservations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "governed_issue_reservations" ADD CONSTRAINT "governed_issue_reservations_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "governed_issue_reservations" ADD CONSTRAINT "governed_issue_reservations_builder_agent_id_agents_id_fk" FOREIGN KEY ("builder_agent_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "governed_issue_reservations" ADD CONSTRAINT "governed_issue_reservations_wakeup_request_id_agent_wakeup_requests_id_fk" FOREIGN KEY ("wakeup_request_id") REFERENCES "public"."agent_wakeup_requests"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "governed_issue_reservations" ADD CONSTRAINT "governed_issue_reservations_heartbeat_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("heartbeat_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "governed_issue_reservations_company_key_uq" ON "governed_issue_reservations" USING btree ("company_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "governed_issue_reservations_issue_uq" ON "governed_issue_reservations" USING btree ("issue_id");--> statement-breakpoint
CREATE INDEX "governed_issue_reservations_builder_idx" ON "governed_issue_reservations" USING btree ("builder_agent_id");--> statement-breakpoint
CREATE INDEX "governed_issue_reservations_company_created_idx" ON "governed_issue_reservations" USING btree ("company_id","created_at");--> statement-breakpoint
-- paperclip:migration-safety-ignore large-create-index-not-concurrently: The new versioned prefix has no historical rows, and this partial uniqueness guard must land atomically with the receipt table used by activation.
CREATE UNIQUE INDEX "agent_wakeup_requests_governed_activation_idempotency_uq" ON "agent_wakeup_requests" USING btree ("company_id","idempotency_key") WHERE "agent_wakeup_requests"."idempotency_key" LIKE 'governed_issue_activation:v1:%';
