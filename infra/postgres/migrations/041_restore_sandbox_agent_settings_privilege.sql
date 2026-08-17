BEGIN;

-- Agent completion is executed as deviludo_sandbox through the SECURITY INVOKER
-- complete_job function. The transaction reads the selected connection to decide
-- whether an asset manifest should enter automatic image generation. Keep the
-- permission table-specific and read-only.
GRANT SELECT ON deviludo.instance_agent_settings
  TO deviludo_scheduler, deviludo_sandbox, deviludo_claim_executor;

COMMIT;
