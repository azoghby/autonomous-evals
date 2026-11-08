BEGIN;
-- Optional application migration. Apply once through the application's migration
-- runner, in a transaction, before enabling createPostgresConversationPort.
-- Independent of Track A tables; no application ownership/auth policy is inferred.
CREATE TABLE reporting_chat_scopes (
  subject_id text NOT NULL CHECK (length(subject_id) BETWEEN 1 AND 256),
  job_id text NOT NULL CHECK (job_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$'),
  last_sequence bigint NOT NULL DEFAULT 0 CHECK (last_sequence BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY (subject_id, job_id)
);

CREATE TABLE reporting_chat_exchanges (
  subject_id text NOT NULL,
  job_id text NOT NULL,
  message_id text NOT NULL CHECK (message_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$'),
  input_digest text NOT NULL CHECK (input_digest ~ '^[a-f0-9]{64}$'),
  reply jsonb NOT NULL CHECK (jsonb_typeof(reply) = 'object'),
  sequence bigint NOT NULL CHECK (sequence BETWEEN 1 AND 9007199254740991),
  PRIMARY KEY (subject_id, job_id, message_id),
  UNIQUE (subject_id, job_id, sequence),
  FOREIGN KEY (subject_id, job_id) REFERENCES reporting_chat_scopes(subject_id, job_id)
);
-- The scoped sequence unique index also supports ordered keyset history paging.
-- No grants: provision a private server role; never expose these tables to clients.

COMMIT;
