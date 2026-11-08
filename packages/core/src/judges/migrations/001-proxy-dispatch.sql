-- Optional owner-applied sidecar. Requires agent_persistence and text_integration.
CREATE SCHEMA IF NOT EXISTS naive_proxy_dispatch;
CREATE TABLE IF NOT EXISTS naive_proxy_dispatch.operations (
 job_id text NOT NULL, operation_id text NOT NULL, input_digest text NOT NULL,
 policy jsonb NOT NULL, active_attempt integer NOT NULL CHECK(active_attempt > 0),
 legacy_checkpoint_id text NOT NULL,
 PRIMARY KEY(job_id,operation_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS proxy_dispatch_legacy_identity ON naive_proxy_dispatch.operations(job_id,legacy_checkpoint_id);
CREATE TABLE IF NOT EXISTS naive_proxy_dispatch.attempts (
 job_id text NOT NULL, operation_id text NOT NULL, attempt integer NOT NULL CHECK(attempt > 0),
 token text NOT NULL, checkpoint_id text NOT NULL UNIQUE, reservation_id text NOT NULL UNIQUE,
 state text NOT NULL CHECK(state IN ('prepared','denied','dispatched','abandoned')),
 reserved boolean NOT NULL,
 PRIMARY KEY(job_id,operation_id,attempt),
 FOREIGN KEY(job_id,operation_id) REFERENCES naive_proxy_dispatch.operations(job_id,operation_id),
 CHECK(state <> 'prepared' OR reserved), CHECK(state <> 'denied' OR NOT reserved)
);
CREATE TABLE IF NOT EXISTS naive_proxy_dispatch.recoveries (
 job_id text NOT NULL, operation_id text NOT NULL, attempt integer NOT NULL,
 actor_id text NOT NULL, reason text NOT NULL, recovered_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(job_id,operation_id,attempt),
 FOREIGN KEY(job_id,operation_id,attempt) REFERENCES naive_proxy_dispatch.attempts(job_id,operation_id,attempt)
);
CREATE OR REPLACE FUNCTION naive_proxy_dispatch.guard_operation_history() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'naive_proxy_dispatch_history_immutable'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.active_attempt<>1 THEN RAISE EXCEPTION 'naive_proxy_dispatch_invalid_initial_attempt'; END IF;
 ELSIF (to_jsonb(NEW)-'active_attempt') IS DISTINCT FROM (to_jsonb(OLD)-'active_attempt') THEN
  RAISE EXCEPTION 'naive_proxy_dispatch_identity_immutable';
 ELSIF NEW.active_attempt<>OLD.active_attempt THEN
  IF NEW.active_attempt<>OLD.active_attempt+1 OR NOT EXISTS(
   SELECT 1 FROM naive_proxy_dispatch.attempts WHERE job_id=OLD.job_id AND operation_id=OLD.operation_id AND attempt=OLD.active_attempt AND state='abandoned'
  ) THEN RAISE EXCEPTION 'naive_proxy_dispatch_invalid_attempt_transition'; END IF;
 END IF;
 RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS naive_proxy_dispatch_operation_history ON naive_proxy_dispatch.operations;
CREATE TRIGGER naive_proxy_dispatch_operation_history BEFORE INSERT OR UPDATE OR DELETE ON naive_proxy_dispatch.operations
FOR EACH ROW EXECUTE FUNCTION naive_proxy_dispatch.guard_operation_history();
CREATE OR REPLACE FUNCTION naive_proxy_dispatch.guard_attempt_history() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'naive_proxy_dispatch_history_immutable'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.state NOT IN ('prepared','denied') THEN RAISE EXCEPTION 'naive_proxy_dispatch_invalid_initial_state'; END IF;
 ELSIF (to_jsonb(NEW)-'state') IS DISTINCT FROM (to_jsonb(OLD)-'state') THEN
  RAISE EXCEPTION 'naive_proxy_dispatch_identity_immutable';
 ELSIF NEW.state<>OLD.state AND NOT(
  OLD.state='prepared' AND NEW.state IN ('dispatched','abandoned') OR OLD.state='denied' AND NEW.state='abandoned'
 ) THEN RAISE EXCEPTION 'naive_proxy_dispatch_invalid_state_transition';
 END IF;
 RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS naive_proxy_dispatch_attempt_history ON naive_proxy_dispatch.attempts;
CREATE TRIGGER naive_proxy_dispatch_attempt_history BEFORE INSERT OR UPDATE OR DELETE ON naive_proxy_dispatch.attempts
FOR EACH ROW EXECUTE FUNCTION naive_proxy_dispatch.guard_attempt_history();
CREATE OR REPLACE FUNCTION naive_proxy_dispatch.guard_recovery_history() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'naive_proxy_dispatch_recovery_audit_immutable';
END;
$$;
DROP TRIGGER IF EXISTS naive_proxy_dispatch_recovery_history ON naive_proxy_dispatch.recoveries;
CREATE TRIGGER naive_proxy_dispatch_recovery_history BEFORE UPDATE OR DELETE ON naive_proxy_dispatch.recoveries
FOR EACH ROW EXECUTE FUNCTION naive_proxy_dispatch.guard_recovery_history();
-- Coordinate with old SQL checkpoint writers without changing their application code.
-- prepare() takes this same advisory lock before inspecting legacy state. An old claim
-- that wins first prevents adoption; an adopted operation prevents all old claims.
CREATE OR REPLACE FUNCTION naive_proxy_dispatch.guard_legacy_checkpoint() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.kind IN ('naive_proxy_judge','naive_proxy_intent','naive_proxy_received') THEN
  PERFORM pg_advisory_xact_lock(hashtext(NEW.job_id),hashtext(NEW.id));
  IF EXISTS(SELECT 1 FROM naive_proxy_dispatch.operations WHERE job_id=NEW.job_id AND legacy_checkpoint_id=NEW.id) THEN
   RAISE EXCEPTION 'naive_proxy_dispatch_legacy_identity_fenced';
  END IF;
 END IF;
 RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS naive_proxy_dispatch_legacy_guard ON text_integration.checkpoints;
CREATE TRIGGER naive_proxy_dispatch_legacy_guard BEFORE INSERT ON text_integration.checkpoints
FOR EACH ROW EXECUTE FUNCTION naive_proxy_dispatch.guard_legacy_checkpoint();
