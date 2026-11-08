CREATE TABLE "usage_warnings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"threshold" integer NOT NULL,
	"plan" text NOT NULL,
	"trials_used" integer NOT NULL,
	"included_trials" integer NOT NULL,
	"status" text DEFAULT 'sent' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "plan_trial_end" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "usage_warnings" ADD CONSTRAINT "usage_warnings_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "usage_warnings_customer_period_threshold_uq" ON "usage_warnings" USING btree ("customer_id","period_start","threshold");