BEGIN;

CREATE OR REPLACE FUNCTION deviludo.request_asset_rerun(
  p_workflow_id uuid,
  p_project_id uuid,
  p_idempotency_key text,
  p_payload jsonb
)
RETURNS TABLE (accepted boolean, queued integer, remaining integer)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, deviludo
AS $$
DECLARE
  workflow deviludo.workflow_instances%ROWTYPE;
  asset_manifest_id uuid;
  existing_kind text;
  inserted_id uuid;
  queued_count integer := 0;
  remaining_count integer := 0;
BEGIN
  SELECT * INTO workflow
    FROM deviludo.workflow_instances
   WHERE id = p_workflow_id AND project_id = p_project_id
   FOR UPDATE;
  IF workflow.id IS NULL THEN RAISE EXCEPTION 'workflow not found'; END IF;

  SELECT manifest.id INTO asset_manifest_id
    FROM deviludo.asset_manifests manifest
   WHERE manifest.workspace_id = workflow.workspace_id
     AND manifest.project_id = workflow.project_id
     AND manifest.workflow_id = workflow.id
   FOR UPDATE;
  IF asset_manifest_id IS NULL THEN RAISE EXCEPTION 'asset manifest not found'; END IF;

  SELECT signal.signal_kind INTO existing_kind
    FROM deviludo.external_signals signal
   WHERE signal.workspace_id = workflow.workspace_id
     AND signal.workflow_id = workflow.id
     AND signal.idempotency_key = p_idempotency_key;
  IF existing_kind IS NOT NULL THEN
    IF existing_kind <> 'ASSET_RERUN_REQUESTED' THEN
      RAISE EXCEPTION 'asset rerun idempotency key conflicts with another signal';
    END IF;
    SELECT count(*)::integer INTO remaining_count
      FROM deviludo.asset_items item
     WHERE item.workspace_id = workflow.workspace_id
       AND item.manifest_id = asset_manifest_id
       AND item.status IN ('planned', 'generating', 'failed');
    RETURN QUERY SELECT false, 0, remaining_count;
    RETURN;
  END IF;

  IF workflow.state NOT IN (
    'ASSET_GENERATING', 'RELEASE_DECISION_PENDING', 'SUCCEEDED', 'FAILED', 'CANCELLED'
  ) THEN
    RAISE EXCEPTION 'Asset rerun requires an idle delivery or the active asset gate';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM deviludo.instance_agent_settings
     WHERE singleton = true
       AND (
         agent_runtime = 'CODEX_CLI'
         OR (agent_runtime = 'CLAUDE_CODE' AND image_model IS NOT NULL)
       )
  ) THEN
    RAISE EXCEPTION 'Image generation configuration is required before rerunning assets';
  END IF;

  SELECT count(*)::integer INTO remaining_count
    FROM deviludo.asset_items item
   WHERE item.workspace_id = workflow.workspace_id
     AND item.manifest_id = asset_manifest_id
     AND item.status IN ('planned', 'generating', 'failed');
  IF remaining_count = 0 THEN RAISE EXCEPTION 'No unresolved assets remain'; END IF;

  INSERT INTO deviludo.external_signals(
    workspace_id, workflow_id, signal_kind, payload, idempotency_key
  ) VALUES (
    workflow.workspace_id, workflow.id, 'ASSET_RERUN_REQUESTED', p_payload, p_idempotency_key
  ) RETURNING id INTO inserted_id;

  UPDATE deviludo.asset_manifests
     SET auto_generate_enabled = true, updated_at = clock_timestamp()
   WHERE workspace_id = workflow.workspace_id AND id = asset_manifest_id;
  UPDATE deviludo.asset_items
     SET status = 'planned', generation_attempt = 0,
         generation_lease_expires_at = NULL, error_message = NULL,
         updated_at = clock_timestamp()
   WHERE workspace_id = workflow.workspace_id
     AND manifest_id = asset_manifest_id
     AND status = 'failed';
  GET DIAGNOSTICS queued_count = ROW_COUNT;

  UPDATE deviludo.jobs
     SET state = 'CANCELLED',
         lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
         heartbeat_at = NULL, fencing_token = fencing_token + 1,
         last_error = 'superseded by asset rerun', updated_at = clock_timestamp()
   WHERE workspace_id = workflow.workspace_id AND workflow_id = workflow.id
     AND kind IN ('ARTIFACT_BUILD', 'E2E_TEST', 'STEAM_PUBLISH')
     AND state <> 'CANCELLED';
  UPDATE deviludo.workflow_instances
     SET state = 'ASSET_GENERATING', version = version + 1,
         updated_at = clock_timestamp()
   WHERE workspace_id = workflow.workspace_id AND id = workflow.id;
  INSERT INTO deviludo.workflow_events(
    workspace_id, workflow_id, event_kind, event_data, idempotency_key
  ) VALUES (
    workflow.workspace_id, workflow.id, 'ASSET_RERUN_REQUESTED',
    p_payload || jsonb_build_object('signalId', inserted_id, 'queued', queued_count),
    'signal:' || p_idempotency_key
  );

  SELECT count(*)::integer INTO remaining_count
    FROM deviludo.asset_items item
   WHERE item.workspace_id = workflow.workspace_id
     AND item.manifest_id = asset_manifest_id
     AND item.status IN ('planned', 'generating', 'failed');
  RETURN QUERY SELECT true, queued_count, remaining_count;
END
$$;
REVOKE ALL ON FUNCTION deviludo.request_asset_rerun(uuid, uuid, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION deviludo.request_asset_rerun(uuid, uuid, text, jsonb) TO deviludo_api;

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
           workflow.target_platforms, agent.id AS agent_job_id,
           asset_rerun.id AS asset_rerun_signal_id
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
      LEFT JOIN LATERAL (
        SELECT signal.id
          FROM deviludo.external_signals signal
         WHERE signal.workspace_id = workflow.workspace_id
           AND signal.workflow_id = workflow.id
           AND signal.signal_kind = 'ASSET_RERUN_REQUESTED'
         ORDER BY signal.created_at DESC, signal.id DESC
         LIMIT 1
      ) asset_rerun ON true
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
        candidate.workflow_id::text || ':artifact:assets:'
          || coalesce(candidate.asset_rerun_signal_id::text, 'initial')
          || ':after:' || candidate.agent_job_id::text,
        jsonb_build_object('targetPlatforms', candidate.target_platforms)
      );
      INSERT INTO deviludo.workflow_events(
        workspace_id, workflow_id, event_kind, event_data, idempotency_key
      ) VALUES (
        candidate.workspace_id, candidate.workflow_id, 'ASSETS_READY',
        jsonb_build_object(
          'agentJobId', candidate.agent_job_id,
          'assetRerunSignalId', candidate.asset_rerun_signal_id
        ),
        'assets-ready:' || coalesce(candidate.asset_rerun_signal_id::text, 'initial')
          || ':' || candidate.agent_job_id::text
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
