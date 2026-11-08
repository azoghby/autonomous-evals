CREATE SCHEMA expert_sourcing;
-- Additive candidate only. Grants combine job authorization and exact derivation receipt.
CREATE TABLE expert_sourcing.policies (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES customers(id), environment text NOT NULL CHECK(environment IN ('test','live')),
 topic text NOT NULL CHECK(topic=btrim(topic) AND length(topic) BETWEEN 1 AND 160),
 caps_policy_id text NOT NULL REFERENCES expert_automation_policies(id),
 policy_version text NOT NULL CHECK(policy_version='expert_sourcing_policy.v1'),
 derivation_version text NOT NULL CHECK(derivation_version='factual_gap_exact_scope.v1'),
 execution_profile text NOT NULL CHECK(execution_profile='generic-text-factual-gap-v1'),
 sharing_envelope_version text NOT NULL CHECK(sharing_envelope_version='expert_sharing.v1'),
 max_requirements integer NOT NULL CHECK(max_requirements BETWEEN 1 AND 36),
 max_context_chars integer NOT NULL CHECK(max_context_chars BETWEEN 1 AND 16000),
 grant_lifetime_seconds integer NOT NULL CHECK(grant_lifetime_seconds BETWEEN 1 AND 604800),
 issued_by_operator text NOT NULL CHECK(length(issued_by_operator) BETWEEN 1 AND 320),
 issued_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
 revoked_at timestamptz, revoked_by text, revocation_reason text,
 CHECK(expires_at>issued_at), CHECK((revoked_at IS NULL AND revoked_by IS NULL AND revocation_reason IS NULL) OR (revoked_at>=issued_at AND revoked_by IS NOT NULL AND length(revocation_reason) BETWEEN 1 AND 500))
);
CREATE UNIQUE INDEX expert_sourcing_one_policy ON expert_sourcing.policies(tenant_id,environment,topic) WHERE revoked_at IS NULL;
CREATE TABLE expert_sourcing.consents (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES customers(id), job_id uuid NOT NULL REFERENCES jobs(id),
 authenticated_customer_id uuid NOT NULL REFERENCES customers(id), topic text NOT NULL CHECK(topic=btrim(topic) AND length(topic) BETWEEN 1 AND 160),
 canonical_input_digest text NOT NULL CHECK(canonical_input_digest ~ '^[a-f0-9]{64}$'),
 consent_version text NOT NULL CHECK(consent_version='expert_sharing_consent.v1'),
 disclosure_text_digest text NOT NULL CHECK(disclosure_text_digest ~ '^[a-f0-9]{64}$'),
 sharing_envelope_version text NOT NULL CHECK(sharing_envelope_version='expert_sharing.v1'),
 issued_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
 revoked_at timestamptz, revoked_by text, revocation_reason text,
 UNIQUE(job_id), CHECK(tenant_id=authenticated_customer_id), CHECK(expires_at>issued_at),
 CHECK((revoked_at IS NULL AND revoked_by IS NULL AND revocation_reason IS NULL) OR (revoked_at>=issued_at AND revoked_by IS NOT NULL AND length(revocation_reason) BETWEEN 1 AND 500))
);
CREATE TABLE expert_sourcing.grants (
 job_id uuid NOT NULL REFERENCES jobs(id), task_id text NOT NULL CHECK(task_id ~ '^[A-Za-z0-9][A-Za-z0-9:_-]{0,95}$'),
 tenant_id uuid NOT NULL REFERENCES customers(id), environment text NOT NULL CHECK(environment IN ('test','live')),
 policy_id uuid NOT NULL REFERENCES expert_sourcing.policies(id), consent_id uuid NOT NULL REFERENCES expert_sourcing.consents(id),
 topic text NOT NULL, proposal_digest text NOT NULL CHECK(proposal_digest ~ '^[a-f0-9]{64}$'),
 canonical_input_digest text NOT NULL CHECK(canonical_input_digest ~ '^[a-f0-9]{64}$'), target_digest text NOT NULL CHECK(target_digest ~ '^[a-f0-9]{64}$'),
 input_digest text NOT NULL CHECK(input_digest ~ '^[a-f0-9]{64}$'),
 request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
 derivation_version text NOT NULL CHECK(derivation_version='factual_gap_exact_scope.v1'),
 execution_profile text NOT NULL CHECK(execution_profile='generic-text-factual-gap-v1'),
 sharing_envelope_version text NOT NULL CHECK(sharing_envelope_version='expert_sharing.v1'),
 issued_via text NOT NULL CHECK(issued_via='standing_policy'), issued_by_policy text NOT NULL,
 issued_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
 revoked_at timestamptz, revoked_by text, revocation_reason text,
 PRIMARY KEY(job_id,task_id), CHECK(expires_at>issued_at),
 CHECK((revoked_at IS NULL AND revoked_by IS NULL AND revocation_reason IS NULL) OR (revoked_at>=issued_at AND revoked_by IS NOT NULL AND length(revocation_reason) BETWEEN 1 AND 500))
);
CREATE FUNCTION expert_sourcing_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'expert_sourcing_immutable'; END IF;
 IF (to_jsonb(NEW)-ARRAY['revoked_at','revoked_by','revocation_reason']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['revoked_at','revoked_by','revocation_reason']) OR OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL THEN RAISE EXCEPTION 'expert_sourcing_immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER expert_sourcing_policy_immutable BEFORE UPDATE OR DELETE ON expert_sourcing.policies FOR EACH ROW EXECUTE FUNCTION expert_sourcing_immutable();
