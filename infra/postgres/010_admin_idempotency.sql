BEGIN;

-- Cross-replica administrator mutation claims. Identities and signed scopes are
-- stored only as SHA-256 digests; response payloads have already passed the API
-- credential redaction boundary and remain size-bounded.
CREATE TABLE deviludo.admin_idempotency_results (
  identity_digest text PRIMARY KEY CHECK (identity_digest ~ '^[a-f0-9]{64}$'),
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[a-f0-9]{64}$'),
  state text NOT NULL CHECK (state IN ('AVAILABLE', 'CLAIMED', 'COMPLETED')),
  claim_token uuid,
  claim_expires_at timestamptz,
  response_payload jsonb,
  completed_at timestamptz,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((state = 'CLAIMED') = (claim_token IS NOT NULL)),
  CHECK ((claim_token IS NULL) = (claim_expires_at IS NULL)),
  CHECK ((state = 'COMPLETED') = (response_payload IS NOT NULL)),
  CHECK ((response_payload IS NULL) = (completed_at IS NULL)),
  CHECK (response_payload IS NULL OR pg_column_size(response_payload) <= 1048576),
  CHECK (expires_at > created_at)
);

CREATE OR REPLACE FUNCTION deviludo.protect_admin_idempotency_binding()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.identity_digest, NEW.request_fingerprint, NEW.expires_at, NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.identity_digest, OLD.request_fingerprint, OLD.expires_at, OLD.created_at) THEN
    RAISE EXCEPTION 'administrator idempotency binding is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.state = 'COMPLETED' AND ROW(NEW.state, NEW.response_payload, NEW.completed_at)
     IS DISTINCT FROM ROW(OLD.state, OLD.response_payload, OLD.completed_at) THEN
    RAISE EXCEPTION 'administrator idempotency result is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER admin_idempotency_binding_immutable
BEFORE UPDATE ON deviludo.admin_idempotency_results
FOR EACH ROW EXECUTE FUNCTION deviludo.protect_admin_idempotency_binding();

CREATE INDEX admin_idempotency_expiry_idx
  ON deviludo.admin_idempotency_results (expires_at);

COMMIT;
