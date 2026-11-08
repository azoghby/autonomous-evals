CREATE TABLE "contact_suppressions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"reason" text DEFAULT 'opt_out' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "expert_engagements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"expert_id" uuid NOT NULL,
	"mode" text DEFAULT 'async' NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"scheduled_at" timestamp with time zone,
	"calendar_event_id" text,
	"recording_consent" boolean DEFAULT false NOT NULL,
	"honorarium_cents" integer DEFAULT 0 NOT NULL,
	"paid_at" timestamp with time zone,
	"outreach_draft_id" uuid,
	"status" text DEFAULT 'invited' NOT NULL,
	"answered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "expert_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid,
	"domain" text NOT NULL,
	"questions" jsonb NOT NULL,
	"purpose" text NOT NULL,
	"max_budget_cents" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"requested_by_agent_session" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "expert_responses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"engagement_id" uuid NOT NULL,
	"answers" jsonb NOT NULL,
	"transcript_blob_path" text,
	"insights" jsonb,
	"provenance" text DEFAULT 'expert_sourced' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "experts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"title" text NOT NULL,
	"organization" text,
	"domains" text[] DEFAULT '{}'::text[] NOT NULL,
	"profile_url" text,
	"source" text DEFAULT 'opt_in' NOT NULL,
	"rate_cents" integer,
	"availability" text,
	"consent_flags" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "expert_engagements" ADD CONSTRAINT "expert_engagements_request_id_expert_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."expert_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expert_engagements" ADD CONSTRAINT "expert_engagements_expert_id_experts_id_fk" FOREIGN KEY ("expert_id") REFERENCES "public"."experts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expert_engagements" ADD CONSTRAINT "expert_engagements_outreach_draft_id_outreach_drafts_id_fk" FOREIGN KEY ("outreach_draft_id") REFERENCES "public"."outreach_drafts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expert_requests" ADD CONSTRAINT "expert_requests_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expert_requests" ADD CONSTRAINT "expert_requests_requested_by_agent_session_agent_sessions_id_fk" FOREIGN KEY ("requested_by_agent_session") REFERENCES "public"."agent_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expert_responses" ADD CONSTRAINT "expert_responses_engagement_id_expert_engagements_id_fk" FOREIGN KEY ("engagement_id") REFERENCES "public"."expert_engagements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "contact_suppressions_email_uq" ON "contact_suppressions" USING btree (lower("email"));--> statement-breakpoint
CREATE UNIQUE INDEX "expert_engagements_token_uq" ON "expert_engagements" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "expert_engagements_req_expert_uq" ON "expert_engagements" USING btree ("request_id","expert_id");--> statement-breakpoint
CREATE INDEX "expert_engagements_expert_idx" ON "expert_engagements" USING btree ("expert_id");--> statement-breakpoint
CREATE INDEX "expert_requests_status_idx" ON "expert_requests" USING btree ("status");--> statement-breakpoint
CREATE INDEX "expert_responses_engagement_idx" ON "expert_responses" USING btree ("engagement_id");--> statement-breakpoint
CREATE UNIQUE INDEX "experts_email_uq" ON "experts" USING btree (lower("email"));