CREATE TABLE "owner_email_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_email" text NOT NULL,
	"agent_id" uuid,
	"kind" text NOT NULL,
	"transactional" boolean NOT NULL,
	"message_id" text,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "public_agent_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"purpose" text DEFAULT 'verify' NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "email_threads" ADD COLUMN "public_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "outreach_drafts" ADD COLUMN "kind" text DEFAULT 'expert_invite' NOT NULL;--> statement-breakpoint
ALTER TABLE "public_agents" ADD COLUMN "owner_email" text;--> statement-breakpoint
ALTER TABLE "public_agents" ADD COLUMN "visibility" text DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE "public_agents" ADD COLUMN "status" text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "public_agents" ADD COLUMN "api_key_ciphertext" text;--> statement-breakpoint
ALTER TABLE "public_agents" ADD COLUMN "consent" jsonb;--> statement-breakpoint
ALTER TABLE "public_agents" ADD COLUMN "verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "public_agents" ADD COLUMN "rerun_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "owner_email_log" ADD CONSTRAINT "owner_email_log_agent_id_public_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."public_agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "public_agent_tokens" ADD CONSTRAINT "public_agent_tokens_agent_id_public_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."public_agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "owner_email_log_owner_sent_idx" ON "owner_email_log" USING btree ("owner_email","sent_at");--> statement-breakpoint
CREATE UNIQUE INDEX "public_agent_tokens_hash_uq" ON "public_agent_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "public_agent_tokens_agent_idx" ON "public_agent_tokens" USING btree ("agent_id");--> statement-breakpoint
ALTER TABLE "email_threads" ADD CONSTRAINT "email_threads_public_agent_id_public_agents_id_fk" FOREIGN KEY ("public_agent_id") REFERENCES "public"."public_agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "public_agents_owner_idx" ON "public_agents" USING btree (lower("owner_email"));