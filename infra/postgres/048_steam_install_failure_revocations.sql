BEGIN;

-- A failed clean-Steam-client install must revoke the persistent Build and
-- Release authority before Runner Control may return its failed workflow
-- receipt. The revocation is an immutable, evidence-bound authorization for
-- the two otherwise-forbidden FAILED transitions below.
ALTER TABLE deviludo.e2e_attempts
  ADD CONSTRAINT e2e_attempts_tenant_project_id_unique
    UNIQUE (tenant_id, project_id, id);

ALTER TABLE deviludo.steam_build_receipts
  DROP CONSTRAINT steam_build_receipts_state_check,
  ADD CONSTRAINT steam_build_receipts_state_check CHECK (
    state IN ('INSTALL_TESTING', 'EXTERNAL_APPROVAL_REQUIRED', 'FAILED')
  ) NOT VALID;
ALTER TABLE deviludo.steam_build_receipts
  VALIDATE CONSTRAINT steam_build_receipts_state_check;

CREATE TABLE deviludo.steam_release_revocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES deviludo.tenants(id),
  project_id uuid NOT NULL,
  workflow_id text NOT NULL CHECK (length(workflow_id) BETWEEN 1 AND 512),
  run_id uuid NOT NULL,
  release_id uuid NOT NULL,
  build_receipt_id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  evidence_bundle_id uuid NOT NULL,
  evidence_bundle_digest char(64) NOT NULL
    CHECK (evidence_bundle_digest ~ '^[a-f0-9]{64}$'),
  repair_prompt_id text NOT NULL CHECK (
    length(repair_prompt_id) BETWEEN 1 AND 160
      AND repair_prompt_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
  ),
  main_commit_sha char(40) NOT NULL CHECK (main_commit_sha ~ '^[a-f0-9]{40}$'),
  build_id text NOT NULL CHECK (build_id ~ '^[1-9][0-9]{0,19}$'),
  reason text NOT NULL CHECK (reason = 'STEAM_INSTALL_E2E_FAILED'),
  revoked_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, release_id),
  UNIQUE (tenant_id, build_receipt_id),
  UNIQUE (tenant_id, evidence_bundle_id),
  FOREIGN KEY (tenant_id, project_id)
    REFERENCES deviludo.projects(tenant_id, id),
  FOREIGN KEY (tenant_id, project_id, run_id)
    REFERENCES deviludo.agent_runs(tenant_id, project_id, id),
  FOREIGN KEY (tenant_id, project_id, release_id)
    REFERENCES deviludo.steam_releases(tenant_id, project_id, id),
  FOREIGN KEY (tenant_id, project_id, build_receipt_id)
    REFERENCES deviludo.steam_build_receipts(tenant_id, project_id, id),
  FOREIGN KEY (tenant_id, project_id, attempt_id)
    REFERENCES deviludo.e2e_attempts(tenant_id, project_id, id),
  FOREIGN KEY (tenant_id, project_id, evidence_bundle_id)
    REFERENCES deviludo.evidence_bundles(tenant_id, project_id, id)
);

CREATE OR REPLACE FUNCTION deviludo.validate_steam_release_revocation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1
    FROM deviludo.e2e_attempts attempt
    JOIN deviludo.evidence_bundles evidence
      ON evidence.tenant_id = attempt.tenant_id
     AND evidence.project_id = attempt.project_id
     AND evidence.attempt_id = attempt.id
    JOIN deviludo.steam_build_receipts build
      ON build.tenant_id = attempt.tenant_id
     AND build.project_id = attempt.project_id
     AND build.id = NEW.build_receipt_id
    JOIN deviludo.steam_releases release
      ON release.tenant_id = build.tenant_id
     AND release.project_id = build.project_id
     AND release.id = build.release_id
   WHERE attempt.tenant_id = NEW.tenant_id
     AND attempt.project_id = NEW.project_id
     AND attempt.id = NEW.attempt_id
     AND attempt.run_id = NEW.run_id
     AND attempt.workflow_id = NEW.workflow_id
     AND attempt.mode = 'STEAM_CLEAN_INSTALL'
     AND attempt.state = 'FAILED'
     AND attempt.commit_sha = NEW.main_commit_sha
     AND attempt.steam_build_id = NEW.build_id
     AND attempt.repair_prompt_id = NEW.repair_prompt_id
     AND attempt.completed_at = NEW.revoked_at
     AND evidence.id = NEW.evidence_bundle_id
     AND evidence.status = 'FAILED'
     AND evidence.bundle_digest = NEW.evidence_bundle_digest
     AND evidence.invalidated_at IS NULL
     AND build.release_id = NEW.release_id
     AND build.state = 'INSTALL_TESTING'
     AND build.steam_install_evidence_bundle_digest IS NULL
     AND build.main_commit_sha = NEW.main_commit_sha
     AND build.build_id = NEW.build_id
     AND release.workflow_id = NEW.workflow_id
     AND release.run_id = NEW.run_id
     AND release.main_commit_sha = NEW.main_commit_sha
     AND release.state = 'INSTALL_TESTING'
     AND release.external_gate = 'NONE'
   FOR SHARE OF attempt, evidence, build, release;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Steam install failure revocation is not evidence-authorized'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER steam_release_revocation_validate
BEFORE INSERT ON deviludo.steam_release_revocations
FOR EACH ROW EXECUTE FUNCTION deviludo.validate_steam_release_revocation();

CREATE TRIGGER steam_release_revocations_append_only
BEFORE UPDATE OR DELETE ON deviludo.steam_release_revocations
FOR EACH ROW EXECUTE FUNCTION deviludo.reject_mutation();

ALTER TABLE deviludo.steam_release_revocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE deviludo.steam_release_revocations FORCE ROW LEVEL SECURITY;
CREATE POLICY steam_release_revocations_tenant_isolation
  ON deviludo.steam_release_revocations
  USING (tenant_id = deviludo.current_tenant_id())
  WITH CHECK (tenant_id = deviludo.current_tenant_id());

CREATE INDEX steam_release_revocation_project_idx
  ON deviludo.steam_release_revocations (tenant_id, project_id, revoked_at);

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

  allowed_transition := OLD.state = 'INSTALL_TESTING'
    AND OLD.steam_install_evidence_bundle_digest IS NULL
    AND NEW.state IN ('EXTERNAL_APPROVAL_REQUIRED', 'FAILED')
    AND NEW.steam_install_evidence_bundle_digest IS NOT NULL;
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

CREATE OR REPLACE FUNCTION deviludo.require_steam_install_failure_revocation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state = 'INSTALL_TESTING' AND NEW.state = 'FAILED' AND NOT EXISTS (
    SELECT 1 FROM deviludo.steam_release_revocations revocation
     WHERE revocation.tenant_id = OLD.tenant_id
       AND revocation.project_id = OLD.project_id
       AND revocation.release_id = OLD.id
  ) THEN
    RAISE EXCEPTION 'Steam install failure has no revocation receipt' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER steam_release_install_failure_revocation_required
BEFORE UPDATE ON deviludo.steam_releases
FOR EACH ROW WHEN (OLD.state = 'INSTALL_TESTING' AND NEW.state = 'FAILED')
EXECUTE FUNCTION deviludo.require_steam_install_failure_revocation();

COMMIT;
