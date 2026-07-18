BEGIN;

-- User acceptance is an immutable business decision, distinct from the
-- retryable Temporal delivery of USER_ACCEPTED. Candidate/evidence bindings
-- are resolved on the server and retained for the later signed SCM proof.
CREATE TABLE deviludo.user_candidate_acceptances (
  operation_key text PRIMARY KEY CHECK (operation_key ~ '^[a-f0-9]{64}$'),
  tenant_id uuid NOT NULL REFERENCES deviludo.tenants(id),
  project_id uuid NOT NULL REFERENCES deviludo.projects(id),
  actor_id text NOT NULL CHECK (actor_id ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,159}$'),
  request_digest text NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  workflow_id text NOT NULL CHECK (length(workflow_id) BETWEEN 1 AND 512),
  action_id uuid NOT NULL,
  spec_revision_id uuid NOT NULL,
  candidate_receipt_id uuid NOT NULL,
  candidate_commit_sha text NOT NULL CHECK (candidate_commit_sha ~ '^[a-f0-9]{40}$'),
  draft_pull_request bigint NOT NULL CHECK (draft_pull_request > 0),
  evidence_bundle_id uuid NOT NULL,
  signal_id text NOT NULL CHECK (
    length(signal_id) BETWEEN 8 AND 200
      AND signal_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]+$'
  ),
  state text NOT NULL CHECK (state IN ('PENDING_DELIVERY', 'COMPLETED')),
  completion_receipt jsonb,
  accepted_at timestamptz NOT NULL,
  completed_at timestamptz,
  UNIQUE (tenant_id, project_id, workflow_id, action_id),
  UNIQUE (tenant_id, signal_id),
  FOREIGN KEY (tenant_id, project_id, workflow_id, action_id)
    REFERENCES deviludo.workflow_control_actions(tenant_id, project_id, workflow_id, id),
  FOREIGN KEY (tenant_id, project_id, spec_revision_id)
    REFERENCES deviludo.immutable_revisions(tenant_id, project_id, id),
  FOREIGN KEY (tenant_id, project_id, candidate_receipt_id)
    REFERENCES deviludo.github_candidate_receipts(tenant_id, project_id, id),
  FOREIGN KEY (tenant_id, project_id, evidence_bundle_id)
    REFERENCES deviludo.evidence_bundles(tenant_id, project_id, id),
  CHECK (
    (state = 'PENDING_DELIVERY' AND completion_receipt IS NULL AND completed_at IS NULL)
    OR
    (state = 'COMPLETED' AND jsonb_typeof(completion_receipt) = 'object'
      AND completed_at IS NOT NULL)
  ),
  CHECK (pg_column_size(completion_receipt) <= 65536)
);

CREATE OR REPLACE FUNCTION deviludo.protect_user_candidate_acceptance()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.operation_key, NEW.tenant_id, NEW.project_id, NEW.actor_id,
         NEW.request_digest, NEW.workflow_id, NEW.action_id,
         NEW.spec_revision_id, NEW.candidate_receipt_id,
         NEW.candidate_commit_sha, NEW.draft_pull_request,
         NEW.evidence_bundle_id, NEW.signal_id, NEW.accepted_at)
     IS DISTINCT FROM
     ROW(OLD.operation_key, OLD.tenant_id, OLD.project_id, OLD.actor_id,
         OLD.request_digest, OLD.workflow_id, OLD.action_id,
         OLD.spec_revision_id, OLD.candidate_receipt_id,
         OLD.candidate_commit_sha, OLD.draft_pull_request,
         OLD.evidence_bundle_id, OLD.signal_id, OLD.accepted_at)
     OR OLD.state = 'COMPLETED'
     OR NEW.state <> 'COMPLETED' THEN
    RAISE EXCEPTION 'user candidate acceptance is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER user_candidate_acceptance_guard
BEFORE UPDATE ON deviludo.user_candidate_acceptances
FOR EACH ROW EXECUTE FUNCTION deviludo.protect_user_candidate_acceptance();
CREATE TRIGGER user_candidate_acceptance_no_delete
BEFORE DELETE ON deviludo.user_candidate_acceptances
FOR EACH ROW EXECUTE FUNCTION deviludo.reject_mutation();

ALTER TABLE deviludo.user_candidate_acceptances ENABLE ROW LEVEL SECURITY;
ALTER TABLE deviludo.user_candidate_acceptances FORCE ROW LEVEL SECURITY;
CREATE POLICY user_candidate_acceptances_tenant_isolation
  ON deviludo.user_candidate_acceptances
  USING (tenant_id = deviludo.current_tenant_id())
  WITH CHECK (tenant_id = deviludo.current_tenant_id());

COMMIT;
