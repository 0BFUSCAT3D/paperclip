ALTER TABLE "decision_queue_items" DROP CONSTRAINT "decision_queue_items_queue_company_fk";--> statement-breakpoint
DROP INDEX "decision_queues_id_company_uq";--> statement-breakpoint
ALTER TABLE "decision_queues" ADD CONSTRAINT "decision_queues_id_company_uq" UNIQUE("id","company_id");--> statement-breakpoint
ALTER TABLE "decision_queue_items" ADD CONSTRAINT "decision_queue_items_queue_company_fk" FOREIGN KEY ("queue_id","company_id") REFERENCES "public"."decision_queues"("id","company_id") ON DELETE cascade ON UPDATE no action;
