-- Unapplied. Requires agent-persistence and internal-mcp migrations first.
CREATE SCHEMA IF NOT EXISTS naive_copilot;
CREATE TABLE naive_copilot.dispatches (
 id text PRIMARY KEY, identity jsonb NOT NULL, body_ciphertext text NOT NULL,
 state text NOT NULL CHECK(state IN ('reserved','ambiguous','running','completed','failed','revoked')),
 revision integer NOT NULL DEFAULT 0 CHECK(revision >= 0), session_id text,
 lease_owner text, lease_until bigint NOT NULL DEFAULT 0,
 consumed_micro_usd bigint CHECK(consumed_micro_usd >= 0)
);
CREATE UNIQUE INDEX copilot_initial_thread ON naive_copilot.dispatches ((identity->'task'->>'customerId'),(identity->'task'->>'jobId'),(identity->>'threadId'));
CREATE UNIQUE INDEX copilot_task_once ON naive_copilot.dispatches ((identity->'task'->>'id'));
CREATE TABLE naive_copilot.cost_outbox (
 dispatch_id text PRIMARY KEY REFERENCES naive_copilot.dispatches(id),
 job_id uuid NOT NULL REFERENCES jobs(id), customer_id uuid NOT NULL REFERENCES customers(id),
 environment text NOT NULL CHECK(environment IN ('test','live')),
 session_id text NOT NULL, consumed_micro_usd bigint NOT NULL CHECK(consumed_micro_usd >= 0),
 source text NOT NULL DEFAULT 'naive' CHECK(source='naive'), delivered_at timestamptz
);
CREATE FUNCTION naive_copilot.immutable_dispatch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.id IS DISTINCT FROM OLD.id OR NEW.identity IS DISTINCT FROM OLD.identity OR NEW.body_ciphertext IS DISTINCT FROM OLD.body_ciphertext THEN
  RAISE EXCEPTION 'copilot_dispatch_immutable';
 END IF;
 IF OLD.state IN ('completed','failed','revoked') AND (NEW.state IS DISTINCT FROM OLD.state OR NEW.session_id IS DISTINCT FROM OLD.session_id OR NEW.consumed_micro_usd IS DISTINCT FROM OLD.consumed_micro_usd) THEN RAISE EXCEPTION 'copilot_dispatch_terminal'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER immutable_dispatch BEFORE UPDATE ON naive_copilot.dispatches FOR EACH ROW EXECUTE FUNCTION naive_copilot.immutable_dispatch();

CREATE UNIQUE INDEX copilot_receipt_session ON naive_copilot.cost_outbox(session_id);
CREATE FUNCTION naive_copilot.protect_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'copilot_dispatch_immutable'; END IF;
 IF (to_jsonb(NEW)-'delivered_at') IS DISTINCT FROM (to_jsonb(OLD)-'delivered_at') OR OLD.delivered_at IS NOT NULL THEN RAISE EXCEPTION 'copilot_receipt_immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER immutable_receipt BEFORE UPDATE OR DELETE ON naive_copilot.cost_outbox FOR EACH ROW EXECUTE FUNCTION naive_copilot.protect_receipt();
CREATE FUNCTION naive_copilot.reject_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'copilot_dispatch_immutable'; END $$;
CREATE TRIGGER retain_dispatch BEFORE DELETE ON naive_copilot.dispatches FOR EACH ROW EXECUTE FUNCTION naive_copilot.reject_delete();
