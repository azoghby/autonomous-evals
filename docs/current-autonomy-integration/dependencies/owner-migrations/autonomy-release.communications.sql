
CREATE SCHEMA IF NOT EXISTS company_autonomy;
CREATE TABLE IF NOT EXISTS company_autonomy.message_days (
 tenant_id text NOT NULL, day text NOT NULL, reserved integer NOT NULL DEFAULT 0,
 PRIMARY KEY (tenant_id, day));
CREATE TABLE IF NOT EXISTS company_autonomy.messages (
 id text PRIMARY KEY, identity text NOT NULL, tenant_id text NOT NULL, day text NOT NULL,
 record jsonb NOT NULL, state text NOT NULL, deadline bigint NOT NULL, claim_token text);
