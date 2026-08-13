BEGIN;

-- PostgreSQL grants PUBLIC execute on newly created routines by default. Close
-- that default for routines introduced by pending release migrations; explicit
-- service-role grants remain intact.
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA deviludo FROM PUBLIC;

COMMIT;
