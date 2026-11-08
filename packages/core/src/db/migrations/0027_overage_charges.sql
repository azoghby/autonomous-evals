CREATE TABLE "overage_charges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"plan" text NOT NULL,
	"trials_used" integer NOT NULL,
	"included_trials" integer NOT NULL,
	"overage_trials" integer NOT NULL,
	"amount_cents" integer NOT NULL,
	"environment" "environment" NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"stripe_invoice_item_id" text,
	"error" text,
	"billed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "overage_charges" ADD CONSTRAINT "overage_charges_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "overage_charges_customer_period_uq" ON "overage_charges" USING btree ("customer_id","period_start");