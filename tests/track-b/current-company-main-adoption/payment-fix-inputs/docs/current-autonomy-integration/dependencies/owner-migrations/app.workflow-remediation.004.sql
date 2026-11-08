-- OPTIONAL integration artifact only. Owner reviews/deploys through normal migration process.
-- Prerequisites: agent/text persistence, workflow 001/002 and core accounting migration.
BEGIN;
ALTER TABLE workflow_integration.bindings ADD COLUMN remediation_operation_micro_usd bigint
 CHECK (remediation_operation_micro_usd > 0 AND remediation_operation_micro_usd <= 9007199254740991);
CREATE TABLE workflow_integration.provider_costs (
 job_id uuid NOT NULL REFERENCES jobs(id), key text PRIMARY KEY REFERENCES workflow_integration.cost_keys(key),
 source text NOT NULL CHECK(source IN ('target_http','ai_gateway')), operation_id text NOT NULL,
 receipt_id text NOT NULL, micro_usd bigint NOT NULL CHECK(micro_usd >= 0),
 UNIQUE(job_id,operation_id)
);
REVOKE ALL ON workflow_integration.provider_costs FROM PUBLIC;
COMMIT;
