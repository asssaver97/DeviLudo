BEGIN;

-- The specification service and Artifact Preparer must interpret a frozen
-- Runner toolchain identically. The foreign key added by migration 017 proves
-- identity and digest; this predicate additionally proves that the referenced
-- payload is compatible with the approved Godot version and exact target
-- matrix. It intentionally accepts no extra top-level or export-template keys.
CREATE OR REPLACE FUNCTION deviludo.runner_toolchain_binding_is_valid(
  toolchain jsonb,
  required_godot_version text,
  target_matrix text[]
) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE
AS $$
DECLARE
  payload_keys text[];
  template_keys text[];
BEGIN
  IF jsonb_typeof(toolchain) IS DISTINCT FROM 'object'
     OR toolchain->>'schemaVersion' IS DISTINCT FROM 'deviludo.runner-toolchain.v1'
     OR toolchain->>'requiredGodotVersion' IS DISTINCT FROM required_godot_version
     OR jsonb_typeof(toolchain->'exportTemplates') IS DISTINCT FROM 'object' THEN
    RETURN false;
  END IF;

  SELECT array_agg(key ORDER BY key) INTO payload_keys
    FROM jsonb_object_keys(toolchain) AS keys(key);
  IF payload_keys IS DISTINCT FROM ARRAY[
    'assetLicenseLedgerDigest', 'buildManifestDigest', 'exportTemplates',
    'godotTestKitDigest', 'requiredGodotVersion', 'sbomDigest',
    'schemaVersion', 'vulnerabilityScanDigest'
  ]::text[] THEN
    RETURN false;
  END IF;

  IF NOT COALESCE(toolchain->>'godotTestKitDigest' ~ '^[a-f0-9]{64}$', false)
     OR NOT COALESCE(toolchain->>'buildManifestDigest' ~ '^[a-f0-9]{64}$', false)
     OR NOT COALESCE(toolchain->>'sbomDigest' ~ '^[a-f0-9]{64}$', false)
     OR NOT COALESCE(toolchain->>'vulnerabilityScanDigest' ~ '^[a-f0-9]{64}$', false)
     OR NOT COALESCE(toolchain->>'assetLicenseLedgerDigest' ~ '^[a-f0-9]{64}$', false) THEN
    RETURN false;
  END IF;

  SELECT array_agg(key ORDER BY key) INTO template_keys
    FROM jsonb_object_keys(toolchain->'exportTemplates') AS keys(key);
  IF template_keys IS DISTINCT FROM target_matrix THEN
    RETURN false;
  END IF;
  IF EXISTS (
    SELECT 1
      FROM jsonb_each(toolchain->'exportTemplates') AS templates(platform, digest)
     WHERE jsonb_typeof(digest) IS DISTINCT FROM 'string'
        OR NOT COALESCE(digest #>> '{}' ~ '^[a-f0-9]{64}$', false)
  ) THEN
    RETURN false;
  END IF;
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION deviludo.approved_test_plan_toolchain_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  toolchain jsonb;
BEGIN
  SELECT revision.payload INTO toolchain
    FROM deviludo.runner_toolchain_revisions revision
   WHERE revision.tenant_id = NEW.tenant_id
     AND revision.project_id = NEW.project_id
     AND revision.id = NEW.runner_toolchain_revision_id
     AND revision.payload_digest = NEW.runner_toolchain_digest;

  IF toolchain IS NULL OR NOT deviludo.runner_toolchain_binding_is_valid(
    toolchain, NEW.required_godot_version, NEW.target_matrix
  ) THEN
    RAISE EXCEPTION 'approved test plan Runner toolchain is incompatible'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER approved_test_plan_toolchain_compatibility
BEFORE INSERT ON deviludo.approved_test_plan_bindings
FOR EACH ROW EXECUTE FUNCTION deviludo.approved_test_plan_toolchain_guard();

-- Refuse to install the guard over legacy rows that would already violate it.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM deviludo.approved_test_plan_bindings binding
      JOIN deviludo.runner_toolchain_revisions revision
        ON revision.tenant_id = binding.tenant_id
       AND revision.project_id = binding.project_id
       AND revision.id = binding.runner_toolchain_revision_id
       AND revision.payload_digest = binding.runner_toolchain_digest
     WHERE NOT deviludo.runner_toolchain_binding_is_valid(
       revision.payload, binding.required_godot_version, binding.target_matrix
     )
  ) THEN
    RAISE EXCEPTION 'existing approved test plan Runner toolchain is incompatible'
      USING ERRCODE = '55000';
  END IF;
END;
$$;

COMMIT;
