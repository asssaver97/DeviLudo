BEGIN;

-- Project depot IDs are non-secret Steamworks metadata. Revisions are exact,
-- tenant-scoped and frozen into the signed RC before any SteamPipe execution.
CREATE TABLE deviludo.steam_project_depot_configurations (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES deviludo.tenants(id),
  project_id uuid NOT NULL REFERENCES deviludo.projects(id),
  steam_app_id text NOT NULL CHECK (steam_app_id ~ '^[1-9][0-9]{0,19}$'),
  revision integer NOT NULL CHECK (revision > 0),
  platform_depots jsonb NOT NULL CHECK (
    jsonb_typeof(platform_depots) = 'object'
      AND jsonb_object_length(platform_depots) BETWEEN 1 AND 3
      AND (platform_depots - 'windows' - 'linux' - 'macos') = '{}'::jsonb
      AND (NOT (platform_depots ? 'windows') OR platform_depots->>'windows' ~ '^[1-9][0-9]{0,19}$')
      AND (NOT (platform_depots ? 'linux') OR platform_depots->>'linux' ~ '^[1-9][0-9]{0,19}$')
      AND (NOT (platform_depots ? 'macos') OR platform_depots->>'macos' ~ '^[1-9][0-9]{0,19}$')
      AND (NOT (platform_depots ? 'windows' AND platform_depots ? 'linux')
        OR platform_depots->>'windows' <> platform_depots->>'linux')
      AND (NOT (platform_depots ? 'windows' AND platform_depots ? 'macos')
        OR platform_depots->>'windows' <> platform_depots->>'macos')
      AND (NOT (platform_depots ? 'linux' AND platform_depots ? 'macos')
        OR platform_depots->>'linux' <> platform_depots->>'macos')
      AND pg_column_size(platform_depots) <= 4096
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
  CHECK (
    (state = 'ACTIVE' AND superseded_at IS NULL)
      OR (state = 'SUPERSEDED' AND superseded_at IS NOT NULL AND superseded_at >= created_at)
  )
);

CREATE UNIQUE INDEX steam_project_depot_configuration_active_idx
  ON deviludo.steam_project_depot_configurations (tenant_id, project_id)
  WHERE state = 'ACTIVE';

CREATE OR REPLACE FUNCTION deviludo.protect_steam_project_depot_configuration()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.id, NEW.tenant_id, NEW.project_id, NEW.steam_app_id, NEW.revision,
         NEW.platform_depots, NEW.configuration_digest, NEW.created_by, NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.id, OLD.tenant_id, OLD.project_id, OLD.steam_app_id, OLD.revision,
         OLD.platform_depots, OLD.configuration_digest, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'steam depot configuration binding is immutable' USING ERRCODE = '55000';
  END IF;
  IF NOT (OLD.state = 'ACTIVE' AND NEW.state = 'SUPERSEDED'
          AND OLD.superseded_at IS NULL AND NEW.superseded_at IS NOT NULL) THEN
    RAISE EXCEPTION 'invalid steam depot configuration transition' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER steam_project_depot_configuration_state_guard
BEFORE UPDATE ON deviludo.steam_project_depot_configurations
FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*)
EXECUTE FUNCTION deviludo.protect_steam_project_depot_configuration();

CREATE TRIGGER steam_project_depot_configuration_no_delete
BEFORE DELETE ON deviludo.steam_project_depot_configurations
FOR EACH ROW EXECUTE FUNCTION deviludo.reject_mutation();

ALTER TABLE deviludo.steam_project_depot_configurations ENABLE ROW LEVEL SECURITY;
ALTER TABLE deviludo.steam_project_depot_configurations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON deviludo.steam_project_depot_configurations
  USING (tenant_id = deviludo.current_tenant_id())
  WITH CHECK (tenant_id = deviludo.current_tenant_id());

-- Existing beta data may be remediated out of band; every RC issued by this
-- version stores both fields and the archive reader rejects legacy NULLs.
ALTER TABLE deviludo.steam_rc_artifacts
  ADD COLUMN depot_configuration_id uuid,
  ADD COLUMN depot_configuration_digest char(64),
  ADD CONSTRAINT steam_rc_depot_configuration_shape CHECK (
    (depot_configuration_id IS NULL AND depot_configuration_digest IS NULL)
      OR (depot_configuration_id IS NOT NULL
        AND depot_configuration_digest ~ '^[a-f0-9]{64}$')
  ),
  ADD CONSTRAINT steam_rc_depot_configuration_fk
    FOREIGN KEY (tenant_id, project_id, depot_configuration_id)
    REFERENCES deviludo.steam_project_depot_configurations(tenant_id, project_id, id);

COMMIT;
