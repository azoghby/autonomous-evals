-- Apply after 001-run-recovery.sql and text integration checkpoint migration.
CREATE TABLE workflow_stage.run_checkpoints (
 job_id text NOT NULL,
 stage_job_id uuid GENERATED ALWAYS AS (job_id::uuid) STORED,
 kind text NOT NULL CHECK(kind IN ('run_identity','run_result','scenario','target','judge')),
 id text NOT NULL CHECK(length(id) BETWEEN 1 AND 4096),
 input_digest text NOT NULL CHECK(length(input_digest) BETWEEN 1 AND 4096),
 stage_key text NOT NULL,
 generation bigint NOT NULL CHECK(generation>0),token text NOT NULL CHECK(length(token) BETWEEN 1 AND 4096),
 outer_id text NOT NULL,outer_digest text NOT NULL,
 PRIMARY KEY(job_id,kind,id),
 FOREIGN KEY(job_id,kind,id) REFERENCES text_integration.checkpoints(job_id,kind,id),
 FOREIGN KEY(stage_job_id,stage_key) REFERENCES workflow_stage.stages(job_id,stage_key)
);
CREATE INDEX run_checkpoints_stage ON workflow_stage.run_checkpoints(stage_job_id,stage_key);
CREATE FUNCTION workflow_stage.bound_run_checkpoint() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s workflow_stage.stages; checkpoint_token text; checkpoint_digest text; checkpoint_state text;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'workflow_run_checkpoint_immutable'; END IF;
 IF TG_OP='UPDATE' THEN
 IF ROW(NEW.job_id,NEW.kind,NEW.id,NEW.input_digest,NEW.stage_key,NEW.outer_id,NEW.outer_digest)
 IS DISTINCT FROM ROW(OLD.job_id,OLD.kind,OLD.id,OLD.input_digest,OLD.stage_key,OLD.outer_id,OLD.outer_digest)
 OR NEW.generation<OLD.generation
 OR (NEW.generation=OLD.generation AND NEW.token<>OLD.token)
 OR (NEW.generation>OLD.generation AND (NEW.token=OLD.token OR NEW.kind='target'))
 THEN RAISE EXCEPTION 'workflow_run_checkpoint_immutable'; END IF;
 END IF;
 SELECT * INTO s FROM workflow_stage.stages WHERE job_id=NEW.job_id::uuid AND stage_key=NEW.stage_key FOR UPDATE;
 IF NOT FOUND OR s.recovery_profile<>'naive-text-run-v1' OR s.state<>'running' OR s.lease_until<=clock_timestamp()
 OR NEW.generation<>s.generation OR NEW.outer_id<>s.expected_child_plan->>'runId' OR NEW.outer_digest<>s.expected_child_plan->>'suiteDigest'
 OR EXISTS(SELECT 1 FROM workflow_stage.cancellations WHERE job_id=s.job_id)
 OR NOT EXISTS(SELECT 1 FROM jobs WHERE id=s.job_id AND state::text IN ('draft','needs_clarification','quoted','awaiting_payment','planning','running','investigating'))
 THEN RAISE EXCEPTION 'workflow_run_checkpoint_conflict'; END IF;
 IF NEW.kind IN ('run_identity','run_result') THEN
 IF NEW.id<>NEW.outer_id THEN RAISE EXCEPTION 'workflow_run_checkpoint_conflict'; END IF;
 ELSE
 IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(s.expected_child_plan->'children') c
 WHERE c->>'operationKey'=NEW.id AND c->>'kind'=CASE WHEN NEW.kind='judge' THEN 'text_run_judge' ELSE 'text_run_target' END)
 THEN RAISE EXCEPTION 'workflow_run_checkpoint_conflict'; END IF;
 END IF;
 SELECT token,input_digest,state INTO checkpoint_token,checkpoint_digest,checkpoint_state FROM text_integration.checkpoints WHERE job_id=NEW.job_id AND kind=NEW.kind AND id=NEW.id FOR UPDATE;
 IF NOT FOUND OR checkpoint_token<>NEW.token OR checkpoint_digest<>NEW.input_digest OR checkpoint_state<>'pending'
 THEN RAISE EXCEPTION 'workflow_run_checkpoint_conflict'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER bounded_run_checkpoint BEFORE INSERT OR UPDATE OR DELETE ON workflow_stage.run_checkpoints FOR EACH ROW EXECUTE FUNCTION workflow_stage.bound_run_checkpoint();
