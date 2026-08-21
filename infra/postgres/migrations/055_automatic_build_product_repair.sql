BEGIN;

-- Preserve generated/uploaded objects for possible reuse, but freeze only keys
-- still present in the latest successful Agent plan into a new build. An Agent
-- repair can therefore remove a genuinely unnecessary key without the old row
-- forcing the same Builder failure forever.
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
     AND item.status IN ('generated', 'uploaded')
     AND item.asset_key IN (
       SELECT planned->>'assetKey'
         FROM deviludo.jobs source_job
         CROSS JOIN LATERAL jsonb_array_elements(
           source_job.receipt #> '{assetManifest,items}'
         ) planned
        WHERE source_job.workspace_id = NEW.workspace_id
          AND source_job.workflow_id = NEW.workflow_id
          AND source_job.kind = 'AGENT_GENERATION'
          AND source_job.state = 'SUCCEEDED'
          AND source_job.id = (
            SELECT latest_agent.id
              FROM deviludo.jobs latest_agent
             WHERE latest_agent.workspace_id = NEW.workspace_id
               AND latest_agent.workflow_id = NEW.workflow_id
               AND latest_agent.kind = 'AGENT_GENERATION'
               AND latest_agent.state = 'SUCCEEDED'
             ORDER BY latest_agent.updated_at DESC, latest_agent.created_at DESC, latest_agent.id DESC
             LIMIT 1
          )
     );
  NEW.payload := NEW.payload || jsonb_build_object('assetInputs', inputs);
  RETURN NEW;
END
$$;

