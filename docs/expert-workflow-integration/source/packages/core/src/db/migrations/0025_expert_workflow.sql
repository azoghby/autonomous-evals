-- Apply only after canonical data persistence and expert-owner 0024 adoption.
-- Trusted deployment/operator SQL provisions plans and receipts; no model/public route writes these.
CREATE SCHEMA expert_workflow;
CREATE TABLE expert_workflow.plans (
 job_id uuid PRIMARY KEY REFERENCES jobs(id), tenant_id uuid NOT NULL REFERENCES customers(id),
 input jsonb NOT NULL CHECK(jsonb_typeof(input)='object'),
 input_digest text NOT NULL CHECK(input_digest ~ '^[a-f0-9]{64}$'),
 topic text NOT NULL CHECK(length(topic) BETWEEN 1 AND 160), enabled boolean NOT NULL DEFAULT false,
 response_deadline timestamptz NOT NULL DEFAULT(now()+interval '7 days'),
 last_result jsonb, last_checked_at timestamptz,
 CHECK(input->'task'->>'jobId'=job_id::text),
 CHECK(octet_length(input::text)<=1000000)
);
CREATE TABLE expert_workflow.contribution_reviews (
 job_id uuid NOT NULL REFERENCES expert_workflow.plans(job_id), task_id text NOT NULL,
 contribution_digest text NOT NULL CHECK(contribution_digest ~ '^[a-f0-9]{64}$'),
 reviewer_id uuid NOT NULL REFERENCES customers(id), review jsonb NOT NULL,
 PRIMARY KEY(job_id,task_id,contribution_digest),
 CHECK(review->>'reviewerId'=reviewer_id::text),
 CHECK(review->>'contextDigest'=contribution_digest),
 CHECK(octet_length(review::text)<=500000)
);
CREATE FUNCTION expert_workflow.immutable_authority() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'retained expert authority cannot be deleted'; END IF;
 IF TG_TABLE_NAME='contribution_reviews' THEN RAISE EXCEPTION 'immutable contribution review'; END IF;
 IF (NEW.job_id,NEW.tenant_id,NEW.input,NEW.input_digest,NEW.topic,NEW.response_deadline)
 IS DISTINCT FROM (OLD.job_id,OLD.tenant_id,OLD.input,OLD.input_digest,OLD.topic,OLD.response_deadline)
 THEN RAISE EXCEPTION 'immutable expert task authority'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER immutable_plan BEFORE UPDATE OR DELETE ON expert_workflow.plans
 FOR EACH ROW EXECUTE FUNCTION expert_workflow.immutable_authority();
CREATE TRIGGER immutable_review BEFORE UPDATE OR DELETE ON expert_workflow.contribution_reviews
 FOR EACH ROW EXECUTE FUNCTION expert_workflow.immutable_authority();
