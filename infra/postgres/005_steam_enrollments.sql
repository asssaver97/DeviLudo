BEGIN;

-- Interactive Steam credentials and Guard codes are intentionally absent.
-- The challenge and resulting config.vdf are represented only by Vault refs.
CREATE TABLE deviludo.steam_enrollments (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES deviludo.tenants(id),
  user_subject text NOT NULL,
  session_binding_digest text NOT NULL CHECK (session_binding_digest ~ '^[a-f0-9]{64}$'),
  idempotency_key text NOT NULL,
  request_digest text NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  state text NOT NULL CHECK (state IN (
    'WAITING_CREDENTIALS', 'WAITING_STEAM_GUARD', 'READY', 'FAILED', 'EXPIRED'
  )),
  challenge_secret_ref text,
  build_session_id uuid REFERENCES deviludo.steam_build_sessions(id),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  completed_at timestamptz,
  UNIQUE (tenant_id, idempotency_key),
  CHECK (expires_at > created_at),
  CHECK (
    (state = 'WAITING_CREDENTIALS' AND challenge_secret_ref IS NULL AND build_session_id IS NULL AND completed_at IS NULL)
    OR (state = 'WAITING_STEAM_GUARD' AND challenge_secret_ref IS NOT NULL AND build_session_id IS NULL AND completed_at IS NULL)
    OR (state = 'READY' AND challenge_secret_ref IS NULL AND build_session_id IS NOT NULL AND completed_at IS NOT NULL)
    OR (state IN ('FAILED', 'EXPIRED') AND build_session_id IS NULL)
  )
);

ALTER TABLE deviludo.steam_enrollments ENABLE ROW LEVEL SECURITY;
ALTER TABLE deviludo.steam_enrollments FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON deviludo.steam_enrollments
  USING (tenant_id = deviludo.current_tenant_id())
  WITH CHECK (tenant_id = deviludo.current_tenant_id());

CREATE INDEX steam_enrollment_principal_state_idx
  ON deviludo.steam_enrollments (tenant_id, user_subject, state, expires_at);
CREATE INDEX steam_enrollment_expiry_idx
  ON deviludo.steam_enrollments (expires_at, state);

CREATE OR REPLACE FUNCTION deviludo.protect_steam_enrollment()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.id, NEW.tenant_id, NEW.user_subject,
         NEW.session_binding_digest, NEW.idempotency_key,
         NEW.request_digest, NEW.created_at, NEW.expires_at)
     IS DISTINCT FROM
     ROW(OLD.id, OLD.tenant_id, OLD.user_subject,
         OLD.session_binding_digest, OLD.idempotency_key,
         OLD.request_digest, OLD.created_at, OLD.expires_at) THEN
    RAISE EXCEPTION 'steam enrollment identity is immutable' USING ERRCODE = '55000';
  END IF;
  IF NOT (
    (OLD.state = 'WAITING_CREDENTIALS' AND NEW.state IN ('WAITING_STEAM_GUARD', 'READY', 'FAILED', 'EXPIRED'))
    OR (OLD.state = 'WAITING_STEAM_GUARD' AND NEW.state IN ('READY', 'FAILED', 'EXPIRED'))
  ) THEN
    RAISE EXCEPTION 'invalid steam enrollment transition' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER steam_enrollment_state_guard
BEFORE UPDATE ON deviludo.steam_enrollments
FOR EACH ROW
WHEN (OLD.* IS DISTINCT FROM NEW.*)
EXECUTE FUNCTION deviludo.protect_steam_enrollment();

CREATE TRIGGER steam_enrollment_no_delete
BEFORE DELETE ON deviludo.steam_enrollments
FOR EACH ROW EXECUTE FUNCTION deviludo.reject_mutation();

COMMIT;
