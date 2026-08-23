BEGIN;

CREATE TABLE deviludo.implementation_change_requests (
  workspace_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  workflow_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  source_message_id bigint NOT NULL,
  state text NOT NULL CHECK (state IN ('PENDING', 'WAITING_FOR_ANALYSIS', 'APPLIED', 'REJECTED', 'SUPERSEDED')),
  summary text NOT NULL CHECK (length(summary) BETWEEN 1 AND 2000),
  implementation_brief text NOT NULL CHECK (length(implementation_brief) BETWEEN 1 AND 12000),
  base_document_revision bigint NOT NULL CHECK (base_document_revision > 0),
  project_document_patch jsonb NOT NULL CHECK (jsonb_typeof(project_document_patch) = 'object'),
  e2e_goal_delta jsonb NOT NULL CHECK (jsonb_typeof(e2e_goal_delta) = 'object'),
  explicit_execution boolean NOT NULL,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 300),
  decision text CHECK (decision IS NULL OR decision IN ('CONFIRM', 'REJECT')),
  decision_idempotency_key text CHECK (decision_idempotency_key IS NULL OR length(decision_idempotency_key) BETWEEN 8 AND 300),
  applied_workflow_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, idempotency_key),
  UNIQUE (workspace_id, decision_idempotency_key),
  FOREIGN KEY (workspace_id, project_id) REFERENCES deviludo.projects(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, workflow_id) REFERENCES deviludo.workflow_instances(workspace_id, id),
  FOREIGN KEY (workspace_id, conversation_id) REFERENCES deviludo.project_conversations(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, source_message_id) REFERENCES deviludo.conversation_messages(workspace_id, message_id),
  FOREIGN KEY (workspace_id, applied_workflow_id) REFERENCES deviludo.workflow_instances(workspace_id, id)
);
CREATE UNIQUE INDEX implementation_change_requests_one_pending
  ON deviludo.implementation_change_requests(workspace_id, project_id)
  WHERE state IN ('PENDING', 'WAITING_FOR_ANALYSIS');

