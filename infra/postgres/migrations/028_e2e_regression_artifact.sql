-- PostgreSQL requires a newly added enum value to be committed before another
-- transaction can use it in functions, triggers, or row data.
ALTER TYPE deviludo.artifact_kind ADD VALUE IF NOT EXISTS 'E2E_REGRESSION' AFTER 'E2E_REPORT';

UPDATE deviludo.schema_metadata
   SET current_version = '028_e2e_regression_artifact', applied_at = clock_timestamp()
 WHERE singleton = true;
