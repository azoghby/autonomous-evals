-- Additive owner migration. Apply after exact f88811c release schema; never auto-DDL at startup.
-- Functions are SECURITY INVOKER and PUBLIC has no access. Only a reviewed server role may call
-- ingest after signature verification; database privileges are not proof of a provider signature.
CREATE SCHEMA IF NOT EXISTS current_autonomy_payment;
REVOKE ALL ON SCHEMA current_autonomy_payment FROM PUBLIC;
CREATE TABLE IF NOT EXISTS current_autonomy_payment.bindings (
 tenant_id text NOT NULL, job_id text NOT NULL, quote_version integer NOT NULL CHECK(quote_version>0),
 quote_digest text NOT NULL CHECK(quote_digest ~ '^[a-f0-9]{64}$'),
 request_digest text NOT NULL CHECK(request_digest ~ '^[a-f0-9]{64}$'),
 environment text NOT NULL CHECK(environment IN ('test','live')),
 currency text NOT NULL DEFAULT 'USD' CHECK(currency='USD'),
 amount_cents bigint NOT NULL CHECK(amount_cents>0 AND amount_cents<=900719925474),
 session_id text, revoked boolean NOT NULL DEFAULT false,
 PRIMARY KEY(tenant_id,job_id,quote_version), UNIQUE(environment,session_id)
);
CREATE TABLE IF NOT EXISTS current_autonomy_payment.events (
 provider text NOT NULL CHECK(provider='stripe'), environment text NOT NULL CHECK(environment IN ('test','live')),
 event_id text NOT NULL CHECK(length(event_id) BETWEEN 1 AND 200),
 event_digest text NOT NULL CHECK(event_digest ~ '^[a-f0-9]{64}$'),
 tenant_id text NOT NULL,job_id text NOT NULL,quote_version integer NOT NULL,
 session_id text NOT NULL,amount_cents bigint NOT NULL CHECK(amount_cents>0),
 currency text NOT NULL CHECK(currency='USD'), status text NOT NULL CHECK(status IN ('paid','refunded','cancelled')),
 quote_digest text NOT NULL CHECK(quote_digest ~ '^[a-f0-9]{64}$'),payment_id text NOT NULL,
 PRIMARY KEY(provider,environment,event_id),
 FOREIGN KEY(tenant_id,job_id,quote_version) REFERENCES current_autonomy_payment.bindings(tenant_id,job_id,quote_version)
);
CREATE TABLE IF NOT EXISTS current_autonomy_payment.outbox (
 provider text NOT NULL,environment text NOT NULL,event_id text NOT NULL,
 delivered boolean NOT NULL DEFAULT false,
 PRIMARY KEY(provider,environment,event_id),
 FOREIGN KEY(provider,environment,event_id) REFERENCES current_autonomy_payment.events(provider,environment,event_id)
);

