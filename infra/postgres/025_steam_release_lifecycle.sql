BEGIN;

-- A release gate is part of the authoritative lifecycle, not UI state. Every
-- gate advance increments the optimistic version even when the coarse state
-- remains EXTERNAL_APPROVAL_REQUIRED.
ALTER TABLE deviludo.steam_releases
  ADD CONSTRAINT steam_release_external_gate_shape CHECK (
    external_gate IN ('NONE', 'VALVE_REVIEW', 'FIRST_RELEASE', 'DEFAULT_BRANCH_CONFIRMATION')
      AND (
        (state = 'EXTERNAL_APPROVAL_REQUIRED' AND external_gate <> 'NONE')
        OR (state <> 'EXTERNAL_APPROVAL_REQUIRED' AND external_gate = 'NONE')
      )
  ) NOT VALID;

CREATE OR REPLACE FUNCTION deviludo.protect_steam_release_execution_binding()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  allowed_transition boolean;
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
    OLD.state = 'WAITING_MFA' AND OLD.external_gate = 'NONE'
      AND NEW.state = 'STEAM_PRIVATE_BETA' AND NEW.external_gate = 'NONE'
      AND OLD.mfa_approval_id IS NULL AND NEW.mfa_approval_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'invalid steam release MFA binding' USING ERRCODE = '55000';
  END IF;

  allowed_transition :=
    (OLD.state = 'WAITING_MFA' AND OLD.external_gate = 'NONE'
      AND NEW.state = 'STEAM_PRIVATE_BETA' AND NEW.external_gate = 'NONE')
    OR (OLD.state = 'STEAM_PRIVATE_BETA' AND OLD.external_gate = 'NONE'
      AND NEW.state = 'INSTALL_TESTING' AND NEW.external_gate = 'NONE')
    OR (OLD.state = 'INSTALL_TESTING' AND OLD.external_gate = 'NONE'
      AND NEW.state = 'EXTERNAL_APPROVAL_REQUIRED' AND NEW.external_gate = 'VALVE_REVIEW')
    OR (OLD.state = 'EXTERNAL_APPROVAL_REQUIRED' AND OLD.external_gate = 'VALVE_REVIEW'
      AND NEW.state = 'EXTERNAL_APPROVAL_REQUIRED' AND NEW.external_gate = 'FIRST_RELEASE')
    OR (OLD.state = 'EXTERNAL_APPROVAL_REQUIRED' AND OLD.external_gate = 'FIRST_RELEASE'
      AND NEW.state = 'EXTERNAL_APPROVAL_REQUIRED' AND NEW.external_gate = 'DEFAULT_BRANCH_CONFIRMATION')
    OR (OLD.state = 'EXTERNAL_APPROVAL_REQUIRED' AND OLD.external_gate = 'DEFAULT_BRANCH_CONFIRMATION'
      AND NEW.state = 'READY_TO_PUBLISH' AND NEW.external_gate = 'NONE')
    OR (OLD.state = 'READY_TO_PUBLISH' AND OLD.external_gate = 'NONE'
      AND NEW.state = 'RELEASED' AND NEW.external_gate = 'NONE')
    OR (OLD.state IN ('STEAM_PRIVATE_BETA', 'INSTALL_TESTING', 'EXTERNAL_APPROVAL_REQUIRED', 'READY_TO_PUBLISH')
      AND NEW.state = 'FAILED' AND NEW.external_gate = 'NONE');

  IF NOT allowed_transition THEN
    RAISE EXCEPTION 'invalid steam release lifecycle transition' USING ERRCODE = '55000';
  END IF;
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'invalid steam release version transition' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;

COMMIT;
