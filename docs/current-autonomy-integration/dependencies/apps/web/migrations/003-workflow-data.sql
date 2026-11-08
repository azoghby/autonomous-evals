-- Deployment owner applies after Workflow001/002 and data persistence001/002.
-- Private producer authority only; no public writer/HTTP plan admission.
CREATE TABLE workflow_integration.data_plans (
 job_id uuid PRIMARY KEY REFERENCES jobs(id), tenant_id uuid NOT NULL, environment text NOT NULL CHECK(environment IN ('test','live')),
 input_digest text NOT NULL CHECK(input_digest ~ '^[a-f0-9]{64}$'), input jsonb NOT NULL
);
CREATE TABLE workflow_integration.data_advances (
 job_id uuid NOT NULL REFERENCES workflow_integration.data_plans(job_id), result_digest text NOT NULL CHECK(result_digest ~ '^[a-f0-9]{64}$'),
 result jsonb NOT NULL, PRIMARY KEY(job_id,result_digest)
);
CREATE TABLE workflow_integration.data_ready (
 job_id uuid PRIMARY KEY REFERENCES workflow_integration.data_plans(job_id), input_digest text NOT NULL CHECK(input_digest ~ '^[a-f0-9]{64}$'),
 result_digest text NOT NULL CHECK(result_digest ~ '^[a-f0-9]{64}$'), result jsonb NOT NULL
);
