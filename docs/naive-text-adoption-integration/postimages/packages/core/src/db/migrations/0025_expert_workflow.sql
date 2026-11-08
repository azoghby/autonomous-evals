CREATE SCHEMA "expert_workflow";
--> statement-breakpoint
CREATE TABLE "expert_workflow"."contribution_reviews" (
	"job_id" uuid NOT NULL,
	"task_id" text NOT NULL,
	"contribution_digest" text NOT NULL,
	"reviewer_id" uuid NOT NULL,
	"review" jsonb NOT NULL,
	CONSTRAINT "contribution_reviews_job_id_task_id_contribution_digest_pk" PRIMARY KEY("job_id","task_id","contribution_digest"),
	CONSTRAINT "contribution_reviews_contribution_digest_check" CHECK ("expert_workflow"."contribution_reviews"."contribution_digest" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "contribution_reviews_check" CHECK ("expert_workflow"."contribution_reviews"."review"->>'reviewerId'="expert_workflow"."contribution_reviews"."reviewer_id"::text),
	CONSTRAINT "contribution_reviews_check1" CHECK ("expert_workflow"."contribution_reviews"."review"->>'contextDigest'="expert_workflow"."contribution_reviews"."contribution_digest"),
	CONSTRAINT "contribution_reviews_review_check" CHECK (octet_length("expert_workflow"."contribution_reviews"."review"::text)<=500000)
);
--> statement-breakpoint
CREATE TABLE "expert_workflow"."plans" (
	"job_id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"input" jsonb NOT NULL,
	"input_digest" text NOT NULL,
	"topic" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"response_deadline" timestamp with time zone DEFAULT now()+interval '7 days' NOT NULL,
	"last_result" jsonb,
	"last_checked_at" timestamp with time zone,
	CONSTRAINT "plans_input_check" CHECK (jsonb_typeof("expert_workflow"."plans"."input")='object'),
	CONSTRAINT "plans_input_digest_check" CHECK ("expert_workflow"."plans"."input_digest" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "plans_topic_check" CHECK (length("expert_workflow"."plans"."topic") BETWEEN 1 AND 160),
	CONSTRAINT "plans_check" CHECK ("expert_workflow"."plans"."input"->'task'->>'jobId'="expert_workflow"."plans"."job_id"::text),
	CONSTRAINT "plans_input_check1" CHECK (octet_length("expert_workflow"."plans"."input"::text)<=1000000)
);
--> statement-breakpoint
ALTER TABLE "expert_workflow"."contribution_reviews" ADD CONSTRAINT "contribution_reviews_job_id_plans_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "expert_workflow"."plans"("job_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expert_workflow"."contribution_reviews" ADD CONSTRAINT "contribution_reviews_reviewer_id_customers_id_fk" FOREIGN KEY ("reviewer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expert_workflow"."plans" ADD CONSTRAINT "plans_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expert_workflow"."plans" ADD CONSTRAINT "plans_tenant_id_customers_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE FUNCTION expert_workflow.immutable_authority() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'retained expert authority cannot be deleted'; END IF;
 IF TG_TABLE_NAME='contribution_reviews' THEN RAISE EXCEPTION 'immutable contribution review'; END IF;
 IF (NEW.job_id,NEW.tenant_id,NEW.input,NEW.input_digest,NEW.topic,NEW.response_deadline)
 IS DISTINCT FROM (OLD.job_id,OLD.tenant_id,OLD.input,OLD.input_digest,OLD.topic,OLD.response_deadline)
 THEN RAISE EXCEPTION 'immutable expert task authority'; END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER immutable_plan BEFORE UPDATE OR DELETE ON expert_workflow.plans
 FOR EACH ROW EXECUTE FUNCTION expert_workflow.immutable_authority();
--> statement-breakpoint
CREATE TRIGGER immutable_review BEFORE UPDATE OR DELETE ON expert_workflow.contribution_reviews
 FOR EACH ROW EXECUTE FUNCTION expert_workflow.immutable_authority();
