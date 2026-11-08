-- Additive candidate only. All writers use canonical job -> stage -> child lock order.
CREATE SCHEMA IF NOT EXISTS workflow_stage;
CREATE TABLE workflow_stage.stages (
 job_id uuid NOT NULL REFERENCES jobs(id), stage_key text NOT NULL,
 customer_id uuid NOT NULL, environment text NOT NULL, input_digest text NOT NULL, role text NOT NULL,
 operation_id text NOT NULL UNIQUE, reservation_id uuid NOT NULL UNIQUE, amount_micro_usd bigint NOT NULL CHECK(amount_micro_usd>0),
 owner_token uuid NOT NULL, generation bigint NOT NULL CHECK(generation>0), workflow_run_id text NOT NULL, step_id text NOT NULL, attempt integer NOT NULL CHECK(attempt>=0),
 state text NOT NULL CHECK(state IN ('running','pending','recovery_required','completed')),
 lease_until timestamptz NOT NULL, recovery boolean NOT NULL DEFAULT false, result_ciphertext text, PRIMARY KEY(job_id,stage_key),
 CHECK((state='completed')=(result_ciphertext IS NOT NULL))
);
CREATE TABLE workflow_stage.children (
 job_id uuid NOT NULL, stage_key text NOT NULL, kind text NOT NULL, operation_key text NOT NULL,
 request_digest text NOT NULL, registered_generation bigint NOT NULL,
 dispatch_generation bigint, dispatch_intent_at timestamptz,
 PRIMARY KEY(job_id,stage_key,kind,operation_key), UNIQUE(kind,operation_key),
 FOREIGN KEY(job_id,stage_key) REFERENCES workflow_stage.stages(job_id,stage_key)
);
CREATE FUNCTION workflow_stage.immutable_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'workflow_stage_evidence_immutable'; END IF;
 IF TG_TABLE_NAME='stages' THEN
  IF ROW(NEW.job_id,NEW.stage_key,NEW.customer_id,NEW.environment,NEW.input_digest,NEW.role,NEW.operation_id,NEW.reservation_id,NEW.amount_micro_usd)
   IS DISTINCT FROM ROW(OLD.job_id,OLD.stage_key,OLD.customer_id,OLD.environment,OLD.input_digest,OLD.role,OLD.operation_id,OLD.reservation_id,OLD.amount_micro_usd)
   OR (OLD.state='completed' AND NEW IS DISTINCT FROM OLD) THEN RAISE EXCEPTION 'workflow_stage_evidence_immutable'; END IF;
 ELSE
  IF ROW(NEW.job_id,NEW.stage_key,NEW.kind,NEW.operation_key,NEW.request_digest,NEW.registered_generation)
   IS DISTINCT FROM ROW(OLD.job_id,OLD.stage_key,OLD.kind,OLD.operation_key,OLD.request_digest,OLD.registered_generation)
   OR (OLD.dispatch_intent_at IS NOT NULL AND ROW(NEW.dispatch_generation,NEW.dispatch_intent_at) IS DISTINCT FROM ROW(OLD.dispatch_generation,OLD.dispatch_intent_at))
   THEN RAISE EXCEPTION 'workflow_stage_evidence_immutable'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER stages_evidence BEFORE UPDATE OR DELETE ON workflow_stage.stages FOR EACH ROW EXECUTE FUNCTION workflow_stage.immutable_evidence();
CREATE TRIGGER children_evidence BEFORE UPDATE OR DELETE ON workflow_stage.children FOR EACH ROW EXECUTE FUNCTION workflow_stage.immutable_evidence();
