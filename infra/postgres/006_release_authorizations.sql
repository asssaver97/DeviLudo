BEGIN;

-- Browser MFA responses are verified in memory and never stored. The signed
-- authorization is non-secret and is bound to the immutable release snapshot.
CREATE TABLE deviludo.steam_release_authorizations (
  approval_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES deviludo.tenants(id),
  project_id uuid NOT NULL REFERENCES deviludo.projects(id),
  release_id uuid NOT NULL REFERENCES deviludo.steam_releases(id),
  workflow_id text NOT NULL,
  user_subject text NOT NULL,
  session_binding_digest text NOT NULL CHECK (session_binding_digest ~ '^[a-f0-9]{64}$'),
  idempotency_key text NOT NULL,
  request_digest text NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  state text NOT NULL CHECK (state IN (
    'CREATING', 'MFA_REQUIRED', 'VERIFIED', 'DISPATCHED', 'FAILED', 'EXPIRED'
  )),
  main_commit_sha text NOT NULL CHECK (main_commit_sha ~ '^[a-f0-9]{40}$'),
  evidence_bundle_digest text NOT NULL CHECK (evidence_bundle_digest ~ '^[a-f0-9]{64}$'),
  authorization_url text,
  mfa_assertion_id text,
  signed_authorization jsonb,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  verified_at timestamptz,
  dispatched_at timestamptz,
  UNIQUE (tenant_id, idempotency_key),
  UNIQUE (tenant_id, release_id, mfa_assertion_id),
  CHECK (expires_at > created_at),
  CHECK (
    (state = 'CREATING' AND authorization_url IS NULL AND mfa_assertion_id IS NULL AND signed_authorization IS NULL)
    OR (state = 'MFA_REQUIRED' AND authorization_url IS NOT NULL AND mfa_assertion_id IS NULL AND signed_authorization IS NULL)
    OR (state = 'VERIFIED' AND authorization_url IS NOT NULL AND mfa_assertion_id IS NOT NULL AND signed_authorization IS NOT NULL AND verified_at IS NOT NULL)
    OR (state = 'DISPATCHED' AND authorization_url IS NOT NULL AND mfa_assertion_id IS NOT NULL AND signed_authorization IS NOT NULL AND verified_at IS NOT NULL AND dispatched_at IS NOT NULL)
    OR state IN ('FAILED', 'EXPIRED')
  )
);

ALTER TABLE deviludo.steam_release_authorizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE deviludo.steam_release_authorizations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON deviludo.steam_release_authorizations
  USING (tenant_id = deviludo.current_tenant_id())
  WITH CHECK (tenant_id = deviludo.current_tenant_id());

CREATE INDEX steam_release_authorization_state_idx
  ON deviludo.steam_release_authorizations (tenant_id, state, expires_at);
CREATE INDEX steam_release_authorization_workflow_idx
  ON deviludo.steam_release_authorizations (workflow_id, state);

CREATE OR REPLACE FUNCTION deviludo.protect_steam_release_authorization()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.approval_id, NEW.tenant_id, NEW.project_id, NEW.release_id,
         NEW.workflow_id, NEW.user_subject, NEW.session_binding_digest,
         NEW.idempotency_key, NEW.request_digest, NEW.main_commit_sha,
         NEW.evidence_bundle_digest, NEW.created_at, NEW.expires_at)
     IS DISTINCT FROM
     ROW(OLD.approval_id, OLD.tenant_id, OLD.project_id, OLD.release_id,
         OLD.workflow_id, OLD.user_subject, OLD.session_binding_digest,
         OLD.idempotency_key, OLD.request_digest, OLD.main_commit_sha,
         OLD.evidence_bundle_digest, OLD.created_at, OLD.expires_at) THEN
    RAISE EXCEPTION 'release authorization binding is immutable' USING ERRCODE = '55000';
  END IF;
  IF NOT (
    (OLD.state = 'CREATING' AND NEW.state IN ('MFA_REQUIRED', 'FAILED'))
    OR (OLD.state = 'MFA_REQUIRED' AND NEW.state IN ('VERIFIED', 'FAILED', 'EXPIRED'))
    OR (OLD.state = 'VERIFIED' AND NEW.state = 'DISPATCHED')
  ) THEN
    RAISE EXCEPTION 'invalid release authorization transition' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER steam_release_authorization_state_guard
BEFORE UPDATE ON deviludo.steam_release_authorizations
FOR EACH ROW
WHEN (OLD.* IS DISTINCT FROM NEW.*)
EXECUTE FUNCTION deviludo.protect_steam_release_authorization();

CREATE TRIGGER steam_release_authorization_no_delete
BEFORE DELETE ON deviludo.steam_release_authorizations
FOR EACH ROW EXECUTE FUNCTION deviludo.reject_mutation();

COMMIT;
