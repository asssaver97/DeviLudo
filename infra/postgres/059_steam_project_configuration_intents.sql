BEGIN;

-- The Web control plane may create this non-secret intent, but every release
-- field and the Beta branch password are submitted only through the isolated
-- Steam Secure UI.  The bound build session and browser session digest make a
-- configuration capability single-user, short-lived and replay safe.
CREATE TABLE deviludo.steam_project_configuration_intents (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES deviludo.tenants(id),
  project_id uuid NOT NULL REFERENCES deviludo.projects(id),
  user_subject text NOT NULL CHECK (length(user_subject) BETWEEN 1 AND 200),
  session_binding_digest char(64) NOT NULL CHECK (session_binding_digest ~ '^[a-f0-9]{64}$'),
  steam_build_session_id uuid NOT NULL,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 160),
  request_digest char(64) NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  state text NOT NULL CHECK (state IN ('CONFIGURING', 'COMPLETED', 'EXPIRED')),
  release_configuration_id uuid,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  completed_at timestamptz,
  UNIQUE (tenant_id, idempotency_key),
  UNIQUE (tenant_id, project_id, id),
  FOREIGN KEY (tenant_id, project_id)
    REFERENCES deviludo.projects(tenant_id, id),
  FOREIGN KEY (tenant_id, steam_build_session_id)
    REFERENCES deviludo.steam_build_sessions(tenant_id, id),
  FOREIGN KEY (tenant_id, project_id, release_configuration_id)
    REFERENCES deviludo.steam_project_release_configurations(tenant_id, project_id, id),
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '10 minutes'),
  CHECK (
    (state = 'CONFIGURING' AND release_configuration_id IS NULL AND completed_at IS NULL)
      OR (state = 'COMPLETED' AND release_configuration_id IS NOT NULL
        AND completed_at IS NOT NULL AND completed_at >= created_at)
      OR (state = 'EXPIRED' AND release_configuration_id IS NULL AND completed_at IS NULL)
  )
);

CREATE INDEX steam_project_configuration_intent_principal_idx
  ON deviludo.steam_project_configuration_intents
    (tenant_id, project_id, user_subject, state, expires_at DESC);

CREATE OR REPLACE FUNCTION deviludo.protect_steam_project_configuration_intent()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.id, NEW.tenant_id, NEW.project_id, NEW.user_subject,
         NEW.session_binding_digest, NEW.steam_build_session_id,
         NEW.idempotency_key, NEW.request_digest, NEW.created_at, NEW.expires_at)
     IS DISTINCT FROM
     ROW(OLD.id, OLD.tenant_id, OLD.project_id, OLD.user_subject,
         OLD.session_binding_digest, OLD.steam_build_session_id,
         OLD.idempotency_key, OLD.request_digest, OLD.created_at, OLD.expires_at) THEN
    RAISE EXCEPTION 'steam project configuration intent binding is immutable' USING ERRCODE = '55000';
  END IF;
  IF NOT (OLD.state = 'CONFIGURING' AND NEW.state IN ('COMPLETED', 'EXPIRED')) THEN
    RAISE EXCEPTION 'invalid steam project configuration intent transition' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER steam_project_configuration_intent_state_guard
BEFORE UPDATE ON deviludo.steam_project_configuration_intents
FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*)
EXECUTE FUNCTION deviludo.protect_steam_project_configuration_intent();

CREATE TRIGGER steam_project_configuration_intent_no_delete
BEFORE DELETE ON deviludo.steam_project_configuration_intents
FOR EACH ROW EXECUTE FUNCTION deviludo.reject_mutation();

ALTER TABLE deviludo.steam_project_configuration_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE deviludo.steam_project_configuration_intents FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON deviludo.steam_project_configuration_intents
  USING (tenant_id = deviludo.current_tenant_id())
  WITH CHECK (tenant_id = deviludo.current_tenant_id());

COMMIT;
