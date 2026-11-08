-- Artifact only. Apply explicitly using the deployment migration role.
CREATE SCHEMA IF NOT EXISTS evaluation_data_persistence;
CREATE TABLE IF NOT EXISTS evaluation_data_persistence.operations (
  tenant_id text NOT NULL CHECK (tenant_id ~ '^[A-Za-z0-9_-]{1,96}$'),
  job_id text NOT NULL CHECK (job_id ~ '^[A-Za-z0-9_-]{1,96}$'),
  operation_key text NOT NULL CHECK (length(operation_key) BETWEEN 1 AND 4096),
  digest text NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
  owner_id text NOT NULL CHECK (owner_id ~ '^[A-Za-z0-9_-]{1,96}$'),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'complete')),
  result jsonb,
  result_digest text CHECK (result_digest ~ '^[a-f0-9]{64}$'),
  reconciliation_receipt text CHECK (reconciliation_receipt ~ '^[A-Za-z0-9_-]{1,96}$'),
  PRIMARY KEY (tenant_id, job_id, operation_key),
  CHECK ((state = 'pending' AND result IS NULL AND result_digest IS NULL AND reconciliation_receipt IS NULL)
    OR (state = 'complete' AND result IS NOT NULL AND result_digest IS NOT NULL)),
  CHECK (octet_length(result::text) <= 1000000)
);
-- Guard accidental privileged application SQL too. Migration owners can intentionally change
-- schema; no application can be made safe against a malicious superuser.
CREATE OR REPLACE FUNCTION evaluation_data_persistence.guard_operation_immutability()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'data_operation_immutable'; END IF;
  IF ROW(NEW.tenant_id, NEW.job_id, NEW.operation_key, NEW.digest, NEW.owner_id)
     IS DISTINCT FROM ROW(OLD.tenant_id, OLD.job_id, OLD.operation_key, OLD.digest, OLD.owner_id)
     OR (OLD.state = 'complete' AND NEW IS DISTINCT FROM OLD) THEN
    RAISE EXCEPTION 'data_operation_immutable';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS operation_immutability ON evaluation_data_persistence.operations;
CREATE TRIGGER operation_immutability BEFORE UPDATE OR DELETE ON evaluation_data_persistence.operations
FOR EACH ROW EXECUTE FUNCTION evaluation_data_persistence.guard_operation_immutability();
