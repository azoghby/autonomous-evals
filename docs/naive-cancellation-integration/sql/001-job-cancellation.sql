-- Candidate only. Apply after stage recovery migrations, never automatically.
CREATE TABLE workflow_stage.cancellations (
 job_id uuid PRIMARY KEY REFERENCES jobs(id),
 reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 1000),
 requested_by uuid NOT NULL REFERENCES customers(id),
 as_operator boolean NOT NULL,
 requested_at timestamptz NOT NULL DEFAULT now(),
 last_attempt_at timestamptz,
 checkout_done_at timestamptz,
 event_delivered_at timestamptz
);

CREATE INDEX cancellation_pending_attempt_idx ON workflow_stage.cancellations
 (COALESCE(last_attempt_at,'epoch'::timestamptz),requested_at,job_id)
 WHERE event_delivered_at IS NULL OR checkout_done_at IS NULL;

-- Preserve the request/outbox payload forever; attempt and delivery metadata remain mutable.
CREATE FUNCTION workflow_stage.keep_cancellation_request() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'cancellation requests are immutable'; END IF;
 IF (NEW.job_id,NEW.reason,NEW.requested_by,NEW.as_operator,NEW.requested_at)
    IS DISTINCT FROM (OLD.job_id,OLD.reason,OLD.requested_by,OLD.as_operator,OLD.requested_at)
    OR (OLD.checkout_done_at IS NOT NULL AND NEW.checkout_done_at IS DISTINCT FROM OLD.checkout_done_at)
    OR (OLD.event_delivered_at IS NOT NULL AND NEW.event_delivered_at IS DISTINCT FROM OLD.event_delivered_at)
 THEN RAISE EXCEPTION 'cancellation requests are immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER keep_cancellation_request BEFORE UPDATE OR DELETE ON workflow_stage.cancellations
 FOR EACH ROW EXECUTE FUNCTION workflow_stage.keep_cancellation_request();
