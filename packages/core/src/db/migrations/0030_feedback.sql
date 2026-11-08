CREATE TABLE "feedback_invites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token" text NOT NULL,
	"email" text NOT NULL,
	"name" text,
	"org" text NOT NULL,
	"source_url" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"message_id" text,
	"thread_id" text,
	"sent_at" timestamp with time zone,
	"reply_text" text,
	"replied_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "feedback_responses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invite_id" uuid,
	"would_use" text NOT NULL,
	"must_have" text,
	"price_per_month" text,
	"quote" text,
	"quote_consent" boolean DEFAULT false NOT NULL,
	"name" text,
	"company" text,
	"ip_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "feedback_responses" ADD CONSTRAINT "feedback_responses_invite_id_feedback_invites_id_fk" FOREIGN KEY ("invite_id") REFERENCES "public"."feedback_invites"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "feedback_invites_token_uq" ON "feedback_invites" USING btree ("token");--> statement-breakpoint
CREATE UNIQUE INDEX "feedback_invites_email_uq" ON "feedback_invites" USING btree (lower("email"));--> statement-breakpoint
CREATE UNIQUE INDEX "feedback_responses_invite_uq" ON "feedback_responses" USING btree ("invite_id");--> statement-breakpoint
CREATE INDEX "feedback_responses_created_idx" ON "feedback_responses" USING btree ("created_at");