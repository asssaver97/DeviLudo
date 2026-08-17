BEGIN;

-- Freeze the deployment-time cohort. Without this marker, every workflow that
-- reaches a terminal state after the upgrade would be needlessly rerun once.
UPDATE deviludo.workflow_instances workflow
   SET state_data = coalesce(workflow.state_data, '{}'::jsonb)
         || jsonb_build_object(
              'e2eProtocolRevalidation',
              jsonb_build_object('protocol', 'deviludo.e2e-evidence.v1', 'queuedAt', clock_timestamp())
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
           workflow.development_actor_id, project.created_by_actor_id
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
    requested_by := coalesce(candidate.development_actor_id, candidate.created_by_actor_id);
    IF EXISTS (
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
        'requestedByActorId', requested_by,
        'reason', 'E2E_PROTOCOL_UPGRADE',
        'evidenceProtocol', p_protocol
      )
    ) THEN scheduled := scheduled + 1; END IF;
  END LOOP;
  RETURN scheduled;
END
$$;

ALTER FUNCTION deviludo.schedule_e2e_protocol_revalidation(text, integer)
  OWNER TO deviludo_claim_executor;
REVOKE ALL ON FUNCTION deviludo.schedule_e2e_protocol_revalidation(text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION deviludo.accept_workflow_signal(uuid, text, text, jsonb)
  TO deviludo_claim_executor;
GRANT EXECUTE ON FUNCTION deviludo.schedule_e2e_protocol_revalidation(text, integer)
  TO deviludo_scheduler;

COMMIT;