CREATE TRIGGER expert_sourcing_consent_immutable BEFORE UPDATE OR DELETE ON expert_sourcing.consents FOR EACH ROW EXECUTE FUNCTION expert_sourcing_immutable();
CREATE TRIGGER expert_sourcing_grant_immutable BEFORE UPDATE OR DELETE ON expert_sourcing.grants FOR EACH ROW EXECUTE FUNCTION expert_sourcing_immutable();

ALTER TABLE expert_automation_scopes ADD COLUMN authority_kind text NOT NULL DEFAULT 'legacy_configured' CHECK(authority_kind IN ('legacy_configured','derived_standing_policy'));
-- Defense in depth: raw writers cannot attach another tenant's consent or grant.
CREATE FUNCTION expert_sourcing_check_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='consents' THEN
  IF NOT EXISTS(SELECT 1 FROM jobs j WHERE j.id=NEW.job_id AND j.customer_id=NEW.tenant_id) THEN RAISE EXCEPTION 'expert_sourcing_job_owner'; END IF;
 ELSE
  IF NOT EXISTS(SELECT 1 FROM jobs j JOIN expert_sourcing.policies p ON p.id=NEW.policy_id JOIN expert_sourcing.consents c ON c.id=NEW.consent_id WHERE j.id=NEW.job_id AND j.customer_id=NEW.tenant_id AND j.environment::text=NEW.environment AND p.tenant_id=NEW.tenant_id AND p.environment=NEW.environment AND p.topic=NEW.topic AND p.revoked_at IS NULL AND p.expires_at>now() AND c.job_id=NEW.job_id AND c.tenant_id=NEW.tenant_id AND c.topic=NEW.topic AND c.canonical_input_digest=NEW.canonical_input_digest AND c.revoked_at IS NULL AND c.expires_at>now() AND NEW.expires_at<=p.expires_at AND NEW.expires_at<=c.expires_at AND NEW.issued_by_policy=p.id::text) THEN RAISE EXCEPTION 'expert_sourcing_grant_binding'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER expert_sourcing_consent_binding BEFORE INSERT ON expert_sourcing.consents FOR EACH ROW EXECUTE FUNCTION expert_sourcing_check_binding();
CREATE TRIGGER expert_sourcing_grant_binding BEFORE INSERT ON expert_sourcing.grants FOR EACH ROW EXECUTE FUNCTION expert_sourcing_check_binding();
