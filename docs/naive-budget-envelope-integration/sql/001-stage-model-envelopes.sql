-- Applies after shared job budget and workflow stage authority migrations.
-- Binding evidence is append-only and established only by atomic first scoped attempt (including model-scope denials).
CREATE TABLE job_budget.stage_model_bindings (
 reservation_id text PRIMARY KEY,
 job_id uuid NOT NULL REFERENCES jobs(id),
 stage_key text NOT NULL,
 parent_reservation_id uuid NOT NULL REFERENCES budget_reservations(id),
 FOREIGN KEY(job_id,stage_key) REFERENCES workflow_stage.stages(job_id,stage_key)
);
CREATE INDEX ON job_budget.stage_model_bindings(job_id,parent_reservation_id);
CREATE TRIGGER retain_stage_model_binding BEFORE UPDATE OR DELETE ON job_budget.stage_model_bindings
 FOR EACH ROW EXECUTE FUNCTION job_budget.guard_retained();

-- Preserve the authority that exhausted a durable denial across replay.
ALTER TABLE job_budget.model_admissions ADD COLUMN exhausted_scope text;
ALTER TABLE job_budget.model_admissions ADD COLUMN cap_micro_usd bigint CHECK(cap_micro_usd>=0 AND cap_micro_usd<=9007199254740991);
ALTER TABLE job_budget.model_admissions ADD CHECK ((exhausted_scope IS NULL)=(cap_micro_usd IS NULL));