-- Controlled Builder product diagnostics are deterministic for a frozen source
-- revision. Do not retry the same source three times: fail that build attempt
-- immediately and give the bounded diagnostic to the configured Agent. Keep
-- transient executor/infrastructure failures on the ordinary retry path.
CREATE OR REPLACE FUNCTION deviludo.fail_job(
  p_job_id uuid,
  p_lease_token uuid,
  p_fencing_token bigint,
  p_reason text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, deviludo
AS $$
DECLARE
  job deviludo.jobs%ROWTYPE;
  workflow deviludo.workflow_instances%ROWTYPE;
  terminal boolean;
  automatic_build_repair boolean;
  repair_count integer := 0;
  agent_settings deviludo.instance_agent_settings%ROWTYPE;
BEGIN
  SELECT * INTO job FROM deviludo.jobs
   WHERE id = p_job_id AND state = 'RUNNING'
     AND lease_token = p_lease_token AND fencing_token = p_fencing_token;
  IF job.id IS NULL THEN RETURN false; END IF;
  SELECT * INTO workflow FROM deviludo.workflow_instances
   WHERE workspace_id = job.workspace_id AND id = job.workflow_id
   FOR UPDATE;
  SELECT * INTO job FROM deviludo.jobs
   WHERE id = p_job_id AND state = 'RUNNING'
     AND lease_token = p_lease_token AND fencing_token = p_fencing_token
   FOR UPDATE;
  IF job.id IS NULL THEN RETURN false; END IF;
  automatic_build_repair := job.kind = 'ARTIFACT_BUILD'
    AND position('BUILD_PRODUCT:' IN p_reason) > 0;
  terminal := automatic_build_repair OR job.attempt >= job.max_attempts;
  UPDATE deviludo.jobs
     SET state = CASE WHEN terminal THEN 'FAILED'::deviludo.job_state ELSE 'RETRY'::deviludo.job_state END,
         available_at = clock_timestamp() + make_interval(secs => least(3600, (2 ^ greatest(attempt, 1))::integer)),
         lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL, heartbeat_at = NULL,
         last_error = left(p_reason, 2000), updated_at = clock_timestamp()
   WHERE workspace_id = job.workspace_id AND id = job.id;
  IF NOT terminal AND job.kind = 'AGENT_GENERATION' THEN
    UPDATE deviludo.job_guidance_messages
       SET state = 'PENDING', delivered_at = NULL
     WHERE workspace_id = job.workspace_id
       AND job_id = job.id
       AND state = 'DELIVERED';
  END IF;
  INSERT INTO deviludo.workflow_events(workspace_id, workflow_id, event_kind, event_data, idempotency_key)
  VALUES (
    job.workspace_id, job.workflow_id,
    CASE WHEN terminal THEN 'JOB_FAILED' ELSE 'JOB_RETRY_SCHEDULED' END,
    jsonb_build_object('jobId', job.id, 'attempt', job.attempt, 'reason', left(p_reason, 2000)),
    'job-failure:' || job.id::text || ':' || job.attempt::text
  );
  IF terminal AND job.kind <> 'PROJECT_DOCUMENT_MAINTENANCE' THEN
    IF automatic_build_repair THEN
      SELECT count(*)::integer INTO repair_count
        FROM deviludo.jobs previous_repair
       WHERE previous_repair.workspace_id = job.workspace_id
         AND previous_repair.workflow_id = job.workflow_id
         AND previous_repair.kind = 'AGENT_GENERATION'
         AND previous_repair.payload->>'repairFailureKind' = 'ARTIFACT_BUILD'
         AND previous_repair.payload->>'manualRerun' IS DISTINCT FROM 'true'
         AND previous_repair.created_at > coalesce((
           SELECT max(manual_agent.created_at)
             FROM deviludo.jobs manual_agent
            WHERE manual_agent.workspace_id = job.workspace_id
              AND manual_agent.workflow_id = job.workflow_id
              AND manual_agent.kind = 'AGENT_GENERATION'
              AND manual_agent.payload->>'manualRerun' = 'true'
         ), '-infinity'::timestamptz);
      SELECT * INTO agent_settings
        FROM deviludo.instance_agent_settings
       WHERE singleton = true;
      IF repair_count < 5 AND agent_settings.singleton IS NOT NULL THEN
        UPDATE deviludo.workflow_instances
           SET state = 'AGENT_RUNNING', version = version + 1,
               updated_at = clock_timestamp()
         WHERE workspace_id = job.workspace_id AND id = job.workflow_id;
        PERFORM deviludo.enqueue_job(
          job.workspace_id, job.workflow_id, job.project_id, 'AGENT_GENERATION', NULL,
          job.workflow_id::text || ':agent:build-repair:' || job.id::text,
          jsonb_build_object(
            'repairFailureJobId', job.id,
            'repairFailureKind', 'ARTIFACT_BUILD',
            'repairFailureSummary', left(p_reason, 1800),
            'repairAttempt', repair_count + 1,
            'agentConfiguration', jsonb_build_object(
              'runtime', agent_settings.agent_runtime::text,
              'baseUrl', agent_settings.base_url,
              'model', coalesce(agent_settings.model_overrides->>'development', agent_settings.primary_model),
              'credentialRef', agent_settings.credential_secret_ref,
              'revision', agent_settings.revision
            )
          )
        );
      ELSE
        UPDATE deviludo.workflow_instances SET state = 'FAILED', version = version + 1,
          updated_at = clock_timestamp()
         WHERE workspace_id = job.workspace_id AND id = job.workflow_id
           AND state NOT IN ('SUCCEEDED', 'FAILED', 'CANCELLED');
      END IF;
    ELSE
      IF job.kind = 'STEAM_PUBLISH' THEN
        UPDATE deviludo.steam_releases
           SET state = 'FAILED', failure_message = left(p_reason, 2000), updated_at = clock_timestamp()
         WHERE workspace_id = job.workspace_id
           AND id = (job.payload #>> '{steamRelease,releaseId}')::uuid;
      END IF;
      UPDATE deviludo.workflow_instances SET state = 'FAILED', version = version + 1,
        updated_at = clock_timestamp()
       WHERE workspace_id = job.workspace_id AND id = job.workflow_id
         AND state NOT IN ('SUCCEEDED', 'FAILED', 'CANCELLED');
    END IF;
  END IF;
  RETURN true;
END
$$;

COMMIT;
