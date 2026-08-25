BEGIN;

CREATE TABLE deviludo.pending_object_uploads (
  workspace_id uuid NOT NULL,
  job_id uuid NOT NULL,
  bucket text NOT NULL CHECK (length(bucket) BETWEEN 3 AND 255),
  object_key text NOT NULL CHECK (object_key LIKE 'workspaces/' || workspace_id::text || '/%'),
  kind deviludo.artifact_kind NOT NULL,
  target_platform deviludo.server_os,
  sha256 text NOT NULL CHECK (sha256 ~ '^sha256:[0-9a-f]{64}$'),
  size_bytes bigint NOT NULL CHECK (size_bytes > 0),
  cleanup_after timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, bucket, object_key),
  FOREIGN KEY (workspace_id, job_id) REFERENCES deviludo.jobs(workspace_id, id) ON DELETE CASCADE
);
ALTER TABLE deviludo.pending_object_uploads ENABLE ROW LEVEL SECURITY;
ALTER TABLE deviludo.pending_object_uploads FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON deviludo.pending_object_uploads
  USING (workspace_id = deviludo.current_workspace_id())
  WITH CHECK (workspace_id = deviludo.current_workspace_id());

CREATE OR REPLACE FUNCTION deviludo.clear_pending_upload_on_artifact()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, deviludo AS $$
BEGIN
  DELETE FROM deviludo.pending_object_uploads
   WHERE workspace_id = NEW.workspace_id AND bucket = NEW.bucket AND object_key = NEW.object_key;
  RETURN NEW;
END
$$;
CREATE TRIGGER artifacts_clear_pending_upload
AFTER INSERT ON deviludo.artifacts
FOR EACH ROW EXECUTE FUNCTION deviludo.clear_pending_upload_on_artifact();
REVOKE ALL ON FUNCTION deviludo.clear_pending_upload_on_artifact() FROM PUBLIC;

CREATE OR REPLACE FUNCTION deviludo.reconcile_expired_uploads(p_limit integer)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, deviludo
SET row_security = off
AS $$
DECLARE enqueued integer;
BEGIN
  IF p_limit NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'invalid pending upload sweep'; END IF;
  WITH candidate AS (
    SELECT pending.workspace_id, pending.bucket, pending.object_key
      FROM deviludo.pending_object_uploads pending
      JOIN deviludo.jobs job ON job.workspace_id = pending.workspace_id AND job.id = pending.job_id
     WHERE pending.cleanup_after <= clock_timestamp()
       AND job.state IN ('SUCCEEDED', 'FAILED', 'CANCELLED')
       AND NOT EXISTS (
         SELECT 1 FROM deviludo.artifacts artifact
          WHERE artifact.workspace_id = pending.workspace_id
            AND artifact.bucket = pending.bucket AND artifact.object_key = pending.object_key
       )
     ORDER BY pending.cleanup_after, pending.created_at
     FOR UPDATE OF pending SKIP LOCKED LIMIT p_limit
  ), queued AS (
    INSERT INTO deviludo.object_cleanup_queue(workspace_id, bucket, object_key, reason)
    SELECT workspace_id, bucket, object_key, 'authorized upload did not become an artifact' FROM candidate
    ON CONFLICT (workspace_id, bucket, object_key) DO NOTHING
  ), removed AS (
    DELETE FROM deviludo.pending_object_uploads pending USING candidate
     WHERE pending.workspace_id = candidate.workspace_id AND pending.bucket = candidate.bucket
       AND pending.object_key = candidate.object_key
    RETURNING pending.workspace_id
  ) SELECT count(*)::integer INTO enqueued FROM removed;
  RETURN enqueued;
END
$$;
ALTER FUNCTION deviludo.reconcile_expired_uploads(integer) OWNER TO deviludo_claim_executor;
REVOKE ALL ON FUNCTION deviludo.reconcile_expired_uploads(integer) FROM PUBLIC;

GRANT SELECT, INSERT, UPDATE, DELETE ON deviludo.pending_object_uploads TO deviludo_api, deviludo_sandbox;
GRANT SELECT, INSERT, UPDATE, DELETE ON deviludo.pending_object_uploads TO deviludo_claim_executor;
GRANT EXECUTE ON FUNCTION deviludo.reconcile_expired_uploads(integer) TO deviludo_scheduler;

UPDATE deviludo.schema_metadata
   SET current_version = '066_pending_upload_cleanup', applied_at = clock_timestamp()
 WHERE singleton = true;

COMMIT;
