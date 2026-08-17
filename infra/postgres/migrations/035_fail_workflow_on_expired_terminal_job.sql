BEGIN;

-- A terminal job whose worker disappears must close its workflow exactly like
-- an explicit fail_job call. Previously the reaper only failed the job, which
-- left projects permanently stuck in a running stage and made rerun-stage
-- return 409 even though no worker or retry remained.
CREATE OR REPLACE FUNCTION deviludo.recover_expired_jobs()
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, deviludo
SET row_security = off
AS $$
DECLARE
  recovered bigint;
BEGIN
  WITH expired AS (
    UPDATE deviludo.jobs
       SET state = CASE WHEN attempt >= max_attempts
                        THEN 'FAILED'::deviludo.job_state
                        ELSE 'RETRY'::deviludo.job_state END,
           available_at = clock_timestamp() + make_interval(secs => least(3600, (2 ^ greatest(attempt, 1))::integer)),
           lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL, heartbeat_at = NULL,
           last_error = 'lease expired', updated_at = clock_timestamp()
     WHERE state = 'RUNNING' AND lease_expires_at < clock_timestamp()
     RETURNING workspace_id, workflow_id, id, kind, attempt, state
  ), replay_guidance AS (
    UPDATE deviludo.job_guidance_messages guidance
       SET state = 'PENDING', delivered_at = NULL
      FROM expired
     WHERE expired.state = 'RETRY'
       AND guidance.workspace_id = expired.workspace_id
       AND guidance.job_id = expired.id
       AND guidance.state = 'DELIVERED'
    RETURNING guidance.id
  ), events AS (
    INSERT INTO deviludo.workflow_events(
      workspace_id, workflow_id, event_kind, event_data, idempotency_key
    )
    SELECT workspace_id, workflow_id,
      CASE WHEN state = 'FAILED' THEN 'JOB_FAILED' ELSE 'JOB_RETRY_SCHEDULED' END,
      jsonb_build_object('jobId', id, 'attempt', attempt, 'reason', 'lease expired'),
      'lease-expired:' || id::text || ':' || attempt::text
    FROM expired
    ON CONFLICT (workspace_id, workflow_id, idempotency_key) DO NOTHING
  ), failed_workflows AS (
    UPDATE deviludo.workflow_instances workflow
       SET state = 'FAILED', version = version + 1, updated_at = clock_timestamp()
      FROM (
        SELECT DISTINCT workspace_id, workflow_id
          FROM expired
         WHERE state = 'FAILED' AND kind <> 'PROJECT_DOCUMENT_MAINTENANCE'
      ) terminal
     WHERE workflow.workspace_id = terminal.workspace_id
       AND workflow.id = terminal.workflow_id
       AND workflow.state NOT IN ('SUCCEEDED', 'FAILED', 'CANCELLED')
    RETURNING workflow.id
  )
  SELECT count(*) INTO recovered FROM expired;
  RETURN recovered;
END
$$;
ALTER FUNCTION deviludo.recover_expired_jobs() OWNER TO deviludo_claim_executor;

-- Repair workflows already stranded by the old function. Only a latest
-- terminal failed non-maintenance job can close a still-running workflow.
UPDATE deviludo.workflow_instances workflow
   SET state = 'FAILED', version = version + 1, updated_at = clock_timestamp()
 WHERE workflow.state NOT IN ('SUCCEEDED', 'FAILED', 'CANCELLED')
   AND EXISTS (
     SELECT 1
       FROM deviludo.jobs job
      WHERE job.workspace_id = workflow.workspace_id
        AND job.workflow_id = workflow.id
        AND job.state = 'FAILED'
        AND job.kind <> 'PROJECT_DOCUMENT_MAINTENANCE'
        AND NOT EXISTS (
          SELECT 1 FROM deviludo.jobs newer
           WHERE newer.workspace_id = job.workspace_id
             AND newer.workflow_id = job.workflow_id
             AND newer.created_at > job.created_at
        )
   );

COMMIT;
