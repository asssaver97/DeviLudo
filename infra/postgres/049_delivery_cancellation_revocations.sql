BEGIN;

-- A Temporal CANCEL signal is not authoritative until the control plane has
-- atomically fenced every durable execution surface that can still mutate the
-- game, its evidence, or its Steam release. The receipt contains no free-form
-- reason; only its digest is retained alongside the exact acknowledged action.
CREATE TABLE deviludo.delivery_cancellation_revocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES deviludo.tenants(id),
  project_id uuid NOT NULL,
  workflow_id text NOT NULL CHECK (length(workflow_id) BETWEEN 1 AND 512),
  action_id uuid NOT NULL REFERENCES deviludo.workflow_control_actions(id),
  operation_key text NOT NULL CHECK (length(operation_key) BETWEEN 1 AND 512),
  request_digest char(64) NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  run_id uuid,
  release_id uuid,
  steam_build_id text CHECK (steam_build_id IS NULL OR steam_build_id ~ '^[1-9][0-9]{0,19}$'),
  reason_digest char(64) NOT NULL CHECK (reason_digest ~ '^[a-f0-9]{64}$'),
  revoked_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, workflow_id),
  UNIQUE (tenant_id, action_id),
  FOREIGN KEY (tenant_id, project_id)
    REFERENCES deviludo.projects(tenant_id, id),
  FOREIGN KEY (tenant_id, project_id, run_id)
    REFERENCES deviludo.agent_runs(tenant_id, project_id, id),
  FOREIGN KEY (tenant_id, project_id, release_id)
    REFERENCES deviludo.steam_releases(tenant_id, project_id, id)
);

ALTER TABLE deviludo.delivery_cancellation_revocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE deviludo.delivery_cancellation_revocations FORCE ROW LEVEL SECURITY;
CREATE POLICY delivery_cancellation_revocations_tenant_isolation
  ON deviludo.delivery_cancellation_revocations
  USING (tenant_id = deviludo.current_tenant_id())
  WITH CHECK (tenant_id = deviludo.current_tenant_id());

CREATE TRIGGER delivery_cancellation_revocations_append_only
BEFORE UPDATE OR DELETE ON deviludo.delivery_cancellation_revocations
FOR EACH ROW EXECUTE FUNCTION deviludo.reject_mutation();

CREATE OR REPLACE FUNCTION deviludo.validate_delivery_cancellation_revocation()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  action_binding jsonb;
BEGIN
  SELECT action.binding
    INTO action_binding
    FROM deviludo.workflow_control_actions action
   WHERE action.id = NEW.action_id
     AND action.tenant_id = NEW.tenant_id
     AND action.project_id = NEW.project_id
     AND action.workflow_id = NEW.workflow_id
     AND action.operation_key = NEW.operation_key
     AND action.request_digest = NEW.request_digest
     AND action.operation = 'CANCEL_DELIVERY'
     AND action.status = 'ACKNOWLEDGED'
   FOR SHARE;
  IF NOT FOUND
     OR action_binding->>'state' <> 'CANCELLED'
     OR NULLIF(action_binding->>'cancellationReason', '') IS NULL
     OR NEW.reason_digest <> encode(digest(action_binding->>'cancellationReason', 'sha256'), 'hex')
     OR NEW.run_id::text IS DISTINCT FROM action_binding->>'lockedRunConfigurationId'
     OR NEW.release_id::text IS DISTINCT FROM action_binding->>'releaseId'
     OR NEW.steam_build_id IS DISTINCT FROM action_binding->>'steamBuildId' THEN
    RAISE EXCEPTION 'delivery cancellation revocation is not action-authorized'
      USING ERRCODE = '55000';
  END IF;

  IF EXISTS (
    SELECT 1 FROM deviludo.steam_releases release
     WHERE release.tenant_id = NEW.tenant_id
       AND release.project_id = NEW.project_id
       AND release.workflow_id = NEW.workflow_id
       AND (NEW.release_id IS NULL OR release.id <> NEW.release_id)
  ) OR EXISTS (
    SELECT 1 FROM deviludo.steam_releases release
     WHERE release.tenant_id = NEW.tenant_id
       AND release.project_id = NEW.project_id
       AND release.id = NEW.release_id
       AND release.state IN ('READY_TO_PUBLISH', 'RELEASED')
  ) OR EXISTS (
    SELECT 1 FROM deviludo.steam_default_branch_receipts published
     WHERE published.tenant_id = NEW.tenant_id
       AND published.project_id = NEW.project_id
       AND published.release_id = NEW.release_id
  ) THEN
    RAISE EXCEPTION 'published or mismatched Steam authority cannot be cancelled'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER delivery_cancellation_revocation_validate
