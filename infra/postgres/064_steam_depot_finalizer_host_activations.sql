BEGIN;

-- RLS-protected tenant operations are projected into a credential-free global
-- claim index so a dedicated signing-host authority can prove that a platform
-- has drained without receiving tenant access or source/build metadata.
CREATE TABLE deviludo.steam_depot_finalizer_active_claims (
  claim_token uuid PRIMARY KEY,
  platform text NOT NULL CHECK (platform IN ('windows', 'linux', 'macos')),
  claim_expires_at timestamptz NOT NULL
);

REVOKE ALL ON TABLE deviludo.steam_depot_finalizer_active_claims FROM PUBLIC;

CREATE INDEX steam_depot_finalizer_active_claim_platform_idx
  ON deviludo.steam_depot_finalizer_active_claims (platform, claim_expires_at);

CREATE OR REPLACE FUNCTION deviludo.sync_steam_depot_finalizer_active_claim()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, deviludo
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.claim_token IS NOT NULL
     AND (NEW.state <> 'RUNNING' OR OLD.claim_token IS DISTINCT FROM NEW.claim_token) THEN
    DELETE FROM deviludo.steam_depot_finalizer_active_claims
     WHERE claim_token = OLD.claim_token;
  END IF;
  IF NEW.state = 'RUNNING' THEN
    INSERT INTO deviludo.steam_depot_finalizer_active_claims
      (claim_token, platform, claim_expires_at)
    VALUES
      (NEW.claim_token, NEW.platform, NEW.claim_expires_at)
    ON CONFLICT (claim_token) DO UPDATE
      SET platform = EXCLUDED.platform,
          claim_expires_at = EXCLUDED.claim_expires_at;
  END IF;
  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION deviludo.sync_steam_depot_finalizer_active_claim() FROM PUBLIC;

CREATE TRIGGER steam_depot_finalization_active_claim_projection
AFTER INSERT OR UPDATE ON deviludo.steam_depot_finalization_operations
FOR EACH ROW EXECUTE FUNCTION deviludo.sync_steam_depot_finalizer_active_claim();

INSERT INTO deviludo.steam_depot_finalizer_active_claims
  (claim_token, platform, claim_expires_at)
SELECT claim_token, platform, claim_expires_at
  FROM deviludo.steam_depot_finalization_operations
 WHERE state = 'RUNNING';

CREATE TABLE deviludo.steam_depot_finalizer_host_activation_operations (
  id uuid PRIMARY KEY,
  host_id text NOT NULL CHECK (host_id ~ '^[a-z0-9][a-z0-9-]{2,63}$'),
  host_spiffe_id text NOT NULL CHECK (host_spiffe_id LIKE 'spiffe://%'),
  host_certificate_fingerprint char(64) NOT NULL
    CHECK (host_certificate_fingerprint ~ '^[a-f0-9]{64}$'),
  platform text NOT NULL CHECK (platform IN ('windows', 'linux', 'macos')),
  architecture text NOT NULL CHECK (architecture IN ('x86_64', 'arm64')),
  operation_state text NOT NULL CHECK (operation_state IN ('INITIALIZING', 'DRAINING')),
  plan_digest char(64) NOT NULL CHECK (plan_digest ~ '^[a-f0-9]{64}$'),
  transaction_digest char(64) NOT NULL CHECK (transaction_digest ~ '^[a-f0-9]{64}$'),
  staging_receipt_digest char(64) NOT NULL CHECK (staging_receipt_digest ~ '^[a-f0-9]{64}$'),
  release_id uuid NOT NULL,
  service_release_digest char(64) NOT NULL CHECK (service_release_digest ~ '^[a-f0-9]{64}$'),
  native_release_digest char(64) NOT NULL CHECK (native_release_digest ~ '^[a-f0-9]{64}$'),
  previous_plan_digest char(64) CHECK (previous_plan_digest IS NULL OR previous_plan_digest ~ '^[a-f0-9]{64}$'),
  previous_definition_digest char(64)
    CHECK (previous_definition_digest IS NULL OR previous_definition_digest ~ '^[a-f0-9]{64}$'),
  definition_digest char(64) NOT NULL CHECK (definition_digest ~ '^[a-f0-9]{64}$'),
  receipt_path text NOT NULL CHECK (length(receipt_path) BETWEEN 4 AND 4096),
  request jsonb NOT NULL CHECK (jsonb_typeof(request) = 'object' AND pg_column_size(request) <= 32768),
  request_digest char(64) NOT NULL UNIQUE CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  state text NOT NULL CHECK (state IN (
    'DRAINING', 'ACTIVATION_AUTHORIZED', 'ACTIVATED', 'ROLLED_BACK', 'QUARANTINED'
  )),
  requested_at timestamptz NOT NULL,
  authorized_at timestamptz,
  completed_at timestamptz,
  CHECK (
    (operation_state = 'INITIALIZING' AND previous_plan_digest IS NULL AND previous_definition_digest IS NULL)
    OR (operation_state = 'DRAINING' AND previous_plan_digest IS NOT NULL AND previous_definition_digest IS NOT NULL)
  ),
  CHECK (authorized_at IS NULL OR authorized_at >= requested_at),
  CHECK (completed_at IS NULL OR completed_at >= requested_at)
);

