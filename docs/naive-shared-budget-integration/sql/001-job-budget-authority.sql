CREATE SCHEMA IF NOT EXISTS job_budget;
CREATE TABLE job_budget.operations (
 operation_id text PRIMARY KEY,
 job_id uuid NOT NULL REFERENCES jobs(id),
 amount_micro_usd bigint NOT NULL CHECK(amount_micro_usd>0 AND amount_micro_usd<=9007199254740991),
 workflow_agent text,
 workflow_reservation_id uuid UNIQUE REFERENCES budget_reservations(id),
 agent_reservation_id text UNIQUE,
 admitted boolean NOT NULL,
 dispatched_at timestamptz,
 refunded_at timestamptz,
 cost_id uuid UNIQUE REFERENCES costs(id),
 CHECK (NOT (workflow_reservation_id IS NOT NULL AND agent_reservation_id IS NOT NULL)),
 CHECK (refunded_at IS NULL OR dispatched_at IS NULL)
);
CREATE INDEX ON job_budget.operations(job_id);
ALTER TABLE job_budget.operations ADD COLUMN completed_at timestamptz;
CREATE TABLE job_budget.cost_links (
 operation_id text NOT NULL REFERENCES job_budget.operations(operation_id),
 cost_id uuid PRIMARY KEY REFERENCES costs(id)
);
CREATE TABLE job_budget.model_admissions (
 reservation_id text PRIMARY KEY,
 job_id uuid NOT NULL REFERENCES jobs(id),
 amount_micro_usd bigint NOT NULL CHECK(amount_micro_usd>0),
 request_digest text NOT NULL,
 admitted boolean NOT NULL,
 remaining_micro_usd bigint NOT NULL CHECK(remaining_micro_usd>=0)
);
-- Retained evidence cannot be reinterpreted or removed by an application retry.
CREATE FUNCTION job_budget.guard_operation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'job_budget_evidence_immutable'; END IF;
 IF (NEW.operation_id,NEW.job_id,NEW.amount_micro_usd,NEW.workflow_agent,NEW.workflow_reservation_id,NEW.agent_reservation_id,NEW.admitted)
 IS DISTINCT FROM
 (OLD.operation_id,OLD.job_id,OLD.amount_micro_usd,OLD.workflow_agent,OLD.workflow_reservation_id,OLD.agent_reservation_id,OLD.admitted)
 OR (OLD.dispatched_at IS NOT NULL AND NEW.dispatched_at IS DISTINCT FROM OLD.dispatched_at)
 OR (OLD.refunded_at IS NOT NULL AND NEW.refunded_at IS DISTINCT FROM OLD.refunded_at)
 OR (OLD.completed_at IS NOT NULL AND NEW.completed_at IS DISTINCT FROM OLD.completed_at)
 OR (OLD.cost_id IS NOT NULL AND NEW.cost_id IS DISTINCT FROM OLD.cost_id)
 OR (NOT NEW.admitted AND (NEW.dispatched_at IS NOT NULL OR NEW.refunded_at IS NOT NULL OR NEW.completed_at IS NOT NULL OR NEW.cost_id IS NOT NULL))
 OR (NEW.completed_at IS NOT NULL AND (NEW.dispatched_at IS NULL OR NEW.refunded_at IS NOT NULL))
 OR (NEW.cost_id IS NOT NULL AND (NEW.dispatched_at IS NULL OR NEW.refunded_at IS NOT NULL))
 THEN RAISE EXCEPTION 'job_budget_evidence_immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER retain_operation BEFORE UPDATE OR DELETE ON job_budget.operations FOR EACH ROW EXECUTE FUNCTION job_budget.guard_operation();
CREATE FUNCTION job_budget.guard_retained() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' OR NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'job_budget_evidence_immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER retain_model_admission BEFORE UPDATE OR DELETE ON job_budget.model_admissions FOR EACH ROW EXECUTE FUNCTION job_budget.guard_retained();
CREATE TRIGGER retain_cost_link BEFORE UPDATE OR DELETE ON job_budget.cost_links FOR EACH ROW EXECUTE FUNCTION job_budget.guard_retained();
