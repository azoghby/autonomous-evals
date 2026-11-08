-- Apply explicitly with the deployment migration role, never from a request handler.
CREATE SCHEMA IF NOT EXISTS evaluation_data_persistence;
CREATE TABLE IF NOT EXISTS evaluation_data_persistence.tasks (
  tenant_id text NOT NULL,
  job_id text NOT NULL,
  task_id text NOT NULL,
  revision bigint NOT NULL CHECK (revision BETWEEN 0 AND 9007199254740991),
  record jsonb NOT NULL CHECK (jsonb_typeof(record) = 'object'),
  PRIMARY KEY (tenant_id, job_id, task_id),
  CHECK (tenant_id ~ '^[A-Za-z0-9_-]{1,96}$'),
  CHECK (job_id ~ '^[A-Za-z0-9_-]{1,96}$'),
  CHECK (task_id ~ '^[A-Za-z0-9_-]{1,96}$'),
  CHECK (record ?& ARRAY['taskId', 'spec', 'revision'] AND jsonb_typeof(record->'spec') = 'object'
    AND (record->'spec') ?& ARRAY['taskId', 'jobId'] AND jsonb_typeof(record->'revision') = 'number'),
  CHECK (record->>'taskId' = task_id AND record->'spec'->>'taskId' = task_id
    AND record->'spec'->>'jobId' = job_id AND (record->>'revision')::numeric = revision),
  CHECK (octet_length(record::text) <= 1000000)
);
