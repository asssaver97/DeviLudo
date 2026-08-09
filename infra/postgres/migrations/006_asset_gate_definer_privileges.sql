-- advance_asset_workflows locks and updates the selected workflow row. SELECT
-- alone is insufficient for SELECT ... FOR UPDATE under the definer role.
GRANT UPDATE ON deviludo.workflow_instances TO deviludo_claim_executor;
