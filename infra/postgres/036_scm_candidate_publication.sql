BEGIN;

-- Candidate receipts are tenant/project authorities. Replace global-only FKs
-- and attempt uniqueness with composite bindings used by the mTLS SCM Broker.
ALTER TABLE deviludo.github_candidate_receipts
  DROP CONSTRAINT github_candidate_receipts_run_id_fkey,
  DROP CONSTRAINT github_candidate_receipts_spec_revision_id_fkey,
  DROP CONSTRAINT github_candidate_receipts_repository_binding_id_fkey,
  DROP CONSTRAINT github_candidate_receipts_attempt_id_key,
  ADD CONSTRAINT github_candidate_receipt_run_fk
    FOREIGN KEY (tenant_id, project_id, run_id)
    REFERENCES deviludo.agent_runs(tenant_id, project_id, id),
  ADD CONSTRAINT github_candidate_receipt_spec_fk
    FOREIGN KEY (tenant_id, project_id, spec_revision_id)
    REFERENCES deviludo.immutable_revisions(tenant_id, project_id, id),
  ADD CONSTRAINT github_candidate_receipt_repository_fk
    FOREIGN KEY (tenant_id, project_id, repository_binding_id)
    REFERENCES deviludo.github_repository_bindings(tenant_id, project_id, id),
  ADD CONSTRAINT github_candidate_receipt_attempt_unique
    UNIQUE (tenant_id, attempt_id),
  ADD CONSTRAINT github_candidate_receipt_tenant_project_id_unique
    UNIQUE (tenant_id, project_id, id);

ALTER TABLE deviludo.scm_operation_claims
  ADD CONSTRAINT scm_operation_claim_completion_shape
    CHECK ((response IS NULL) = (completed_at IS NULL));

CREATE OR REPLACE FUNCTION deviludo.protect_scm_operation_claim()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.operation_key, NEW.tenant_id, NEW.project_id, NEW.operation,
         NEW.request_digest, NEW.authorized_at)
     IS DISTINCT FROM
     ROW(OLD.operation_key, OLD.tenant_id, OLD.project_id, OLD.operation,
         OLD.request_digest, OLD.authorized_at)
     OR OLD.response IS NOT NULL
     OR NEW.response IS NOT NULL
       AND NEW.claim_token IS DISTINCT FROM OLD.claim_token
     OR NEW.response IS NULL AND OLD.response IS NULL
       AND OLD.claim_expires_at > now()
       AND ROW(NEW.claim_token, NEW.claim_expires_at)
         IS DISTINCT FROM ROW(OLD.claim_token, OLD.claim_expires_at)
     OR NEW.response IS NOT NULL AND NEW.completed_at IS NULL THEN
    RAISE EXCEPTION 'SCM operation claim binding or transition is invalid' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER scm_operation_claim_guard
BEFORE UPDATE ON deviludo.scm_operation_claims
FOR EACH ROW EXECUTE FUNCTION deviludo.protect_scm_operation_claim();
CREATE TRIGGER scm_operation_claim_no_delete
BEFORE DELETE ON deviludo.scm_operation_claims
FOR EACH ROW EXECUTE FUNCTION deviludo.reject_mutation();

COMMIT;
