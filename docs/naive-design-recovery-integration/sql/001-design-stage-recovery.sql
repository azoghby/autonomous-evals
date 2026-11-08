-- Apply after stage recovery and cancellation migrations. No existing profile is broadened.
ALTER TABLE workflow_stage.stages ADD COLUMN expected_child_plan jsonb;
ALTER TABLE workflow_stage.children ADD COLUMN design_slot text;
ALTER TABLE workflow_stage.stages DROP CONSTRAINT stages_recovery_profile_check;
ALTER TABLE workflow_stage.stages ADD CONSTRAINT stages_recovery_profile_check CHECK(recovery_profile IN ('none','retained-children','naive-single-child-v1','naive-design-v1'));
ALTER TABLE workflow_stage.stages ADD CONSTRAINT design_plan_shape CHECK(
 (recovery_profile='naive-design-v1' AND expected_child_plan IS NOT NULL AND jsonb_typeof(expected_child_plan)='object'
 AND expected_child_plan ?& ARRAY['profile','scope','outerDesignId','inputDigest']
 AND expected_child_plan - ARRAY['profile','scope','outerDesignId','inputDigest'] = '{}'::jsonb
 AND jsonb_typeof(expected_child_plan->'profile')='string' AND jsonb_typeof(expected_child_plan->'scope')='string' AND jsonb_typeof(expected_child_plan->'outerDesignId')='string' AND jsonb_typeof(expected_child_plan->'inputDigest')='string'
 AND expected_child_plan->>'profile'='naive-design-v1'
 AND expected_child_plan->>'scope' ~ '^[a-f0-9]{24}$'
 AND expected_child_plan->>'inputDigest' ~ '^[a-f0-9]{64}$'
 AND length(expected_child_plan->>'outerDesignId') BETWEEN 1 AND 4096)
 OR (recovery_profile<>'naive-design-v1' AND expected_child_plan IS NULL));
CREATE UNIQUE INDEX design_child_slot ON workflow_stage.children(job_id,stage_key,design_slot) WHERE design_slot IS NOT NULL;
CREATE FUNCTION workflow_stage.bound_design_child() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s workflow_stage.stages; suffix text; rev integer;
BEGIN
 SELECT * INTO s FROM workflow_stage.stages WHERE job_id=NEW.job_id AND stage_key=NEW.stage_key FOR UPDATE;
 IF s.recovery_profile<>'naive-design-v1' THEN IF NEW.design_slot IS NOT NULL THEN RAISE EXCEPTION 'workflow_stage_conflict'; END IF; RETURN NEW; END IF;
 IF EXISTS(SELECT 1 FROM workflow_stage.cancellations WHERE job_id=NEW.job_id) OR NOT EXISTS(SELECT 1 FROM jobs WHERE id=NEW.job_id AND state::text IN ('draft','needs_clarification','quoted','awaiting_payment','planning','running','investigating')) OR s.state<>'running' OR s.lease_until<=clock_timestamp() OR NEW.registered_generation<>s.generation OR NEW.kind<>'naive_session' THEN RAISE EXCEPTION 'workflow_stage_conflict'; END IF;
 NEW.design_slot=NULL;
 FOR rev IN 0..1 LOOP
 IF NEW.operation_key=NEW.job_id::text||':evaluation_engineer:text_design_'||(s.expected_child_plan->>'scope')||'_'||rev||':1' THEN NEW.design_slot='engineer:'||rev; END IF;
 suffix=NEW.job_id::text||':quality_investigator:text_review_'||(s.expected_child_plan->>'scope')||'_'||rev||'_';
 IF left(NEW.operation_key,length(suffix))=suffix AND substring(NEW.operation_key FROM length(suffix)+1) ~ '^[a-f0-9]{12}:1$' THEN NEW.design_slot='reviewer:'||rev; END IF;
 END LOOP;
 IF NEW.design_slot IS NULL THEN RAISE EXCEPTION 'workflow_stage_conflict'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER bounded_design_child BEFORE INSERT ON workflow_stage.children FOR EACH ROW EXECUTE FUNCTION workflow_stage.bound_design_child();
CREATE OR REPLACE FUNCTION workflow_stage.immutable_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'workflow_stage_evidence_immutable'; END IF;
 IF TG_TABLE_NAME='stages' THEN
  IF ROW(NEW.job_id,NEW.stage_key,NEW.customer_id,NEW.environment,NEW.input_digest,NEW.role,NEW.operation_id,NEW.reservation_id,NEW.amount_micro_usd,NEW.recovery_profile,NEW.expected_child_key,NEW.expected_child_plan)
   IS DISTINCT FROM ROW(OLD.job_id,OLD.stage_key,OLD.customer_id,OLD.environment,OLD.input_digest,OLD.role,OLD.operation_id,OLD.reservation_id,OLD.amount_micro_usd,OLD.recovery_profile,OLD.expected_child_key,OLD.expected_child_plan)
   OR (OLD.state='completed' AND NEW IS DISTINCT FROM OLD) THEN RAISE EXCEPTION 'workflow_stage_evidence_immutable'; END IF;
 ELSE
  IF ROW(NEW.job_id,NEW.stage_key,NEW.kind,NEW.operation_key,NEW.request_digest,NEW.registered_generation,NEW.design_slot)
   IS DISTINCT FROM ROW(OLD.job_id,OLD.stage_key,OLD.kind,OLD.operation_key,OLD.request_digest,OLD.registered_generation,OLD.design_slot)
   OR (OLD.dispatch_intent_at IS NOT NULL AND ROW(NEW.dispatch_generation,NEW.dispatch_intent_at) IS DISTINCT FROM ROW(OLD.dispatch_generation,OLD.dispatch_intent_at))
   THEN RAISE EXCEPTION 'workflow_stage_evidence_immutable'; END IF;
 END IF;
 RETURN NEW;
END $$;
