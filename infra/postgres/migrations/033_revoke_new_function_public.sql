BEGIN;

-- PostgreSQL grants EXECUTE on newly created functions to PUBLIC by default.
-- Several post-baseline functions were added after the baseline-wide revoke;
-- close that default grant without altering their explicit service-role grants.
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA deviludo FROM PUBLIC;

COMMIT;
