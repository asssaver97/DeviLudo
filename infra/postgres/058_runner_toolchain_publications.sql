BEGIN;

-- Only the isolated Runner toolchain publisher may create project revisions.
-- Its append-only receipt binds the exact admitted physical Runner capability
-- used for every platform, so a valid-looking digest cannot be inserted by a
-- browser or by the specification service.
CREATE TABLE deviludo.runner_toolchain_publications (
  publication_id uuid NOT NULL,
  tenant_id uuid NOT NULL REFERENCES deviludo.tenants(id),
  project_id uuid NOT NULL REFERENCES deviludo.projects(id),
  request_digest char(64) NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  publisher_spiffe_id text NOT NULL CHECK (publisher_spiffe_id LIKE 'spiffe://%'),
  required_godot_version text NOT NULL
    CHECK (required_godot_version ~ '^4\.[0-9]+\.[0-9]+([.-][A-Za-z0-9]+)*$'),
  godot_testkit_digest char(64) NOT NULL CHECK (godot_testkit_digest ~ '^[a-f0-9]{64}$'),
  build_manifest_digest char(64) NOT NULL CHECK (build_manifest_digest ~ '^[a-f0-9]{64}$'),
  sbom_digest char(64) NOT NULL CHECK (sbom_digest ~ '^[a-f0-9]{64}$'),
  vulnerability_scan_digest char(64) NOT NULL CHECK (vulnerability_scan_digest ~ '^[a-f0-9]{64}$'),
  asset_license_ledger_digest char(64) NOT NULL CHECK (asset_license_ledger_digest ~ '^[a-f0-9]{64}$'),
  target_matrix text[] NOT NULL,
  runner_bindings jsonb NOT NULL,
  runner_toolchain_revision_id uuid NOT NULL,
  runner_toolchain_digest char(64) NOT NULL
    CHECK (runner_toolchain_digest ~ '^[a-f0-9]{64}$'),
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, publication_id),
  UNIQUE (tenant_id, project_id, publication_id),
  UNIQUE (tenant_id, project_id, runner_toolchain_revision_id),
  FOREIGN KEY (tenant_id, project_id, runner_toolchain_revision_id, runner_toolchain_digest)
    REFERENCES deviludo.runner_toolchain_revisions
      (tenant_id, project_id, id, payload_digest),
  CHECK (
    target_matrix IN (
      ARRAY['linux']::text[], ARRAY['macos']::text[], ARRAY['windows']::text[],
      ARRAY['linux', 'macos']::text[], ARRAY['linux', 'windows']::text[],
      ARRAY['macos', 'windows']::text[], ARRAY['linux', 'macos', 'windows']::text[]
    )
  ),
  CHECK (jsonb_typeof(runner_bindings) = 'object' AND pg_column_size(runner_bindings) <= 16384),
  CHECK (
    expires_at > issued_at
      AND expires_at <= issued_at + interval '15 minutes'
      AND created_at >= issued_at - interval '30 seconds'
      AND created_at < expires_at
  )
);

CREATE OR REPLACE FUNCTION deviludo.validate_runner_toolchain_revision()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE matrix text[];
BEGIN
  SELECT array_agg(key ORDER BY key) INTO matrix
    FROM jsonb_object_keys(NEW.payload->'exportTemplates') keys(key);
  IF NEW.created_by NOT LIKE 'spiffe://%'
     OR matrix IS NULL
     OR NOT deviludo.runner_toolchain_binding_is_valid(
       NEW.payload, NEW.payload->>'requiredGodotVersion', matrix
     ) THEN
    RAISE EXCEPTION 'Runner toolchain revision is not a canonical publisher output'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION deviludo.validate_runner_toolchain_publication()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  revision deviludo.runner_toolchain_revisions%ROWTYPE;
  platform text;
  binding jsonb;
  registration deviludo.runner_registrations%ROWTYPE;
