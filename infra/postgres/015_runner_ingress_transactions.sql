BEGIN;

-- The signed job and submitted platform evidence are retained in the lease so
-- retries replay identical bytes and terminal aggregation never trusts a
-- mutable Runner request. Existing development rows are intentionally not
-- backfilled; NOT VALID constraints still protect every new write.
ALTER TABLE deviludo.e2e_platform_leases
  ADD COLUMN job jsonb,
  ADD COLUMN evidence_manifest jsonb,
  ADD CONSTRAINT e2e_platform_lease_job_required CHECK (
    job IS NOT NULL AND jsonb_typeof(job) = 'object' AND pg_column_size(job) <= 262144
  ) NOT VALID,
  ADD CONSTRAINT e2e_platform_evidence_shape CHECK (
    evidence_manifest IS NULL OR
      (jsonb_typeof(evidence_manifest) = 'object' AND pg_column_size(evidence_manifest) <= 1048576)
  ) NOT VALID,
  ADD CONSTRAINT e2e_platform_cursor_shape CHECK (
    jsonb_typeof(cursor) = 'object' AND pg_column_size(cursor) <= 65536
  ) NOT VALID,
  ADD CONSTRAINT e2e_platform_job_signature_shape CHECK (
    length(job_signature) BETWEEN 16 AND 4096
  ) NOT VALID,
  ADD CONSTRAINT e2e_platform_lease_tenant_id_unique UNIQUE (tenant_id, id);

ALTER TABLE deviludo.runner_registrations
  ADD CONSTRAINT runner_capabilities_shape CHECK (
    jsonb_typeof(capabilities) = 'object' AND pg_column_size(capabilities) <= 131072
  ) NOT VALID;

CREATE OR REPLACE FUNCTION deviludo.protect_runner_registration()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.id, NEW.spiffe_id, NEW.certificate_fingerprint,
         NEW.certificate_serial, NEW.certificate_not_after, NEW.platform,
         NEW.architecture, NEW.capability_digest, NEW.capabilities,
         NEW.registered_at)
     IS DISTINCT FROM
     ROW(OLD.id, OLD.spiffe_id, OLD.certificate_fingerprint,
         OLD.certificate_serial, OLD.certificate_not_after, OLD.platform,
         OLD.architecture, OLD.capability_digest, OLD.capabilities,
         OLD.registered_at) THEN
    RAISE EXCEPTION 'runner identity and capabilities are immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW.last_seen_at < OLD.last_seen_at THEN
    RAISE EXCEPTION 'runner last-seen timestamp cannot move backwards' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER runner_registration_binding_immutable
BEFORE UPDATE ON deviludo.runner_registrations
FOR EACH ROW EXECUTE FUNCTION deviludo.protect_runner_registration();

CREATE TRIGGER runner_registration_no_delete
BEFORE DELETE ON deviludo.runner_registrations
FOR EACH ROW EXECUTE FUNCTION deviludo.reject_mutation();

CREATE OR REPLACE FUNCTION deviludo.protect_e2e_platform_lease()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.id, NEW.tenant_id, NEW.project_id, NEW.attempt_id,
         NEW.platform, NEW.runner_id, NEW.fencing_token,
         NEW.lease_expires_at, NEW.job_digest, NEW.job_signature,
         NEW.job, NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.id, OLD.tenant_id, OLD.project_id, OLD.attempt_id,
         OLD.platform, OLD.runner_id, OLD.fencing_token,
         OLD.lease_expires_at, OLD.job_digest, OLD.job_signature,
         OLD.job, OLD.created_at) THEN
    RAISE EXCEPTION 'platform lease binding and signed job are immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.state IN ('PASSED', 'FAILED', 'EXPIRED', 'INVALIDATED')
      AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'terminal platform lease is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.evidence_manifest IS NOT NULL
      AND NEW.evidence_manifest IS DISTINCT FROM OLD.evidence_manifest THEN
    RAISE EXCEPTION 'platform evidence is immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW.last_seq_no < OLD.last_seq_no OR NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'platform lease cursor cannot move backwards' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER e2e_platform_lease_binding_immutable
BEFORE UPDATE ON deviludo.e2e_platform_leases
FOR EACH ROW EXECUTE FUNCTION deviludo.protect_e2e_platform_lease();

CREATE TRIGGER e2e_platform_lease_no_delete
BEFORE DELETE ON deviludo.e2e_platform_leases
FOR EACH ROW EXECUTE FUNCTION deviludo.reject_mutation();

CREATE TRIGGER platform_runner_events_append_only
BEFORE UPDATE OR DELETE ON deviludo.platform_runner_events
FOR EACH ROW EXECUTE FUNCTION deviludo.reject_mutation();

COMMIT;
