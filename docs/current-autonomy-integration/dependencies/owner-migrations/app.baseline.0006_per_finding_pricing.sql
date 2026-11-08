ALTER TABLE "payments" ADD COLUMN "status" text DEFAULT 'paid' NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "captured_amount_cents" integer;--> statement-breakpoint
ALTER TABLE "quotes" ADD COLUMN "pricing_mode" text DEFAULT 'fixed' NOT NULL;--> statement-breakpoint
ALTER TABLE "quotes" ADD COLUMN "cap_cents" integer;