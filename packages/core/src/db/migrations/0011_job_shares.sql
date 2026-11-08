CREATE TABLE "job_shares" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "job_shares" ADD CONSTRAINT "job_shares_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "job_shares_job_uq" ON "job_shares" USING btree ("job_id");--> statement-breakpoint
CREATE UNIQUE INDEX "job_shares_token_uq" ON "job_shares" USING btree ("token_hash");