BEGIN;

-- A database retry creates a new task container. Guidance marked DELIVERED was
-- delivered only to the previous container, so make it pending again before the
-- replacement attempt starts. This keeps player corrections durable across
-- ordinary failures and expired leases without re-delivering inside one lease.
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
  terminal := job.attempt >= job.max_attempts;
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
    UPDATE deviludo.workflow_instances SET state = 'FAILED', version = version + 1,
      updated_at = clock_timestamp()
     WHERE workspace_id = job.workspace_id AND id = job.workflow_id
       AND state NOT IN ('SUCCEEDED', 'FAILED', 'CANCELLED');
  END IF;
  RETURN true;
END
$$;

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
     RETURNING workspace_id, workflow_id, id, attempt, state
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
  )
  SELECT count(*) INTO recovered FROM expired;
  RETURN recovered;
END
$$;
ALTER FUNCTION deviludo.recover_expired_jobs() OWNER TO deviludo_claim_executor;

COMMIT;
