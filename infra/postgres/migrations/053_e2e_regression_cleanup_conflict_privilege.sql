BEGIN;

-- complete_job is SECURITY INVOKER and queues a replaced regression artifact
-- with ON CONFLICT DO NOTHING. PostgreSQL checks SELECT privileges for the
-- conflict key, even when no conflicting row exists. Grant only those columns
-- so successful E2E settlement can remain least-privileged.
GRANT SELECT (workspace_id, bucket, object_key)
  ON deviludo.object_cleanup_queue TO deviludo_api, deviludo_sandbox;

COMMIT;