CREATE TABLE deviludo.workflow_e2e_goal_revisions (
  workspace_id uuid NOT NULL,
  workflow_id uuid NOT NULL,
  revision bigint NOT NULL CHECK (revision > 0),
  change_request_id uuid,
  goals jsonb NOT NULL CHECK (jsonb_typeof(goals) = 'array'),
  goals_digest text NOT NULL CHECK (goals_digest ~ '^sha256:[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, workflow_id, revision),
  FOREIGN KEY (workspace_id, workflow_id) REFERENCES deviludo.workflow_instances(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, change_request_id) REFERENCES deviludo.implementation_change_requests(workspace_id, id)
);

WITH requirement_rows AS (
  SELECT workflow.workspace_id, workflow.id AS workflow_id,
         'CORE_LOOP'::text AS source, entry.ordinality,
         btrim(entry.value #>> '{}') AS description
    FROM deviludo.workflow_instances workflow
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(workflow.state_data #> '{specification,coreLoop}') = 'array'
        THEN workflow.state_data #> '{specification,coreLoop}' ELSE '[]'::jsonb END
    ) WITH ORDINALITY entry(value, ordinality)
  UNION ALL
  SELECT workflow.workspace_id, workflow.id, 'ACCEPTANCE', entry.ordinality,
         btrim(entry.value #>> '{}')
    FROM deviludo.workflow_instances workflow
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(workflow.state_data #> '{specification,acceptanceCriteria}') = 'array'
        THEN workflow.state_data #> '{specification,acceptanceCriteria}' ELSE '[]'::jsonb END
    ) WITH ORDINALITY entry(value, ordinality)
), snapshots AS (
  SELECT workspace_id, workflow_id,
         jsonb_agg(jsonb_build_object(
           'id', 'goal-import-' || substr(md5(source || ':' || ordinality::text || ':' || description), 1, 16),
           'description', description,
           'source', source
         ) ORDER BY source, ordinality) AS goals
    FROM requirement_rows
   WHERE description <> ''
   GROUP BY workspace_id, workflow_id
)
INSERT INTO deviludo.workflow_e2e_goal_revisions(
  workspace_id, workflow_id, revision, goals, goals_digest
)
SELECT workspace_id, workflow_id, 1, goals,
       'sha256:' || encode(digest(goals::text, 'sha256'), 'hex')
  FROM snapshots;
UPDATE deviludo.workflow_instances workflow
   SET state_data = workflow.state_data || jsonb_build_object('e2eGoalRevision', 1)
 WHERE EXISTS (
   SELECT 1 FROM deviludo.workflow_e2e_goal_revisions goals
    WHERE goals.workspace_id = workflow.workspace_id AND goals.workflow_id = workflow.id
 );

ALTER TABLE deviludo.asset_items
  ADD COLUMN generation_lease_token uuid;
UPDATE deviludo.asset_items
   SET generation_lease_token = gen_random_uuid()
 WHERE status = 'generating';
ALTER TABLE deviludo.asset_items
  DROP CONSTRAINT asset_items_lease_requires_generating,
  ADD CONSTRAINT asset_items_lease_requires_generating CHECK (
    (generation_lease_expires_at IS NOT NULL) = (status = 'generating')
    AND (status <> 'generating' OR generation_lease_token IS NOT NULL)
  );

DROP FUNCTION deviludo.claim_asset_generation(integer, integer);
CREATE FUNCTION deviludo.claim_asset_generation(p_lease_seconds integer, p_batch_size integer DEFAULT 4)
RETURNS TABLE (
  "workspaceId" uuid, "projectId" uuid, "itemId" uuid, "assetKey" text,
  "assetType" text, "description" text, "generationPrompt" text,
  "dimensions" text, "frameCount" integer, "attempt" integer, "leaseToken" uuid
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, deviludo SET row_security = off
AS $$
BEGIN
  IF p_lease_seconds NOT BETWEEN 30 AND 3600 OR p_batch_size NOT BETWEEN 1 AND 50 THEN
    RAISE EXCEPTION 'invalid asset generation claim';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM deviludo.instance_agent_settings
     WHERE singleton = true
       AND (agent_runtime = 'CODEX_CLI' OR (agent_runtime = 'CLAUDE_CODE' AND image_model IS NOT NULL))
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
       AND (item.status = 'planned'
         OR (item.status = 'generating' AND item.generation_lease_expires_at <= clock_timestamp()))
     ORDER BY item.generation_attempt, item.created_at, item.id
     FOR UPDATE OF item SKIP LOCKED
     LIMIT p_batch_size
  )
  UPDATE deviludo.asset_items item
     SET status = 'generating', generation_attempt = item.generation_attempt + 1,
         generation_lease_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds),
         generation_lease_token = gen_random_uuid(), error_message = NULL,
         updated_at = clock_timestamp()
    FROM candidate
   WHERE item.workspace_id = candidate.workspace_id AND item.id = candidate.id
  RETURNING item.workspace_id, (
    SELECT manifest.project_id FROM deviludo.asset_manifests manifest
     WHERE manifest.workspace_id = item.workspace_id AND manifest.id = item.manifest_id
  ), item.id, item.asset_key, item.asset_type, item.description,
     item.generation_prompt, item.dimensions, item.frame_count, item.generation_attempt,
     item.generation_lease_token;
END
$$;
ALTER FUNCTION deviludo.claim_asset_generation(integer, integer) OWNER TO deviludo_claim_executor;

DROP FUNCTION deviludo.complete_asset_generation(uuid, uuid, text, text, text, bigint);
CREATE FUNCTION deviludo.complete_asset_generation(
  p_workspace_id uuid, p_item_id uuid, p_lease_token uuid, p_bucket text,
  p_object_key text, p_sha256 text, p_size_bytes bigint
)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, deviludo SET row_security = off
AS $$
DECLARE updated integer;
BEGIN
  UPDATE deviludo.asset_items
     SET status = 'generated', bucket = p_bucket, object_key = p_object_key,
         sha256 = p_sha256, size_bytes = p_size_bytes, error_message = NULL,
         generation_lease_expires_at = NULL, updated_at = clock_timestamp()
   WHERE workspace_id = p_workspace_id AND id = p_item_id
     AND status = 'generating' AND generation_lease_token = p_lease_token;
  GET DIAGNOSTICS updated = ROW_COUNT;
  RETURN updated = 1;
END
$$;
ALTER FUNCTION deviludo.complete_asset_generation(uuid, uuid, uuid, text, text, text, bigint)
  OWNER TO deviludo_claim_executor;

DROP FUNCTION deviludo.fail_asset_generation(uuid, uuid, text);
CREATE FUNCTION deviludo.fail_asset_generation(
  p_workspace_id uuid, p_item_id uuid, p_lease_token uuid, p_error text
)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, deviludo SET row_security = off
AS $$
DECLARE updated integer;
BEGIN
  UPDATE deviludo.asset_items
     SET status = CASE WHEN generation_attempt >= 3 THEN 'failed' ELSE 'planned' END,
         error_message = left(coalesce(nullif(btrim(p_error), ''), 'generation failed'), 2000),
         generation_lease_expires_at = NULL, updated_at = clock_timestamp()
   WHERE workspace_id = p_workspace_id AND id = p_item_id
     AND status = 'generating' AND generation_lease_token = p_lease_token;
  GET DIAGNOSTICS updated = ROW_COUNT;
  RETURN updated = 1;
END
$$;
ALTER FUNCTION deviludo.fail_asset_generation(uuid, uuid, uuid, text)
  OWNER TO deviludo_claim_executor;

ALTER TABLE deviludo.e2e_test_plans
  ADD COLUMN source_revision bigint,
  ADD COLUMN goal_revision bigint,
  ADD COLUMN goal_digest text;
UPDATE deviludo.e2e_test_plans plan
   SET source_revision = coalesce((
         SELECT max(source.revision)
           FROM deviludo.project_source_revisions source
          WHERE source.workspace_id = plan.workspace_id
            AND source.project_id = plan.project_id
       ), 1),
       goal_revision = coalesce((
         SELECT max(goals.revision)
           FROM deviludo.workflow_e2e_goal_revisions goals
          WHERE goals.workspace_id = plan.workspace_id
            AND goals.workflow_id = plan.workflow_id
       ), 1),
       goal_digest = coalesce((
         SELECT goals.goals_digest
           FROM deviludo.workflow_e2e_goal_revisions goals
          WHERE goals.workspace_id = plan.workspace_id
            AND goals.workflow_id = plan.workflow_id
          ORDER BY goals.revision DESC
          LIMIT 1
       ), plan.test_manifest_digest);
ALTER TABLE deviludo.e2e_test_plans
  ALTER COLUMN source_revision SET NOT NULL,
  ALTER COLUMN goal_revision SET NOT NULL,
  ALTER COLUMN goal_digest SET NOT NULL,
  ADD CHECK (source_revision > 0),
  ADD CHECK (goal_revision > 0),
  ADD CHECK (goal_digest ~ '^sha256:[0-9a-f]{64}$'),
  DROP CONSTRAINT e2e_test_plans_pkey,
  ADD PRIMARY KEY (workspace_id, workflow_id, source_revision, goal_revision, target_platform);

UPDATE deviludo.jobs job
   SET payload = job.payload || (
     SELECT jsonb_build_object(
              'e2eGoalRevision', snapshot.revision,
              'e2eGoalDigest', snapshot.goals_digest
            )
       FROM deviludo.workflow_e2e_goal_revisions snapshot
      WHERE snapshot.workspace_id = job.workspace_id
        AND snapshot.workflow_id = job.workflow_id
      ORDER BY snapshot.revision DESC
      LIMIT 1
   )
 WHERE job.kind = 'E2E_TEST'
   AND EXISTS (
     SELECT 1 FROM deviludo.workflow_e2e_goal_revisions snapshot
      WHERE snapshot.workspace_id = job.workspace_id
        AND snapshot.workflow_id = job.workflow_id
   );

ALTER TABLE deviludo.artifacts
  DROP CONSTRAINT artifacts_workspace_id_object_key_sha256_key,
  ADD UNIQUE (workspace_id, workflow_id, object_key, sha256);

DO $migration$
DECLARE
  definition text;
  patched text;
  source_declaration constant text := '  v_source deviludo.project_source_revisions%ROWTYPE;';
  extended_declaration constant text := E'  v_source deviludo.project_source_revisions%ROWTYPE;\n  v_goal deviludo.workflow_e2e_goal_revisions%ROWTYPE;';
  source_tail constant text := E'      ) END;\n  END IF;\n  INSERT INTO deviludo.jobs (';
  goal_tail constant text := E'      ) END;\n    IF p_kind = ''E2E_TEST'' THEN\n      SELECT * INTO v_goal\n        FROM deviludo.workflow_e2e_goal_revisions\n       WHERE workspace_id = p_workspace_id AND workflow_id = p_workflow_id\n       ORDER BY revision DESC LIMIT 1;\n      IF v_goal.revision IS NULL THEN RAISE EXCEPTION ''E2E jobs require a frozen goal revision''; END IF;\n      p_payload := p_payload || jsonb_build_object(\n        ''e2eGoalRevision'', v_goal.revision,\n        ''e2eGoalDigest'', v_goal.goals_digest\n      );\n    END IF;\n  END IF;\n  INSERT INTO deviludo.jobs (';
BEGIN
  SELECT pg_get_functiondef(
    'deviludo.enqueue_job(uuid,uuid,uuid,deviludo.job_kind,deviludo.server_os,text,jsonb)'::regprocedure
  ) INTO definition;
  patched := replace(replace(definition, source_declaration, extended_declaration), source_tail, goal_tail);
  IF patched = definition OR position(extended_declaration IN patched) = 0 OR position(goal_tail IN patched) = 0 THEN
    RAISE EXCEPTION 'enqueue_job E2E goal snapshot insertion point was not found';
  END IF;
  EXECUTE patched;
END
$migration$;

ALTER TABLE deviludo.job_progress_events DROP CONSTRAINT job_progress_events_event_kind_check;
DELETE FROM deviludo.job_progress_events WHERE event_kind = 'GUIDANCE_ACCEPTED';
ALTER TABLE deviludo.job_progress_events ADD CHECK (
  event_kind IN ('PHASE', 'AGENT_OUTPUT', 'SUPERSEDED', 'COMPLETED', 'FAILED')
);

DO $migration$
DECLARE
  definition text;
  patched text;
BEGIN
  SELECT pg_get_functiondef('deviludo.fail_job(uuid,uuid,bigint,text)'::regprocedure) INTO definition;
  patched := regexp_replace(
    definition,
    E'\\n  IF NOT terminal AND job\\.kind = ''AGENT_GENERATION'' THEN\\n    UPDATE deviludo\\.job_guidance_messages[\\s\\S]*?\\n  END IF;',
    '',
    'n'
  );
  IF patched = definition THEN RAISE EXCEPTION 'fail_job guidance replay block was not found'; END IF;
  EXECUTE patched;

  SELECT pg_get_functiondef('deviludo.recover_expired_jobs()'::regprocedure) INTO definition;
  patched := regexp_replace(
    definition,
    E'\\n  \\), replay_guidance AS \\([\\s\\S]*?RETURNING guidance\\.id\\n  \\), events AS \\(',
    E'\n  ), events AS (',
    'n'
  );
  IF patched = definition THEN RAISE EXCEPTION 'recover_expired_jobs guidance replay CTE was not found'; END IF;
  EXECUTE patched;
END
$migration$;

DROP TABLE deviludo.job_guidance_messages;

ALTER TABLE deviludo.implementation_change_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE deviludo.implementation_change_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON deviludo.implementation_change_requests
  USING (workspace_id = deviludo.current_workspace_id())
  WITH CHECK (workspace_id = deviludo.current_workspace_id());
ALTER TABLE deviludo.workflow_e2e_goal_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE deviludo.workflow_e2e_goal_revisions FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON deviludo.workflow_e2e_goal_revisions
  USING (workspace_id = deviludo.current_workspace_id())
  WITH CHECK (workspace_id = deviludo.current_workspace_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON
  deviludo.implementation_change_requests, deviludo.workflow_e2e_goal_revisions
  TO deviludo_api;
GRANT SELECT ON deviludo.workflow_e2e_goal_revisions
  TO deviludo_scheduler, deviludo_sandbox;
REVOKE ALL ON FUNCTION deviludo.claim_asset_generation(integer, integer),
  deviludo.complete_asset_generation(uuid, uuid, uuid, text, text, text, bigint),
  deviludo.fail_asset_generation(uuid, uuid, uuid, text)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION deviludo.claim_asset_generation(integer, integer),
  deviludo.complete_asset_generation(uuid, uuid, uuid, text, text, text, bigint),
  deviludo.fail_asset_generation(uuid, uuid, uuid, text)
  TO deviludo_scheduler;

COMMIT;
