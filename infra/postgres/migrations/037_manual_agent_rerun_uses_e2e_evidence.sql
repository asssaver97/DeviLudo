BEGIN;

-- A user-triggered Agent rerun is the root of a new bounded repair cycle. When
-- the workflow has a verified product-level E2E failure, keep that evidence as
-- an input so the rerun fixes the observed game defect instead of resuming an
-- unrelated item from the project specification.
DO $migration$
DECLARE
  target regprocedure :=
    'deviludo.accept_workflow_signal(uuid,text,text,jsonb)'::regprocedure;
  definition text;
  old_declaration text := $old$  downstream_stages deviludo.job_kind[];$old$;
  new_declaration text := $new$  downstream_stages deviludo.job_kind[];
  repair_e2e_job_id uuid;
  repair_e2e_platform deviludo.server_os;$new$;
  old_agent_guard text := $old$      IF agent_settings.singleton IS NULL THEN
        RAISE EXCEPTION 'Agent configuration is required before rerunning agent generation';
      END IF;$old$;
  new_agent_guard text := $new$      IF agent_settings.singleton IS NULL THEN
        RAISE EXCEPTION 'Agent configuration is required before rerunning agent generation';
      END IF;
      SELECT failed_job.id, failed_job.target_operating_system
        INTO repair_e2e_job_id, repair_e2e_platform
        FROM deviludo.jobs failed_job
       WHERE failed_job.workspace_id = workflow.workspace_id
         AND failed_job.workflow_id = workflow.id
         AND failed_job.kind = 'E2E_TEST'
         AND failed_job.state = 'FAILED'
         AND failed_job.last_error LIKE 'E2E_PRODUCT:%'
         AND EXISTS (
           SELECT 1
             FROM deviludo.artifacts evidence
            WHERE evidence.workspace_id = failed_job.workspace_id
              AND evidence.producing_job_id = failed_job.id
              AND evidence.kind = 'E2E_REPORT'
         )
       ORDER BY failed_job.updated_at DESC, failed_job.created_at DESC, failed_job.id DESC
       LIMIT 1;$new$;
  old_payload_start text := $old$        workflow.id::text || ':rerun:agent:' || inserted_id::text,
        jsonb_build_object(
          'agentConfiguration',$old$;
  new_payload_start text := $new$        workflow.id::text || ':rerun:agent:' || inserted_id::text,
        jsonb_build_object(
          'manualRerun', true,
          'agentConfiguration',$new$;
  old_payload_end text := $old$            'revision', agent_settings.revision
          )
        )
      );
    ELSE$old$;
  new_payload_end text := $new$            'revision', agent_settings.revision
          )
        ) || CASE WHEN repair_e2e_job_id IS NULL THEN '{}'::jsonb ELSE jsonb_build_object(
          'repairFromE2eJobId', repair_e2e_job_id,
          'failedPlatform', repair_e2e_platform
        ) END
      );
    ELSE$new$;
BEGIN
  SELECT pg_get_functiondef(target) INTO definition;
  IF position(new_declaration IN definition) > 0 THEN
    RETURN;
  END IF;
  IF position(old_declaration IN definition) = 0
    OR position(old_agent_guard IN definition) = 0
    OR position(old_payload_start IN definition) = 0
    OR position(old_payload_end IN definition) = 0
  THEN
    RAISE EXCEPTION 'accept_workflow_signal no longer matches the expected rerun contract';
  END IF;
  definition := replace(definition, old_declaration, new_declaration);
  definition := replace(definition, old_agent_guard, new_agent_guard);
  definition := replace(definition, old_payload_start, new_payload_start);
  definition := replace(definition, old_payload_end, new_payload_end);
  EXECUTE definition;
END
$migration$;

-- Count only automatic repairs after the latest explicit Agent rerun. A manual
-- rerun may itself carry E2E evidence, so absence of repairFromE2eJobId is no
-- longer a valid way to identify the reset boundary.
DO $migration$
DECLARE
  target regprocedure :=
    'deviludo.complete_job(uuid,uuid,bigint,bigint,jsonb,jsonb,text,text,text)'::regprocedure;
  definition text;
  old_filter text := $old$       AND previous_repair.payload ? 'repairFromE2eJobId'
       AND previous_repair.created_at > coalesce(($old$;
  new_filter text := $new$       AND previous_repair.payload ? 'repairFromE2eJobId'
       AND previous_repair.payload->>'manualRerun' IS DISTINCT FROM 'true'
       AND previous_repair.created_at > coalesce(($new$;
  old_anchor text := $old$            AND manual_agent.kind = 'AGENT_GENERATION'
            AND NOT (manual_agent.payload ? 'repairFromE2eJobId')$old$;
  new_anchor text := $new$            AND manual_agent.kind = 'AGENT_GENERATION'
            AND manual_agent.payload->>'manualRerun' = 'true'$new$;
BEGIN
  SELECT pg_get_functiondef(target) INTO definition;
  IF position(new_filter IN definition) > 0 AND position(new_anchor IN definition) > 0 THEN
    RETURN;
  END IF;
  IF position(old_filter IN definition) = 0 OR position(old_anchor IN definition) = 0 THEN
    RAISE EXCEPTION 'complete_job no longer matches the expected repair-budget contract';
  END IF;
  definition := replace(definition, old_filter, new_filter);
  definition := replace(definition, old_anchor, new_anchor);
  EXECUTE definition;
END
$migration$;

COMMIT;
