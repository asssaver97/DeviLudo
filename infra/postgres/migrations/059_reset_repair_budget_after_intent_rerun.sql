BEGIN;

-- A confirmed conversation change enqueues a normal Agent generation rather
-- than the legacy `manualRerun` repair shape. Treat that new source cycle as a
-- repair-budget boundary for both E2E and Builder product diagnostics.
DO $migration$
DECLARE
  complete_target regprocedure :=
    'deviludo.complete_job(uuid,uuid,bigint,bigint,jsonb,jsonb,text,text,text)'::regprocedure;
  fail_target regprocedure :=
    'deviludo.fail_job(uuid,uuid,bigint,text)'::regprocedure;
  definition text;
  old_e2e_anchor text := $old$
            AND manual_agent.payload->>'manualRerun' = 'true'$old$;
  new_e2e_anchor text := $new$
            AND (
              manual_agent.payload->>'manualRerun' = 'true'
              OR NOT (manual_agent.payload ? 'repairFromE2eJobId')
            )$new$;
  old_build_anchor text := $old$
              AND manual_agent.payload->>'manualRerun' = 'true'$old$;
  new_build_anchor text := $new$
              AND (
                manual_agent.payload->>'manualRerun' = 'true'
                OR (
                  NOT (manual_agent.payload ? 'repairFromE2eJobId')
                  AND NOT (manual_agent.payload ? 'repairFailureKind')
                )
              )$new$;
BEGIN
  SELECT pg_get_functiondef(complete_target) INTO definition;
  IF position(new_e2e_anchor IN definition) = 0 THEN
    IF position(old_e2e_anchor IN definition) = 0 THEN
      RAISE EXCEPTION 'complete_job repair budget anchor no longer matches the expected contract';
    END IF;
    EXECUTE replace(definition, old_e2e_anchor, new_e2e_anchor);
  END IF;

  SELECT pg_get_functiondef(fail_target) INTO definition;
  IF position(new_build_anchor IN definition) = 0 THEN
    IF position(old_build_anchor IN definition) = 0 THEN
      RAISE EXCEPTION 'fail_job repair budget anchor no longer matches the expected contract';
    END IF;
    EXECUTE replace(definition, old_build_anchor, new_build_anchor);
  END IF;
END
$migration$;

COMMIT;
