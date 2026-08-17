BEGIN;

-- Build completion resolves the currently managed E2E regression trace from
-- complete_job(). That function is SECURITY INVOKER, so the executor roles
-- need the same narrow read capability as the scheduler.
GRANT SELECT ON deviludo.e2e_regression_traces
  TO deviludo_scheduler, deviludo_sandbox, deviludo_claim_executor;

COMMIT;
