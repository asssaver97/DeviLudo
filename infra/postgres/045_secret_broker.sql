BEGIN;

-- Secret bytes live only in Vault KV. PostgreSQL stores an opaque Vault path,
-- a one-way content digest and the state needed to fence retries and one-time
-- reads across Broker replicas.
CREATE TABLE deviludo.secret_broker_records (
  id uuid PRIMARY KEY,
  secret_ref text NOT NULL UNIQUE
    CHECK (secret_ref ~ '^vault://kv/deviludo/records/[a-f0-9-]{36}$'),
  backend_path text NOT NULL UNIQUE
    CHECK (backend_path ~ '^records/[a-f0-9-]{36}$'),
  write_key text NOT NULL UNIQUE CHECK (write_key ~ '^[a-f0-9]{64}$'),
  purpose text NOT NULL CHECK (purpose IN ('provider-credential', 'github-pkce-v1')),
  plaintext_digest text NOT NULL CHECK (plaintext_digest ~ '^[a-f0-9]{64}$'),
  state text NOT NULL CHECK (state IN ('PENDING', 'ACTIVE', 'TAKE_CLAIMED', 'CONSUMED', 'REVOKED')),
  claim_token uuid,
  claim_expires_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz NOT NULL,
  activated_at timestamptz,
  consumed_at timestamptz,
  revoked_at timestamptz,
  CHECK ((state = 'PENDING' AND activated_at IS NULL AND consumed_at IS NULL AND revoked_at IS NULL)
    OR (state = 'ACTIVE' AND claim_token IS NULL AND claim_expires_at IS NULL
      AND activated_at IS NOT NULL AND consumed_at IS NULL AND revoked_at IS NULL)
    OR (state = 'TAKE_CLAIMED' AND claim_token IS NOT NULL AND claim_expires_at IS NOT NULL
      AND activated_at IS NOT NULL AND consumed_at IS NULL AND revoked_at IS NULL)
    OR (state = 'CONSUMED' AND claim_token IS NULL AND claim_expires_at IS NULL
      AND activated_at IS NOT NULL AND consumed_at IS NOT NULL AND revoked_at IS NULL)
    OR (state = 'REVOKED' AND claim_token IS NULL AND claim_expires_at IS NULL
      AND consumed_at IS NULL AND revoked_at IS NOT NULL)),
  CHECK ((purpose = 'github-pkce-v1' AND expires_at IS NOT NULL)
    OR (purpose = 'provider-credential' AND expires_at IS NULL))
);

CREATE TABLE deviludo.secret_broker_audit (
  id uuid PRIMARY KEY,
  secret_ref text NOT NULL,
  action text NOT NULL CHECK (action IN ('CREATED', 'CONSUMED', 'REVOKED', 'LEASED')),
  purpose text NOT NULL CHECK (purpose IN (
    'provider-credential', 'github-pkce-v1', 'github-oauth-client-secret'
  )),
  workload_spiffe_id text NOT NULL CHECK (workload_spiffe_id ~ '^spiffe://'),
  binding_digest text NOT NULL CHECK (binding_digest ~ '^[a-f0-9]{64}$'),
  occurred_at timestamptz NOT NULL
);

CREATE INDEX secret_broker_active_expiry_idx
  ON deviludo.secret_broker_records (expires_at)
  WHERE state IN ('ACTIVE', 'TAKE_CLAIMED');
CREATE INDEX secret_broker_audit_time_idx
  ON deviludo.secret_broker_audit (occurred_at DESC, id DESC);

CREATE OR REPLACE FUNCTION deviludo.protect_secret_broker_record()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.id, NEW.secret_ref, NEW.backend_path, NEW.write_key,
         NEW.purpose, NEW.plaintext_digest, NEW.expires_at, NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.id, OLD.secret_ref, OLD.backend_path, OLD.write_key,
         OLD.purpose, OLD.plaintext_digest, OLD.expires_at, OLD.created_at) THEN
    RAISE EXCEPTION 'secret Broker binding is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER secret_broker_record_guard
BEFORE UPDATE ON deviludo.secret_broker_records
FOR EACH ROW EXECUTE FUNCTION deviludo.protect_secret_broker_record();

CREATE TRIGGER secret_broker_record_no_delete
BEFORE DELETE ON deviludo.secret_broker_records
FOR EACH ROW EXECUTE FUNCTION deviludo.reject_mutation();

CREATE TRIGGER secret_broker_audit_append_only
BEFORE UPDATE OR DELETE ON deviludo.secret_broker_audit
FOR EACH ROW EXECUTE FUNCTION deviludo.reject_mutation();

COMMIT;