CREATE OR REPLACE FUNCTION current_autonomy_payment.prepare_binding(
 t text,j text,v integer,qd text,rd text,e text,a bigint,s text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE b current_autonomy_payment.bindings; q public.quotes; job public.jobs;
BEGIN
 SELECT * INTO job FROM public.jobs WHERE id::text=j FOR UPDATE;
 IF NOT FOUND OR job.customer_id::text<>t OR job.environment::text<>e OR job.is_mock
 OR job.workflow_run_id IS NULL OR job.state::text IN ('cancelled','failed','delivered') THEN RAISE EXCEPTION 'canonical_job_refused'; END IF;
 SELECT * INTO q FROM public.quotes WHERE job_id::text=j ORDER BY version DESC LIMIT 1 FOR UPDATE;
 IF NOT FOUND OR q.version<>v OR q.pricing_mode<>'fixed' OR q.price_cents<>a OR q.package<>job.package
 OR (s IS NOT NULL AND q.stripe_checkout_session_id IS DISTINCT FROM s) THEN RAISE EXCEPTION 'canonical_quote_refused'; END IF;
 SELECT * INTO b FROM current_autonomy_payment.bindings WHERE tenant_id=t AND job_id=j AND quote_version=v FOR UPDATE;
 IF FOUND THEN
  IF b.quote_digest<>qd OR b.request_digest<>rd OR b.environment<>e OR b.amount_cents<>a OR b.revoked
   OR (s IS NOT NULL AND b.session_id IS NOT NULL AND b.session_id<>s) THEN RAISE EXCEPTION 'binding_replay_conflict'; END IF;
  IF b.session_id IS NULL AND s IS NOT NULL THEN UPDATE current_autonomy_payment.bindings SET session_id=s WHERE tenant_id=t AND job_id=j AND quote_version=v; END IF;
  RETURN 'duplicate';
 END IF;
 INSERT INTO current_autonomy_payment.bindings(tenant_id,job_id,quote_version,quote_digest,request_digest,environment,amount_cents,session_id)
 VALUES(t,j,v,qd,rd,e,a,s);
 RETURN 'prepared';
END $$;

CREATE OR REPLACE FUNCTION current_autonomy_payment.ingest_event(
 t text,j text,v integer,p text,e text,eid text,ed text,s text,a bigint,c text,st text,qd text,pid text)
 RETURNS text LANGUAGE plpgsql AS $$
DECLARE b current_autonomy_payment.bindings; prior current_autonomy_payment.events; q public.quotes; job public.jobs; pay public.payments;
BEGIN
 -- Lock canonical job first: serializes independent events for the same quote/session.
 SELECT * INTO job FROM public.jobs WHERE id::text=j FOR UPDATE;
 IF NOT FOUND OR job.customer_id::text<>t OR job.environment::text<>e OR job.is_mock THEN RAISE EXCEPTION 'canonical_job_refused'; END IF;
 SELECT * INTO b FROM current_autonomy_payment.bindings WHERE tenant_id=t AND job_id=j AND quote_version=v FOR UPDATE;
 IF NOT FOUND OR b.environment<>e OR b.quote_digest<>qd OR b.amount_cents<>a OR c<>'USD' OR p<>'stripe'
 THEN RAISE EXCEPTION 'event_binding_refused'; END IF;
 SELECT * INTO prior FROM current_autonomy_payment.events WHERE provider=p AND environment=e AND event_id=eid;
 IF FOUND THEN
  IF prior.event_digest<>ed OR prior.tenant_id<>t OR prior.job_id<>j OR prior.quote_version<>v OR prior.session_id<>s
   OR prior.amount_cents<>a OR prior.currency<>c OR prior.status<>st OR prior.quote_digest<>qd OR prior.payment_id<>pid
   THEN RAISE EXCEPTION 'provider_event_replay_conflict'; END IF;
  RETURN 'duplicate';
 END IF;
 SELECT * INTO q FROM public.quotes WHERE job_id::text=j AND version=v FOR UPDATE;
 IF NOT FOUND OR q.pricing_mode<>'fixed' OR q.price_cents<>a OR q.stripe_checkout_session_id IS DISTINCT FROM s
 OR b.session_id IS NOT NULL AND b.session_id<>s THEN RAISE EXCEPTION 'canonical_quote_refused'; END IF;
 SELECT * INTO pay FROM public.payments WHERE id::text=pid FOR UPDATE;
 IF NOT FOUND OR pay.job_id::text<>j OR pay.quote_version<>v OR pay.stripe_checkout_session_id<>s
 OR pay.environment::text<>e OR upper(pay.currency)<>c OR pay.amount_cents<>a OR pay.kind<>'one_time'
 OR (st='paid' AND pay.status<>'paid') THEN RAISE EXCEPTION 'canonical_payment_refused'; END IF;
 -- Late/stale/cancelled fixed payments remain retained evidence, but never publish usable authority.
 UPDATE current_autonomy_payment.bindings SET session_id=s,revoked=revoked OR st<>'paid'
  OR job.state::text IN ('cancelled','failed','delivered')
  OR v<>(SELECT max(version) FROM public.quotes WHERE job_id::text=j)
 WHERE tenant_id=t AND job_id=j AND quote_version=v;
 INSERT INTO current_autonomy_payment.events VALUES(p,e,eid,ed,t,j,v,s,a,c,st,qd,pid);
 INSERT INTO current_autonomy_payment.outbox VALUES(p,e,eid,false);
 IF st<>'paid' THEN UPDATE company_autonomy_release.payment_receipts SET settled=false WHERE tenant_id=t AND job_id=j AND record->>'quoteDigest'=qd; END IF;
 RETURN 'queued';
END $$;

CREATE OR REPLACE FUNCTION current_autonomy_payment.receipt_valid(t text,j text,qd text,rid text)
 RETURNS boolean LANGUAGE sql AS $$
 SELECT EXISTS (
 SELECT 1 FROM current_autonomy_payment.bindings b
 JOIN current_autonomy_payment.events ev USING(tenant_id,job_id,quote_version)
 JOIN public.jobs job ON job.id::text=b.job_id
 JOIN public.quotes q ON q.job_id=job.id AND q.version=b.quote_version
 JOIN public.payments pay ON pay.id::text=ev.payment_id
 JOIN company_autonomy_release.job_bindings rel ON rel.tenant_id=b.tenant_id AND rel.job_id=b.job_id
 WHERE b.tenant_id=t AND b.job_id=j AND b.quote_digest=qd AND NOT b.revoked AND rel.enabled
 AND rel.owner_id=t AND rel.request->>'tenantId'=t AND rel.request->'job'->>'customerId'=t
 AND rel.request->'job'->>'jobId'=j AND rel.request->'job'->>'environment'=b.environment
 AND job.customer_id::text=t AND NOT job.is_mock AND job.workflow_run_id IS NOT NULL
 AND job.state::text NOT IN ('cancelled','failed','delivered') AND job.environment::text=b.environment
 AND q.version=(SELECT max(version) FROM public.quotes WHERE job_id=job.id)
 AND q.pricing_mode='fixed' AND q.package=job.package AND q.price_cents=b.amount_cents AND q.accepted_at IS NOT NULL
 AND q.stripe_checkout_session_id=b.session_id AND ev.session_id=b.session_id AND ev.environment=b.environment
 AND ev.quote_digest=b.quote_digest AND ev.amount_cents=b.amount_cents AND ev.currency=b.currency AND ev.status='paid'
 AND rid=ev.provider||':'||ev.environment||':'||ev.event_id
 AND pay.job_id=job.id AND pay.quote_version=q.version AND pay.stripe_checkout_session_id=b.session_id
 AND pay.environment::text=b.environment AND upper(pay.currency)=b.currency AND pay.amount_cents=b.amount_cents
 AND pay.status='paid' AND pay.kind='one_time'
 AND NOT EXISTS(SELECT 1 FROM public.payments other WHERE other.job_id=job.id AND other.quote_version=q.version
  AND other.id<>pay.id AND other.kind='one_time' AND other.status IN ('paid','authorized','captured'))
 );
$$;

CREATE OR REPLACE FUNCTION current_autonomy_payment.publish_receipt(t text,j text,eid text)
 RETURNS text LANGUAGE plpgsql AS $$
DECLARE ev current_autonomy_payment.events; rid text;
BEGIN
 PERFORM 1 FROM public.jobs WHERE id::text=j FOR UPDATE;
 SELECT * INTO ev FROM current_autonomy_payment.events WHERE tenant_id=t AND job_id=j AND event_id=eid AND provider='stripe';
 IF NOT FOUND THEN RAISE EXCEPTION 'verified_event_missing'; END IF;
 rid:=ev.provider||':'||ev.environment||':'||ev.event_id;
 IF NOT current_autonomy_payment.receipt_valid(t,j,ev.quote_digest,rid) THEN RETURN 'waiting_or_revoked'; END IF;
 INSERT INTO company_autonomy_release.payment_receipts(tenant_id,job_id,receipt_id,settled,amount_micro_usd,currency,record)
 VALUES(t,j,rid,true,ev.amount_cents*10000,'USD',jsonb_build_object('quoteDigest',ev.quote_digest,'provider',ev.provider,'environment',ev.environment,'providerEventId',ev.event_id,'providerEventDigest',ev.event_digest,'paymentId',ev.payment_id,'sessionId',ev.session_id))
 ON CONFLICT(tenant_id,job_id,receipt_id) DO NOTHING;
 UPDATE current_autonomy_payment.outbox SET delivered=true WHERE provider=ev.provider AND environment=ev.environment AND event_id=eid;
 RETURN 'published';
END $$;
REVOKE ALL ON ALL TABLES IN SCHEMA current_autonomy_payment FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA current_autonomy_payment FROM PUBLIC;
