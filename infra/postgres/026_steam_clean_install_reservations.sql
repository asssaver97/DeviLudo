BEGIN;

-- The publisher reserves one immutable clean-install handle per selected OS
-- before returning the private-Beta receipt. Runner preparation later proves
-- the receipt contains exactly these server-created handles.
CREATE TABLE deviludo.steam_clean_install_reservations (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES deviludo.tenants(id),
  project_id uuid NOT NULL,
  release_id uuid NOT NULL,
  steam_app_id text NOT NULL CHECK (steam_app_id ~ '^[1-9][0-9]{0,19}$'),
  build_id text NOT NULL CHECK (build_id ~ '^[1-9][0-9]{0,19}$'),
  platform text NOT NULL CHECK (platform IN ('windows', 'linux', 'macos')),
  main_commit_sha text NOT NULL CHECK (main_commit_sha ~ '^[a-f0-9]{40}$'),
  source_digest text NOT NULL CHECK (source_digest ~ '^[a-f0-9]{64}$'),
  spec_digest text NOT NULL CHECK (spec_digest ~ '^[a-f0-9]{64}$'),
  test_plan_digest text NOT NULL CHECK (test_plan_digest ~ '^[a-f0-9]{64}$'),
  reservation_digest text NOT NULL CHECK (reservation_digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL,
  FOREIGN KEY (tenant_id, project_id)
    REFERENCES deviludo.projects(tenant_id, id),
  FOREIGN KEY (tenant_id, project_id, release_id)
    REFERENCES deviludo.steam_releases(tenant_id, project_id, id),
  UNIQUE (tenant_id, project_id, id),
  UNIQUE (release_id, platform)
);

CREATE TRIGGER steam_clean_install_reservations_append_only
BEFORE UPDATE OR DELETE ON deviludo.steam_clean_install_reservations
FOR EACH ROW EXECUTE FUNCTION deviludo.reject_mutation();

ALTER TABLE deviludo.steam_clean_install_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE deviludo.steam_clean_install_reservations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON deviludo.steam_clean_install_reservations
  USING (tenant_id = deviludo.current_tenant_id())
  WITH CHECK (tenant_id = deviludo.current_tenant_id());

CREATE INDEX steam_clean_install_reservations_build_idx
  ON deviludo.steam_clean_install_reservations (tenant_id, project_id, build_id, platform);

COMMIT;
