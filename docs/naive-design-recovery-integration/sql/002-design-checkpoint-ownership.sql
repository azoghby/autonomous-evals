-- Apply after stage ownership, design recovery profile and text integration SQL.
-- This table associates only pure design/artifact checkpoints, never external sends.
CREATE TABLE workflow_stage.design_checkpoints (
 job_id text NOT NULL,kind text NOT NULL CHECK(kind IN ('design','suite','cost')),
 id text NOT NULL,input_digest text NOT NULL,stage_key text NOT NULL,
 generation bigint NOT NULL CHECK(generation>0),token text NOT NULL,
 outer_id text NOT NULL,outer_digest text NOT NULL,
 PRIMARY KEY(job_id,kind,id),
 FOREIGN KEY(job_id,kind,id) REFERENCES text_integration.checkpoints(job_id,kind,id)
);
CREATE FUNCTION workflow_stage.immutable_design_checkpoint() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'workflow_design_checkpoint_immutable'; END IF;
 IF ROW(NEW.job_id,NEW.kind,NEW.id,NEW.input_digest,NEW.stage_key,NEW.outer_id,NEW.outer_digest)
 IS DISTINCT FROM ROW(OLD.job_id,OLD.kind,OLD.id,OLD.input_digest,OLD.stage_key,OLD.outer_id,OLD.outer_digest)
 OR NEW.generation<OLD.generation THEN RAISE EXCEPTION 'workflow_design_checkpoint_immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER immutable_design_checkpoint BEFORE UPDATE OR DELETE ON workflow_stage.design_checkpoints FOR EACH ROW EXECUTE FUNCTION workflow_stage.immutable_design_checkpoint();
