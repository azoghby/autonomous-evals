CREATE SCHEMA IF NOT EXISTS company_autonomy;
-- One tenant/period lock serializes reservations across policy versions and workers.
CREATE TABLE IF NOT EXISTS company_autonomy.periods (
 tenant_id text NOT NULL, period_id text NOT NULL, root_cap bigint NOT NULL CHECK(root_cap > 0),
 PRIMARY KEY(tenant_id, period_id)
);
CREATE TABLE IF NOT EXISTS company_autonomy.policies (
 tenant_id text NOT NULL, version text NOT NULL, digest text NOT NULL, record jsonb NOT NULL,
 PRIMARY KEY(tenant_id, version)
);
CREATE TABLE IF NOT EXISTS company_autonomy.actions (
 tenant_id text NOT NULL, action_key text NOT NULL, period_id text NOT NULL,
 job_id text NOT NULL, role text NOT NULL, held bigint NOT NULL CHECK(held >= 0),
 record jsonb NOT NULL, PRIMARY KEY(tenant_id, action_key)
);
CREATE INDEX IF NOT EXISTS autonomy_actions_period ON company_autonomy.actions(tenant_id, period_id);
CREATE TABLE IF NOT EXISTS company_autonomy.decisions (
 tenant_id text NOT NULL, decision_key text NOT NULL, record jsonb NOT NULL,
 PRIMARY KEY(tenant_id, decision_key)
);

-- Package classification and cap are frozen at the first admission; a later action cannot
-- claim comparison pricing or a fresh accounting period to increase one job's authority.
CREATE TABLE IF NOT EXISTS company_autonomy.jobs (
 tenant_id text NOT NULL, job_id text NOT NULL, comparison boolean NOT NULL,
 cap bigint NOT NULL CHECK(cap > 0), PRIMARY KEY(tenant_id,job_id)
);

CREATE TABLE IF NOT EXISTS company_autonomy.daily_audits (
 tenant_id text NOT NULL, day text NOT NULL, digest text NOT NULL, record jsonb NOT NULL,
 PRIMARY KEY(tenant_id,day)
);
