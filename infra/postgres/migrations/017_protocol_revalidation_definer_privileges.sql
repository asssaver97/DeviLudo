-- schedule_e2e_protocol_revalidation is SECURITY DEFINER and owned by
-- deviludo_claim_executor. It invokes accept_workflow_signal as that owner, so
-- the owner must be able to route the signal itself instead of relying on the
-- scheduler caller's privileges.

BEGIN;

GRANT INSERT ON deviludo.external_signals TO deviludo_claim_executor;
GRANT EXECUTE ON FUNCTION deviludo.delivery_stages(deviludo.workflow_profile)
  TO deviludo_claim_executor;
GRANT EXECUTE ON FUNCTION deviludo.stage_running_state(deviludo.job_kind)
  TO deviludo_claim_executor;

COMMIT;
