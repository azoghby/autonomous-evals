BEGIN;
CREATE TABLE IF NOT EXISTS workflow_integration.rich_artifacts (
  job_id text PRIMARY KEY,
  tenant_id text NOT NULL,
  environment text NOT NULL CHECK(environment IN ('test','live')),
  suite_digest text NOT NULL,
  body jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
REVOKE ALL ON workflow_integration.rich_artifacts FROM PUBLIC;
COMMIT;
