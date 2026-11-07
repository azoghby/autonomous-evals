CREATE TABLE "remediations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"finding_row_id" uuid NOT NULL,
	"data" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "remediations" ADD CONSTRAINT "remediations_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "remediations" ADD CONSTRAINT "remediations_finding_row_id_findings_id_fk" FOREIGN KEY ("finding_row_id") REFERENCES "public"."findings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "remediations_job_idx" ON "remediations" USING btree ("job_id");--> statement-breakpoint
CREATE UNIQUE INDEX "remediations_finding_uq" ON "remediations" USING btree ("finding_row_id");