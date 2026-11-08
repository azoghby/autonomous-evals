-- Exact stage progress replay is idempotent, in the same owner-check transaction.
CREATE TABLE workflow_stage.progress (
 job_id uuid NOT NULL, stage_key text NOT NULL, milestone text NOT NULL, message_digest text NOT NULL,
 PRIMARY KEY(job_id,stage_key,milestone,message_digest),
 FOREIGN KEY(job_id,stage_key) REFERENCES workflow_stage.stages(job_id,stage_key)
);
