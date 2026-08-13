BEGIN;

-- Automatic E2E repair attempts are a budget for one generated source cycle,
-- not a lifetime budget for the workflow. A manual Agent-stage rerun produces a
-- new source baseline and must therefore make three automatic repairs available
-- again. Patch the existing function in place so upgrades keep the full current
-- completion contract without duplicating that large function here.
DO $migration$
DECLARE
  target regprocedure :=
    'deviludo.complete_job(uuid,uuid,bigint,bigint,jsonb,jsonb,text,text,text)'::regprocedure;
  definition text;
  old_count text := $old$
    SELECT count(*)::integer INTO repair_count
      FROM deviludo.jobs previous_repair
     WHERE previous_repair.workspace_id = job.workspace_id
       AND previous_repair.workflow_id = job.workflow_id
       AND previous_repair.kind = 'AGENT_GENERATION'
       AND previous_repair.payload ? 'repairFromE2eJobId';$old$;
  new_count text := $new$
    SELECT count(*)::integer INTO repair_count
      FROM deviludo.jobs previous_repair
     WHERE previous_repair.workspace_id = job.workspace_id
       AND previous_repair.workflow_id = job.workflow_id
       AND previous_repair.kind = 'AGENT_GENERATION'
       AND previous_repair.payload ? 'repairFromE2eJobId'
       AND previous_repair.created_at > coalesce((
         SELECT max(manual_agent.created_at)
           FROM deviludo.jobs manual_agent
          WHERE manual_agent.workspace_id = job.workspace_id
            AND manual_agent.workflow_id = job.workflow_id
            AND manual_agent.kind = 'AGENT_GENERATION'
            AND NOT (manual_agent.payload ? 'repairFromE2eJobId')
       ), '-infinity'::timestamptz);$new$;
BEGIN
  SELECT pg_get_functiondef(target) INTO definition;
  IF position(new_count IN definition) > 0 THEN
    RETURN;
  END IF;
  IF position(old_count IN definition) = 0 THEN
    RAISE EXCEPTION 'complete_job repair counter no longer matches the expected contract';
  END IF;
  EXECUTE replace(definition, old_count, new_count);
END
$migration$;

COMMIT;
