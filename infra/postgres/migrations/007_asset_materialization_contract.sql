-- Make planned asset keys safe to materialize below a Godot project root.
ALTER TABLE deviludo.asset_items
  DROP CONSTRAINT IF EXISTS asset_items_asset_key_check;

ALTER TABLE deviludo.asset_items
  ADD CONSTRAINT asset_items_asset_key_check CHECK (
    length(asset_key) BETWEEN 1 AND 200
    AND asset_key ~ '^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$'
    AND asset_key !~ '(^|/)\.{1,2}(/|$)'
    AND asset_key !~ '//'
    AND asset_key !~ '/$'
  );

-- Existing databases keep their installed enqueue_job function immutable. A
-- trigger snapshots the supplied image objects into each new build job before
-- it becomes visible to a worker.
CREATE OR REPLACE FUNCTION deviludo.snapshot_artifact_build_assets()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, deviludo
AS $$
DECLARE
  inputs jsonb;
BEGIN
  IF NEW.kind <> 'ARTIFACT_BUILD' THEN RETURN NEW; END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'assetKey', item.asset_key,
    'bucket', item.bucket,
    'objectKey', item.object_key,
    'sha256', item.sha256,
    'sizeBytes', item.size_bytes
  ) ORDER BY item.asset_key), '[]'::jsonb)
    INTO inputs
    FROM deviludo.asset_manifests manifest
    JOIN deviludo.asset_items item
      ON item.workspace_id = manifest.workspace_id AND item.manifest_id = manifest.id
   WHERE manifest.workspace_id = NEW.workspace_id
     AND manifest.project_id = NEW.project_id
     AND manifest.workflow_id = NEW.workflow_id
     AND item.status IN ('generated', 'uploaded');
  NEW.payload := NEW.payload || jsonb_build_object('assetInputs', inputs);
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS jobs_snapshot_artifact_build_assets ON deviludo.jobs;
CREATE TRIGGER jobs_snapshot_artifact_build_assets
BEFORE INSERT ON deviludo.jobs
FOR EACH ROW EXECUTE FUNCTION deviludo.snapshot_artifact_build_assets();
