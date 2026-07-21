BEGIN;

-- A privileged host updater may stage bytes locally, but only Runner ingress
-- can prove that the registered identity is draining and has no live leases.
-- The immutable operation binds that proof to one reviewed plan/release and to
-- the next Runner identity before any OS service pointer is switched.
CREATE TABLE deviludo.runner_native_install_operations (
  id uuid PRIMARY KEY,
  current_runner_id text NOT NULL REFERENCES deviludo.runner_registrations(id),
  current_spiffe_id text NOT NULL CHECK (current_spiffe_id LIKE 'spiffe://%'),
  current_certificate_fingerprint text NOT NULL CHECK (current_certificate_fingerprint ~ '^[a-f0-9]{64}$'),
  current_capability_digest text NOT NULL CHECK (current_capability_digest ~ '^[a-f0-9]{64}$'),
  target_runner_id text NOT NULL CHECK (target_runner_id ~ '^[a-z0-9][a-z0-9-]{2,63}$'),
  target_spiffe_id text NOT NULL CHECK (target_spiffe_id LIKE 'spiffe://%'),
  target_capability_digest text NOT NULL CHECK (target_capability_digest ~ '^[a-f0-9]{64}$'),
  platform text NOT NULL CHECK (platform IN ('windows', 'linux', 'macos')),
  architecture text NOT NULL CHECK (architecture IN ('x86_64', 'arm64')),
  plan_digest text NOT NULL CHECK (plan_digest ~ '^[a-f0-9]{64}$'),
  staging_receipt_digest text NOT NULL CHECK (staging_receipt_digest ~ '^[a-f0-9]{64}$'),
  release_id uuid NOT NULL,
  release_digest text NOT NULL CHECK (release_digest ~ '^sha256:[a-f0-9]{64}$'),
  request jsonb NOT NULL CHECK (jsonb_typeof(request) = 'object' AND pg_column_size(request) <= 32768),
  request_digest text NOT NULL UNIQUE CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  state text NOT NULL CHECK (state IN (
    'DRAINING', 'ACTIVATION_AUTHORIZED', 'ACTIVATED', 'ROLLED_BACK', 'QUARANTINED'
  )),
  requested_at timestamptz NOT NULL,
  authorized_at timestamptz,
  completed_at timestamptz,
  CHECK (current_runner_id <> target_runner_id OR current_capability_digest = target_capability_digest),
  CHECK (authorized_at IS NULL OR authorized_at >= requested_at),
  CHECK (completed_at IS NULL OR completed_at >= requested_at)
);

CREATE UNIQUE INDEX runner_native_install_target_identity_unique
  ON deviludo.runner_native_install_operations (target_runner_id, target_spiffe_id);
CREATE UNIQUE INDEX runner_native_install_one_active_per_runner
  ON deviludo.runner_native_install_operations (current_runner_id)
  WHERE state IN ('DRAINING', 'ACTIVATION_AUTHORIZED');
CREATE INDEX e2e_platform_leases_runner_drain_lookup
  ON deviludo.e2e_platform_leases (runner_id, lease_expires_at)
  WHERE state IN ('LEASED', 'RUNNING');

CREATE TABLE deviludo.runner_native_install_grants (
  operation_id uuid NOT NULL REFERENCES deviludo.runner_native_install_operations(id),
  grant_sequence integer NOT NULL CHECK (grant_sequence > 0),
  grant jsonb NOT NULL CHECK (jsonb_typeof(grant) = 'object' AND pg_column_size(grant) <= 32768),
  grant_digest text NOT NULL UNIQUE CHECK (grant_digest ~ '^[a-f0-9]{64}$'),
  signing_key_id text NOT NULL CHECK (signing_key_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,159}$'),
  signature text NOT NULL CHECK (length(signature) BETWEEN 80 AND 120),
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK (
    expires_at > issued_at AND expires_at <= issued_at + interval '15 minutes'
  ),
  PRIMARY KEY (operation_id, grant_sequence)
);

