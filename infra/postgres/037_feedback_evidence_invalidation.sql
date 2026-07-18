BEGIN;

-- A feedback signal is authoritative only when it names a new draft
-- GameSpecRevision and atomically tombstones the exact candidate evidence
-- that was shown to the user. The evidence object itself stays immutable;
-- invalidated_at is its one permitted lifecycle mutation.
CREATE TABLE deviludo.workflow_feedback_invalidations (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES deviludo.tenants(id),
  project_id uuid NOT NULL REFERENCES deviludo.projects(id),
  workflow_id text NOT NULL CHECK (length(workflow_id) BETWEEN 1 AND 512),
  action_id uuid NOT NULL,
  candidate_receipt_id uuid NOT NULL,
  evidence_bundle_id uuid NOT NULL,
  previous_spec_revision_id uuid NOT NULL,
  next_spec_revision_id uuid NOT NULL,
  source_receipt_id text NOT NULL CHECK (
    length(source_receipt_id) BETWEEN 3 AND 200
      AND source_receipt_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]+$'
  ),
  reason text NOT NULL CHECK (reason = 'USER_FEEDBACK'),
  receipt_digest text NOT NULL CHECK (receipt_digest ~ '^[a-f0-9]{64}$'),
  receipt jsonb NOT NULL CHECK (
    jsonb_typeof(receipt) = 'object' AND pg_column_size(receipt) <= 65536
  ),
  invalidated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, project_id, workflow_id, action_id),
  UNIQUE (tenant_id, project_id, evidence_bundle_id),
  FOREIGN KEY (tenant_id, project_id, workflow_id, action_id)
    REFERENCES deviludo.workflow_control_actions(tenant_id, project_id, workflow_id, id),
  FOREIGN KEY (tenant_id, project_id, candidate_receipt_id)
    REFERENCES deviludo.github_candidate_receipts(tenant_id, project_id, id),
  FOREIGN KEY (tenant_id, project_id, evidence_bundle_id)
    REFERENCES deviludo.evidence_bundles(tenant_id, project_id, id),
  FOREIGN KEY (tenant_id, project_id, previous_spec_revision_id)
    REFERENCES deviludo.immutable_revisions(tenant_id, project_id, id),
  FOREIGN KEY (tenant_id, project_id, next_spec_revision_id)
    REFERENCES deviludo.immutable_revisions(tenant_id, project_id, id),
  CHECK (previous_spec_revision_id <> next_spec_revision_id)
);

CREATE TRIGGER workflow_feedback_invalidations_append_only
BEFORE UPDATE OR DELETE ON deviludo.workflow_feedback_invalidations
FOR EACH ROW EXECUTE FUNCTION deviludo.reject_mutation();

ALTER TABLE deviludo.workflow_feedback_invalidations ENABLE ROW LEVEL SECURITY;
ALTER TABLE deviludo.workflow_feedback_invalidations FORCE ROW LEVEL SECURITY;
CREATE POLICY workflow_feedback_invalidations_tenant_isolation
  ON deviludo.workflow_feedback_invalidations
  USING (tenant_id = deviludo.current_tenant_id())
  WITH CHECK (tenant_id = deviludo.current_tenant_id());

COMMIT;
