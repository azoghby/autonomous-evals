CREATE TABLE "expert_automation_invitations" (
	"operation_id" text NOT NULL,
	"expert_id" uuid NOT NULL,
	"engagement_id" uuid NOT NULL,
	"draft_id" uuid NOT NULL,
	"invitation_digest" text NOT NULL,
	"promise_key" text,
	"amount_micro_usd" bigint NOT NULL,
	"promised" boolean DEFAULT false NOT NULL,
	"promise_day" date,
	"founder_approved_by" text,
	"send_state" text DEFAULT 'prepared' NOT NULL,
	"message_id" text,
	"thread_id" text,
	CONSTRAINT "expert_automation_invitations_operation_id_expert_id_pk" PRIMARY KEY("operation_id","expert_id"),
	CONSTRAINT "expert_automation_invitations_engagement_id_unique" UNIQUE("engagement_id"),
	CONSTRAINT "expert_automation_invitations_draft_id_unique" UNIQUE("draft_id"),
	CONSTRAINT "expert_automation_invitations_promise_key_unique" UNIQUE("promise_key"),
	CONSTRAINT "expert_automation_invitations_amount_micro_usd_check" CHECK (amount_micro_usd BETWEEN 0 AND 25000000),
	CONSTRAINT "expert_automation_invitations_send_state_check" CHECK (send_state IN ('prepared','claimed','sent'))
);
--> statement-breakpoint
CREATE TABLE "expert_automation_operations" (
	"operation_id" text PRIMARY KEY NOT NULL,
	"job_id" uuid NOT NULL,
	"task_id" text NOT NULL,
	"tenant_id" uuid NOT NULL,
	"request_hash" text NOT NULL,
	"request_id" uuid NOT NULL,
	"first_promise_day" date,
	CONSTRAINT "expert_automation_operations_request_id_unique" UNIQUE("request_id")
);
--> statement-breakpoint
CREATE TABLE "expert_automation_policies" (
	"id" text PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"job_cap_micro_usd" bigint NOT NULL,
	"daily_cap_micro_usd" bigint NOT NULL,
	CONSTRAINT "expert_automation_policies_job_cap_micro_usd_check" CHECK (job_cap_micro_usd=25000000),
	CONSTRAINT "expert_automation_policies_daily_cap_micro_usd_check" CHECK (daily_cap_micro_usd=50000000)
);
--> statement-breakpoint
CREATE TABLE "expert_automation_qualifications" (
	"expert_id" uuid NOT NULL,
	"topic" text NOT NULL,
	"qualified" boolean DEFAULT false NOT NULL,
	"evidence" jsonb NOT NULL,
	"allowed_uses" jsonb NOT NULL,
	"consent_receipt" text NOT NULL,
	"contribution_source" jsonb,
	CONSTRAINT "expert_automation_qualifications_expert_id_topic_pk" PRIMARY KEY("expert_id","topic")
);
--> statement-breakpoint
CREATE TABLE "expert_automation_response_bindings" (
	"operation_id" text NOT NULL,
	"engagement_id" uuid NOT NULL,
	"response_id" uuid NOT NULL,
	"response_digest" text NOT NULL,
	CONSTRAINT "expert_automation_response_bindings_operation_id_engagement_id_pk" PRIMARY KEY("operation_id","engagement_id")
);
--> statement-breakpoint
CREATE TABLE "expert_automation_scopes" (
	"job_id" uuid NOT NULL,
	"task_id" text NOT NULL,
	"tenant_id" uuid NOT NULL,
	"request_hash" text NOT NULL,
	"policy_id" text NOT NULL,
	"topic" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"customer_sharing_consent" boolean DEFAULT false NOT NULL,
	CONSTRAINT "expert_automation_scopes_job_id_task_id_pk" PRIMARY KEY("job_id","task_id")
);
--> statement-breakpoint
ALTER TABLE "expert_automation_invitations" ADD CONSTRAINT "expert_automation_invitations_operation_id_expert_automation_operations_operation_id_fk" FOREIGN KEY ("operation_id") REFERENCES "public"."expert_automation_operations"("operation_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expert_automation_invitations" ADD CONSTRAINT "expert_automation_invitations_expert_id_experts_id_fk" FOREIGN KEY ("expert_id") REFERENCES "public"."experts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expert_automation_invitations" ADD CONSTRAINT "expert_automation_invitations_engagement_id_expert_engagements_id_fk" FOREIGN KEY ("engagement_id") REFERENCES "public"."expert_engagements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expert_automation_invitations" ADD CONSTRAINT "expert_automation_invitations_draft_id_outreach_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."outreach_drafts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expert_automation_operations" ADD CONSTRAINT "expert_automation_operations_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expert_automation_operations" ADD CONSTRAINT "expert_automation_operations_tenant_id_customers_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expert_automation_operations" ADD CONSTRAINT "expert_automation_operations_request_id_expert_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."expert_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expert_automation_qualifications" ADD CONSTRAINT "expert_automation_qualifications_expert_id_experts_id_fk" FOREIGN KEY ("expert_id") REFERENCES "public"."experts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expert_automation_response_bindings" ADD CONSTRAINT "expert_automation_response_bindings_operation_id_expert_automation_operations_operation_id_fk" FOREIGN KEY ("operation_id") REFERENCES "public"."expert_automation_operations"("operation_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expert_automation_response_bindings" ADD CONSTRAINT "expert_automation_response_bindings_engagement_id_expert_engagements_id_fk" FOREIGN KEY ("engagement_id") REFERENCES "public"."expert_engagements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expert_automation_response_bindings" ADD CONSTRAINT "expert_automation_response_bindings_response_id_expert_responses_id_fk" FOREIGN KEY ("response_id") REFERENCES "public"."expert_responses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expert_automation_scopes" ADD CONSTRAINT "expert_automation_scopes_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expert_automation_scopes" ADD CONSTRAINT "expert_automation_scopes_tenant_id_customers_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expert_automation_scopes" ADD CONSTRAINT "expert_automation_scopes_policy_id_expert_automation_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."expert_automation_policies"("id") ON DELETE no action ON UPDATE no action;