CREATE TABLE deviludo.runner_native_install_rollbacks (
  operation_id uuid PRIMARY KEY REFERENCES deviludo.runner_native_install_operations(id),
  grant_sequence integer NOT NULL CHECK (grant_sequence > 0),
  failure_evidence_digest text NOT NULL CHECK (failure_evidence_digest ~ '^[a-f0-9]{64}$'),
  receipt jsonb NOT NULL CHECK (jsonb_typeof(receipt) = 'object' AND pg_column_size(receipt) <= 32768),
  receipt_digest text NOT NULL UNIQUE CHECK (receipt_digest ~ '^[a-f0-9]{64}$'),
  rolled_back_at timestamptz NOT NULL,
  FOREIGN KEY (operation_id, grant_sequence)
    REFERENCES deviludo.runner_native_install_grants(operation_id, grant_sequence)
);

CREATE OR REPLACE FUNCTION deviludo.protect_runner_native_install_operation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.id, NEW.current_runner_id, NEW.current_spiffe_id,
         NEW.current_certificate_fingerprint, NEW.current_capability_digest,
         NEW.target_runner_id, NEW.target_spiffe_id, NEW.target_capability_digest,
         NEW.platform, NEW.architecture, NEW.plan_digest,
         NEW.staging_receipt_digest, NEW.release_id, NEW.release_digest,
         NEW.request, NEW.request_digest, NEW.requested_at)
     IS DISTINCT FROM
     ROW(OLD.id, OLD.current_runner_id, OLD.current_spiffe_id,
         OLD.current_certificate_fingerprint, OLD.current_capability_digest,
         OLD.target_runner_id, OLD.target_spiffe_id, OLD.target_capability_digest,
         OLD.platform, OLD.architecture, OLD.plan_digest,
         OLD.staging_receipt_digest, OLD.release_id, OLD.release_digest,
         OLD.request, OLD.request_digest, OLD.requested_at) THEN
    RAISE EXCEPTION 'Runner native install binding is immutable' USING ERRCODE = '55000';
  END IF;
  IF NOT (
    (OLD.state = 'DRAINING' AND NEW.state IN ('DRAINING', 'ACTIVATION_AUTHORIZED', 'ROLLED_BACK', 'QUARANTINED'))
    OR (OLD.state = 'ACTIVATION_AUTHORIZED' AND NEW.state IN ('ACTIVATION_AUTHORIZED', 'ACTIVATED', 'ROLLED_BACK', 'QUARANTINED'))
    OR (OLD.state IN ('ACTIVATED', 'ROLLED_BACK', 'QUARANTINED') AND NEW IS NOT DISTINCT FROM OLD)
  ) THEN
    RAISE EXCEPTION 'Runner native install state transition is invalid' USING ERRCODE = '55000';
  END IF;
  IF NEW.authorized_at IS DISTINCT FROM OLD.authorized_at
     AND (OLD.authorized_at IS NOT NULL OR NEW.authorized_at IS NULL) THEN
    RAISE EXCEPTION 'Runner native install authorization timestamp is immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW.completed_at IS DISTINCT FROM OLD.completed_at
     AND (OLD.completed_at IS NOT NULL OR NEW.completed_at IS NULL) THEN
    RAISE EXCEPTION 'Runner native install completion timestamp is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER runner_native_install_operation_guard
BEFORE UPDATE ON deviludo.runner_native_install_operations
FOR EACH ROW EXECUTE FUNCTION deviludo.protect_runner_native_install_operation();

CREATE TRIGGER runner_native_install_operation_no_delete
BEFORE DELETE ON deviludo.runner_native_install_operations
FOR EACH ROW EXECUTE FUNCTION deviludo.reject_mutation();

CREATE TRIGGER runner_native_install_grants_append_only
BEFORE UPDATE OR DELETE ON deviludo.runner_native_install_grants
FOR EACH ROW EXECUTE FUNCTION deviludo.reject_mutation();

CREATE TRIGGER runner_native_install_rollbacks_append_only
BEFORE UPDATE OR DELETE ON deviludo.runner_native_install_rollbacks
FOR EACH ROW EXECUTE FUNCTION deviludo.reject_mutation();

COMMIT;