CREATE UNIQUE INDEX steam_depot_finalizer_one_active_host_activation
  ON deviludo.steam_depot_finalizer_host_activation_operations (host_id)
  WHERE state IN ('DRAINING', 'ACTIVATION_AUTHORIZED');

CREATE TABLE deviludo.steam_depot_finalizer_host_activation_grants (
  operation_id uuid NOT NULL
    REFERENCES deviludo.steam_depot_finalizer_host_activation_operations(id),
  grant_sequence integer NOT NULL CHECK (grant_sequence > 0),
  grant jsonb NOT NULL CHECK (jsonb_typeof(grant) = 'object' AND pg_column_size(grant) <= 32768),
  grant_digest char(64) NOT NULL UNIQUE CHECK (grant_digest ~ '^[a-f0-9]{64}$'),
  signing_key_id text NOT NULL CHECK (signing_key_id ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]{2,159}$'),
  signature text NOT NULL CHECK (length(signature) = 86),
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK (
    expires_at > issued_at AND expires_at <= issued_at + interval '15 minutes'
  ),
  PRIMARY KEY (operation_id, grant_sequence)
);

REVOKE ALL ON TABLE deviludo.steam_depot_finalizer_host_activation_operations FROM PUBLIC;
REVOKE ALL ON TABLE deviludo.steam_depot_finalizer_host_activation_grants FROM PUBLIC;

CREATE TABLE deviludo.steam_depot_finalizer_host_activation_results (
  operation_id uuid PRIMARY KEY
    REFERENCES deviludo.steam_depot_finalizer_host_activation_operations(id),
  grant_sequence integer NOT NULL CHECK (grant_sequence > 0),
  state text NOT NULL CHECK (state IN ('ACTIVATED', 'ROLLED_BACK')),
  receipt jsonb NOT NULL CHECK (jsonb_typeof(receipt) = 'object' AND pg_column_size(receipt) <= 65536),
  receipt_digest char(64) NOT NULL UNIQUE CHECK (receipt_digest ~ '^[a-f0-9]{64}$'),
  failure_digest char(64) CHECK (failure_digest IS NULL OR failure_digest ~ '^[a-f0-9]{64}$'),
  completed_at timestamptz NOT NULL,
  FOREIGN KEY (operation_id, grant_sequence)
    REFERENCES deviludo.steam_depot_finalizer_host_activation_grants(operation_id, grant_sequence),
  CHECK ((state = 'ACTIVATED' AND failure_digest IS NULL)
      OR (state = 'ROLLED_BACK' AND failure_digest IS NOT NULL))
);

