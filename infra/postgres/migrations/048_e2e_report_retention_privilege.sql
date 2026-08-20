BEGIN;

-- 047 initially assigned the trigger to the cross-workspace claim role. Keep
-- deletion authority inside the trigger without granting that role table-wide
-- DELETE: trigger functions cannot be called as ordinary SQL functions, PUBLIC
-- has no execute privilege, and the table owner already owns the affected rows.
ALTER FUNCTION deviludo.retain_latest_e2e_report() OWNER TO CURRENT_USER;
REVOKE ALL ON FUNCTION deviludo.retain_latest_e2e_report() FROM PUBLIC;

COMMIT;
