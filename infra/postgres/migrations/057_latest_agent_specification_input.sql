BEGIN;

-- Historical draft specifications remain useful project records, but a new or
-- repaired Agent run must consume exactly the newest approved draft. Selecting
-- every historical row makes enqueue_job reject a valid stage rerun because its
-- one-specification input contract is no longer satisfied.
DO $migration$
DECLARE
  definition text;
  patched text;
  old_condition constant text := $old$artifact.kind = 'SPECIFICATION' AND artifact.producing_job_id IS NULL$old$;
  latest_condition constant text := $new$artifact.kind = 'SPECIFICATION' AND artifact.producing_job_id IS NULL
             AND artifact.id = (
               SELECT latest_specification.id
                 FROM deviludo.artifacts latest_specification
                WHERE latest_specification.workspace_id = p_workspace_id
                  AND latest_specification.workflow_id = p_workflow_id
                  AND latest_specification.kind = 'SPECIFICATION'
                  AND latest_specification.producing_job_id IS NULL
                ORDER BY latest_specification.created_at DESC, latest_specification.id DESC
                LIMIT 1
             )$new$;
BEGIN
  SELECT pg_get_functiondef(
    'deviludo.enqueue_job(uuid,uuid,uuid,deviludo.job_kind,deviludo.server_os,text,jsonb)'::regprocedure
  ) INTO definition;
  IF position(latest_condition IN definition) = 0 THEN
    patched := replace(definition, old_condition, latest_condition);
    IF patched = definition THEN
      RAISE EXCEPTION 'enqueue_job specification input condition was not found';
    END IF;
    EXECUTE patched;
  END IF;
END
$migration$;

COMMIT;
