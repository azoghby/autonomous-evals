CREATE TABLE "founder_approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seq" serial NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"summary" text NOT NULL,
	"ref" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"decided_via" text,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"result" text,
	"expires_at" timestamp with time zone,
	"channel_refs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "founder_notify_settings" (
	"id" text PRIMARY KEY NOT NULL,
	"telegram_chat_id" text,
	"telegram_link_code_hash" text,
	"telegram_link_code_expires_at" timestamp with time zone,
	"whatsapp_to" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "founder_approvals_kind_ref_uq" ON "founder_approvals" USING btree ("kind","ref");--> statement-breakpoint
CREATE UNIQUE INDEX "founder_approvals_seq_uq" ON "founder_approvals" USING btree ("seq");--> statement-breakpoint
CREATE INDEX "founder_approvals_status_idx" ON "founder_approvals" USING btree ("status","created_at");