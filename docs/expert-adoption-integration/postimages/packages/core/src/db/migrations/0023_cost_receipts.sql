-- Existing rows are deliberately not backfilled or deleted. Inventory/reconcile legacy Naive
-- receipts before activation; the sink refuses matching unkeyed historical receipts.
ALTER TABLE "costs" ADD COLUMN "receipt_key" text;
--> statement-breakpoint
ALTER TABLE "costs" ADD COLUMN "receipt_identity" jsonb;
--> statement-breakpoint
CREATE UNIQUE INDEX "costs_provider_receipt_uq" ON "costs" USING btree ("source","receipt_key") WHERE "costs"."receipt_key" is not null;
