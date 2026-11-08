-- Optional migration artifact only; deployment and grants belong to the application owner.
-- Requires agent_persistence migration and global workflow_integration.cost_keys cost protocol.
CREATE SCHEMA remediation_accounting;
CREATE TABLE remediation_accounting.operations (
 operation_id text PRIMARY KEY,
 job_id text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('target','judge')),
 input_digest text NOT NULL CHECK(input_digest ~ '^[a-f0-9]{64}$'),
 reservation jsonb NOT NULL,
 allowed boolean,
 dispatch_evidence jsonb,
 usage jsonb,
 ambiguous boolean NOT NULL DEFAULT false,
 settlement jsonb
);
CREATE TABLE remediation_accounting.reconciliation_outbox (
 operation_id text PRIMARY KEY REFERENCES remediation_accounting.operations(operation_id),
 pending boolean NOT NULL DEFAULT true,
 receipt_id text,
 reason text NOT NULL CHECK(reason IN ('reserved','dispatched','usage_unknown','usage_observed','ambiguous','settled'))
);
REVOKE ALL ON SCHEMA remediation_accounting FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA remediation_accounting FROM PUBLIC;
