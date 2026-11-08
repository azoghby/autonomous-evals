-- Apply once using deployment migration credentials, before starting Workflow workers.
-- Runtime service role must not own this schema or have DDL rights.
BEGIN;
CREATE SCHEMA IF NOT EXISTS workflow_integration;
CREATE TABLE workflow_integration.cost_keys (
 job_id uuid NOT NULL REFERENCES jobs(id), key text NOT NULL, payload jsonb NOT NULL,
 PRIMARY KEY(key)
);
-- Existing keyed ledger entries must acquire the same identity before replay is enabled.
-- Duplicate historical keys intentionally abort this transaction for operator reconciliation.
INSERT INTO workflow_integration.cost_keys(job_id,key,payload)
 SELECT job_id,meta->>'idempotencyKey',jsonb_strip_nulls(jsonb_build_object(
   'jobId',job_id,'source',source,'agent',agent,'sessionId',session_id,'microUsd',micro_usd,'meta',meta))
 FROM costs WHERE job_id IS NOT NULL AND jsonb_typeof(meta->'idempotencyKey')='string';
-- Populated by an authenticated operator admission transaction. Never customer request JSON.
-- Updating target_revision changes the target version and blocks existing checkpoint replay.
CREATE TABLE workflow_integration.bindings (
 job_id uuid PRIMARY KEY REFERENCES jobs(id), target_revision text NOT NULL CHECK(target_revision ~ '^[A-Za-z0-9_.:-]{1,128}$'),
 reviewed_calendar jsonb, isolation text, baseline_suite_digest text, baseline_run_id text,
 admitted_by uuid NOT NULL REFERENCES customers(id), admitted_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON SCHEMA workflow_integration FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA workflow_integration FROM PUBLIC;
COMMIT;