BEGIN
  SELECT * INTO revision
    FROM deviludo.runner_toolchain_revisions selected
   WHERE selected.tenant_id = NEW.tenant_id
     AND selected.project_id = NEW.project_id
     AND selected.id = NEW.runner_toolchain_revision_id
     AND selected.payload_digest = NEW.runner_toolchain_digest;
  IF revision.id IS NULL
     OR revision.created_by IS DISTINCT FROM NEW.publisher_spiffe_id
     OR revision.payload->>'requiredGodotVersion' IS DISTINCT FROM NEW.required_godot_version
     OR revision.payload->>'godotTestKitDigest' IS DISTINCT FROM NEW.godot_testkit_digest
     OR revision.payload->>'buildManifestDigest' IS DISTINCT FROM NEW.build_manifest_digest
     OR revision.payload->>'sbomDigest' IS DISTINCT FROM NEW.sbom_digest
     OR revision.payload->>'vulnerabilityScanDigest' IS DISTINCT FROM NEW.vulnerability_scan_digest
     OR revision.payload->>'assetLicenseLedgerDigest' IS DISTINCT FROM NEW.asset_license_ledger_digest
     OR (SELECT array_agg(key ORDER BY key)
           FROM jsonb_object_keys(NEW.runner_bindings) keys(key)) IS DISTINCT FROM NEW.target_matrix
     OR (SELECT array_agg(key ORDER BY key)
           FROM jsonb_object_keys(revision.payload->'exportTemplates') keys(key)) IS DISTINCT FROM NEW.target_matrix THEN
    RAISE EXCEPTION 'Runner toolchain publication binding is invalid' USING ERRCODE = '23514';
  END IF;

  FOREACH platform IN ARRAY NEW.target_matrix LOOP
    binding := NEW.runner_bindings->platform;
    IF jsonb_typeof(binding) IS DISTINCT FROM 'object'
       OR (SELECT array_agg(key ORDER BY key)
             FROM jsonb_object_keys(binding) keys(key))
            IS DISTINCT FROM ARRAY['capabilityDigest', 'runnerId']::text[] THEN
      RAISE EXCEPTION 'Runner toolchain publication Runner binding is invalid' USING ERRCODE = '23514';
    END IF;
    SELECT * INTO registration
      FROM deviludo.runner_registrations selected
     WHERE selected.id = binding->>'runnerId'
       AND selected.platform = platform
       AND selected.capability_digest = binding->>'capabilityDigest';
    IF registration.id IS NULL
       OR registration.state <> 'ONLINE'
       OR registration.certificate_not_after <= NEW.created_at
       OR registration.capabilities->>'godotVersion' IS DISTINCT FROM NEW.required_godot_version
       OR registration.capabilities->>'exportTemplatesDigest'
            IS DISTINCT FROM revision.payload->'exportTemplates'->>platform THEN
      RAISE EXCEPTION 'Runner toolchain publication does not match an admitted Runner'
        USING ERRCODE = '23514';
    END IF;
  END LOOP;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION deviludo.require_runner_toolchain_publication()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM deviludo.runner_toolchain_publications publication
     WHERE publication.tenant_id = NEW.tenant_id
       AND publication.project_id = NEW.project_id
       AND publication.runner_toolchain_revision_id = NEW.id
       AND publication.runner_toolchain_digest = NEW.payload_digest
  ) THEN
    RAISE EXCEPTION 'Runner toolchain revision lacks its authoritative publication'
      USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER runner_toolchain_revision_insert_guard
BEFORE INSERT ON deviludo.runner_toolchain_revisions
FOR EACH ROW EXECUTE FUNCTION deviludo.validate_runner_toolchain_revision();
CREATE TRIGGER runner_toolchain_publication_insert_guard
BEFORE INSERT ON deviludo.runner_toolchain_publications
FOR EACH ROW EXECUTE FUNCTION deviludo.validate_runner_toolchain_publication();
CREATE CONSTRAINT TRIGGER runner_toolchain_revision_requires_publication
AFTER INSERT ON deviludo.runner_toolchain_revisions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION deviludo.require_runner_toolchain_publication();
CREATE TRIGGER runner_toolchain_publications_append_only
BEFORE UPDATE OR DELETE ON deviludo.runner_toolchain_publications
FOR EACH ROW EXECUTE FUNCTION deviludo.reject_mutation();

ALTER TABLE deviludo.runner_toolchain_publications ENABLE ROW LEVEL SECURITY;
ALTER TABLE deviludo.runner_toolchain_publications FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON deviludo.runner_toolchain_publications
  USING (tenant_id = deviludo.current_tenant_id())
  WITH CHECK (tenant_id = deviludo.current_tenant_id());

CREATE INDEX runner_toolchain_publication_project_idx
  ON deviludo.runner_toolchain_publications
  (tenant_id, project_id, created_at DESC);

-- Migration-time audit: every pre-existing revision must already satisfy the
-- same canonical payload contract. Revisions created before this publisher was
-- introduced are allowed to retain their historic actor label.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM deviludo.runner_toolchain_revisions revision
     WHERE NOT deviludo.runner_toolchain_binding_is_valid(
       revision.payload,
       revision.payload->>'requiredGodotVersion',
       ARRAY(SELECT key FROM jsonb_object_keys(revision.payload->'exportTemplates') keys(key) ORDER BY key)
     )
  ) THEN
    RAISE EXCEPTION 'existing Runner toolchain revision is invalid' USING ERRCODE = '23514';
  END IF;
END $$;

COMMIT;
