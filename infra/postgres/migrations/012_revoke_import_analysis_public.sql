-- Migration 010 creates this SECURITY DEFINER function after the baseline's
-- blanket function revoke. PostgreSQL grants PUBLIC EXECUTE on newly-created
-- functions, so upgraded databases need the same fail-closed privilege set as
-- fresh databases.
REVOKE ALL ON FUNCTION deviludo.claim_project_import_analysis(integer) FROM PUBLIC;

