-- app.autonomy-release.001 (owner migration registry; runner-owned transaction).
-- Apply after core autonomy operations and communications migrations. No startup auto-DDL.
-- Server adapters MUST reauthorize tenant/job, source expiry, quote identity and provider
-- receipts on every read/effect. Database ownership is not customer authorization.
CREATE SCHEMA IF NOT EXISTS company_autonomy_release;
REVOKE ALL ON SCHEMA company_autonomy_release FROM PUBLIC;

CREATE TABLE IF NOT EXISTS company_autonomy_release.job_bindings (
 tenant_id text NOT NULL CHECK(length(tenant_id) BETWEEN 1 AND 200),
 job_id text NOT NULL CHECK(length(job_id) BETWEEN 1 AND 200),
 owner_id text NOT NULL CHECK(length(owner_id) BETWEEN 1 AND 200),
 policy_version text NOT NULL CHECK(length(policy_version) BETWEEN 1 AND 200),
 request jsonb NOT NULL CHECK(jsonb_typeof(request) = 'object'),
 enabled boolean NOT NULL DEFAULT false,
 next_tick_at bigint NOT NULL CHECK(next_tick_at >= 0),
 PRIMARY KEY(tenant_id,job_id)
);
CREATE INDEX IF NOT EXISTS autonomy_release_due_jobs
 ON company_autonomy_release.job_bindings(next_tick_at,tenant_id,job_id) WHERE enabled;

-- Permissions are evidence supplied by an authorized source adapter, never model output.
CREATE TABLE IF NOT EXISTS company_autonomy_release.source_permissions (
 tenant_id text NOT NULL, job_id text NOT NULL,
 source_id text NOT NULL CHECK(length(source_id) BETWEEN 1 AND 200),
 permission_digest text NOT NULL CHECK(permission_digest ~ '^[a-f0-9]{64}$'),
 allowed boolean NOT NULL,
 expires_at bigint NOT NULL CHECK(expires_at >= 0),
 PRIMARY KEY(tenant_id,job_id,source_id),
 FOREIGN KEY(tenant_id,job_id) REFERENCES company_autonomy_release.job_bindings(tenant_id,job_id)
);
CREATE TABLE IF NOT EXISTS company_autonomy_release.payment_receipts (
 tenant_id text NOT NULL, job_id text NOT NULL,
 receipt_id text NOT NULL CHECK(length(receipt_id) BETWEEN 1 AND 200),
 settled boolean NOT NULL DEFAULT false,
 amount_micro_usd bigint CHECK(amount_micro_usd >= 0 AND amount_micro_usd <= 9007199254740991),
 currency text NOT NULL DEFAULT 'USD' CHECK(currency = 'USD'),
 record jsonb NOT NULL CHECK(jsonb_typeof(record) = 'object'
   AND COALESCE(record->>'quoteDigest','') ~ '^[a-f0-9]{64}$'),
 CHECK(NOT settled OR amount_micro_usd IS NOT NULL),
 PRIMARY KEY(tenant_id,job_id,receipt_id),
 FOREIGN KEY(tenant_id,job_id) REFERENCES company_autonomy_release.job_bindings(tenant_id,job_id)
);
-- This cache contains authoritative lookup results only. Absence never permits redispatch.
CREATE TABLE IF NOT EXISTS company_autonomy_release.provider_receipts (
 tenant_id text NOT NULL, job_id text NOT NULL,
 action_key text NOT NULL CHECK(length(action_key) BETWEEN 1 AND 200),
 provider_id text NOT NULL CHECK(length(provider_id) BETWEEN 1 AND 200),
 receipt jsonb NOT NULL CHECK(jsonb_typeof(receipt) = 'object'),
 PRIMARY KEY(tenant_id,job_id,action_key),
 FOREIGN KEY(tenant_id,job_id) REFERENCES company_autonomy_release.job_bindings(tenant_id,job_id)
);
REVOKE ALL ON ALL TABLES IN SCHEMA company_autonomy_release FROM PUBLIC;
-- Explicit owner-controlled server-role grants remain a deployment prerequisite. No grants
-- to anon, authenticated customer, model, scheduler HTTP caller or provider are inferred.
-- Budget authority remains core company_autonomy.{periods,policies,jobs,actions,decisions}
-- plus the SAME PostgresBudgetLedger reservation wrapped by createAutonomousBudgetLedger.
-- No duplicate monetary ledger and no forged legacy-human review/publication are introduced.
