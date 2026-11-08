-- app.autonomy-paid-authority.001. Owner transaction/registry only; after autonomy-release access.
-- Existing bindings remain NULL and fail closed. The owner must explicitly reauthorize
-- their immutable original policy and paid caps; this migration never infers/backfills authority.
ALTER TABLE company_autonomy_release.job_bindings
 ADD COLUMN authority_digest text CHECK(authority_digest IS NULL OR authority_digest ~ '^[a-f0-9]{64}$');
