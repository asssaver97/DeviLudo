BEGIN;

ALTER TABLE deviludo.steam_build_sessions
  ADD CONSTRAINT steam_build_sessions_tenant_id_unique UNIQUE (tenant_id, id);

-- One immutable revision freezes every non-secret project choice needed to
-- create a release. Secret values remain in Vault; only versioned refs live here.
CREATE TABLE deviludo.steam_project_release_configurations (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES deviludo.tenants(id),
  project_id uuid NOT NULL REFERENCES deviludo.projects(id),
  revision integer NOT NULL CHECK (revision > 0),
  steam_app_id text NOT NULL CHECK (steam_app_id ~ '^[1-9][0-9]{0,19}$'),
  steam_build_session_id uuid NOT NULL,
  depot_configuration_id uuid NOT NULL,
  beta_branch text NOT NULL CHECK (
    beta_branch ~ '^[a-z0-9][a-z0-9_-]{2,39}$' AND beta_branch NOT IN ('default', 'public')
  ),
  branch_password_secret_ref text NOT NULL CHECK (
    branch_password_secret_ref ~ '^vault://[A-Za-z0-9._~:/-]{2,500}$'
  ),
  configuration_digest char(64) NOT NULL CHECK (configuration_digest ~ '^[a-f0-9]{64}$'),
  state text NOT NULL CHECK (state IN ('ACTIVE', 'SUPERSEDED')),
  created_by text NOT NULL CHECK (length(created_by) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL,
  superseded_at timestamptz,
  UNIQUE (tenant_id, project_id, revision),
  UNIQUE (tenant_id, project_id, id),
  FOREIGN KEY (tenant_id, project_id)
    REFERENCES deviludo.projects(tenant_id, id),
  FOREIGN KEY (tenant_id, steam_build_session_id)
    REFERENCES deviludo.steam_build_sessions(tenant_id, id),
  FOREIGN KEY (tenant_id, project_id, depot_configuration_id)
    REFERENCES deviludo.steam_project_depot_configurations(tenant_id, project_id, id),
  CHECK (
    (state = 'ACTIVE' AND superseded_at IS NULL)
      OR (state = 'SUPERSEDED' AND superseded_at IS NOT NULL AND superseded_at >= created_at)
  )
);

CREATE UNIQUE INDEX steam_project_release_configuration_active_idx
  ON deviludo.steam_project_release_configurations (tenant_id, project_id)
  WHERE state = 'ACTIVE';

CREATE OR REPLACE FUNCTION deviludo.protect_steam_project_release_configuration()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.id, NEW.tenant_id, NEW.project_id, NEW.revision, NEW.steam_app_id,
         NEW.steam_build_session_id, NEW.depot_configuration_id, NEW.beta_branch,
         NEW.branch_password_secret_ref, NEW.configuration_digest,
         NEW.created_by, NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.id, OLD.tenant_id, OLD.project_id, OLD.revision, OLD.steam_app_id,
         OLD.steam_build_session_id, OLD.depot_configuration_id, OLD.beta_branch,
         OLD.branch_password_secret_ref, OLD.configuration_digest,
         OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'steam release configuration binding is immutable' USING ERRCODE = '55000';
  END IF;
  IF NOT (OLD.state = 'ACTIVE' AND NEW.state = 'SUPERSEDED'
          AND OLD.superseded_at IS NULL AND NEW.superseded_at IS NOT NULL) THEN
    RAISE EXCEPTION 'invalid steam release configuration transition' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER steam_project_release_configuration_state_guard
BEFORE UPDATE ON deviludo.steam_project_release_configurations
FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*)
EXECUTE FUNCTION deviludo.protect_steam_project_release_configuration();

CREATE TRIGGER steam_project_release_configuration_no_delete
BEFORE DELETE ON deviludo.steam_project_release_configurations
FOR EACH ROW EXECUTE FUNCTION deviludo.reject_mutation();

ALTER TABLE deviludo.steam_project_release_configurations ENABLE ROW LEVEL SECURITY;
ALTER TABLE deviludo.steam_project_release_configurations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON deviludo.steam_project_release_configurations
  USING (tenant_id = deviludo.current_tenant_id())
  WITH CHECK (tenant_id = deviludo.current_tenant_id());

