CREATE TABLE "github_prs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"remediation_id" uuid NOT NULL,
	"branch" text NOT NULL,
	"pr_number" integer NOT NULL,
	"pr_url" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_github_targets" (
	"job_id" uuid PRIMARY KEY NOT NULL,
	"owner" text NOT NULL,
	"repo" text NOT NULL,
	"base_branch" text NOT NULL,
	"file_path" text NOT NULL,
	"token_ciphertext" text NOT NULL,
	"token_expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "github_prs" ADD CONSTRAINT "github_prs_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_prs" ADD CONSTRAINT "github_prs_remediation_id_remediations_id_fk" FOREIGN KEY ("remediation_id") REFERENCES "public"."remediations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_github_targets" ADD CONSTRAINT "job_github_targets_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "github_prs_remediation_uq" ON "github_prs" USING btree ("remediation_id");--> statement-breakpoint
CREATE INDEX "github_prs_job_idx" ON "github_prs" USING btree ("job_id");