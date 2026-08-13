BEGIN;

ALTER TABLE deviludo.project_source_revisions
  ADD COLUMN IF NOT EXISTS test_manifest_protocol text
    CHECK (test_manifest_protocol ~ '^deviludo\.test-manifest\.v[0-9]+$'),
  ADD COLUMN IF NOT EXISTS test_manifest_digest text
    CHECK (test_manifest_digest ~ '^sha256:[0-9a-f]{64}$');

-- Keep the current completion function (including all fixes from earlier
-- migrations) and surgically add the v3 source contract plus five-repair
-- budget. This avoids replacing the large state machine with a stale copy.
DO $migration$
DECLARE
  target regprocedure :=
    'deviludo.complete_job(uuid,uuid,bigint,bigint,jsonb,jsonb,text,text,text)'::regprocedure;
  definition text;
  old_validation text := $old$
      OR (p_receipt #>> '{sourceRevision,totalBytes}')::bigint NOT BETWEEN 1 AND 1073741824
    THEN RAISE EXCEPTION 'validated persistent source revision is required'; END IF;$old$;
  new_validation text := $new$
      OR (p_receipt #>> '{sourceRevision,totalBytes}')::bigint NOT BETWEEN 1 AND 1073741824
      OR coalesce(p_receipt #>> '{testManifest,schemaVersion}', '') <> 'deviludo.test-manifest.v3'
      OR coalesce(p_receipt->>'testManifestDigest', '') !~ '^sha256:[0-9a-f]{64}$'
    THEN RAISE EXCEPTION 'validated persistent source revision is required'; END IF;$new$;
  old_insert text := $old$
      file_count, total_bytes, workflow_id, job_id, actor_account_id, fencing_token
    ) VALUES (
      job.workspace_id, job.project_id, (p_receipt #>> '{sourceRevision,revision}')::bigint,
      p_receipt #>> '{sourceRevision,relativePath}', p_receipt #>> '{sourceRevision,digest}',
      (p_receipt #>> '{sourceRevision,fileCount}')::integer,
      (p_receipt #>> '{sourceRevision,totalBytes}')::bigint,
      job.workflow_id, job.id, workflow.development_actor_account_id, job.fencing_token$old$;
  new_insert text := $new$
      file_count, total_bytes, test_manifest_protocol, test_manifest_digest,
      workflow_id, job_id, actor_account_id, fencing_token
    ) VALUES (
      job.workspace_id, job.project_id, (p_receipt #>> '{sourceRevision,revision}')::bigint,
      p_receipt #>> '{sourceRevision,relativePath}', p_receipt #>> '{sourceRevision,digest}',
      (p_receipt #>> '{sourceRevision,fileCount}')::integer,
      (p_receipt #>> '{sourceRevision,totalBytes}')::bigint,
      p_receipt #>> '{testManifest,schemaVersion}',
      p_receipt->>'testManifestDigest',
      job.workflow_id, job.id, workflow.development_actor_account_id, job.fencing_token$new$;
BEGIN
  SELECT pg_get_functiondef(target) INTO definition;
  IF position('deviludo.test-manifest.v3' IN definition) = 0 THEN
    IF position(old_validation IN definition) = 0 OR position(old_insert IN definition) = 0 THEN
      RAISE EXCEPTION 'complete_job source contract no longer matches the expected definition';
    END IF;
    definition := replace(definition, old_validation, new_validation);
    definition := replace(definition, old_insert, new_insert);
  END IF;
  definition := replace(definition, 'repair_count < 3', 'repair_count < 5');
  EXECUTE definition;
END
$migration$;

-- Freeze only latest terminal iterations into the v3 upgrade cohort. A null
-- source protocol means imported/v2 source and therefore forces Agent first.
UPDATE deviludo.workflow_instances workflow
   SET state_data = coalesce(workflow.state_data, '{}'::jsonb)
         || jsonb_build_object(
              'e2eProtocolRevalidation',
              jsonb_build_object('protocol', 'deviludo.e2e-evidence.v2', 'queuedAt', clock_timestamp())
            )
 WHERE workflow.state IN ('SUCCEEDED', 'FAILED', 'CANCELLED')
   AND NOT EXISTS (
     SELECT 1 FROM deviludo.workflow_instances newer
      WHERE newer.workspace_id = workflow.workspace_id
        AND newer.project_id = workflow.project_id
        AND newer.iteration_number > workflow.iteration_number
   );

CREATE OR REPLACE FUNCTION deviludo.schedule_e2e_protocol_revalidation(
  p_protocol text,
  p_batch_size integer DEFAULT 2
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, deviludo
SET row_security = off
AS $$
DECLARE
  candidate record;
  rerun_stage deviludo.job_kind;
  requested_by uuid;
  scheduled integer := 0;
  signal_key text;
BEGIN
  IF p_protocol !~ '^deviludo\.e2e-evidence\.v[0-9]+$' THEN RAISE EXCEPTION 'invalid E2E evidence protocol'; END IF;
  IF p_batch_size NOT BETWEEN 1 AND 20 THEN RAISE EXCEPTION 'invalid E2E revalidation batch size'; END IF;
  signal_key := 'e2e-protocol-revalidate:' || p_protocol;
  FOR candidate IN
    SELECT workflow.workspace_id, workflow.id AS workflow_id, workflow.project_id,
           workflow.development_actor_account_id, project.created_by_actor_account_id,
           (
             SELECT source.test_manifest_protocol
               FROM deviludo.project_source_revisions source
              WHERE source.workspace_id = workflow.workspace_id
                AND source.project_id = workflow.project_id
              ORDER BY source.revision DESC
              LIMIT 1
           ) AS latest_test_manifest_protocol
      FROM deviludo.workflow_instances workflow
      JOIN deviludo.projects project
        ON project.workspace_id = workflow.workspace_id AND project.id = workflow.project_id
     WHERE workflow.state IN ('SUCCEEDED', 'FAILED', 'CANCELLED')
       AND workflow.state_data #>> '{e2eProtocolRevalidation,protocol}' = p_protocol
       AND NOT EXISTS (
         SELECT 1 FROM deviludo.workflow_instances newer
          WHERE newer.workspace_id = workflow.workspace_id
            AND newer.project_id = workflow.project_id
            AND newer.iteration_number > workflow.iteration_number
       )
       AND NOT EXISTS (
         SELECT 1 FROM deviludo.external_signals signal
          WHERE signal.workspace_id = workflow.workspace_id
            AND signal.workflow_id = workflow.id
            AND signal.idempotency_key = signal_key
       )
       AND (
         EXISTS (
           SELECT 1 FROM deviludo.project_source_revisions source
            WHERE source.workspace_id = workflow.workspace_id AND source.project_id = workflow.project_id
         )
         OR EXISTS (SELECT 1 FROM deviludo.instance_agent_settings WHERE singleton = true)
       )
     ORDER BY workflow.updated_at, workflow.id
     LIMIT p_batch_size
  LOOP
    requested_by := coalesce(candidate.development_actor_account_id, candidate.created_by_actor_account_id);
    IF candidate.latest_test_manifest_protocol IS DISTINCT FROM 'deviludo.test-manifest.v3' THEN
      rerun_stage := 'AGENT_GENERATION';
    ELSIF EXISTS (
      SELECT 1 FROM deviludo.artifacts artifact
      JOIN deviludo.jobs producing_job
        ON producing_job.workspace_id = artifact.workspace_id AND producing_job.id = artifact.producing_job_id
      WHERE artifact.workspace_id = candidate.workspace_id
        AND artifact.workflow_id = candidate.workflow_id
        AND artifact.kind = 'BUILD'
        AND producing_job.state = 'SUCCEEDED'
    ) THEN rerun_stage := 'E2E_TEST';
    ELSIF EXISTS (
      SELECT 1 FROM deviludo.project_source_revisions source
       WHERE source.workspace_id = candidate.workspace_id AND source.project_id = candidate.project_id
    ) THEN rerun_stage := 'ARTIFACT_BUILD';
    ELSE rerun_stage := 'AGENT_GENERATION';
    END IF;
    IF rerun_stage = 'AGENT_GENERATION'
      AND NOT EXISTS (SELECT 1 FROM deviludo.instance_agent_settings WHERE singleton = true)
    THEN CONTINUE; END IF;
    IF deviludo.accept_workflow_signal(
      candidate.workflow_id,
      'STAGE_RERUN_REQUESTED',
      signal_key,
      jsonb_build_object(
        'stage', rerun_stage::text,
        'requestedByAccountId', requested_by,
        'reason', 'E2E_PROTOCOL_UPGRADE',
        'testManifestProtocol', 'deviludo.test-manifest.v3',
        'evidenceProtocol', p_protocol
      )
    ) THEN scheduled := scheduled + 1; END IF;
  END LOOP;
  RETURN scheduled;
END
$$;

ALTER FUNCTION deviludo.complete_job(uuid, uuid, bigint, bigint, jsonb, jsonb, text, text, text)
  OWNER TO deviludo_claim_executor;
ALTER FUNCTION deviludo.schedule_e2e_protocol_revalidation(text, integer)
  OWNER TO deviludo_claim_executor;
REVOKE ALL ON FUNCTION deviludo.schedule_e2e_protocol_revalidation(text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION deviludo.schedule_e2e_protocol_revalidation(text, integer)
  TO deviludo_scheduler;

COMMIT;
