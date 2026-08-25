BEGIN;

ALTER TABLE deviludo.artifacts
  ADD COLUMN state text NOT NULL DEFAULT 'AVAILABLE'
  CHECK (state IN ('AVAILABLE', 'DELETING', 'DELETED'));

CREATE OR REPLACE FUNCTION deviludo.complete_object_cleanup(
  p_workspace_id uuid, p_bucket text, p_object_key text, p_lease_token uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, deviludo
SET row_security = off
AS $$
DECLARE removed integer;
BEGIN
  UPDATE deviludo.artifacts
     SET state = 'DELETED'
   WHERE workspace_id = p_workspace_id AND bucket = p_bucket AND object_key = p_object_key
     AND state = 'DELETING'
     AND EXISTS (
       SELECT 1 FROM deviludo.object_cleanup_queue queue
        WHERE queue.workspace_id = p_workspace_id AND queue.bucket = p_bucket
          AND queue.object_key = p_object_key AND queue.lease_token = p_lease_token
          AND queue.lease_expires_at > clock_timestamp()
     );
  DELETE FROM deviludo.object_cleanup_queue
   WHERE workspace_id = p_workspace_id AND bucket = p_bucket AND object_key = p_object_key
     AND lease_token = p_lease_token AND lease_expires_at > clock_timestamp();
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed = 1;
END
$$;
ALTER FUNCTION deviludo.complete_object_cleanup(uuid, text, text, uuid) OWNER TO deviludo_claim_executor;
REVOKE ALL ON FUNCTION deviludo.complete_object_cleanup(uuid, text, text, uuid) FROM PUBLIC;
GRANT UPDATE (state) ON deviludo.artifacts TO deviludo_claim_executor;

CREATE OR REPLACE FUNCTION deviludo.enqueue_expired_artifacts(
  p_retention_days integer, p_limit integer
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, deviludo
SET row_security = off
AS $$
DECLARE enqueued integer;
BEGIN
  IF p_retention_days NOT BETWEEN 1 AND 3650 OR p_limit NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'invalid artifact retention sweep';
  END IF;
  WITH candidate AS (
    SELECT artifact.workspace_id, artifact.id, artifact.bucket, artifact.object_key
      FROM deviludo.artifacts artifact
     WHERE artifact.state = 'AVAILABLE'
       AND artifact.kind IN ('BUILD', 'E2E_REPORT', 'SIGNED_BUILD', 'PUBLISH_RECEIPT', 'CLEAN_INSTALL_REPORT')
       AND artifact.created_at < clock_timestamp() - make_interval(days => p_retention_days)
       AND NOT EXISTS (
         SELECT 1 FROM deviludo.artifact_inputs input
         JOIN deviludo.jobs job ON job.workspace_id = input.workspace_id AND job.id = input.job_id
          WHERE input.workspace_id = artifact.workspace_id AND input.artifact_id = artifact.id
            AND job.state IN ('QUEUED', 'RUNNING', 'RETRY')
       )
     ORDER BY artifact.created_at, artifact.id
     FOR UPDATE SKIP LOCKED LIMIT p_limit
  ), queued AS (
    INSERT INTO deviludo.object_cleanup_queue(workspace_id, bucket, object_key, reason)
    SELECT workspace_id, bucket, object_key, 'artifact retention expired' FROM candidate
    ON CONFLICT (workspace_id, bucket, object_key) DO NOTHING
  )
  UPDATE deviludo.artifacts artifact SET state = 'DELETING'
    FROM candidate
   WHERE artifact.workspace_id = candidate.workspace_id AND artifact.id = candidate.id;
  GET DIAGNOSTICS enqueued = ROW_COUNT;
  RETURN enqueued;
END
$$;
ALTER FUNCTION deviludo.enqueue_expired_artifacts(integer, integer) OWNER TO deviludo_claim_executor;
REVOKE ALL ON FUNCTION deviludo.enqueue_expired_artifacts(integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION deviludo.enqueue_expired_artifacts(integer, integer) TO deviludo_scheduler;

UPDATE deviludo.schema_metadata
   SET current_version = '065_artifact_retention', applied_at = clock_timestamp()
 WHERE singleton = true;

COMMIT;
