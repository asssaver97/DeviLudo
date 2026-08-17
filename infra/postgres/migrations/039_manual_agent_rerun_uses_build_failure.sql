BEGIN;

-- Manual Agent reruns use the newest trusted product diagnostic. E2E failures
-- retain their evidence ZIP; controlled Builder failures retain a bounded error
-- summary so parse/import/export defects are repaired instead of blindly retried.
DO $migration$
DECLARE
  target regprocedure :=
    'deviludo.accept_workflow_signal(uuid,text,text,jsonb)'::regprocedure;
  definition text;
  old_declaration text := $old$  repair_e2e_job_id uuid;
  repair_e2e_platform deviludo.server_os;$old$;
  new_declaration text := $new$  repair_e2e_job_id uuid;
  repair_e2e_platform deviludo.server_os;
  repair_e2e_updated_at timestamptz;
  repair_build_job_id uuid;
  repair_build_summary text;
  repair_build_updated_at timestamptz;$new$;
  old_selection text := $old$      SELECT failed_job.id, failed_job.target_operating_system
        INTO repair_e2e_job_id, repair_e2e_platform
        FROM deviludo.jobs failed_job
       WHERE failed_job.workspace_id = workflow.workspace_id
         AND failed_job.workflow_id = workflow.id
         AND failed_job.kind = 'E2E_TEST'
         AND failed_job.receipt #>> '{execution,outcome}' = 'FAILED'
         AND failed_job.receipt #>> '{execution,failureDomain}' = 'PRODUCT'
         AND EXISTS (
           SELECT 1
             FROM deviludo.artifacts evidence
            WHERE evidence.workspace_id = failed_job.workspace_id
              AND evidence.producing_job_id = failed_job.id
              AND evidence.kind = 'E2E_REPORT'
         )
       ORDER BY failed_job.updated_at DESC, failed_job.created_at DESC, failed_job.id DESC
       LIMIT 1;$old$;
  new_selection text := $new$      SELECT failed_job.id, failed_job.target_operating_system, failed_job.updated_at
        INTO repair_e2e_job_id, repair_e2e_platform, repair_e2e_updated_at
        FROM deviludo.jobs failed_job
       WHERE failed_job.workspace_id = workflow.workspace_id
         AND failed_job.workflow_id = workflow.id
         AND failed_job.kind = 'E2E_TEST'
         AND failed_job.receipt #>> '{execution,outcome}' = 'FAILED'
         AND failed_job.receipt #>> '{execution,failureDomain}' = 'PRODUCT'
         AND EXISTS (
           SELECT 1
             FROM deviludo.artifacts evidence
            WHERE evidence.workspace_id = failed_job.workspace_id
              AND evidence.producing_job_id = failed_job.id
              AND evidence.kind = 'E2E_REPORT'
         )
       ORDER BY failed_job.updated_at DESC, failed_job.created_at DESC, failed_job.id DESC
       LIMIT 1;
      SELECT failed_job.id, left(failed_job.last_error, 1800), failed_job.updated_at
        INTO repair_build_job_id, repair_build_summary, repair_build_updated_at
        FROM deviludo.jobs failed_job
       WHERE failed_job.workspace_id = workflow.workspace_id
         AND failed_job.workflow_id = workflow.id
         AND failed_job.kind = 'ARTIFACT_BUILD'
         AND failed_job.state = 'FAILED'
         AND length(coalesce(failed_job.last_error, '')) > 0
       ORDER BY failed_job.updated_at DESC, failed_job.created_at DESC, failed_job.id DESC
       LIMIT 1;
      IF repair_build_updated_at > coalesce(repair_e2e_updated_at, '-infinity'::timestamptz) THEN
        repair_e2e_job_id := NULL;
      ELSE
        repair_build_job_id := NULL;
      END IF;$new$;
  old_payload text := $old$        ) || CASE WHEN repair_e2e_job_id IS NULL THEN '{}'::jsonb ELSE jsonb_build_object(
          'repairFromE2eJobId', repair_e2e_job_id,
          'failedPlatform', repair_e2e_platform
        ) END
      );$old$;
  new_payload text := $new$        ) || CASE WHEN repair_e2e_job_id IS NOT NULL THEN jsonb_build_object(
          'repairFromE2eJobId', repair_e2e_job_id,
          'failedPlatform', repair_e2e_platform
        ) WHEN repair_build_job_id IS NOT NULL THEN jsonb_build_object(
          'repairFailureJobId', repair_build_job_id,
          'repairFailureKind', 'ARTIFACT_BUILD',
          'repairFailureSummary', repair_build_summary
        ) ELSE '{}'::jsonb END
      );$new$;
BEGIN
  SELECT pg_get_functiondef(target) INTO definition;
  IF position(new_declaration IN definition) > 0 THEN
    RETURN;
  END IF;
  IF position(old_declaration IN definition) = 0
    OR position(old_selection IN definition) = 0
    OR position(old_payload IN definition) = 0
  THEN
    RAISE EXCEPTION 'accept_workflow_signal no longer matches the expected manual repair contract';
  END IF;
  definition := replace(definition, old_declaration, new_declaration);
  definition := replace(definition, old_selection, new_selection);
  definition := replace(definition, old_payload, new_payload);
  EXECUTE definition;
END
$migration$;

COMMIT;
