-- Optional application migration artifact. Apply only through the parent application's migration process.
-- Deliberately separate from Track A's agent_tasks and budget_reservations tables.
CREATE SCHEMA agent_persistence;
CREATE TABLE agent_persistence.tasks (
  task_key text PRIMARY KEY,
  revision bigint NOT NULL CHECK (revision BETWEEN 0 AND 9007199254740991),
  record jsonb NOT NULL CHECK (jsonb_typeof(record) = 'object')
);
CREATE UNIQUE INDEX tasks_idempotency_key ON agent_persistence.tasks ((record->>'idempotencyKey'));
CREATE TABLE agent_persistence.scopes (
  key text PRIMARY KEY,
  cap_micro_usd bigint NOT NULL CHECK (cap_micro_usd BETWEEN 0 AND 9007199254740991)
);
CREATE TABLE agent_persistence.reservations (
  id text PRIMARY KEY,
  job_id text NOT NULL,
  amount_micro_usd bigint NOT NULL CHECK (amount_micro_usd BETWEEN 1 AND 9007199254740991),
  scopes jsonb NOT NULL,
  first_result jsonb,
  settled_micro_usd bigint CHECK (settled_micro_usd BETWEEN 0 AND 9007199254740991),
  CHECK (settled_micro_usd IS NULL OR first_result->>'ok' = 'true')
);
