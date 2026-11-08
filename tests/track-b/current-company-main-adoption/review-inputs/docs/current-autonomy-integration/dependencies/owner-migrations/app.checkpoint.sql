-- Optional app migration. Apply through the application's normal migration process
-- before constructing PostgresTextCheckpointStore. No application tables are changed.
CREATE SCHEMA IF NOT EXISTS text_integration;
CREATE TABLE IF NOT EXISTS text_integration.checkpoints (
  job_id text NOT NULL,
  kind text NOT NULL,
  id text NOT NULL,
  input_digest text NOT NULL,
  token text NOT NULL,
  state text NOT NULL CHECK (state IN ('ready', 'pending', 'completed', 'ambiguous')),
  value jsonb,
  PRIMARY KEY (job_id, kind, id),
  CHECK ((state = 'completed') = (value IS NOT NULL))
);
