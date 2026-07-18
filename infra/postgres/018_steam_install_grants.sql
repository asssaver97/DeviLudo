BEGIN;

-- Opaque grants authorize only an exact private-Beta BuildID. They carry no
-- Steam session material and may be redeemed once per selected platform.
CREATE TABLE deviludo.steam_install_grants (
  grant_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES deviludo.tenants(id),
  project_id uuid NOT NULL REFERENCES deviludo.projects(id),
  run_id uuid NOT NULL REFERENCES deviludo.agent_runs(id),
  lock_key char(64) NOT NULL CHECK (lock_key ~ '^[a-f0-9]{64}$'),
  build_receipt_id uuid NOT NULL REFERENCES deviludo.steam_build_receipts(id),
  steam_app_id text NOT NULL CHECK (steam_app_id ~ '^[1-9][0-9]{0,19}$'),
  build_id text NOT NULL CHECK (build_id ~ '^[1-9][0-9]{0,19}$'),
  beta_branch text NOT NULL CHECK (beta_branch ~ '^[a-z0-9][a-z0-9_-]{2,39}$'),
  target_matrix text[] NOT NULL,
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  UNIQUE (tenant_id, lock_key),
  UNIQUE (tenant_id, project_id, run_id, grant_id),
  CHECK (expires_at > issued_at AND expires_at <= issued_at + interval '24 hours'),
  CHECK (revoked_at IS NULL OR (revoked_at >= issued_at AND revoked_at < expires_at)),
  CHECK (
    cardinality(target_matrix) BETWEEN 1 AND 3
      AND target_matrix <@ ARRAY['windows', 'linux', 'macos']::text[]
      AND array_lower(target_matrix, 1) = 1
      AND array_position(target_matrix, NULL) IS NULL
      AND (target_matrix[2] IS NULL OR target_matrix[2] > target_matrix[1])
      AND (target_matrix[3] IS NULL OR target_matrix[3] > target_matrix[2])
  )
);

CREATE TABLE deviludo.steam_install_grant_redemptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES deviludo.tenants(id),
  project_id uuid NOT NULL REFERENCES deviludo.projects(id),
  run_id uuid NOT NULL REFERENCES deviludo.agent_runs(id),
  grant_id uuid NOT NULL,
  platform text NOT NULL CHECK (platform IN ('windows', 'linux', 'macos')),
  runner_id text NOT NULL CHECK (runner_id ~ '^[a-z0-9][a-z0-9-]{2,63}$'),
  job_digest char(64) NOT NULL CHECK (job_digest ~ '^[a-f0-9]{64}$'),
  execution_lock_digest char(64) NOT NULL CHECK (execution_lock_digest ~ '^[a-f0-9]{64}$'),
  redeemed_at timestamptz NOT NULL,
  FOREIGN KEY (tenant_id, project_id, run_id, grant_id)
    REFERENCES deviludo.steam_install_grants (tenant_id, project_id, run_id, grant_id),
  UNIQUE (tenant_id, grant_id, platform)
);

ALTER TABLE deviludo.steam_install_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE deviludo.steam_install_grants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON deviludo.steam_install_grants
  USING (tenant_id = deviludo.current_tenant_id())
  WITH CHECK (tenant_id = deviludo.current_tenant_id());

ALTER TABLE deviludo.steam_install_grant_redemptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE deviludo.steam_install_grant_redemptions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON deviludo.steam_install_grant_redemptions
  USING (tenant_id = deviludo.current_tenant_id())
  WITH CHECK (tenant_id = deviludo.current_tenant_id());

CREATE OR REPLACE FUNCTION deviludo.protect_steam_install_grant()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.grant_id, NEW.tenant_id, NEW.project_id, NEW.run_id, NEW.lock_key,
         NEW.build_receipt_id, NEW.steam_app_id, NEW.build_id, NEW.beta_branch,
         NEW.target_matrix, NEW.issued_at, NEW.expires_at)
     IS DISTINCT FROM
     ROW(OLD.grant_id, OLD.tenant_id, OLD.project_id, OLD.run_id, OLD.lock_key,
         OLD.build_receipt_id, OLD.steam_app_id, OLD.build_id, OLD.beta_branch,
         OLD.target_matrix, OLD.issued_at, OLD.expires_at) THEN
    RAISE EXCEPTION 'Steam install grant binding is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL THEN
    RAISE EXCEPTION 'invalid Steam install grant revocation' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER steam_install_grant_update_guard
BEFORE UPDATE ON deviludo.steam_install_grants
FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*)
EXECUTE FUNCTION deviludo.protect_steam_install_grant();

CREATE TRIGGER steam_install_grant_no_delete
BEFORE DELETE ON deviludo.steam_install_grants
FOR EACH ROW EXECUTE FUNCTION deviludo.reject_mutation();

CREATE TRIGGER steam_install_grant_redemptions_append_only
BEFORE UPDATE OR DELETE ON deviludo.steam_install_grant_redemptions
FOR EACH ROW EXECUTE FUNCTION deviludo.reject_mutation();

CREATE INDEX steam_install_grant_expiry_idx
  ON deviludo.steam_install_grants (tenant_id, expires_at) WHERE revoked_at IS NULL;

COMMIT;
