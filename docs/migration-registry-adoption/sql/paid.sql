-- Owner migration only. Constructors never run DDL. Local intent is not provider attestation.
CREATE SCHEMA IF NOT EXISTS autonomous_paid_app;
REVOKE ALL ON SCHEMA autonomous_paid_app FROM PUBLIC;
CREATE TABLE autonomous_paid_app.operations (
 operation_id text PRIMARY KEY, job_id text NOT NULL, input_digest text NOT NULL,
 policy_digest text NOT NULL, reservation jsonb NOT NULL, state text NOT NULL CHECK(state IN ('reserved','denied','dispatched','settled')),
 receipt jsonb,
 CHECK(input_digest ~ '^[a-f0-9]{64}$')
);
REVOKE ALL ON autonomous_paid_app.operations FROM PUBLIC;
-- Owner grants server-only access and reconciles this stable identity with its migration registry.
