CREATE TABLE "email_threads" (
	"thread_id" text PRIMARY KEY NOT NULL,
	"job_id" uuid,
	"expert_engagement_id" uuid,
	"purpose" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "email_threads" ADD CONSTRAINT "email_threads_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_threads" ADD CONSTRAINT "email_threads_expert_engagement_id_expert_engagements_id_fk" FOREIGN KEY ("expert_engagement_id") REFERENCES "public"."expert_engagements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "email_threads_job_idx" ON "email_threads" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "email_threads_engagement_idx" ON "email_threads" USING btree ("expert_engagement_id");