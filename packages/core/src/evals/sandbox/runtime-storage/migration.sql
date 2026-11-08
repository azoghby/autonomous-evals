-- Optional owner-applied artifact. No external migration is performed by this package.
CREATE SCHEMA IF NOT EXISTS sandbox_runtime_storage;
CREATE TABLE IF NOT EXISTS sandbox_runtime_storage.images (
  scope_key text NOT NULL,
  run_id text NOT NULL,
  binding_digest text NOT NULL,
  metadata jsonb NOT NULL,
  metadata_digest text NOT NULL,
  image_digest text NOT NULL,
  image_size bigint NOT NULL CHECK (image_size > 0 AND image_size <= 268435456),
  image bytea,
  needed boolean NOT NULL DEFAULT true,
  retain_until bigint NOT NULL DEFAULT 0 CHECK (retain_until >= 0),
  PRIMARY KEY (scope_key, run_id),
  CHECK (image IS NULL OR octet_length(image) = image_size)
);
-- The server SQL role must be private; direct table access bypasses application authorization.
