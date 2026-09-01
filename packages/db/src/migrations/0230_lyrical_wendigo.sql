CREATE TABLE "governed_executor_launch_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"reservation_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"heartbeat_run_id" uuid NOT NULL,
	"execution_workspace_id" uuid NOT NULL,
	"connection_id" text NOT NULL,
	"lifecycle_id" text NOT NULL,
	"task_id" text NOT NULL,
	"cwd" text NOT NULL,
	"branch_name" text NOT NULL,
	"head_sha" text NOT NULL,
	"pid" integer NOT NULL,
	"start_token" text NOT NULL,
	"instance_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "governed_executor_launch_receipts_identity_check" CHECK ("governed_executor_launch_receipts"."pid" > 0 AND "governed_executor_launch_receipts"."start_token" ~ '^[0-9a-f]{64}$' AND "governed_executor_launch_receipts"."head_sha" ~ '^([0-9a-f]{40}|[0-9a-f]{64})$')
);
--> statement-breakpoint
ALTER TABLE "execution_workspaces" ADD COLUMN "custody_kind" text DEFAULT 'paperclip' NOT NULL;--> statement-breakpoint
ALTER TABLE "execution_workspaces" ADD COLUMN "external_connection_id" text;--> statement-breakpoint
ALTER TABLE "execution_workspaces" ADD COLUMN "external_lifecycle_id" text;--> statement-breakpoint
ALTER TABLE "execution_workspaces" ADD COLUMN "external_task_id" text;--> statement-breakpoint
ALTER TABLE "execution_workspaces" ADD COLUMN "prepared_identity_sha256" text;--> statement-breakpoint
ALTER TABLE "execution_workspaces" ADD COLUMN "authorized_start_head_sha" text;--> statement-breakpoint
ALTER TABLE "execution_workspaces" ADD COLUMN "repository_identity_sha256" text;--> statement-breakpoint
ALTER TABLE "execution_workspaces" ADD COLUMN "inspection_receipt_sha256" text;--> statement-breakpoint
ALTER TABLE "execution_workspaces" ADD COLUMN "external_root" text;--> statement-breakpoint
ALTER TABLE "execution_workspaces" ADD COLUMN "external_common_git_directory" text;--> statement-breakpoint
ALTER TABLE "governed_issue_reservations" ADD COLUMN "execution_workspace_id" uuid;--> statement-breakpoint
ALTER TABLE "governed_executor_launch_receipts" ADD CONSTRAINT "governed_executor_launch_receipts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "governed_executor_launch_receipts" ADD CONSTRAINT "governed_executor_launch_receipts_reservation_id_governed_issue_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."governed_issue_reservations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "governed_executor_launch_receipts" ADD CONSTRAINT "governed_executor_launch_receipts_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "governed_executor_launch_receipts" ADD CONSTRAINT "governed_executor_launch_receipts_heartbeat_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("heartbeat_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "governed_executor_launch_receipts" ADD CONSTRAINT "governed_executor_launch_receipts_execution_workspace_id_execution_workspaces_id_fk" FOREIGN KEY ("execution_workspace_id") REFERENCES "public"."execution_workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "governed_executor_launch_receipts_reservation_uq" ON "governed_executor_launch_receipts" USING btree ("reservation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "governed_executor_launch_receipts_run_uq" ON "governed_executor_launch_receipts" USING btree ("heartbeat_run_id");--> statement-breakpoint
CREATE INDEX "governed_executor_launch_receipts_company_created_idx" ON "governed_executor_launch_receipts" USING btree ("company_id","created_at");--> statement-breakpoint
ALTER TABLE "governed_issue_reservations" ADD CONSTRAINT "governed_issue_reservations_execution_workspace_id_execution_workspaces_id_fk" FOREIGN KEY ("execution_workspace_id") REFERENCES "public"."execution_workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "execution_workspaces_external_lifecycle_uq" ON "execution_workspaces" USING btree ("company_id","external_connection_id","external_lifecycle_id");--> statement-breakpoint
CREATE UNIQUE INDEX "governed_issue_reservations_execution_workspace_uq" ON "governed_issue_reservations" USING btree ("execution_workspace_id");