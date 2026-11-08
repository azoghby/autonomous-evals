CREATE TABLE "plan_purchases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid,
	"email" text NOT NULL,
	"kind" text NOT NULL,
	"product" text NOT NULL,
	"interval" text,
	"amount_cents" integer NOT NULL,
	"currency" text DEFAULT 'usd' NOT NULL,
	"environment" "environment" NOT NULL,
	"stripe_checkout_session_id" text NOT NULL,
	"stripe_subscription_id" text,
	"stripe_customer_id" text,
	"status" text DEFAULT 'paid' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sales_leads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"work_email" text NOT NULL,
	"company" text NOT NULL,
	"agent_description" text NOT NULL,
	"volume" text NOT NULL,
	"status" text DEFAULT 'new' NOT NULL,
	"source" text DEFAULT 'contact_sales' NOT NULL,
	"ip_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "plan" text DEFAULT 'developer' NOT NULL;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "plan_interval" text;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "plan_status" text;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "stripe_customer_id" text;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "stripe_subscription_id" text;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "plan_current_period_end" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "plan_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "plan_purchases" ADD CONSTRAINT "plan_purchases_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "plan_purchases_session_uq" ON "plan_purchases" USING btree ("stripe_checkout_session_id");--> statement-breakpoint
CREATE INDEX "plan_purchases_customer_idx" ON "plan_purchases" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "sales_leads_created_idx" ON "sales_leads" USING btree ("created_at");