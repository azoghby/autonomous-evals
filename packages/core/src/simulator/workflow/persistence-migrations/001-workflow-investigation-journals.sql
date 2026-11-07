-- OPTIONAL application-database migration. Never apply to simulator branches automatically.
-- Application roles must not modify these rows outside the validated journal adapter.
CREATE TABLE IF NOT EXISTS app_workflow_investigation_journals (
  tenant_id text NOT NULL CHECK (length(tenant_id) BETWEEN 1 AND 128),
  journal_key text NOT NULL CHECK (length(journal_key) BETWEEN 1 AND 1024),
  record jsonb NOT NULL CHECK (
    jsonb_typeof(record) = 'object'
    AND jsonb_typeof(record->'original') = 'object'
    AND jsonb_typeof(record->'attempts') = 'array'
    AND jsonb_array_length(record->'attempts') <= 3
    AND record ?& ARRAY['original', 'attempts']
  ),
  PRIMARY KEY (tenant_id, journal_key)
);
