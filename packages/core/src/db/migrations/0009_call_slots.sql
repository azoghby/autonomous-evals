CREATE TABLE "call_slots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"duration_min" integer DEFAULT 15 NOT NULL,
	"taken_by_engagement_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "call_slots" ADD CONSTRAINT "call_slots_taken_by_engagement_id_expert_engagements_id_fk" FOREIGN KEY ("taken_by_engagement_id") REFERENCES "public"."expert_engagements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "call_slots_starts_at_uq" ON "call_slots" USING btree ("starts_at");--> statement-breakpoint
CREATE INDEX "call_slots_engagement_idx" ON "call_slots" USING btree ("taken_by_engagement_id");