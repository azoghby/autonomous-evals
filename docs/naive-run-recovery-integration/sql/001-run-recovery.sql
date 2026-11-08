-- Additive profile, after 001-design-stage-recovery.sql. Existing profile constraints retained.
ALTER TABLE workflow_stage.stages DROP CONSTRAINT stages_recovery_profile_check;
ALTER TABLE workflow_stage.stages ADD CONSTRAINT stages_recovery_profile_check CHECK(recovery_profile IN ('none','retained-children','naive-single-child-v1','naive-design-v1','naive-text-run-v1'));
ALTER TABLE workflow_stage.stages DROP CONSTRAINT design_plan_shape;
CREATE FUNCTION workflow_stage.valid_text_run_plan(p jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE c jsonb; seen text[]='{}'; ident text; targets integer=0;
BEGIN
 IF p IS NULL OR jsonb_typeof(p)<>'object' OR NOT p ?& ARRAY['profile','runId','suiteDigest','targetVersion','environment','children'] OR p-ARRAY['profile','runId','suiteDigest','targetVersion','environment','children']<>'{}'::jsonb THEN RETURN false; END IF;
 IF p->>'profile'<>'naive-text-run-v1' OR jsonb_typeof(p->'children')<>'array' THEN RETURN false; END IF;
 FOREACH ident IN ARRAY ARRAY['profile','runId','suiteDigest','targetVersion','environment'] LOOP
 IF jsonb_typeof(p->ident)<>'string' OR length(p->>ident) NOT BETWEEN 1 AND 4096 THEN RETURN false; END IF; END LOOP;
 IF p->>'suiteDigest' !~ '^[a-f0-9]{64}$' OR jsonb_array_length(p->'children') NOT BETWEEN 1 AND 256 THEN RETURN false; END IF;
 FOR c IN SELECT value FROM jsonb_array_elements(p->'children') LOOP
 IF jsonb_typeof(c)<>'object' OR NOT c ?& ARRAY['kind','operationKey'] OR c-ARRAY['kind','operationKey']<>'{}'::jsonb OR jsonb_typeof(c->'kind')<>'string' OR jsonb_typeof(c->'operationKey')<>'string' OR c->>'kind' NOT IN ('text_run_target','text_run_judge') OR length(c->>'operationKey') NOT BETWEEN 1 AND 4096 THEN RETURN false; END IF;
 ident=c::text; IF ident=ANY(seen) THEN RETURN false; END IF; seen=array_append(seen,ident); IF c->>'kind'='text_run_target' THEN targets=targets+1; END IF;
 END LOOP; RETURN targets>0;
END $$;
ALTER TABLE workflow_stage.stages ADD CONSTRAINT design_plan_shape CHECK(
 (recovery_profile='naive-design-v1' AND expected_child_plan IS NOT NULL AND jsonb_typeof(expected_child_plan)='object'
 AND expected_child_plan ?& ARRAY['profile','scope','outerDesignId','inputDigest']
 AND expected_child_plan - ARRAY['profile','scope','outerDesignId','inputDigest'] = '{}'::jsonb
 AND jsonb_typeof(expected_child_plan->'profile')='string' AND jsonb_typeof(expected_child_plan->'scope')='string' AND jsonb_typeof(expected_child_plan->'outerDesignId')='string' AND jsonb_typeof(expected_child_plan->'inputDigest')='string'
 AND expected_child_plan->>'profile'='naive-design-v1'
 AND expected_child_plan->>'scope' ~ '^[a-f0-9]{24}$'
 AND expected_child_plan->>'inputDigest' ~ '^[a-f0-9]{64}$'
 AND length(expected_child_plan->>'outerDesignId') BETWEEN 1 AND 4096)
 OR (recovery_profile='naive-text-run-v1' AND workflow_stage.valid_text_run_plan(expected_child_plan)) OR (recovery_profile NOT IN ('naive-design-v1','naive-text-run-v1') AND expected_child_plan IS NULL));
CREATE FUNCTION workflow_stage.bound_text_run_child() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s workflow_stage.stages;
BEGIN
 SELECT * INTO s FROM workflow_stage.stages WHERE job_id=NEW.job_id AND stage_key=NEW.stage_key FOR UPDATE;
 IF s.recovery_profile<>'naive-text-run-v1' THEN RETURN NEW; END IF;
 IF s.state<>'running' OR s.lease_until<=clock_timestamp() OR NEW.registered_generation<>s.generation
 OR EXISTS(SELECT 1 FROM workflow_stage.cancellations WHERE job_id=NEW.job_id)
 OR NOT EXISTS(SELECT 1 FROM jobs WHERE id=NEW.job_id AND state::text IN ('draft','needs_clarification','quoted','awaiting_payment','planning','running','investigating'))
 OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(s.expected_child_plan->'children') c WHERE c->>'kind'=NEW.kind AND c->>'operationKey'=NEW.operation_key)
 THEN RAISE EXCEPTION 'workflow_stage_conflict'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER bounded_text_run_child BEFORE INSERT ON workflow_stage.children FOR EACH ROW EXECUTE FUNCTION workflow_stage.bound_text_run_child();
