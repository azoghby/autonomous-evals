-- Apply after rich artifacts and remediation bindings; no runtime DDL.
ALTER TABLE workflow_integration.bindings ADD COLUMN rerun_operation_micro_usd bigint CHECK (rerun_operation_micro_usd > 0);
CREATE TABLE workflow_integration.finding_reruns (
 job_id uuid NOT NULL REFERENCES jobs(id), operation_key text NOT NULL,
 operation_id text NOT NULL UNIQUE, finding_id uuid NOT NULL REFERENCES findings(id),
 input_digest text NOT NULL, authority_digest text NOT NULL,
 hold_micro_usd bigint NOT NULL CHECK (hold_micro_usd > 0),
 state text NOT NULL CHECK (state IN ('pending','completed','needs_operator')),
 result jsonb, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(job_id,operation_key)
);
-- Server role only, matching rich_artifacts. Never grant public/browser access.
REVOKE ALL ON workflow_integration.finding_reruns FROM PUBLIC;