REVOKE ALL ON TABLE deviludo.steam_depot_finalizer_host_activation_results FROM PUBLIC;

CREATE OR REPLACE FUNCTION deviludo.protect_steam_depot_finalizer_host_activation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.id, NEW.host_id, NEW.host_spiffe_id, NEW.host_certificate_fingerprint,
         NEW.platform, NEW.architecture, NEW.operation_state, NEW.plan_digest,
         NEW.transaction_digest, NEW.staging_receipt_digest, NEW.release_id,
         NEW.service_release_digest, NEW.native_release_digest, NEW.previous_plan_digest,
         NEW.previous_definition_digest, NEW.definition_digest, NEW.receipt_path,
         NEW.request, NEW.request_digest, NEW.requested_at)
     IS DISTINCT FROM
     ROW(OLD.id, OLD.host_id, OLD.host_spiffe_id, OLD.host_certificate_fingerprint,
         OLD.platform, OLD.architecture, OLD.operation_state, OLD.plan_digest,
         OLD.transaction_digest, OLD.staging_receipt_digest, OLD.release_id,
         OLD.service_release_digest, OLD.native_release_digest, OLD.previous_plan_digest,
         OLD.previous_definition_digest, OLD.definition_digest, OLD.receipt_path,
         OLD.request, OLD.request_digest, OLD.requested_at) THEN
    RAISE EXCEPTION 'Steam depot Finalizer host activation binding is immutable' USING ERRCODE = '55000';
  END IF;
  IF NOT (
    (OLD.state = 'DRAINING' AND NEW.state IN ('DRAINING', 'ACTIVATION_AUTHORIZED', 'ROLLED_BACK', 'QUARANTINED'))
    OR (OLD.state = 'ACTIVATION_AUTHORIZED' AND NEW.state IN ('ACTIVATION_AUTHORIZED', 'ACTIVATED', 'ROLLED_BACK', 'QUARANTINED'))
    OR (OLD.state IN ('ACTIVATED', 'ROLLED_BACK', 'QUARANTINED') AND NEW IS NOT DISTINCT FROM OLD)
  ) THEN
    RAISE EXCEPTION 'Steam depot Finalizer host activation transition is invalid' USING ERRCODE = '55000';
  END IF;
  IF NEW.authorized_at IS DISTINCT FROM OLD.authorized_at
     AND (OLD.authorized_at IS NOT NULL OR NEW.authorized_at IS NULL) THEN
    RAISE EXCEPTION 'Steam depot Finalizer host authorization timestamp is immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW.completed_at IS DISTINCT FROM OLD.completed_at
     AND (OLD.completed_at IS NOT NULL OR NEW.completed_at IS NULL) THEN
    RAISE EXCEPTION 'Steam depot Finalizer host completion timestamp is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION deviludo.protect_steam_depot_finalizer_host_activation() FROM PUBLIC;

CREATE TRIGGER steam_depot_finalizer_host_activation_guard
BEFORE UPDATE ON deviludo.steam_depot_finalizer_host_activation_operations
FOR EACH ROW EXECUTE FUNCTION deviludo.protect_steam_depot_finalizer_host_activation();

CREATE TRIGGER steam_depot_finalizer_host_activation_no_delete
BEFORE DELETE ON deviludo.steam_depot_finalizer_host_activation_operations
FOR EACH ROW EXECUTE FUNCTION deviludo.reject_mutation();

CREATE TRIGGER steam_depot_finalizer_host_activation_grants_append_only
BEFORE UPDATE OR DELETE ON deviludo.steam_depot_finalizer_host_activation_grants
FOR EACH ROW EXECUTE FUNCTION deviludo.reject_mutation();

CREATE TRIGGER steam_depot_finalizer_host_activation_results_append_only
BEFORE UPDATE OR DELETE ON deviludo.steam_depot_finalizer_host_activation_results
FOR EACH ROW EXECUTE FUNCTION deviludo.reject_mutation();

COMMIT;
