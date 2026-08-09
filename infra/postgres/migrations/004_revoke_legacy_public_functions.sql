-- Functions introduced by legacy repair scripts were created after the original
-- baseline's global REVOKE and inherited PostgreSQL's default PUBLIC EXECUTE.
-- Revoke it once; explicit service-role grants remain intact.
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA deviludo FROM PUBLIC;
