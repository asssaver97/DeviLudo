-- Asset readiness and release approval gates for persistent-source v1.
-- The enum values used by these definitions are committed by migration 002.
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
              AND item.status NOT IN ('generated', 'uploaded')
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

CREATE OR REPLACE FUNCTION deviludo.accept_workflow_signal(
  p_workflow_id uuid,
  p_signal_kind text,
  p_idempotency_key text,
  p_payload jsonb
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, deviludo
AS $$
DECLARE
  workflow deviludo.workflow_instances%ROWTYPE;
  agent_settings deviludo.instance_agent_settings%ROWTYPE;
  inserted_id uuid;
  platform deviludo.server_os;
  rerun_stage deviludo.job_kind;
  stage_list deviludo.job_kind[];
  stage_index integer;
  downstream_stages deviludo.job_kind[];
BEGIN
  -- The routing below is a chain of guarded branches, so a kind this version does
  -- not know falls through it: the signal row inserts, the function returns true,
  -- and nothing moves. That reaches the user as a button that does nothing, with
  -- no error anywhere to explain it -- the exact shape of a database whose
  -- functions predate the caller. Reject the kind up front instead, where it is
  -- still distinguishable from a known kind whose state guard legitimately did
  -- not match.
  IF p_signal_kind NOT IN (
    'SPEC_APPROVED', 'STAGE_RERUN_REQUESTED', 'CANCEL_REQUESTED',
    'RELEASE_APPROVED', 'EXTERNAL_APPROVAL'
  ) THEN
    RAISE EXCEPTION 'Signal kind % cannot be routed by this schema version', p_signal_kind;
  END IF;
  SELECT * INTO workflow
    FROM deviludo.workflow_instances
   WHERE id = p_workflow_id
   FOR UPDATE;
  IF workflow.id IS NULL THEN RAISE EXCEPTION 'workflow not found'; END IF;
  IF p_signal_kind = 'STAGE_RERUN_REQUESTED' THEN
    -- A rerun is only meaningful from a terminal workflow. While work is still
    -- in flight, superseding jobs would race the executors currently holding
    -- their leases, so require an explicit cancel first.
    IF workflow.state NOT IN ('FAILED', 'SUCCEEDED', 'CANCELLED') THEN
      RAISE EXCEPTION 'Stage rerun requires a terminal workflow; cancel the running delivery first';
    END IF;
    BEGIN
      rerun_stage := (p_payload->>'stage')::deviludo.job_kind;
    EXCEPTION WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'Stage rerun target is not a known job kind';
    END;
    stage_list := deviludo.delivery_stages(workflow.profile);
    stage_index := array_position(stage_list, rerun_stage);
    IF stage_index IS NULL THEN
      RAISE EXCEPTION 'Stage % is not part of the % delivery chain', rerun_stage, workflow.profile;
    END IF;
    IF rerun_stage = 'AGENT_GENERATION' THEN
      SELECT * INTO agent_settings
        FROM deviludo.instance_agent_settings
       WHERE singleton = true;
      IF agent_settings.singleton IS NULL THEN
        RAISE EXCEPTION 'Agent configuration is required before rerunning agent generation';
      END IF;
    END IF;
  END IF;
  IF p_signal_kind = 'RELEASE_APPROVED' THEN
    IF workflow.state <> 'RELEASE_APPROVAL_PENDING' THEN
      RAISE EXCEPTION 'Release approval requires signed builds awaiting approval';
    END IF;
  END IF;
  INSERT INTO deviludo.external_signals(
    workspace_id, workflow_id, signal_kind, payload, idempotency_key
  )
  VALUES (
    workflow.workspace_id, workflow.id, p_signal_kind, p_payload, p_idempotency_key
  )
  ON CONFLICT (workspace_id, workflow_id, idempotency_key) DO NOTHING
  RETURNING id INTO inserted_id;
  IF inserted_id IS NULL THEN RETURN false; END IF;

  INSERT INTO deviludo.workflow_events(
    workspace_id, workflow_id, event_kind, event_data, idempotency_key
  )
  VALUES (
    workflow.workspace_id, workflow.id, p_signal_kind, p_payload, 'signal:' || p_idempotency_key
  );

  IF p_signal_kind = 'SPEC_APPROVED' AND workflow.state = 'DRAFT' THEN
    SELECT * INTO agent_settings
      FROM deviludo.instance_agent_settings
     WHERE singleton = true;
    UPDATE deviludo.workflow_instances
       SET state = 'AGENT_RUNNING', version = version + 1,
           development_actor_account_id = (p_payload->>'requestedByAccountId')::uuid,
           updated_at = clock_timestamp()
     WHERE workspace_id = workflow.workspace_id AND id = workflow.id;
    PERFORM deviludo.enqueue_job(
      workflow.workspace_id, workflow.id, workflow.project_id, 'AGENT_GENERATION', NULL,
      workflow.id::text || ':agent',
      CASE WHEN agent_settings.singleton IS NULL THEN '{}'::jsonb ELSE jsonb_build_object(
        'agentConfiguration', jsonb_build_object(
          'runtime', agent_settings.agent_runtime::text,
          'baseUrl', agent_settings.base_url,
          'models', CASE WHEN agent_settings.primary_model IS NULL THEN NULL ELSE jsonb_build_object(
            'primary', agent_settings.primary_model,
            'opus', agent_settings.opus_model,
            'sonnet', agent_settings.sonnet_model,
            'haiku', agent_settings.haiku_model,
            'subagent', agent_settings.subagent_model
          ) END,
          'credentialRef', agent_settings.credential_secret_ref,
          'revision', agent_settings.revision
        )
      ) END
    );
  ELSIF p_signal_kind = 'STAGE_RERUN_REQUESTED' THEN
    -- Rerunning a stage invalidates everything downstream of it: those results
    -- were derived from inputs this rerun is about to replace. Supersede the
    -- selected stage and every later stage, then enqueue only the selected
    -- stage; complete_job walks the chain forward from there as usual.
    downstream_stages := stage_list[stage_index:array_length(stage_list, 1)];
    UPDATE deviludo.jobs
       SET state = 'CANCELLED',
           lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
           heartbeat_at = NULL, fencing_token = fencing_token + 1,
           last_error = 'superseded by stage rerun from ' || rerun_stage::text,
           updated_at = clock_timestamp()
     WHERE workspace_id = workflow.workspace_id AND workflow_id = workflow.id
       AND kind = ANY(downstream_stages)
       AND state <> 'CANCELLED';
    UPDATE deviludo.workflow_instances
       SET state = deviludo.stage_running_state(rerun_stage), version = version + 1,
           development_actor_account_id = (p_payload->>'requestedByAccountId')::uuid,
           updated_at = clock_timestamp()
     WHERE workspace_id = workflow.workspace_id AND id = workflow.id;
    IF rerun_stage IN ('E2E_TEST', 'ARTIFACT_SIGN', 'STEAM_CLEAN_INSTALL') THEN
      -- Per-platform stages always rerun on every target platform. Skipping
      -- platforms that previously succeeded would leave results tied to the
      -- superseded upstream artifact.
      FOREACH platform IN ARRAY workflow.target_platforms
      LOOP
        PERFORM deviludo.enqueue_job(
          workflow.workspace_id, workflow.id, workflow.project_id, rerun_stage, platform,
          workflow.id::text || ':rerun:' || rerun_stage::text || ':' || platform::text
            || ':' || inserted_id::text
        );
      END LOOP;
    ELSIF rerun_stage = 'AGENT_GENERATION' THEN
      PERFORM deviludo.enqueue_job(
        workflow.workspace_id, workflow.id, workflow.project_id, 'AGENT_GENERATION', NULL,
        workflow.id::text || ':rerun:agent:' || inserted_id::text,
        jsonb_build_object(
          'agentConfiguration', jsonb_build_object(
            'runtime', agent_settings.agent_runtime::text,
            'baseUrl', agent_settings.base_url,
            'models', CASE WHEN agent_settings.primary_model IS NULL THEN NULL ELSE jsonb_build_object(
              'primary', agent_settings.primary_model,
              'opus', agent_settings.opus_model,
              'sonnet', agent_settings.sonnet_model,
              'haiku', agent_settings.haiku_model,
              'subagent', agent_settings.subagent_model
            ) END,
            'credentialRef', agent_settings.credential_secret_ref,
            'revision', agent_settings.revision
          )
        )
      );
    ELSE
      PERFORM deviludo.enqueue_job(
        workflow.workspace_id, workflow.id, workflow.project_id, rerun_stage, NULL,
        workflow.id::text || ':rerun:' || rerun_stage::text || ':' || inserted_id::text,
        jsonb_build_object('targetPlatforms', workflow.target_platforms)
      );
    END IF;
  ELSIF p_signal_kind = 'RELEASE_APPROVED' THEN
    UPDATE deviludo.workflow_instances
       SET state = 'STEAM_PUBLISHING', version = version + 1,
           updated_at = clock_timestamp()
     WHERE workspace_id = workflow.workspace_id AND id = workflow.id
       AND state = 'RELEASE_APPROVAL_PENDING';
    PERFORM deviludo.enqueue_job(
      workflow.workspace_id, workflow.id, workflow.project_id, 'STEAM_PUBLISH', NULL,
      workflow.id::text || ':publish:approved:' || inserted_id::text,
      jsonb_build_object(
        'targetPlatforms', workflow.target_platforms,
        'approvalSignalId', inserted_id,
        'approvedByAccountId', p_payload->>'requestedByAccountId'
      )
    );
  ELSIF p_signal_kind = 'CANCEL_REQUESTED' THEN
    UPDATE deviludo.workflow_instances
       SET state = 'CANCELLED', version = version + 1, updated_at = clock_timestamp()
     WHERE workspace_id = workflow.workspace_id AND id = workflow.id
       AND state NOT IN ('SUCCEEDED', 'FAILED', 'CANCELLED');
    UPDATE deviludo.jobs
       SET state = 'CANCELLED',
           lease_owner = NULL,
           lease_token = NULL,
           lease_expires_at = NULL,
           heartbeat_at = NULL,
           fencing_token = fencing_token + 1,
           updated_at = clock_timestamp()
     WHERE workspace_id = workflow.workspace_id AND workflow_id = workflow.id
       AND state IN ('QUEUED', 'RETRY', 'RUNNING');
  END IF;
  RETURN true;
END
$$;

CREATE OR REPLACE FUNCTION deviludo.complete_job(
  p_job_id uuid,
  p_lease_token uuid,
  p_fencing_token bigint,
  p_isolation_generation bigint,
  p_receipt jsonb,
  p_executor_receipt jsonb,
  p_before_reimage_proof text,
  p_cleanup_proof text,
  p_after_reimage_proof text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, deviludo
AS $$
DECLARE
  job deviludo.jobs%ROWTYPE;
  workflow deviludo.workflow_instances%ROWTYPE;
  project deviludo.projects%ROWTYPE;
  platform deviludo.server_os;
  output jsonb;
  document jsonb;
  next_document_revision bigint;
  e2e_content_failure boolean := false;
  repair_count integer := 0;
  failure_summary text;
  agent_settings deviludo.instance_agent_settings%ROWTYPE;
  asset_manifest_id uuid;
  asset_auto_generate boolean := false;
BEGIN
  -- Serialize all terminal job mutations on the workflow before taking a job
  -- row lock. Platform workers complete sibling jobs concurrently, and taking
  -- those locks in the opposite order can deadlock during stage advancement.
  SELECT * INTO job
    FROM deviludo.jobs
   WHERE id = p_job_id
     AND state = 'RUNNING'
     AND lease_token = p_lease_token
     AND fencing_token = p_fencing_token
     AND isolation_generation = p_isolation_generation;
  IF job.id IS NULL THEN RETURN false; END IF;
  SELECT * INTO workflow
    FROM deviludo.workflow_instances
   WHERE workspace_id = job.workspace_id AND id = job.workflow_id
   FOR UPDATE;
  SELECT * INTO job
    FROM deviludo.jobs
   WHERE id = p_job_id
     AND state = 'RUNNING'
     AND lease_token = p_lease_token
     AND fencing_token = p_fencing_token
     AND isolation_generation = p_isolation_generation
   FOR UPDATE;
  IF job.id IS NULL THEN RETURN false; END IF;
  IF job.exclusive AND (
    length(coalesce(p_before_reimage_proof, '')) < 16
    OR length(coalesce(p_cleanup_proof, '')) < 16
    OR length(coalesce(p_after_reimage_proof, '')) < 16
  ) THEN RAISE EXCEPTION 'trusted reimage and cleanup proofs are required'; END IF;
  IF p_executor_receipt->>'schemaVersion' <> 'deviludo.executor-receipt.v2'
    OR coalesce(p_executor_receipt->>'simulated', 'true') <> 'false'
    OR length(coalesce(p_executor_receipt->>'signature', '')) < 32
    OR jsonb_typeof(p_executor_receipt->'outputObjects') <> 'array'
  THEN RAISE EXCEPTION 'verified executor receipt v2 is required'; END IF;
  IF job.kind = 'E2E_TEST' THEN
    IF coalesce(p_receipt #>> '{execution,outcome}', '') NOT IN ('PASSED', 'FAILED')
      OR (p_receipt #>> '{execution,outcome}' = 'FAILED'
        AND coalesce(p_receipt #>> '{execution,failureDomain}', '') <> 'PRODUCT')
      OR length(coalesce(p_receipt #>> '{execution,summary}', '')) NOT BETWEEN 1 AND 2000
    THEN RAISE EXCEPTION 'classified E2E execution report is required'; END IF;
    e2e_content_failure := p_receipt #>> '{execution,outcome}' = 'FAILED';
  END IF;
  IF job.kind = 'AGENT_GENERATION' THEN
    IF (p_receipt #>> '{sourceRevision,revision}')::bigint <> (job.payload->>'publishSourceRevision')::bigint
      OR p_receipt #>> '{sourceRevision,relativePath}' <> 'workspaces/' || job.workspace_id::text
        || '/projects/' || job.project_id::text || '/revisions/r'
        || lpad((job.payload->>'publishSourceRevision')::bigint::text, 12, '0') || '-'
        || substring(p_receipt #>> '{sourceRevision,digest}' from 8 for 16)
      OR coalesce(p_receipt #>> '{sourceRevision,digest}', '') !~ '^sha256:[0-9a-f]{64}$'
      OR (p_receipt #>> '{sourceRevision,fileCount}')::integer NOT BETWEEN 1 AND 20000
      OR (p_receipt #>> '{sourceRevision,totalBytes}')::bigint NOT BETWEEN 1 AND 1073741824
    THEN RAISE EXCEPTION 'validated persistent source revision is required'; END IF;
    INSERT INTO deviludo.project_source_revisions(
      workspace_id, project_id, revision, relative_path, content_digest,
      file_count, total_bytes, workflow_id, job_id, actor_account_id, fencing_token
    ) VALUES (
      job.workspace_id, job.project_id, (p_receipt #>> '{sourceRevision,revision}')::bigint,
      p_receipt #>> '{sourceRevision,relativePath}', p_receipt #>> '{sourceRevision,digest}',
      (p_receipt #>> '{sourceRevision,fileCount}')::integer,
      (p_receipt #>> '{sourceRevision,totalBytes}')::bigint,
      job.workflow_id, job.id, workflow.development_actor_account_id, job.fencing_token
    ) ON CONFLICT (workspace_id, project_id, revision) DO NOTHING;

    -- The Agent plans the game's assets while writing the source that expects
    -- them. When an image provider is configured this delivery waits for those
    -- exact assets before building; without one it deliberately keeps the
    -- placeholder path so a local/code-only project is never stranded.
    IF p_receipt ? 'assetManifest' THEN
      IF jsonb_typeof(p_receipt->'assetManifest') <> 'object'
        OR jsonb_typeof(p_receipt #> '{assetManifest,items}') <> 'array'
        OR jsonb_array_length(p_receipt #> '{assetManifest,items}') NOT BETWEEN 1 AND 500
      THEN RAISE EXCEPTION 'validated asset manifest is required when present'; END IF;
      -- Reject the whole manifest rather than silently dropping rows: a source
      -- tree referencing an asset that never got planned fails at build time,
      -- which is far harder to diagnose than a rejected receipt.
      IF EXISTS (
        SELECT 1 FROM jsonb_array_elements(p_receipt #> '{assetManifest,items}') item
         WHERE jsonb_typeof(item) <> 'object'
           OR length(coalesce(item->>'assetKey', '')) NOT BETWEEN 1 AND 200
           OR coalesce(item->>'assetType', '') NOT IN
             ('sprite', 'animation', 'background', 'ui', 'icon', 'tileset')
           OR length(coalesce(item->>'description', '')) NOT BETWEEN 1 AND 2000
           OR (item ? 'generationPrompt'
             AND length(coalesce(item->>'generationPrompt', '')) NOT BETWEEN 1 AND 4000)
           OR (item ? 'frameCount' AND item->'frameCount' <> 'null'::jsonb
             AND (jsonb_typeof(item->'frameCount') <> 'number'
               OR coalesce(item->>'frameCount', '') !~ '^[0-9]+$'
               OR (item->>'frameCount')::integer NOT BETWEEN 1 AND 4096))
           OR (item ? 'dimensions' AND item->'dimensions' <> 'null'::jsonb
             AND (jsonb_typeof(item->'dimensions') <> 'string'
               OR coalesce(item->>'dimensions', '') !~ '^[0-9]{1,5}x[0-9]{1,5}$'))
      ) THEN RAISE EXCEPTION 'asset manifest items are invalid'; END IF;
      IF (
        SELECT count(DISTINCT item->>'assetKey')
          FROM jsonb_array_elements(p_receipt #> '{assetManifest,items}') item
      ) <> jsonb_array_length(p_receipt #> '{assetManifest,items}')
      THEN RAISE EXCEPTION 'asset manifest keys must be unique'; END IF;

      -- One manifest per project. Every new Agent plan starts its image branch;
      -- generated/uploaded assets still survive the re-plan below, and the user
      -- can pause new claims from the asset panel after planning completes.
      INSERT INTO deviludo.asset_manifests(
        workspace_id, project_id, workflow_id, auto_generate_enabled
      )
      VALUES (
        job.workspace_id, job.project_id, job.workflow_id,
        EXISTS (SELECT 1 FROM deviludo.instance_image_generation_settings WHERE singleton = true)
      )
      ON CONFLICT (workspace_id, project_id) DO UPDATE
        SET workflow_id = excluded.workflow_id,
            auto_generate_enabled = excluded.auto_generate_enabled,
            updated_at = clock_timestamp()
      RETURNING id, auto_generate_enabled INTO asset_manifest_id, asset_auto_generate;

      -- Assets the user already supplied keep their object; only the planning
      -- fields are refreshed. Re-planned keys that no longer appear are dropped
      -- unless an upload is already attached to them.
      INSERT INTO deviludo.asset_items(
        workspace_id, manifest_id, asset_key, asset_type, description,
        generation_prompt, frame_count, dimensions
      )
      SELECT
        job.workspace_id, asset_manifest_id, item->>'assetKey', item->>'assetType',
        item->>'description', item->>'generationPrompt',
        (item->>'frameCount')::integer, item->>'dimensions'
      FROM jsonb_array_elements(p_receipt #> '{assetManifest,items}') item
      ON CONFLICT (workspace_id, manifest_id, asset_key) DO UPDATE
        SET asset_type = excluded.asset_type,
            description = excluded.description,
            generation_prompt = excluded.generation_prompt,
            frame_count = excluded.frame_count,
            dimensions = excluded.dimensions,
            -- A re-plan is a new prompt, so the previous attempts no longer apply:
            -- an item that had exhausted its budget becomes generatable again. The
            -- lease has to be cleared with the status or the CHECK tying the two
            -- together fails.
            generation_attempt = CASE
              WHEN deviludo.asset_items.status IN ('generated', 'uploaded') THEN deviludo.asset_items.generation_attempt
              ELSE 0 END,
            generation_lease_expires_at = NULL,
            status = CASE
              WHEN deviludo.asset_items.status IN ('generated', 'uploaded') THEN deviludo.asset_items.status
              ELSE 'planned' END,
            error_message = CASE
              WHEN deviludo.asset_items.status IN ('generated', 'uploaded') THEN deviludo.asset_items.error_message
              ELSE NULL END,
            updated_at = clock_timestamp();

      DELETE FROM deviludo.asset_items
       WHERE workspace_id = job.workspace_id
         AND manifest_id = asset_manifest_id
         AND status NOT IN ('generated', 'uploaded')
         AND asset_key NOT IN (
           SELECT item->>'assetKey'
             FROM jsonb_array_elements(p_receipt #> '{assetManifest,items}') item
         );
    END IF;
  ELSIF job.kind = 'PROJECT_DOCUMENT_MAINTENANCE' THEN
    SELECT * INTO project
      FROM deviludo.projects
     WHERE workspace_id = job.workspace_id AND id = job.project_id
     FOR UPDATE;
    SELECT content INTO document
      FROM deviludo.project_documents
     WHERE workspace_id = job.workspace_id AND project_id = job.project_id
       AND revision = (job.payload->>'baseRevision')::bigint
     FOR UPDATE;
    IF document IS NULL
      OR project.last_activity_at <> (job.payload->>'activityAt')::timestamptz
    THEN RAISE EXCEPTION 'project document maintenance result is stale'; END IF;
    IF jsonb_typeof(p_receipt->'projectDocument') <> 'object'
      OR jsonb_typeof(p_receipt #> '{projectDocument,content}') <> 'object'
      OR jsonb_typeof(p_receipt #> '{projectDocument,content,introduction}') <> 'string'
      OR jsonb_typeof(p_receipt #> '{projectDocument,content,gameplay}') <> 'string'
      OR jsonb_typeof(p_receipt #> '{projectDocument,content,categories}') <> 'array'
      OR jsonb_array_length(p_receipt #> '{projectDocument,content,categories}') NOT BETWEEN 1 AND 32
      OR jsonb_typeof(p_receipt #> '{projectDocument,content,features}') <> 'array'
      OR jsonb_array_length(p_receipt #> '{projectDocument,content,features}') NOT BETWEEN 1 AND 32
      OR length(coalesce(p_receipt #>> '{projectDocument,markdown}', '')) NOT BETWEEN 1 AND 100000
    THEN RAISE EXCEPTION 'validated project document output is required'; END IF;
    IF (
      SELECT count(*) FROM jsonb_array_elements(p_executor_receipt->'outputObjects') item
       WHERE item->>'kind' = 'PROJECT_DOCUMENT'
    ) <> 1 THEN RAISE EXCEPTION 'one project document artifact is required'; END IF;
  END IF;

  INSERT INTO deviludo.executor_receipts(
    workspace_id, project_id, workflow_id, job_id, executor_id,
    isolation_generation, fencing_token, receipt, signature
  ) VALUES (
    job.workspace_id, job.project_id, job.workflow_id, job.id,
    p_executor_receipt->>'executorId', job.isolation_generation,
    job.fencing_token, p_executor_receipt, p_executor_receipt->>'signature'
  );

  FOR output IN SELECT value FROM jsonb_array_elements(p_executor_receipt->'outputObjects')
  LOOP
    INSERT INTO deviludo.artifacts(
      workspace_id, project_id, workflow_id, producing_job_id, kind,
      target_platform, bucket, object_key, sha256, size_bytes, metadata
    ) VALUES (
      job.workspace_id, job.project_id, job.workflow_id, job.id,
      (output->>'kind')::deviludo.artifact_kind,
      nullif(output->>'targetPlatform', '')::deviludo.server_os,
      output->>'bucket', output->>'key', output->>'sha256',
      (output->>'sizeBytes')::bigint, coalesce(output->'metadata', '{}'::jsonb)
    );
  END LOOP;

  IF e2e_content_failure THEN
    failure_summary := left(p_receipt #>> '{execution,summary}', 1800);
    UPDATE deviludo.jobs
       SET state = 'FAILED', receipt = p_receipt,
           last_error = 'E2E_PRODUCT: ' || failure_summary,
           before_reimage_proof = p_before_reimage_proof,
           cleanup_proof = p_cleanup_proof,
           after_reimage_proof = p_after_reimage_proof,
           lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
           heartbeat_at = NULL, updated_at = clock_timestamp()
     WHERE workspace_id = job.workspace_id AND id = job.id;
    UPDATE deviludo.jobs
       SET state = 'CANCELLED',
           lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
           heartbeat_at = NULL, fencing_token = fencing_token + 1,
           last_error = 'superseded by automatic E2E content repair',
           updated_at = clock_timestamp()
     WHERE workspace_id = job.workspace_id AND workflow_id = job.workflow_id
       AND kind = 'E2E_TEST' AND id <> job.id
       AND state IN ('QUEUED', 'RETRY', 'RUNNING');
    INSERT INTO deviludo.workflow_events(
      workspace_id, workflow_id, event_kind, event_data, idempotency_key
    ) VALUES (
      job.workspace_id, job.workflow_id, 'E2E_CONTENT_FAILED',
      jsonb_build_object(
        'jobId', job.id,
        'operatingSystem', job.target_operating_system,
        'summary', failure_summary
      ),
      'e2e-content-failed:' || job.id::text
    );
    SELECT count(*)::integer INTO repair_count
      FROM deviludo.jobs previous_repair
     WHERE previous_repair.workspace_id = job.workspace_id
       AND previous_repair.workflow_id = job.workflow_id
       AND previous_repair.kind = 'AGENT_GENERATION'
       AND previous_repair.payload ? 'repairFromE2eJobId';
    SELECT * INTO agent_settings
      FROM deviludo.instance_agent_settings
     WHERE singleton = true;
    IF repair_count < 3 AND agent_settings.singleton IS NOT NULL THEN
      UPDATE deviludo.workflow_instances
         SET state = 'AGENT_RUNNING', version = version + 1, updated_at = clock_timestamp()
       WHERE workspace_id = workflow.workspace_id AND id = workflow.id;
      PERFORM deviludo.enqueue_job(
        workflow.workspace_id, workflow.id, workflow.project_id, 'AGENT_GENERATION', NULL,
        workflow.id::text || ':agent:e2e-repair:' || job.id::text,
        jsonb_build_object(
          'repairFromE2eJobId', job.id,
          'repairAttempt', repair_count + 1,
          'failedPlatform', job.target_operating_system,
          'agentConfiguration', jsonb_build_object(
            'runtime', agent_settings.agent_runtime::text,
            'baseUrl', agent_settings.base_url,
            'models', CASE WHEN agent_settings.primary_model IS NULL THEN NULL ELSE jsonb_build_object(
              'primary', agent_settings.primary_model,
              'opus', agent_settings.opus_model,
              'sonnet', agent_settings.sonnet_model,
              'haiku', agent_settings.haiku_model,
              'subagent', agent_settings.subagent_model
            ) END,
            'credentialRef', agent_settings.credential_secret_ref,
            'revision', agent_settings.revision
          )
        )
      );
    ELSE
      UPDATE deviludo.workflow_instances
         SET state = 'FAILED', version = version + 1, updated_at = clock_timestamp()
       WHERE workspace_id = workflow.workspace_id AND id = workflow.id;
    END IF;
    RETURN true;
  END IF;

  IF job.kind = 'PROJECT_DOCUMENT_MAINTENANCE' THEN
    next_document_revision := (job.payload->>'baseRevision')::bigint + 1;
    UPDATE deviludo.project_documents
       SET revision = next_document_revision,
           content = p_receipt #> '{projectDocument,content}',
           markdown = p_receipt #>> '{projectDocument,markdown}',
           maintained_by = 'AGENT',
           updated_by_actor_account_id = NULL,
           last_agent_maintained_at = clock_timestamp(),
           updated_at = clock_timestamp()
     WHERE workspace_id = job.workspace_id AND project_id = job.project_id;
    INSERT INTO deviludo.project_document_revisions(
      workspace_id, project_id, revision, content, markdown, source, maintenance_job_id
    ) VALUES (
      job.workspace_id, job.project_id, next_document_revision,
      p_receipt #> '{projectDocument,content}', p_receipt #>> '{projectDocument,markdown}',
      'AGENT_IDLE_MAINTENANCE', job.id
    );
  END IF;

  UPDATE deviludo.jobs
     SET state = 'SUCCEEDED', receipt = p_receipt,
         last_error = NULL,
         before_reimage_proof = p_before_reimage_proof,
         cleanup_proof = p_cleanup_proof,
         after_reimage_proof = p_after_reimage_proof,
         lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
         heartbeat_at = NULL, updated_at = clock_timestamp()
   WHERE workspace_id = job.workspace_id AND id = job.id;
  UPDATE deviludo.operation_receipts
     SET state = 'RECEIPTED', receipt = p_receipt, updated_at = clock_timestamp()
   WHERE workspace_id = job.workspace_id AND job_id = job.id
     AND state IN ('REGISTERED', 'IN_PROGRESS');
  INSERT INTO deviludo.workflow_events(
    workspace_id, workflow_id, event_kind, event_data, idempotency_key
  ) VALUES (
    job.workspace_id, job.workflow_id, 'JOB_SUCCEEDED',
    jsonb_build_object('jobId', job.id, 'jobKind', job.kind, 'operatingSystem', job.target_operating_system),
    'job-succeeded:' || job.id::text
  );

  IF job.kind = 'PROJECT_DOCUMENT_MAINTENANCE' THEN
    NULL;
  ELSIF workflow.state = 'AGENT_RUNNING' AND job.kind = 'AGENT_GENERATION' THEN
    IF asset_auto_generate THEN
      UPDATE deviludo.workflow_instances SET state = 'ASSET_GENERATING', version = version + 1,
        updated_at = clock_timestamp() WHERE workspace_id = workflow.workspace_id AND id = workflow.id;
    ELSE
      UPDATE deviludo.workflow_instances SET state = 'ARTIFACT_BUILDING', version = version + 1,
        updated_at = clock_timestamp() WHERE workspace_id = workflow.workspace_id AND id = workflow.id;
      -- The predecessor job id is part of every forward idempotency key. A stage
      -- rerun leaves the superseded job row (and its unique key) behind; reusing
      -- the first delivery's fixed key would return that CANCELLED row and move
      -- the workflow into a running state with no runnable downstream job.
      PERFORM deviludo.enqueue_job(job.workspace_id, job.workflow_id, job.project_id, 'ARTIFACT_BUILD', NULL,
        job.workflow_id::text || ':artifact:after:' || job.id::text,
        jsonb_build_object('targetPlatforms', workflow.target_platforms));
    END IF;
  ELSIF workflow.state = 'ARTIFACT_BUILDING' AND job.kind = 'ARTIFACT_BUILD' THEN
    UPDATE deviludo.workflow_instances SET state = 'E2E_TESTING', version = version + 1,
      updated_at = clock_timestamp() WHERE workspace_id = workflow.workspace_id AND id = workflow.id;
    FOREACH platform IN ARRAY workflow.target_platforms
    LOOP
      PERFORM deviludo.enqueue_job(job.workspace_id, job.workflow_id, job.project_id, 'E2E_TEST', platform,
        job.workflow_id::text || ':e2e:' || platform::text || ':after:' || job.id::text);
    END LOOP;
  ELSIF workflow.state = 'E2E_TESTING' AND job.kind = 'E2E_TEST'
    AND NOT EXISTS (
      SELECT 1 FROM unnest(workflow.target_platforms) AS required_platform(operating_system)
       WHERE NOT EXISTS (
         SELECT 1 FROM deviludo.jobs successful_test
          WHERE successful_test.workspace_id = job.workspace_id
            AND successful_test.workflow_id = job.workflow_id
            AND successful_test.kind = 'E2E_TEST'
            AND successful_test.target_operating_system = required_platform.operating_system
            AND successful_test.state = 'SUCCEEDED'
       )
    )
  THEN
    IF workflow.profile = 'VALIDATE' THEN
      UPDATE deviludo.workflow_instances SET state = 'SUCCEEDED', version = version + 1,
        updated_at = clock_timestamp() WHERE workspace_id = workflow.workspace_id AND id = workflow.id;
    ELSE
      UPDATE deviludo.workflow_instances SET state = 'SIGNING', version = version + 1,
        updated_at = clock_timestamp() WHERE workspace_id = workflow.workspace_id AND id = workflow.id;
      FOREACH platform IN ARRAY workflow.target_platforms
      LOOP
        PERFORM deviludo.enqueue_job(job.workspace_id, job.workflow_id, job.project_id, 'ARTIFACT_SIGN', platform,
          job.workflow_id::text || ':sign:' || platform::text || ':after:' || job.id::text);
      END LOOP;
    END IF;
  ELSIF workflow.state = 'SIGNING' AND job.kind = 'ARTIFACT_SIGN'
    AND NOT EXISTS (
      SELECT 1 FROM deviludo.jobs
       WHERE workspace_id = job.workspace_id AND workflow_id = job.workflow_id
         AND kind = 'ARTIFACT_SIGN' AND state <> 'SUCCEEDED'
    )
  THEN
    -- Signing is reversible; publishing to Steam is not. Hold the exact signed
    -- builds until a workspace administrator explicitly approves this release.
    UPDATE deviludo.workflow_instances SET state = 'RELEASE_APPROVAL_PENDING', version = version + 1,
      updated_at = clock_timestamp() WHERE workspace_id = workflow.workspace_id AND id = workflow.id;
  ELSIF workflow.state = 'STEAM_PUBLISHING' AND job.kind = 'STEAM_PUBLISH' THEN
    UPDATE deviludo.workflow_instances SET state = 'CLEAN_INSTALL_VERIFYING', version = version + 1,
      updated_at = clock_timestamp() WHERE workspace_id = workflow.workspace_id AND id = workflow.id;
    FOREACH platform IN ARRAY workflow.target_platforms
    LOOP
      PERFORM deviludo.enqueue_job(job.workspace_id, job.workflow_id, job.project_id, 'STEAM_CLEAN_INSTALL', platform,
        job.workflow_id::text || ':clean-install:' || platform::text || ':after:' || job.id::text);
    END LOOP;
  ELSIF workflow.state = 'CLEAN_INSTALL_VERIFYING' AND job.kind = 'STEAM_CLEAN_INSTALL'
    AND NOT EXISTS (
      SELECT 1 FROM deviludo.jobs
       WHERE workspace_id = job.workspace_id AND workflow_id = job.workflow_id
         AND kind = 'STEAM_CLEAN_INSTALL' AND state <> 'SUCCEEDED'
    )
  THEN
    UPDATE deviludo.workflow_instances SET state = 'SUCCEEDED', version = version + 1,
      updated_at = clock_timestamp() WHERE workspace_id = workflow.workspace_id AND id = workflow.id;
  END IF;
  SELECT * INTO workflow FROM deviludo.workflow_instances
   WHERE workspace_id = job.workspace_id AND id = job.workflow_id;
  IF workflow.state = 'SUCCEEDED' AND workflow.development_actor_account_id IS NOT NULL THEN
    INSERT INTO deviludo.project_source_ready_outbox(
      workspace_id, project_id, workflow_id, source_revision, content_digest,
      development_actor_account_id
    )
    SELECT source.workspace_id, source.project_id, job.workflow_id, source.revision,
           source.content_digest, workflow.development_actor_account_id
      FROM deviludo.project_source_revisions source
     WHERE source.workspace_id = job.workspace_id AND source.project_id = job.project_id
     ORDER BY source.revision DESC LIMIT 1
    ON CONFLICT (workspace_id, project_id, workflow_id, source_revision) DO NOTHING;
  END IF;
  RETURN true;
END
$$;


REVOKE ALL ON FUNCTION deviludo.advance_asset_workflows(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION deviludo.advance_asset_workflows(integer) TO deviludo_scheduler;
