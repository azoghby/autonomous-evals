CREATE TABLE "public_agent_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"suite_version" text NOT NULL,
	"ran_at" timestamp with time zone DEFAULT now() NOT NULL,
	"passed" integer NOT NULL,
	"total" integer NOT NULL,
	"by_category" jsonb NOT NULL,
	"findings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cost_micro_usd" bigint DEFAULT 0 NOT NULL,
	"job_id" uuid
);
--> statement-breakpoint
CREATE TABLE "public_agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"vendor" text NOT NULL,
	"kind" text DEFAULT 'third_party' NOT NULL,
	"endpoint_url" text NOT NULL,
	"model" text NOT NULL,
	"auth_env_var" text,
	"system_prompt" text,
	"homepage" text,
	"terms_url" text,
	"authorized_note" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "public_agent_runs" ADD CONSTRAINT "public_agent_runs_agent_id_public_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."public_agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "public_agent_runs_agent_ran_idx" ON "public_agent_runs" USING btree ("agent_id","ran_at");--> statement-breakpoint
CREATE UNIQUE INDEX "public_agents_slug_uq" ON "public_agents" USING btree ("slug");