BEGIN;

-- New merge receipts retain the workflow job, user decision and exact evidence
-- that authorized the GitHub side effect. Existing pre-Beta rows remain
-- readable, but only fully bound rows can be created by the merge Broker.
ALTER TABLE deviludo.user_candidate_acceptances
  ADD CONSTRAINT user_candidate_acceptance_tenant_operation_unique
    UNIQUE (tenant_id, project_id, operation_key);

ALTER TABLE deviludo.github_merge_receipts
  DROP CONSTRAINT github_merge_receipts_candidate_receipt_id_fkey,
  ADD COLUMN acceptance_operation_key text,
  ADD COLUMN workflow_id text,
  ADD COLUMN run_id uuid,
  ADD COLUMN spec_revision_id uuid,
  ADD COLUMN evidence_bundle_id uuid,
  ADD COLUMN acceptance_signal_id text,
  ADD COLUMN workflow_request_digest char(64),
  ADD CONSTRAINT github_merge_receipt_candidate_tenant_fk
    FOREIGN KEY (tenant_id, project_id, candidate_receipt_id)
    REFERENCES deviludo.github_candidate_receipts(tenant_id, project_id, id),
  ADD CONSTRAINT github_merge_receipt_acceptance_fk
    FOREIGN KEY (tenant_id, project_id, acceptance_operation_key)
    REFERENCES deviludo.user_candidate_acceptances(tenant_id, project_id, operation_key),
  ADD CONSTRAINT github_merge_receipt_run_fk
    FOREIGN KEY (tenant_id, project_id, run_id)
    REFERENCES deviludo.agent_runs(tenant_id, project_id, id),
  ADD CONSTRAINT github_merge_receipt_spec_fk
    FOREIGN KEY (tenant_id, project_id, spec_revision_id)
    REFERENCES deviludo.immutable_revisions(tenant_id, project_id, id),
  ADD CONSTRAINT github_merge_receipt_evidence_fk
    FOREIGN KEY (tenant_id, project_id, evidence_bundle_id)
    REFERENCES deviludo.evidence_bundles(tenant_id, project_id, id),
  ADD CONSTRAINT github_merge_receipt_signal_unique
    UNIQUE (tenant_id, acceptance_signal_id),
  ADD CONSTRAINT github_merge_receipt_authority_shape CHECK (
    (acceptance_operation_key IS NULL AND workflow_id IS NULL AND run_id IS NULL
      AND spec_revision_id IS NULL AND evidence_bundle_id IS NULL
      AND acceptance_signal_id IS NULL AND workflow_request_digest IS NULL)
    OR
    (acceptance_operation_key ~ '^[a-f0-9]{64}$'
      AND length(workflow_id) BETWEEN 1 AND 512
      AND run_id IS NOT NULL AND spec_revision_id IS NOT NULL
      AND evidence_bundle_id IS NOT NULL
      AND length(acceptance_signal_id) BETWEEN 8 AND 200
      AND workflow_request_digest ~ '^[a-f0-9]{64}$'
      AND main_source_digest ~ '^[a-f0-9]{64}$')
  ) NOT VALID;

CREATE INDEX github_merge_receipt_workflow_idx
  ON deviludo.github_merge_receipts (tenant_id, project_id, workflow_id)
  WHERE workflow_id IS NOT NULL;

COMMIT;
