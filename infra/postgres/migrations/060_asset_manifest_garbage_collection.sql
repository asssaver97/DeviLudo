BEGIN;

-- Make the accepted Agent Manifest authoritative without deleting user art.
-- The durable queue lets object deletion retry independently after commit.
DO $migration$
DECLARE
  target regprocedure :=
    'deviludo.complete_job(uuid,uuid,bigint,bigint,jsonb,jsonb,text,text,text)'::regprocedure;
  definition text;
  insert_anchor text := $old$      INSERT INTO deviludo.asset_items($old$;
  cleanup_block text := $new$      -- The accepted Manifest is now authoritative. Generated objects that are
      -- absent or whose generation contract changed are retired durably before
      -- their rows are reset/deleted. Uploaded objects are explicit user input
      -- and never enter this automatic cleanup path.
      INSERT INTO deviludo.object_cleanup_queue(workspace_id, bucket, object_key, reason)
      SELECT old.workspace_id, old.bucket, old.object_key,
             'retired generated asset after Agent manifest re-plan'
        FROM deviludo.asset_items old
       WHERE old.workspace_id = job.workspace_id
         AND old.manifest_id = asset_manifest_id
         AND old.status = 'generated'
         AND (
           NOT EXISTS (
             SELECT 1
               FROM jsonb_array_elements(p_receipt #> '{assetManifest,items}') item
              WHERE item->>'assetKey' = old.asset_key
           )
           OR EXISTS (
             SELECT 1
               FROM jsonb_array_elements(p_receipt #> '{assetManifest,items}') item
              WHERE item->>'assetKey' = old.asset_key
                AND (
                  old.asset_type IS DISTINCT FROM item->>'assetType'
                  OR old.generation_prompt IS DISTINCT FROM item->>'generationPrompt'
                  OR old.frame_count IS DISTINCT FROM (item->>'frameCount')::integer
                  OR old.dimensions IS DISTINCT FROM item->>'dimensions'
                )
           )
         )
      ON CONFLICT (workspace_id, bucket, object_key) DO NOTHING;

      UPDATE deviludo.asset_items old
         SET status = 'planned', bucket = NULL, object_key = NULL,
             sha256 = NULL, size_bytes = NULL, source_path = NULL,
             generation_attempt = 0, generation_lease_expires_at = NULL,
             generation_lease_token = NULL, error_message = NULL,
             updated_at = clock_timestamp()
        FROM jsonb_array_elements(p_receipt #> '{assetManifest,items}') item
       WHERE old.workspace_id = job.workspace_id
         AND old.manifest_id = asset_manifest_id
         AND old.status = 'generated'
         AND item->>'assetKey' = old.asset_key
         AND (
           old.asset_type IS DISTINCT FROM item->>'assetType'
           OR old.generation_prompt IS DISTINCT FROM item->>'generationPrompt'
           OR old.frame_count IS DISTINCT FROM (item->>'frameCount')::integer
           OR old.dimensions IS DISTINCT FROM item->>'dimensions'
         );

      INSERT INTO deviludo.asset_items($new$;
  old_retention text := $old$         AND status NOT IN ('generated', 'uploaded')$old$;
  new_retention text := $new$         AND status <> 'uploaded'$new$;
BEGIN
  SELECT pg_get_functiondef(target) INTO definition;

  IF position('retired generated asset after Agent manifest re-plan' IN definition) = 0 THEN
    IF position(insert_anchor IN definition) = 0 THEN
      RAISE EXCEPTION 'complete_job asset insertion anchor no longer matches the expected contract';
    END IF;
    definition := replace(definition, insert_anchor, cleanup_block);
  END IF;

  IF position(new_retention IN definition) = 0 THEN
    IF position(old_retention IN definition) = 0 THEN
      RAISE EXCEPTION 'complete_job asset retention anchor no longer matches the expected contract';
    END IF;
    definition := replace(definition, old_retention, new_retention);
  END IF;

  EXECUTE definition;
END
$migration$;

COMMIT;
