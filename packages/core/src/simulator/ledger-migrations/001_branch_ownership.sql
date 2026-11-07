-- OPTIONAL APPLICATION DATABASE migration: Track A incorporates/applies this explicitly.
-- Never apply to the disposable simulator seed or per-job branches.
CREATE TABLE app_branch_ownership (
  job_id text PRIMARY KEY CHECK (length(job_id) BETWEEN 1 AND 128),
  project_id text NOT NULL CHECK (project_id ~ '^[a-z0-9-]{1,60}$'),
  parent_id text NOT NULL CHECK (parent_id ~ '^br-[a-z0-9-]+$' AND length(parent_id) <= 128),
  name text NOT NULL CHECK (name ~ '^eval-job-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'),
  branch_id text UNIQUE CHECK (branch_id ~ '^br-[a-z0-9-]+$' AND length(branch_id) <= 128),
  state text NOT NULL CHECK (state IN ('creating', 'retryable', 'ready', 'delete_requested', 'deleted')),
  create_attempts integer CHECK (create_attempts BETWEEN 1 AND 3),
  CHECK ((state IN ('creating', 'retryable') AND branch_id IS NULL) OR (state NOT IN ('creating', 'retryable') AND branch_id IS NOT NULL)),
  CHECK (branch_id IS NULL OR branch_id <> parent_id),
  UNIQUE (project_id, name)
);
