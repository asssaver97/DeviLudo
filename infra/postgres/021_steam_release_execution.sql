BEGIN;

-- Execution configuration is metadata only. Both fields are Vault references
-- or non-secret branch names; credential plaintext remains outside PostgreSQL.
ALTER TABLE deviludo.steam_releases
  ADD COLUMN beta_branch text,
  ADD COLUMN branch_password_secret_ref text,
  ADD CONSTRAINT steam_release_beta_execution_shape CHECK (
    (beta_branch IS NULL AND branch_password_secret_ref IS NULL)
    OR (beta_branch ~ '^[a-z0-9][a-z0-9_-]{2,39}$'
      AND beta_branch NOT IN ('default', 'public')
      AND branch_password_secret_ref ~ '^vault://[A-Za-z0-9._~:/-]{2,500}$')
  ) NOT VALID;

ALTER TABLE deviludo.evidence_bundles
  ADD CONSTRAINT evidence_bundles_tenant_project_id_unique UNIQUE (tenant_id, project_id, id);
ALTER TABLE deviludo.steam_build_receipts
  ADD CONSTRAINT steam_build_receipts_tenant_project_id_unique UNIQUE (tenant_id, project_id, id);

-- The signed RC is produced after the merged-main release gate. It is immutable
-- and separately bound to the exact run and evidence row used by Steam.
CREATE TABLE deviludo.steam_rc_artifacts (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES deviludo.tenants(id),
  project_id uuid NOT NULL REFERENCES deviludo.projects(id),
  run_id uuid NOT NULL,
  release_id uuid NOT NULL,
  main_evidence_bundle_id uuid NOT NULL,
  artifact_digest char(64) NOT NULL CHECK (artifact_digest ~ '^[a-f0-9]{64}$'),
  signed_artifact jsonb NOT NULL CHECK (
    jsonb_typeof(signed_artifact) = 'object' AND pg_column_size(signed_artifact) <= 262144
  ),
  created_at timestamptz NOT NULL,
  UNIQUE (tenant_id, release_id),
  FOREIGN KEY (tenant_id, project_id, release_id)
    REFERENCES deviludo.steam_releases(tenant_id, project_id, id),
  FOREIGN KEY (tenant_id, project_id, run_id)
    REFERENCES deviludo.agent_runs(tenant_id, project_id, id),
  FOREIGN KEY (tenant_id, project_id, main_evidence_bundle_id)
    REFERENCES deviludo.evidence_bundles(tenant_id, project_id, id)
);

-- Public/default-branch publication is append-only and can only reference the
-- already archived private-Beta Build and its clean-install evidence digest.
CREATE TABLE deviludo.steam_default_branch_receipts (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES deviludo.tenants(id),
  project_id uuid NOT NULL REFERENCES deviludo.projects(id),
  run_id uuid NOT NULL,
  release_id uuid NOT NULL,
  build_receipt_id uuid NOT NULL,
  operation_key text NOT NULL CHECK (operation_key ~ '^workflow-job:[a-f0-9-]{36}$'),
  request_digest char(64) NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  steam_app_id text NOT NULL CHECK (steam_app_id ~ '^[1-9][0-9]{0,19}$'),
  beta_build_id text NOT NULL CHECK (beta_build_id ~ '^[1-9][0-9]{0,19}$'),
  default_branch_build_id text NOT NULL CHECK (default_branch_build_id = beta_build_id),
  steam_install_evidence_bundle_digest char(64) NOT NULL
    CHECK (steam_install_evidence_bundle_digest ~ '^[a-f0-9]{64}$'),
  external_approval_ids text[] NOT NULL CHECK (
    cardinality(external_approval_ids) = 3
      AND array_lower(external_approval_ids, 1) = 1
      AND array_position(external_approval_ids, NULL) IS NULL
      AND external_approval_ids[1] <> external_approval_ids[2]
      AND external_approval_ids[1] <> external_approval_ids[3]
      AND external_approval_ids[2] <> external_approval_ids[3]
  ),
  receipt jsonb NOT NULL CHECK (jsonb_typeof(receipt) = 'object' AND pg_column_size(receipt) <= 65536),
  published_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE (tenant_id, release_id),
  UNIQUE (tenant_id, operation_key),
  UNIQUE (build_receipt_id),
  FOREIGN KEY (tenant_id, project_id, release_id)
    REFERENCES deviludo.steam_releases(tenant_id, project_id, id),
  FOREIGN KEY (tenant_id, project_id, run_id)
    REFERENCES deviludo.agent_runs(tenant_id, project_id, id),
  FOREIGN KEY (tenant_id, project_id, build_receipt_id)
    REFERENCES deviludo.steam_build_receipts(tenant_id, project_id, id)
);

CREATE OR REPLACE FUNCTION deviludo.protect_steam_release_execution_binding()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.id, NEW.tenant_id, NEW.project_id, NEW.main_commit_sha,
         NEW.evidence_bundle_id, NEW.steam_app_id, NEW.steam_session_secret_ref,
         NEW.mfa_approval_id, NEW.beta_branch, NEW.branch_password_secret_ref,
         NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.id, OLD.tenant_id, OLD.project_id, OLD.main_commit_sha,
         OLD.evidence_bundle_id, OLD.steam_app_id, OLD.steam_session_secret_ref,
         OLD.mfa_approval_id, OLD.beta_branch, OLD.branch_password_secret_ref,
         OLD.created_at) THEN
    RAISE EXCEPTION 'steam release execution binding is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER steam_release_execution_binding_immutable
BEFORE UPDATE ON deviludo.steam_releases
FOR EACH ROW EXECUTE FUNCTION deviludo.protect_steam_release_execution_binding();

CREATE TRIGGER steam_rc_artifact_append_only
BEFORE UPDATE OR DELETE ON deviludo.steam_rc_artifacts
FOR EACH ROW EXECUTE FUNCTION deviludo.reject_mutation();

CREATE TRIGGER steam_default_branch_receipt_append_only
BEFORE UPDATE OR DELETE ON deviludo.steam_default_branch_receipts
FOR EACH ROW EXECUTE FUNCTION deviludo.reject_mutation();

ALTER TABLE deviludo.steam_rc_artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE deviludo.steam_rc_artifacts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON deviludo.steam_rc_artifacts
  USING (tenant_id = deviludo.current_tenant_id())
  WITH CHECK (tenant_id = deviludo.current_tenant_id());

ALTER TABLE deviludo.steam_default_branch_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE deviludo.steam_default_branch_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON deviludo.steam_default_branch_receipts
  USING (tenant_id = deviludo.current_tenant_id())
  WITH CHECK (tenant_id = deviludo.current_tenant_id());

CREATE INDEX steam_rc_artifact_run_idx
  ON deviludo.steam_rc_artifacts (tenant_id, project_id, run_id);
CREATE INDEX steam_default_branch_receipt_build_idx
  ON deviludo.steam_default_branch_receipts (tenant_id, project_id, beta_build_id);

COMMIT;
