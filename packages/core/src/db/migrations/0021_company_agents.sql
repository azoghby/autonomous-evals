-- Idempotent: first applied on the shared DB as 0019_company_agents, before 0019_founder_approvals and 0020_founder_email landed on main.
CREATE TABLE IF NOT EXISTS "company_agent_activity" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" text NOT NULL,
	"trigger" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"summary" text,
	"public_summary" text,
	"counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"cost_micro_usd" bigint DEFAULT 0 NOT NULL,
	"budget_micro_usd" bigint DEFAULT 0 NOT NULL,
	"error" text,
	"dry_run" boolean DEFAULT false NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "company_agent_settings" (
	"agent_id" text PRIMARY KEY NOT NULL,
	"enabled" boolean NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "company_plans" (
	"plan_date" text PRIMARY KEY NOT NULL,
	"summary" text NOT NULL,
	"metrics" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"activity_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "company_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plan_date" text NOT NULL,
	"assignee" text NOT NULL,
	"title" text NOT NULL,
	"rationale" text DEFAULT '' NOT NULL,
	"priority" integer DEFAULT 3 NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"activity_id" uuid,
	"created_by" text DEFAULT 'planner' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "market_briefs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"brief_date" text NOT NULL,
	"activity_id" uuid,
	"brief" jsonb NOT NULL,
	"sources" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cost_micro_usd" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "onboarding_conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"thread_id" text,
	"status" text DEFAULT 'collecting' NOT NULL,
	"collected" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"transcript" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"environment_id" text,
	"suite_id" text,
	"run_id" text,
	"reported_at" timestamp with time zone,
	"cost_micro_usd" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "prospect_leads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"domain" text NOT NULL,
	"company" text NOT NULL,
	"segment" text NOT NULL,
	"agent_description" text NOT NULL,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"fit_score" integer NOT NULL,
	"fit_reason" text DEFAULT '' NOT NULL,
	"recommended_plan" text NOT NULL,
	"contact_email" text,
	"contact_name" text,
	"contact_role" text,
	"contact_source" text,
	"status" text DEFAULT 'new' NOT NULL,
	"outreach_draft_id" uuid,
	"activity_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "company_plans" ADD CONSTRAINT "company_plans_activity_id_company_agent_activity_id_fk" FOREIGN KEY ("activity_id") REFERENCES "public"."company_agent_activity"("id") ON DELETE set null ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "company_tasks" ADD CONSTRAINT "company_tasks_activity_id_company_agent_activity_id_fk" FOREIGN KEY ("activity_id") REFERENCES "public"."company_agent_activity"("id") ON DELETE set null ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "market_briefs" ADD CONSTRAINT "market_briefs_activity_id_company_agent_activity_id_fk" FOREIGN KEY ("activity_id") REFERENCES "public"."company_agent_activity"("id") ON DELETE set null ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "onboarding_conversations" ADD CONSTRAINT "onboarding_conversations_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "prospect_leads" ADD CONSTRAINT "prospect_leads_outreach_draft_id_outreach_drafts_id_fk" FOREIGN KEY ("outreach_draft_id") REFERENCES "public"."outreach_drafts"("id") ON DELETE set null ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "prospect_leads" ADD CONSTRAINT "prospect_leads_activity_id_company_agent_activity_id_fk" FOREIGN KEY ("activity_id") REFERENCES "public"."company_agent_activity"("id") ON DELETE set null ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "company_agent_activity_agent_idx" ON "company_agent_activity" USING btree ("agent_id","started_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "company_agent_activity_started_idx" ON "company_agent_activity" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "company_tasks_plan_idx" ON "company_tasks" USING btree ("plan_date","assignee");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "market_briefs_date_uq" ON "market_briefs" USING btree ("brief_date");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "onboarding_conversations_customer_idx" ON "onboarding_conversations" USING btree ("customer_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "onboarding_conversations_thread_uq" ON "onboarding_conversations" USING btree ("thread_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "prospect_leads_domain_uq" ON "prospect_leads" USING btree ("domain");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "prospect_leads_status_idx" ON "prospect_leads" USING btree ("status","fit_score");