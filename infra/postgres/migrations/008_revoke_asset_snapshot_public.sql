-- PostgreSQL grants PUBLIC EXECUTE on newly created functions by default. The
-- snapshot trigger runs through the jobs table and needs no direct caller.
REVOKE ALL ON FUNCTION deviludo.snapshot_artifact_build_assets() FROM PUBLIC;
