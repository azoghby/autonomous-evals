-- Owner adoption only; register with the owning migration process. No automatic application.
CREATE TABLE expert_workflow.text_bindings (
 job_id uuid PRIMARY KEY REFERENCES expert_workflow.plans(job_id),
 scope jsonb NOT NULL CHECK(jsonb_typeof(scope)='object'),
 target_version text NOT NULL CHECK(target_version ~ '^[a-f0-9]{64}$'),
 run_id text NOT NULL CHECK(run_id ~ '^expert-[a-f0-9]{24}$'),
 CHECK(scope->>'jobId'=job_id::text),
 CHECK(octet_length(scope::text)<4096)
);
CREATE FUNCTION expert_workflow.immutable_text_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'immutable expert text binding'; END $$;
CREATE TRIGGER immutable_text_binding BEFORE UPDATE OR DELETE ON expert_workflow.text_bindings
 FOR EACH ROW EXECUTE FUNCTION expert_workflow.immutable_text_binding();
