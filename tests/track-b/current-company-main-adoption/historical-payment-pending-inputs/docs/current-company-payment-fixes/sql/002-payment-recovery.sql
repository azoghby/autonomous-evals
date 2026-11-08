-- Apply after the exact current-payment migration. No automatic startup DDL.
ALTER TABLE current_autonomy_payment.outbox
 ADD COLUMN IF NOT EXISTS last_attempt_at bigint NOT NULL DEFAULT 0;

-- Retire only permanently unusable events. Unknown/transient authorization
-- failures remain pending and rotate fairly through the bounded bridge drain.
CREATE OR REPLACE FUNCTION current_autonomy_payment.retire_receipts(max_rows integer)
RETURNS integer LANGUAGE plpgsql AS $$
DECLARE retired integer;
BEGIN
 IF max_rows<1 OR max_rows>1000 OR max_rows IS NULL THEN RAISE EXCEPTION 'retirement_limit_refused'; END IF;
 WITH terminal AS (
  SELECT o.provider,o.environment,o.event_id
  FROM current_autonomy_payment.outbox o
  JOIN current_autonomy_payment.events ev USING(provider,environment,event_id)
  JOIN current_autonomy_payment.bindings b USING(tenant_id,job_id,quote_version)
  JOIN public.jobs j ON j.id::text=ev.job_id
  WHERE NOT o.delivered AND (
   ev.status IN ('refunded','cancelled') OR b.revoked
   OR j.state::text IN ('cancelled','failed','delivered')
   OR ev.quote_version < (SELECT max(q.version) FROM public.quotes q WHERE q.job_id=j.id)
  )
  ORDER BY o.last_attempt_at,o.provider,o.environment,o.event_id
  LIMIT max_rows FOR UPDATE OF o SKIP LOCKED
 )
 UPDATE current_autonomy_payment.outbox o SET delivered=true FROM terminal t
 WHERE o.provider=t.provider AND o.environment=t.environment AND o.event_id=t.event_id;
 GET DIAGNOSTICS retired=ROW_COUNT;
 RETURN retired;
END $$;
REVOKE ALL ON FUNCTION current_autonomy_payment.retire_receipts(integer) FROM PUBLIC;
