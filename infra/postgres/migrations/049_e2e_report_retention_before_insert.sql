BEGIN;

-- BEFORE ROW triggers observe preceding rows from the same multi-row INSERT but
-- not later rows. That makes the retention order deterministic: each incoming
-- report replaces the previous one, and the final input row remains current.
DROP TRIGGER IF EXISTS artifacts_retain_latest_e2e_report ON deviludo.artifacts;
CREATE TRIGGER artifacts_retain_latest_e2e_report
BEFORE INSERT ON deviludo.artifacts
FOR EACH ROW WHEN (NEW.kind = 'E2E_REPORT')
EXECUTE FUNCTION deviludo.retain_latest_e2e_report();

COMMIT;
