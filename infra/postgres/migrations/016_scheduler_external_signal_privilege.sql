-- The scheduler calls the protocol revalidation routine, but that routine is a
-- SECURITY DEFINER function owned by deviludo_claim_executor. The caller needs
-- the ordinary table privileges used by repository queries, while the function
-- owner needs SELECT for its idempotency predicate. Missing the latter causes
-- every scheduler tick to fail before later work such as local Git commits.

BEGIN;

GRANT SELECT, INSERT, UPDATE ON deviludo.external_signals TO deviludo_scheduler;
GRANT SELECT ON deviludo.external_signals TO deviludo_claim_executor;

COMMIT;
