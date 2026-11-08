BEGIN;
CREATE TABLE workflow_integration.review_resume_intents (
 job_id text NOT NULL,
 request_digest text NOT NULL CHECK(request_digest ~ '^[a-f0-9]{64}$'),
 tenant_id text NOT NULL,
 environment text NOT NULL CHECK(environment IN ('test','live')),
 workflow_run_id text NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','needs_operator','finished')),
 last_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(job_id,request_digest)
);
REVOKE ALL ON workflow_integration.review_resume_intents FROM PUBLIC;
COMMIT;
