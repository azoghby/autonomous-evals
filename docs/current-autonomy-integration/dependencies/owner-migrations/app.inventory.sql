-- Artifact only. Owner applies transactionally after review. No runtime DDL.
CREATE SCHEMA IF NOT EXISTS structured_progress;
CREATE TABLE IF NOT EXISTS structured_progress.inventory (
  tenant_id text NOT NULL,
  job_id text PRIMARY KEY,
  environment text NOT NULL CHECK (environment IN ('test', 'live')),
  revision bigint NOT NULL CHECK (revision >= 0),
  plan jsonb NOT NULL CHECK (jsonb_typeof(plan) = 'object'),
  observed_at timestamptz NOT NULL
);
-- Private server DB role only. Do not expose via direct client data APIs.
REVOKE ALL ON SCHEMA structured_progress FROM PUBLIC;
REVOKE ALL ON structured_progress.inventory FROM PUBLIC;
