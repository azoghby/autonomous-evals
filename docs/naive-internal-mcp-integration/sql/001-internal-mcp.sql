-- Proposed additive migration; never applied by this candidate.
CREATE SCHEMA naive_internal;
CREATE TABLE naive_internal.credentials (
 id uuid PRIMARY KEY, role text NOT NULL CHECK(role='copilot'),
 agent_id text NOT NULL CHECK(length(agent_id) BETWEEN 1 AND 200),
 agent_version integer NOT NULL CHECK(agent_version>0),
 bearer_sha256 text NOT NULL UNIQUE CHECK(bearer_sha256 ~ '^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), revoked_at timestamptz,
 CHECK(revoked_at IS NULL OR revoked_at>=created_at)
);
CREATE UNIQUE INDEX one_active_internal_pin ON naive_internal.credentials(role,agent_id,agent_version) WHERE revoked_at IS NULL;
CREATE TABLE naive_internal.tasks (
 id uuid PRIMARY KEY, request_id uuid NOT NULL,
 customer_id uuid NOT NULL REFERENCES customers(id), job_id uuid NOT NULL REFERENCES jobs(id),
 environment text NOT NULL CHECK(environment IN ('test','live')),
 credential_id uuid NOT NULL REFERENCES naive_internal.credentials(id),
 role text NOT NULL CHECK(role='copilot'), agent_id text NOT NULL, agent_version integer NOT NULL CHECK(agent_version>0),
 nonce text NOT NULL UNIQUE CHECK(nonce ~ '^[A-Za-z0-9_-]{43}$'),
 issued_at bigint NOT NULL, expires_at bigint NOT NULL, revoked_at timestamptz,
 CHECK(expires_at>issued_at AND expires_at-issued_at<=300),
 UNIQUE(customer_id,job_id,request_id)
);
CREATE TABLE naive_internal.audit (
 id uuid PRIMARY KEY, credential_id uuid REFERENCES naive_internal.credentials(id),
 task_id uuid REFERENCES naive_internal.tasks(id),
 outcome text NOT NULL CHECK(outcome IN ('task_issued','task_replayed','task_revoked','read_allowed','auth_denied','rate_limited','request_denied','read_denied','internal_error')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE FUNCTION naive_internal.immutable_row() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'internal row immutable'; END IF;
 IF TG_TABLE_NAME='audit' THEN RAISE EXCEPTION 'internal audit immutable'; END IF;
 IF (to_jsonb(NEW)-'revoked_at') IS DISTINCT FROM (to_jsonb(OLD)-'revoked_at') OR OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL THEN
  RAISE EXCEPTION 'internal binding immutable';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER immutable_credentials BEFORE UPDATE OR DELETE ON naive_internal.credentials FOR EACH ROW EXECUTE FUNCTION naive_internal.immutable_row();
CREATE TRIGGER immutable_tasks BEFORE UPDATE OR DELETE ON naive_internal.tasks FOR EACH ROW EXECUTE FUNCTION naive_internal.immutable_row();
CREATE TRIGGER immutable_audit BEFORE UPDATE OR DELETE ON naive_internal.audit FOR EACH ROW EXECUTE FUNCTION naive_internal.immutable_row();
-- Defense in depth: no SQL caller can insert a task under a foreign/stale binding.
CREATE FUNCTION naive_internal.task_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM 1 FROM jobs WHERE id=NEW.job_id AND customer_id=NEW.customer_id AND environment::text=NEW.environment FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'internal job binding invalid'; END IF;
 PERFORM 1 FROM naive_internal.credentials WHERE id=NEW.credential_id AND role=NEW.role AND agent_id=NEW.agent_id AND agent_version=NEW.agent_version AND revoked_at IS NULL FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'internal credential binding invalid'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER task_binding BEFORE INSERT ON naive_internal.tasks FOR EACH ROW EXECUTE FUNCTION naive_internal.task_binding();
