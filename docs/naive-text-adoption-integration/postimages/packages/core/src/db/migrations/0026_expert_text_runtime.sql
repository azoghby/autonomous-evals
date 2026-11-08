CREATE TABLE "expert_workflow"."text_bindings" (
	"job_id" uuid PRIMARY KEY NOT NULL,
	"scope" jsonb NOT NULL,
	"target_version" text NOT NULL,
	"run_id" text NOT NULL,
	CONSTRAINT "text_bindings_scope_check" CHECK (jsonb_typeof("expert_workflow"."text_bindings"."scope")='object'),
	CONSTRAINT "text_bindings_target_version_check" CHECK ("expert_workflow"."text_bindings"."target_version" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "text_bindings_run_id_check" CHECK ("expert_workflow"."text_bindings"."run_id" ~ '^expert-[a-f0-9]{24}$'),
	CONSTRAINT "text_bindings_check" CHECK ("expert_workflow"."text_bindings"."scope"->>'jobId'="expert_workflow"."text_bindings"."job_id"::text),
	CONSTRAINT "text_bindings_scope_check1" CHECK (octet_length("expert_workflow"."text_bindings"."scope"::text)<4096)
);
--> statement-breakpoint
ALTER TABLE "expert_workflow"."text_bindings" ADD CONSTRAINT "text_bindings_job_id_plans_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "expert_workflow"."plans"("job_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE FUNCTION expert_workflow.immutable_text_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'immutable expert text binding'; END $$;
--> statement-breakpoint
CREATE TRIGGER immutable_text_binding BEFORE UPDATE OR DELETE ON expert_workflow.text_bindings
 FOR EACH ROW EXECUTE FUNCTION expert_workflow.immutable_text_binding();
