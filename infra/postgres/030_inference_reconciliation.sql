BEGIN;

-- SecurityAdmin reconciliation is the only supported escape hatch for an
-- ambiguous upstream dispatch. The operation key and canonical payload digest
-- make a retry safe while preventing an administrator from changing the
-- declared outcome after the first commit.
ALTER TABLE deviludo.inference_request_claims
  ADD COLUMN reconciliation_operation_key text,
  ADD COLUMN reconciliation_payload_digest text,
  ADD COLUMN reconciliation_action text,
  ADD COLUMN reconciliation_evidence_digest text,
  ADD COLUMN reconciled_by text,
  ADD COLUMN reconciled_at timestamptz,
  ADD CONSTRAINT inference_reconciliation_shape CHECK (
    (reconciliation_operation_key IS NULL
      AND reconciliation_payload_digest IS NULL
      AND reconciliation_action IS NULL
      AND reconciliation_evidence_digest IS NULL
      AND reconciled_by IS NULL
      AND reconciled_at IS NULL)
    OR
    (reconciliation_operation_key ~ '^[a-f0-9]{64}$'
      AND reconciliation_payload_digest ~ '^[a-f0-9]{64}$'
      AND reconciliation_action IN ('CONFIRM_NO_USAGE', 'RECORD_USAGE')
      AND reconciliation_evidence_digest ~ '^[a-f0-9]{64}$'
      AND reconciled_by ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,159}$'
      AND reconciled_at IS NOT NULL
      AND ((reconciliation_action = 'CONFIRM_NO_USAGE' AND state = 'RELEASED')
        OR (reconciliation_action = 'RECORD_USAGE' AND state = 'COMPLETED')))
  );

-- Migration 029 used one partial index per unresolved state. Replace both with
-- one invariant so an ACTIVE and an INDETERMINATE claim cannot coexist for the
-- same run even if a writer bypasses the Gateway service transaction.
DROP INDEX deviludo.inference_one_active_request_per_run;
DROP INDEX deviludo.inference_one_indeterminate_request_per_run;
CREATE UNIQUE INDEX inference_one_unresolved_request_per_run
  ON deviludo.inference_request_claims (tenant_id, run_id)
  WHERE state IN ('ACTIVE', 'INDETERMINATE');

CREATE UNIQUE INDEX inference_reconciliation_operation_key_unique
  ON deviludo.inference_request_claims (reconciliation_operation_key)
  WHERE reconciliation_operation_key IS NOT NULL;

CREATE OR REPLACE FUNCTION deviludo.protect_inference_request_claim()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.request_id, NEW.tenant_id, NEW.project_id, NEW.run_id,
         NEW.provider_revision_id, NEW.credential_version_id, NEW.model,
         NEW.claim_token, NEW.claim_expires_at, NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.request_id, OLD.tenant_id, OLD.project_id, OLD.run_id,
         OLD.provider_revision_id, OLD.credential_version_id, OLD.model,
         OLD.claim_token, OLD.claim_expires_at, OLD.created_at) THEN
    RAISE EXCEPTION 'inference request claim binding is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.state IN ('COMPLETED', 'RELEASED') AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'terminal inference request claim is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.state = 'INDETERMINATE' AND NEW.state NOT IN ('INDETERMINATE', 'COMPLETED', 'RELEASED') THEN
    RAISE EXCEPTION 'invalid inference reconciliation transition' USING ERRCODE = '55000';
  END IF;
  IF OLD.state = 'ACTIVE' AND NEW.state NOT IN ('ACTIVE', 'COMPLETED', 'RELEASED', 'INDETERMINATE') THEN
    RAISE EXCEPTION 'invalid inference request transition' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER inference_request_claim_immutable
BEFORE UPDATE ON deviludo.inference_request_claims
FOR EACH ROW EXECUTE FUNCTION deviludo.protect_inference_request_claim();

COMMIT;