BEFORE INSERT ON deviludo.delivery_cancellation_revocations
FOR EACH ROW EXECUTE FUNCTION deviludo.validate_delivery_cancellation_revocation();

-- CANCELLED releases may legitimately have no MFA approval when cancellation
-- occurs while the user is still at the fresh-MFA gate.
ALTER TABLE deviludo.steam_releases
  DROP CONSTRAINT steam_release_mfa_shape,
  ADD CONSTRAINT steam_release_mfa_shape CHECK (
    (state = 'WAITING_MFA' AND mfa_approval_id IS NULL)
      OR state = 'CANCELLED'
      OR (state NOT IN ('WAITING_MFA', 'CANCELLED') AND mfa_approval_id IS NOT NULL)
  ) NOT VALID;
ALTER TABLE deviludo.steam_releases
  VALIDATE CONSTRAINT steam_release_mfa_shape;

ALTER TABLE deviludo.steam_build_receipts
  DROP CONSTRAINT steam_build_receipts_state_check,
  ADD CONSTRAINT steam_build_receipts_state_check CHECK (
    state IN ('INSTALL_TESTING', 'EXTERNAL_APPROVAL_REQUIRED', 'FAILED', 'CANCELLED')
  ) NOT VALID;
ALTER TABLE deviludo.steam_build_receipts
  VALIDATE CONSTRAINT steam_build_receipts_state_check;

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
      AND NEW.state = 'FAILED' AND NEW.external_gate = 'NONE')
    OR (OLD.state NOT IN ('RELEASED', 'CANCELLED')
      AND NEW.state = 'CANCELLED' AND NEW.external_gate = 'NONE'
      AND EXISTS (
        SELECT 1 FROM deviludo.delivery_cancellation_revocations cancellation
         WHERE cancellation.tenant_id = OLD.tenant_id
           AND cancellation.project_id = OLD.project_id
           AND cancellation.workflow_id = OLD.workflow_id
           AND cancellation.release_id = OLD.id
      ));

  IF NOT allowed_transition THEN
    RAISE EXCEPTION 'invalid steam release lifecycle transition' USING ERRCODE = '55000';
  END IF;
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'invalid steam release version transition' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION deviludo.protect_steam_build_receipt()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  allowed_transition boolean;
BEGIN
  IF ROW(NEW.id, NEW.tenant_id, NEW.project_id, NEW.release_id, NEW.steam_app_id,
         NEW.build_id, NEW.main_commit_sha, NEW.source_digest,
         NEW.evidence_bundle_digest, NEW.beta_branch, NEW.depot_manifest_ids,
         NEW.install_attempts, NEW.uploaded_at, NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.id, OLD.tenant_id, OLD.project_id, OLD.release_id, OLD.steam_app_id,
         OLD.build_id, OLD.main_commit_sha, OLD.source_digest,
         OLD.evidence_bundle_digest, OLD.beta_branch, OLD.depot_manifest_ids,
         OLD.install_attempts, OLD.uploaded_at, OLD.created_at) THEN
    RAISE EXCEPTION 'steam build receipt binding is immutable' USING ERRCODE = '55000';
  END IF;

  allowed_transition := (
    OLD.state = 'INSTALL_TESTING'
      AND OLD.steam_install_evidence_bundle_digest IS NULL
      AND NEW.state IN ('EXTERNAL_APPROVAL_REQUIRED', 'FAILED')
      AND NEW.steam_install_evidence_bundle_digest IS NOT NULL
  ) OR (
    OLD.state <> 'CANCELLED' AND NEW.state = 'CANCELLED'
      AND EXISTS (
        SELECT 1 FROM deviludo.delivery_cancellation_revocations cancellation
         WHERE cancellation.tenant_id = OLD.tenant_id
           AND cancellation.project_id = OLD.project_id
           AND cancellation.release_id = OLD.release_id
      )
  );
  IF NOT allowed_transition THEN
    RAISE EXCEPTION 'invalid steam build receipt transition' USING ERRCODE = '55000';
  END IF;
  IF NEW.state = 'FAILED' AND NOT EXISTS (
    SELECT 1 FROM deviludo.steam_release_revocations revocation
     WHERE revocation.tenant_id = OLD.tenant_id
       AND revocation.project_id = OLD.project_id
       AND revocation.release_id = OLD.release_id
       AND revocation.build_receipt_id = OLD.id
       AND revocation.evidence_bundle_digest = NEW.steam_install_evidence_bundle_digest
  ) THEN
    RAISE EXCEPTION 'steam build failure has no revocation receipt' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION deviludo.protect_steam_publish_claim()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM deviludo.steam_releases release
     WHERE release.tenant_id = NEW.tenant_id
       AND release.project_id = NEW.project_id
       AND release.id = NEW.release_id
       AND release.state = 'CANCELLED'
  ) OR EXISTS (
    SELECT 1 FROM deviludo.delivery_cancellation_revocations cancellation
     WHERE cancellation.tenant_id = NEW.tenant_id
       AND cancellation.project_id = NEW.project_id
       AND cancellation.release_id = NEW.release_id
  ) THEN
    RAISE EXCEPTION 'cancelled Steam release claim is fenced' USING ERRCODE = '55000';
  END IF;
  IF ROW(NEW.key, NEW.tenant_id, NEW.project_id, NEW.release_id,
         NEW.request_digest, NEW.authorized_at)
     IS DISTINCT FROM
     ROW(OLD.key, OLD.tenant_id, OLD.project_id, OLD.release_id,
         OLD.request_digest, OLD.authorized_at) THEN
    RAISE EXCEPTION 'steam publish claim binding is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.response IS NOT NULL AND ROW(NEW.response, NEW.completed_at)
     IS DISTINCT FROM ROW(OLD.response, OLD.completed_at) THEN
    RAISE EXCEPTION 'completed steam publish claim is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.response IS NOT NULL
     AND ROW(NEW.claim_token, NEW.claim_expires_at)
       IS DISTINCT FROM ROW(OLD.claim_token, OLD.claim_expires_at) THEN
    RAISE EXCEPTION 'completed steam publish claim cannot be reclaimed' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION deviludo.reject_cancelled_steam_publish_claim()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM deviludo.steam_releases release
     WHERE release.tenant_id = NEW.tenant_id
       AND release.project_id = NEW.project_id
       AND release.id = NEW.release_id
       AND release.state = 'CANCELLED'
  ) OR EXISTS (
    SELECT 1 FROM deviludo.delivery_cancellation_revocations cancellation
     WHERE cancellation.tenant_id = NEW.tenant_id
       AND cancellation.project_id = NEW.project_id
       AND cancellation.release_id = NEW.release_id
  ) THEN
    RAISE EXCEPTION 'cancelled Steam release cannot acquire a publish claim' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER steam_publish_claim_cancelled_insert_guard
