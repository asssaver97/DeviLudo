BEGIN;

-- RELEASE_DECISION_PENDING has no running executor lease. It is therefore a
-- valid rerun origin, just like a terminal workflow, and must not be forced
-- through cancellation before a build can be recreated with newly generated
-- assets.
DO $migration$
DECLARE
  target regprocedure :=
    'deviludo.accept_workflow_signal(uuid,text,text,jsonb)'::regprocedure;
  definition text;
  old_guard text := $old$IF workflow.state NOT IN ('FAILED', 'SUCCEEDED', 'CANCELLED') THEN$old$;
  new_guard text := $new$IF workflow.state NOT IN ('RELEASE_DECISION_PENDING', 'FAILED', 'SUCCEEDED', 'CANCELLED') THEN$new$;
BEGIN
  SELECT pg_get_functiondef(target) INTO definition;
  IF position(new_guard IN definition) = 0 THEN
    IF position(old_guard IN definition) = 0 THEN
      RAISE EXCEPTION 'accept_workflow_signal no longer matches the expected rerun state guard';
    END IF;
    EXECUTE replace(definition, old_guard, new_guard);
  END IF;
END
$migration$;

CREATE OR REPLACE FUNCTION deviludo.request_stage_rerun(
  p_workflow_id uuid,
  p_idempotency_key text,
  p_payload jsonb
)
RETURNS boolean
LANGUAGE sql
SECURITY INVOKER
SET search_path = pg_catalog, deviludo
AS $$
  SELECT deviludo.accept_workflow_signal(
    p_workflow_id, 'STAGE_RERUN_REQUESTED', p_idempotency_key, p_payload
  )
$$;

REVOKE ALL ON FUNCTION deviludo.request_stage_rerun(uuid, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION deviludo.request_stage_rerun(uuid, text, jsonb) TO deviludo_api;

COMMIT;
