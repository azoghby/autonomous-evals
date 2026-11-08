-- Owner-reviewed canonical grants. Application/model input cannot populate these records.
CREATE TABLE expert_automation_policies (
 id text PRIMARY KEY, enabled boolean NOT NULL DEFAULT false,
 job_cap_micro_usd bigint NOT NULL CHECK(job_cap_micro_usd=25000000),
 daily_cap_micro_usd bigint NOT NULL CHECK(daily_cap_micro_usd=50000000)
);
CREATE TABLE expert_automation_scopes (
 job_id uuid NOT NULL REFERENCES jobs(id), task_id text NOT NULL,
 tenant_id uuid NOT NULL REFERENCES customers(id), request_hash text NOT NULL,
 policy_id text NOT NULL REFERENCES expert_automation_policies(id), topic text NOT NULL,
 enabled boolean NOT NULL DEFAULT false, customer_sharing_consent boolean NOT NULL DEFAULT false,
 PRIMARY KEY(job_id,task_id)
);
CREATE TABLE expert_automation_qualifications (
 expert_id uuid NOT NULL REFERENCES experts(id), topic text NOT NULL,
 qualified boolean NOT NULL DEFAULT false, evidence jsonb NOT NULL,
 allowed_uses jsonb NOT NULL, consent_receipt text NOT NULL, contribution_source jsonb,
 PRIMARY KEY(expert_id,topic)
);
CREATE TABLE expert_automation_operations (
 operation_id text PRIMARY KEY, job_id uuid NOT NULL REFERENCES jobs(id), task_id text NOT NULL,
 tenant_id uuid NOT NULL REFERENCES customers(id), request_hash text NOT NULL,
 request_id uuid NOT NULL UNIQUE REFERENCES expert_requests(id), first_promise_day date
);
CREATE TABLE expert_automation_invitations (
 operation_id text NOT NULL REFERENCES expert_automation_operations(operation_id),
 expert_id uuid NOT NULL REFERENCES experts(id), engagement_id uuid NOT NULL UNIQUE REFERENCES expert_engagements(id),
 draft_id uuid NOT NULL UNIQUE REFERENCES outreach_drafts(id), invitation_digest text NOT NULL,
 promise_key text UNIQUE, amount_micro_usd bigint NOT NULL CHECK(amount_micro_usd BETWEEN 0 AND 25000000),
 promised boolean NOT NULL DEFAULT false, promise_day date,
 founder_approved_by text, send_state text NOT NULL DEFAULT 'prepared' CHECK(send_state IN ('prepared','claimed','sent')),
 message_id text, thread_id text, PRIMARY KEY(operation_id,expert_id)
);
CREATE FUNCTION expert_automation_operation_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (NEW.operation_id,NEW.job_id,NEW.task_id,NEW.tenant_id,NEW.request_hash,NEW.request_id)
 IS DISTINCT FROM (OLD.operation_id,OLD.job_id,OLD.task_id,OLD.tenant_id,OLD.request_hash,OLD.request_id)
 OR (OLD.first_promise_day IS NOT NULL AND NEW.first_promise_day IS DISTINCT FROM OLD.first_promise_day)
 THEN RAISE EXCEPTION 'immutable expert operation'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER expert_automation_operation_identity BEFORE UPDATE ON expert_automation_operations
 FOR EACH ROW EXECUTE FUNCTION expert_automation_operation_identity();
CREATE FUNCTION expert_automation_promise_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (NEW.operation_id,NEW.expert_id,NEW.engagement_id,NEW.draft_id,NEW.amount_micro_usd)
 IS DISTINCT FROM (OLD.operation_id,OLD.expert_id,OLD.engagement_id,OLD.draft_id,OLD.amount_micro_usd)
 OR (OLD.promised AND (NEW.promised,NEW.promise_key,NEW.promise_day,NEW.invitation_digest)
 IS DISTINCT FROM (OLD.promised,OLD.promise_key,OLD.promise_day,OLD.invitation_digest))
 THEN RAISE EXCEPTION 'immutable expert promise'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER expert_automation_promise_identity BEFORE UPDATE ON expert_automation_invitations
 FOR EACH ROW EXECUTE FUNCTION expert_automation_promise_identity();

CREATE TABLE expert_automation_response_bindings (
 operation_id text NOT NULL REFERENCES expert_automation_operations(operation_id),
 engagement_id uuid NOT NULL REFERENCES expert_engagements(id),
 response_id uuid NOT NULL REFERENCES expert_responses(id), response_digest text NOT NULL,
 PRIMARY KEY(operation_id,engagement_id)
);
CREATE FUNCTION expert_automation_response_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'immutable expert response binding'; END $$;
CREATE TRIGGER expert_automation_response_identity BEFORE UPDATE OR DELETE ON expert_automation_response_bindings
 FOR EACH ROW EXECUTE FUNCTION expert_automation_response_identity();