BEFORE INSERT ON deviludo.steam_publish_claims
FOR EACH ROW EXECUTE FUNCTION deviludo.reject_cancelled_steam_publish_claim();

CREATE OR REPLACE FUNCTION deviludo.apply_delivery_cancellation_revocation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE deviludo.workflow_control_actions
     SET status = 'INVALIDATED', completed_at = NEW.revoked_at
   WHERE tenant_id = NEW.tenant_id
     AND project_id = NEW.project_id
     AND workflow_id = NEW.workflow_id
     AND id <> NEW.action_id
     AND status = 'WAITING';

  UPDATE deviludo.workflow_command_jobs
     SET state = 'CANCELLED', claimed_by = NULL, claim_token = NULL,
         claim_expires_at = NULL, completed_at = NEW.revoked_at,
         updated_at = GREATEST(updated_at, NEW.revoked_at)
   WHERE tenant_id = NEW.tenant_id
     AND project_id = NEW.project_id
     AND workflow_id = NEW.workflow_id
     AND operation <> 'CANCEL_DELIVERY'
     AND state IN ('QUEUED', 'RUNNING', 'RETRYABLE_FAILED');

  UPDATE deviludo.e2e_platform_leases lease
     SET state = 'INVALIDATED', updated_at = GREATEST(lease.updated_at, NEW.revoked_at)
   WHERE lease.tenant_id = NEW.tenant_id
     AND lease.project_id = NEW.project_id
     AND lease.state IN ('LEASED', 'RUNNING')
     AND EXISTS (
       SELECT 1 FROM deviludo.e2e_attempts attempt
        WHERE attempt.id = lease.attempt_id
          AND attempt.tenant_id = NEW.tenant_id
          AND attempt.project_id = NEW.project_id
          AND attempt.workflow_id = NEW.workflow_id
     );

  UPDATE deviludo.e2e_attempts
     SET state = 'INVALIDATED', updated_at = GREATEST(updated_at, NEW.revoked_at)
   WHERE tenant_id = NEW.tenant_id
     AND project_id = NEW.project_id
     AND workflow_id = NEW.workflow_id
     AND state IN ('QUEUED', 'RUNNING');

  IF NEW.run_id IS NOT NULL THEN
    UPDATE deviludo.inference_run_authorizations
       SET state = 'REVOKED'
     WHERE tenant_id = NEW.tenant_id
       AND project_id = NEW.project_id
       AND run_id = NEW.run_id
       AND state = 'ACTIVE';

    UPDATE deviludo.agent_execution_operations
       SET state = 'CANCELLED', claim_token = NULL, claim_expires_at = NULL,
           retry_at = NULL, receipt_payload = NULL, receipt_digest = NULL,
           completed_at = NEW.revoked_at, updated_at = GREATEST(updated_at, NEW.revoked_at)
     WHERE tenant_id = NEW.tenant_id
       AND project_id = NEW.project_id
       AND run_id = NEW.run_id
       AND state IN ('QUEUED', 'PREPARING', 'RUNNING', 'WAITING_PROVIDER');

    UPDATE deviludo.agent_runs
       SET state = 'CANCELLING'
     WHERE tenant_id = NEW.tenant_id
       AND project_id = NEW.project_id
       AND id = NEW.run_id
       AND state IN ('QUEUED', 'PREPARING', 'RUNNING', 'WAITING_PROVIDER');
    UPDATE deviludo.agent_runs
       SET state = 'CANCELLED'
     WHERE tenant_id = NEW.tenant_id
       AND project_id = NEW.project_id
       AND id = NEW.run_id
       AND state = 'CANCELLING';

    UPDATE deviludo.steam_install_grants
       SET revoked_at = NEW.revoked_at
     WHERE tenant_id = NEW.tenant_id
       AND project_id = NEW.project_id
       AND run_id = NEW.run_id
       AND revoked_at IS NULL
       AND expires_at > NEW.revoked_at;
  END IF;

  IF NEW.release_id IS NOT NULL THEN
    UPDATE deviludo.steam_build_receipts
       SET state = 'CANCELLED'
     WHERE tenant_id = NEW.tenant_id
       AND project_id = NEW.project_id
       AND release_id = NEW.release_id
       AND state <> 'CANCELLED';

    UPDATE deviludo.steam_releases
       SET state = 'CANCELLED', external_gate = 'NONE', version = version + 1
     WHERE tenant_id = NEW.tenant_id
       AND project_id = NEW.project_id
       AND id = NEW.release_id
       AND workflow_id = NEW.workflow_id
       AND state NOT IN ('RELEASED', 'CANCELLED');
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER delivery_cancellation_revocation_apply
AFTER INSERT ON deviludo.delivery_cancellation_revocations
FOR EACH ROW EXECUTE FUNCTION deviludo.apply_delivery_cancellation_revocation();

CREATE INDEX delivery_cancellation_revocation_project_idx
  ON deviludo.delivery_cancellation_revocations (tenant_id, project_id, revoked_at);

COMMIT;
