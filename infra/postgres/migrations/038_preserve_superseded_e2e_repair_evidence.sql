BEGIN;

-- A stage rerun supersedes the old E2E job and changes its mutable state/error,
-- while its signed execution receipt and evidence artifact remain immutable.
-- Select repair evidence from that receipt so a later manual rerun cannot lose
-- the product failure merely because an intervening rerun was cancelled.
DO $migration$
DECLARE
  target regprocedure :=
    'deviludo.accept_workflow_signal(uuid,text,text,jsonb)'::regprocedure;
  definition text;
  old_predicate text := $old$         AND failed_job.state = 'FAILED'
         AND failed_job.last_error LIKE 'E2E_PRODUCT:%'$old$;
  new_predicate text := $new$         AND failed_job.receipt #>> '{execution,outcome}' = 'FAILED'
         AND failed_job.receipt #>> '{execution,failureDomain}' = 'PRODUCT'$new$;
BEGIN
  SELECT pg_get_functiondef(target) INTO definition;
  IF position(new_predicate IN definition) > 0 THEN
    RETURN;
  END IF;
  IF position(old_predicate IN definition) = 0 THEN
    RAISE EXCEPTION 'accept_workflow_signal no longer matches the expected E2E evidence predicate';
  END IF;
  EXECUTE replace(definition, old_predicate, new_predicate);
END
$migration$;

COMMIT;
