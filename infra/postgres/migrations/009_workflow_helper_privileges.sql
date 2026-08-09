-- Existing databases created before the delivery helpers were added received
-- these functions through migration 003. Migration 004 then removed PostgreSQL's
-- default PUBLIC EXECUTE, but the service-role grants only existed in the fresh
-- baseline. Restore the same least-privilege grants for upgraded databases.
GRANT EXECUTE ON FUNCTION deviludo.delivery_stages(deviludo.workflow_profile) TO
  deviludo_api, deviludo_scheduler, deviludo_sandbox;

GRANT EXECUTE ON FUNCTION deviludo.stage_running_state(deviludo.job_kind) TO
  deviludo_api, deviludo_scheduler, deviludo_sandbox;