ALTER TABLE deviludo.steam_releases
  ALTER COLUMN mfa_approval_id DROP NOT NULL,
  ADD COLUMN workflow_id text,
  ADD COLUMN run_id uuid,
  ADD COLUMN release_configuration_id uuid,
  ADD COLUMN target_matrix text[],
  ADD CONSTRAINT steam_release_preparation_shape CHECK (
    (workflow_id IS NULL AND run_id IS NULL AND release_configuration_id IS NULL AND target_matrix IS NULL)
      OR (workflow_id IS NOT NULL AND length(workflow_id) BETWEEN 3 AND 200
        AND run_id IS NOT NULL AND release_configuration_id IS NOT NULL AND target_matrix IS NOT NULL
        AND target_matrix IN (
          ARRAY['linux']::text[], ARRAY['macos']::text[], ARRAY['windows']::text[],
          ARRAY['linux','macos']::text[], ARRAY['linux','windows']::text[],
          ARRAY['macos','windows']::text[], ARRAY['linux','macos','windows']::text[]
        ))
  ) NOT VALID,
  ADD CONSTRAINT steam_release_known_state CHECK (state IN (
    'WAITING_MFA', 'STEAM_PRIVATE_BETA', 'INSTALL_TESTING',
    'EXTERNAL_APPROVAL_REQUIRED', 'READY_TO_PUBLISH', 'RELEASED', 'FAILED', 'CANCELLED'
  )) NOT VALID,
  ADD CONSTRAINT steam_release_mfa_shape CHECK (
    (state = 'WAITING_MFA' AND mfa_approval_id IS NULL)
      OR (state <> 'WAITING_MFA' AND mfa_approval_id IS NOT NULL)
  ) NOT VALID,
  ADD CONSTRAINT steam_release_run_fk
    FOREIGN KEY (tenant_id, project_id, run_id)
    REFERENCES deviludo.agent_runs(tenant_id, project_id, id),
  ADD CONSTRAINT steam_release_configuration_fk
    FOREIGN KEY (tenant_id, project_id, release_configuration_id)
    REFERENCES deviludo.steam_project_release_configurations(tenant_id, project_id, id);

CREATE UNIQUE INDEX steam_release_workflow_idx
  ON deviludo.steam_releases (tenant_id, workflow_id)
  WHERE workflow_id IS NOT NULL;

-- Release bindings never change. The only MFA mutation is the one-way binding
-- performed after the matching authorization has already reached DISPATCHED.
CREATE OR REPLACE FUNCTION deviludo.protect_steam_release_execution_binding()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.id, NEW.tenant_id, NEW.project_id, NEW.workflow_id, NEW.run_id,
         NEW.release_configuration_id, NEW.target_matrix, NEW.main_commit_sha,
         NEW.evidence_bundle_id, NEW.steam_app_id, NEW.steam_session_secret_ref,
         NEW.beta_branch, NEW.branch_password_secret_ref, NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.id, OLD.tenant_id, OLD.project_id, OLD.workflow_id, OLD.run_id,
         OLD.release_configuration_id, OLD.target_matrix, OLD.main_commit_sha,
         OLD.evidence_bundle_id, OLD.steam_app_id, OLD.steam_session_secret_ref,
         OLD.beta_branch, OLD.branch_password_secret_ref, OLD.created_at) THEN
    RAISE EXCEPTION 'steam release execution binding is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.mfa_approval_id IS DISTINCT FROM NEW.mfa_approval_id AND NOT (
    OLD.state = 'WAITING_MFA' AND NEW.state = 'STEAM_PRIVATE_BETA'
      AND OLD.mfa_approval_id IS NULL AND NEW.mfa_approval_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'invalid steam release MFA binding' USING ERRCODE = '55000';
  END IF;
  IF OLD.state IS DISTINCT FROM NEW.state AND NOT (
    (OLD.state = 'WAITING_MFA' AND NEW.state = 'STEAM_PRIVATE_BETA')
    OR (OLD.state = 'STEAM_PRIVATE_BETA' AND NEW.state IN ('INSTALL_TESTING', 'FAILED'))
    OR (OLD.state = 'INSTALL_TESTING' AND NEW.state IN ('EXTERNAL_APPROVAL_REQUIRED', 'FAILED'))
    OR (OLD.state = 'EXTERNAL_APPROVAL_REQUIRED' AND NEW.state IN ('READY_TO_PUBLISH', 'FAILED'))
    OR (OLD.state = 'READY_TO_PUBLISH' AND NEW.state IN ('RELEASED', 'FAILED'))
  ) THEN
    RAISE EXCEPTION 'invalid steam release state transition' USING ERRCODE = '55000';
  END IF;
  IF OLD.state IS DISTINCT FROM NEW.state AND NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'invalid steam release version transition' USING ERRCODE = '55000';
  END IF;
  IF OLD.state IS NOT DISTINCT FROM NEW.state AND OLD.version IS DISTINCT FROM NEW.version THEN
    RAISE EXCEPTION 'steam release version cannot change without state' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;

COMMIT;
