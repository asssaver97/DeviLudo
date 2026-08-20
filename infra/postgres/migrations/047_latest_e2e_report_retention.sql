BEGIN;

-- A complete E2E evidence package is one ZIP containing its report, videos,
-- screenshots, logs, and traces. Keep one package for each immutable workflow
-- iteration and target platform. The trigger applies the rule to every future
-- rerun before complete_job advances the workflow or schedules a repair.
CREATE OR REPLACE FUNCTION deviludo.retain_latest_e2e_report()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, deviludo
SET row_security = off
AS $$
BEGIN
  INSERT INTO deviludo.object_cleanup_queue(workspace_id, bucket, object_key, reason)
  SELECT artifact.workspace_id, artifact.bucket, artifact.object_key,
         'superseded E2E report'
    FROM deviludo.artifacts artifact
   WHERE artifact.workspace_id = NEW.workspace_id
     AND artifact.workflow_id = NEW.workflow_id
     AND artifact.kind = 'E2E_REPORT'
     AND artifact.target_platform IS NOT DISTINCT FROM NEW.target_platform
     AND artifact.id <> NEW.id
     AND (artifact.bucket, artifact.object_key) IS DISTINCT FROM (NEW.bucket, NEW.object_key)
  ON CONFLICT (workspace_id, bucket, object_key) DO NOTHING;

  DELETE FROM deviludo.artifact_inputs input
   USING deviludo.artifacts artifact
   WHERE artifact.workspace_id = NEW.workspace_id
     AND artifact.workflow_id = NEW.workflow_id
     AND artifact.kind = 'E2E_REPORT'
     AND artifact.target_platform IS NOT DISTINCT FROM NEW.target_platform
     AND artifact.id <> NEW.id
     AND input.workspace_id = artifact.workspace_id
     AND input.artifact_id = artifact.id;
  DELETE FROM deviludo.artifacts artifact
   WHERE artifact.workspace_id = NEW.workspace_id
     AND artifact.workflow_id = NEW.workflow_id
     AND artifact.kind = 'E2E_REPORT'
     AND artifact.target_platform IS NOT DISTINCT FROM NEW.target_platform
     AND artifact.id <> NEW.id;
  RETURN NEW;
END
$$;
ALTER FUNCTION deviludo.retain_latest_e2e_report()
  OWNER TO deviludo_claim_executor;
REVOKE ALL ON FUNCTION deviludo.retain_latest_e2e_report() FROM PUBLIC;

DROP TRIGGER IF EXISTS artifacts_retain_latest_e2e_report ON deviludo.artifacts;
CREATE TRIGGER artifacts_retain_latest_e2e_report
AFTER INSERT ON deviludo.artifacts
FOR EACH ROW WHEN (NEW.kind = 'E2E_REPORT')
EXECUTE FUNCTION deviludo.retain_latest_e2e_report();

-- Apply the same retention rule to reports created before this release. The
-- newest record is stable by timestamp and UUID. Database references are
-- removed now; the scheduler deletes queued object-store ZIPs after deployment.
WITH ranked AS MATERIALIZED (
  SELECT artifact.*,
         row_number() OVER (
           PARTITION BY workspace_id, workflow_id, target_platform
           ORDER BY created_at DESC, id DESC
         ) AS retention_rank
    FROM deviludo.artifacts artifact
   WHERE artifact.kind = 'E2E_REPORT'
), expired AS MATERIALIZED (
  SELECT old.*
    FROM ranked old
   WHERE old.retention_rank > 1
     AND NOT EXISTS (
       SELECT 1 FROM ranked current
        WHERE current.retention_rank = 1
          AND current.workspace_id = old.workspace_id
          AND current.workflow_id = old.workflow_id
          AND current.target_platform IS NOT DISTINCT FROM old.target_platform
          AND current.bucket = old.bucket
          AND current.object_key = old.object_key
     )
)
INSERT INTO deviludo.object_cleanup_queue(workspace_id, bucket, object_key, reason)
SELECT workspace_id, bucket, object_key, 'superseded E2E report'
  FROM expired
ON CONFLICT (workspace_id, bucket, object_key) DO NOTHING;

WITH ranked AS MATERIALIZED (
  SELECT artifact.id, artifact.workspace_id,
         row_number() OVER (
           PARTITION BY workspace_id, workflow_id, target_platform
           ORDER BY created_at DESC, id DESC
         ) AS retention_rank
    FROM deviludo.artifacts artifact
   WHERE artifact.kind = 'E2E_REPORT'
), expired AS MATERIALIZED (
  SELECT id, workspace_id FROM ranked WHERE retention_rank > 1
)
DELETE FROM deviludo.artifact_inputs input
USING expired
WHERE input.workspace_id = expired.workspace_id
  AND input.artifact_id = expired.id;

WITH ranked AS MATERIALIZED (
  SELECT artifact.id, artifact.workspace_id,
         row_number() OVER (
           PARTITION BY workspace_id, workflow_id, target_platform
           ORDER BY created_at DESC, id DESC
         ) AS retention_rank
    FROM deviludo.artifacts artifact
   WHERE artifact.kind = 'E2E_REPORT'
), expired AS MATERIALIZED (
  SELECT id, workspace_id FROM ranked WHERE retention_rank > 1
)
DELETE FROM deviludo.artifacts artifact
USING expired
WHERE artifact.workspace_id = expired.workspace_id
  AND artifact.id = expired.id;

COMMIT;
