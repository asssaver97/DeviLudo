BEGIN;

ALTER TABLE deviludo.asset_items
  ADD COLUMN source_path text;

ALTER TABLE deviludo.asset_items
  DROP CONSTRAINT IF EXISTS asset_items_status_check,
  DROP CONSTRAINT IF EXISTS asset_items_check,
  ADD CONSTRAINT asset_items_status_check CHECK (
    status IN ('planned', 'generating', 'generated', 'uploaded', 'existing', 'failed')
  ),
  ADD CONSTRAINT asset_items_object_check CHECK (
    (status IN ('generated', 'uploaded'))
      = (object_key IS NOT NULL AND bucket IS NOT NULL AND sha256 IS NOT NULL AND size_bytes IS NOT NULL)
  ),
  ADD CONSTRAINT asset_items_source_path_check CHECK (
    source_path IS NULL OR (
      length(source_path) BETWEEN 1 AND 500
      AND source_path !~ '(^|/)\.{1,2}(/|$)'
      AND source_path !~ '//'
      AND source_path !~ '^/'
    )
  ),
  ADD CONSTRAINT asset_items_existing_source_check CHECK (
    (status = 'existing') = (source_path IS NOT NULL)
  );

CREATE OR REPLACE FUNCTION deviludo.default_asset_auto_generation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, deviludo
AS $$
BEGIN
  NEW.auto_generate_enabled := EXISTS (
    SELECT 1 FROM deviludo.instance_agent_settings
     WHERE singleton = true
       AND (
         agent_runtime = 'CODEX_CLI'
         OR (agent_runtime = 'CLAUDE_CODE' AND image_model IS NOT NULL)
       )
  );
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS asset_manifests_default_auto_generation ON deviludo.asset_manifests;
CREATE TRIGGER asset_manifests_default_auto_generation
BEFORE INSERT ON deviludo.asset_manifests
FOR EACH ROW EXECUTE FUNCTION deviludo.default_asset_auto_generation();
REVOKE ALL ON FUNCTION deviludo.default_asset_auto_generation() FROM PUBLIC;

CREATE OR REPLACE FUNCTION deviludo.claim_asset_generation(
  p_lease_seconds integer,
  p_batch_size integer DEFAULT 4
)
RETURNS TABLE (
  "workspaceId" uuid,
  "projectId" uuid,
  "itemId" uuid,
  "assetKey" text,
  "assetType" text,
  "description" text,
  "generationPrompt" text,
  "dimensions" text,
  "frameCount" integer,
  "attempt" integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, deviludo
SET row_security = off
AS $$
BEGIN
  IF p_lease_seconds NOT BETWEEN 30 AND 3600 OR p_batch_size NOT BETWEEN 1 AND 50 THEN
    RAISE EXCEPTION 'invalid asset generation claim';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM deviludo.instance_agent_settings
     WHERE singleton = true
       AND (
         agent_runtime = 'CODEX_CLI'
         OR (agent_runtime = 'CLAUDE_CODE' AND image_model IS NOT NULL)
       )
  ) THEN RETURN; END IF;

  RETURN QUERY
  WITH candidate AS (
    SELECT item.workspace_id, item.id
      FROM deviludo.asset_items item
      JOIN deviludo.asset_manifests manifest
        ON manifest.workspace_id = item.workspace_id AND manifest.id = item.manifest_id
     WHERE manifest.auto_generate_enabled = true
       AND item.generation_prompt IS NOT NULL
       AND item.generation_attempt < 3
       AND (
         item.status = 'planned'
         OR (item.status = 'generating' AND item.generation_lease_expires_at <= clock_timestamp())
       )
     ORDER BY item.generation_attempt, item.created_at, item.id
     FOR UPDATE OF item SKIP LOCKED
     LIMIT p_batch_size
  )
  UPDATE deviludo.asset_items item
     SET status = 'generating',
         generation_attempt = item.generation_attempt + 1,
         generation_lease_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds),
         error_message = NULL,
         updated_at = clock_timestamp()
    FROM candidate
   WHERE item.workspace_id = candidate.workspace_id AND item.id = candidate.id
  RETURNING item.workspace_id, (
    SELECT manifest.project_id FROM deviludo.asset_manifests manifest
     WHERE manifest.workspace_id = item.workspace_id AND manifest.id = item.manifest_id
  ), item.id, item.asset_key, item.asset_type, item.description,
     item.generation_prompt, item.dimensions, item.frame_count, item.generation_attempt;
END
$$;
ALTER FUNCTION deviludo.claim_asset_generation(integer, integer)
  OWNER TO deviludo_claim_executor;

CREATE OR REPLACE FUNCTION deviludo.advance_asset_workflows(p_batch_size integer DEFAULT 20)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, deviludo
SET row_security = off
AS $$
DECLARE
  candidate record;
  advanced integer := 0;
BEGIN
  IF p_batch_size NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'invalid asset workflow batch size';
  END IF;
  FOR candidate IN
    SELECT workflow.workspace_id, workflow.id AS workflow_id, workflow.project_id,
           workflow.target_platforms, agent.id AS agent_job_id
      FROM deviludo.workflow_instances workflow
      JOIN deviludo.asset_manifests manifest
        ON manifest.workspace_id = workflow.workspace_id
       AND manifest.project_id = workflow.project_id
       AND manifest.workflow_id = workflow.id
      JOIN LATERAL (
        SELECT source.id
          FROM deviludo.jobs source
         WHERE source.workspace_id = workflow.workspace_id
           AND source.workflow_id = workflow.id
           AND source.kind = 'AGENT_GENERATION'
           AND source.state = 'SUCCEEDED'
         ORDER BY source.updated_at DESC, source.created_at DESC
         LIMIT 1
      ) agent ON true
     WHERE workflow.state = 'ASSET_GENERATING'
       AND (
         manifest.auto_generate_enabled = false
         OR NOT EXISTS (
           SELECT 1 FROM deviludo.asset_items item
            WHERE item.workspace_id = manifest.workspace_id
              AND item.manifest_id = manifest.id
              AND item.status NOT IN ('generated', 'uploaded', 'existing')
         )
       )
     ORDER BY workflow.updated_at, workflow.id
     FOR UPDATE OF workflow SKIP LOCKED
     LIMIT p_batch_size
  LOOP
    UPDATE deviludo.workflow_instances
       SET state = 'ARTIFACT_BUILDING', version = version + 1,
           updated_at = clock_timestamp()
     WHERE workspace_id = candidate.workspace_id AND id = candidate.workflow_id
       AND state = 'ASSET_GENERATING';
    IF FOUND THEN
      PERFORM deviludo.enqueue_job(
        candidate.workspace_id, candidate.workflow_id, candidate.project_id,
        'ARTIFACT_BUILD', NULL,
        candidate.workflow_id::text || ':artifact:after:' || candidate.agent_job_id::text,
        jsonb_build_object('targetPlatforms', candidate.target_platforms)
      );
      INSERT INTO deviludo.workflow_events(
        workspace_id, workflow_id, event_kind, event_data, idempotency_key
      ) VALUES (
        candidate.workspace_id, candidate.workflow_id, 'ASSETS_READY',
        jsonb_build_object('agentJobId', candidate.agent_job_id),
        'assets-ready:' || candidate.agent_job_id::text
      ) ON CONFLICT (workspace_id, workflow_id, idempotency_key) DO NOTHING;
      advanced := advanced + 1;
    END IF;
  END LOOP;
  RETURN advanced;
END
$$;
ALTER FUNCTION deviludo.advance_asset_workflows(integer)
  OWNER TO deviludo_claim_executor;

COMMIT;
