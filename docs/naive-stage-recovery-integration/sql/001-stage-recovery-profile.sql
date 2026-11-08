-- Apply after the stage ownership migration. Existing stages remain conservative.
ALTER TABLE workflow_stage.stages
 ADD COLUMN recovery_profile text NOT NULL DEFAULT 'none' CHECK(recovery_profile IN ('none','retained-children','naive-single-child-v1')),
 ADD COLUMN expected_child_key text,
 ADD CONSTRAINT stage_recovery_profile_key CHECK ((recovery_profile='naive-single-child-v1' AND expected_child_key IS NOT NULL AND length(expected_child_key)>0) OR (recovery_profile<>'naive-single-child-v1' AND expected_child_key IS NULL));
CREATE OR REPLACE FUNCTION workflow_stage.immutable_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'workflow_stage_evidence_immutable'; END IF;
 IF TG_TABLE_NAME='stages' THEN
  IF ROW(NEW.job_id,NEW.stage_key,NEW.customer_id,NEW.environment,NEW.input_digest,NEW.role,NEW.operation_id,NEW.reservation_id,NEW.amount_micro_usd,NEW.recovery_profile,NEW.expected_child_key)
   IS DISTINCT FROM ROW(OLD.job_id,OLD.stage_key,OLD.customer_id,OLD.environment,OLD.input_digest,OLD.role,OLD.operation_id,OLD.reservation_id,OLD.amount_micro_usd,OLD.recovery_profile,OLD.expected_child_key)
   OR (OLD.state='completed' AND NEW IS DISTINCT FROM OLD) THEN RAISE EXCEPTION 'workflow_stage_evidence_immutable'; END IF;
 ELSE
  IF ROW(NEW.job_id,NEW.stage_key,NEW.kind,NEW.operation_key,NEW.request_digest,NEW.registered_generation)
   IS DISTINCT FROM ROW(OLD.job_id,OLD.stage_key,OLD.kind,OLD.operation_key,OLD.request_digest,OLD.registered_generation)
   OR (OLD.dispatch_intent_at IS NOT NULL AND ROW(NEW.dispatch_generation,NEW.dispatch_intent_at) IS DISTINCT FROM ROW(OLD.dispatch_generation,OLD.dispatch_intent_at))
   THEN RAISE EXCEPTION 'workflow_stage_evidence_immutable'; END IF;
 END IF;
 RETURN NEW;
END $$;
