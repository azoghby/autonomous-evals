-- Owner-reviewed SQL artifact only. No runtime DDL. Apply after prior workflow migrations.
CREATE SCHEMA IF NOT EXISTS workflow_comparison;
CREATE TABLE workflow_comparison.bindings (
 job_id uuid PRIMARY KEY REFERENCES jobs(id), suite jsonb NOT NULL, retained jsonb NOT NULL,
 binding jsonb NOT NULL, binding_digest text NOT NULL CHECK (binding_digest ~ '^[a-f0-9]{64}$')
);
-- Canonical operator binding publication is INSERT-only; replacement needs a new job/version authority.
CREATE TABLE workflow_comparison.costs (
 job_id uuid NOT NULL REFERENCES jobs(id), operation_id text NOT NULL, source text NOT NULL,
 id text NOT NULL, micro_usd bigint NOT NULL CHECK(micro_usd >= 0),
 PRIMARY KEY(job_id,source,id)
);
-- Grant the runtime role SELECT,INSERT only on bindings/costs; never UPDATE/DELETE.
-- Reconciliation is evidence inspection, never checkpoint release or automatic retry.
CREATE TABLE workflow_comparison.reconciliation (
 job_id uuid NOT NULL REFERENCES jobs(id), operation_id text NOT NULL, operator_id uuid NOT NULL,
 evidence_digest text NOT NULL CHECK(evidence_digest ~ '^[a-f0-9]{64}$'),
 decision text NOT NULL CHECK(decision IN ('retain_blocked','accept_retained_completion')),
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(job_id,operation_id,evidence_digest)
);
