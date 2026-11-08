CREATE TABLE "follow_ups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "monitoring_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subscription_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"run_date" text NOT NULL,
	"ran_at" timestamp with time zone DEFAULT now() NOT NULL,
	"results" jsonb NOT NULL,
	"regressions" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "monitoring_runs" ADD CONSTRAINT "monitoring_runs_subscription_id_monitoring_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."monitoring_subscriptions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitoring_runs" ADD CONSTRAINT "monitoring_runs_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "follow_ups_subject_kind_uq" ON "follow_ups" USING btree ("subject_type","subject_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "monitoring_runs_sub_day_uq" ON "monitoring_runs" USING btree ("subscription_id","run_date");--> statement-breakpoint
CREATE INDEX "monitoring_runs_sub_idx" ON "monitoring_runs" USING btree ("subscription_id");