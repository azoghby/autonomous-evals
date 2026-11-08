CREATE TABLE "founder_email_threads" (
	"thread_id" text PRIMARY KEY NOT NULL,
	"approval_id" uuid,
	"kind" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "founder_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"body" text NOT NULL,
	"thread_id" text NOT NULL,
	"message_id" text NOT NULL,
	"approval_seq" integer,
	"reported_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "founder_email_threads" ADD CONSTRAINT "founder_email_threads_approval_id_founder_approvals_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."founder_approvals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "founder_notes_message_uq" ON "founder_notes" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "founder_notes_created_idx" ON "founder_notes" USING btree ("created_at");