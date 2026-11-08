BEGIN;
-- Authenticated operator endpoint is the only application writer. No runtime DDL.
-- One immutable approval per job: a Workflow restart cannot choose a new run to evade a fence.
CREATE TABLE workflow_integration.pack_approvals (
 job_id uuid PRIMARY KEY REFERENCES jobs(id),
 tenant_id uuid NOT NULL REFERENCES customers(id),
 environment text NOT NULL CHECK(environment IN ('test','live')),
 authorization_id text NOT NULL UNIQUE,
 manifest jsonb NOT NULL,
 source_rules jsonb NOT NULL,
 reviewed_by text NOT NULL,
 reviewed_at timestamptz NOT NULL,
 revoked_at timestamptz
);
-- Keep this table private with the existing jobs/checkpoint tables. No customer grants.
COMMIT;
