BEGIN;

-- Durable authority for turning a user's candidate-build feedback into the
-- next immutable specification draft. Model generation is deliberately
-- separated from evidence invalidation: only a committed DRAFT_READY row may
-- complete REQUEST_USER_ACCEPTANCE and tombstone the old evidence bundle.
CREATE TABLE deviludo.user_feedback_operations (
  operation_key text PRIMARY KEY CHECK (operation_key ~ '^[a-f0-9]{64}$'),
  tenant_id uuid NOT NULL REFERENCES deviludo.tenants(id),
  project_id uuid NOT NULL REFERENCES deviludo.projects(id),
  actor_id text NOT NULL CHECK (actor_id ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,159}$'),
  request_digest text NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  feedback text NOT NULL CHECK (length(feedback) BETWEEN 1 AND 4000),
  feedback_digest text NOT NULL CHECK (feedback_digest ~ '^[a-f0-9]{64}$'),
  workflow_id text NOT NULL CHECK (length(workflow_id) BETWEEN 1 AND 512),
  action_id uuid NOT NULL,
  previous_conversation_id uuid NOT NULL,
  previous_spec_revision_id uuid NOT NULL,
  previous_test_plan_revision_id uuid NOT NULL,
  next_conversation_id uuid,
  evidence_invalidation_id uuid NOT NULL,
  signal_id text NOT NULL CHECK (
    length(signal_id) BETWEEN 8 AND 200
      AND signal_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]+$'
  ),
  state text NOT NULL CHECK (state IN ('GENERATING', 'DRAFT_READY', 'COMPLETED')),
  claim_token uuid,
  claim_expires_at timestamptz,
  next_spec_revision_id uuid,
  next_test_plan_revision_id uuid,
  draft_snapshot jsonb,
  completion_receipt jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  draft_created_at timestamptz,
  completed_at timestamptz,
  UNIQUE (tenant_id, project_id, workflow_id, action_id),
  UNIQUE (tenant_id, project_id, next_conversation_id),
  UNIQUE (tenant_id, signal_id),
  UNIQUE (tenant_id, project_id, evidence_invalidation_id),
  FOREIGN KEY (tenant_id, project_id, workflow_id, action_id)
    REFERENCES deviludo.workflow_control_actions(tenant_id, project_id, workflow_id, id),
  FOREIGN KEY (tenant_id, project_id, previous_conversation_id)
    REFERENCES deviludo.spec_conversations(tenant_id, project_id, id),
  FOREIGN KEY (tenant_id, project_id, previous_spec_revision_id)
    REFERENCES deviludo.immutable_revisions(tenant_id, project_id, id),
  FOREIGN KEY (tenant_id, project_id, previous_test_plan_revision_id)
    REFERENCES deviludo.immutable_revisions(tenant_id, project_id, id),
  FOREIGN KEY (tenant_id, project_id, next_conversation_id)
    REFERENCES deviludo.spec_conversations(tenant_id, project_id, id),
  FOREIGN KEY (tenant_id, project_id, next_spec_revision_id)
    REFERENCES deviludo.immutable_revisions(tenant_id, project_id, id),
  FOREIGN KEY (tenant_id, project_id, next_test_plan_revision_id)
    REFERENCES deviludo.immutable_revisions(tenant_id, project_id, id),
  CHECK (
    (state = 'GENERATING' AND claim_token IS NOT NULL
      AND claim_expires_at IS NOT NULL AND next_conversation_id IS NULL
      AND next_spec_revision_id IS NULL
      AND next_test_plan_revision_id IS NULL AND draft_snapshot IS NULL
      AND completion_receipt IS NULL AND draft_created_at IS NULL
      AND completed_at IS NULL)
    OR
    (state = 'DRAFT_READY' AND claim_token IS NULL
      AND claim_expires_at IS NULL AND next_conversation_id IS NOT NULL
      AND next_spec_revision_id IS NOT NULL
      AND next_test_plan_revision_id IS NOT NULL
      AND jsonb_typeof(draft_snapshot) = 'object'
      AND completion_receipt IS NULL AND draft_created_at IS NOT NULL
      AND completed_at IS NULL)
    OR
    (state = 'COMPLETED' AND claim_token IS NULL
      AND claim_expires_at IS NULL AND next_conversation_id IS NOT NULL
      AND next_spec_revision_id IS NOT NULL
      AND next_test_plan_revision_id IS NOT NULL
      AND jsonb_typeof(draft_snapshot) = 'object'
      AND jsonb_typeof(completion_receipt) = 'object'
      AND draft_created_at IS NOT NULL AND completed_at IS NOT NULL)
  ),
  CHECK (pg_column_size(draft_snapshot) <= 1048576),
  CHECK (pg_column_size(completion_receipt) <= 65536)
);

CREATE OR REPLACE FUNCTION deviludo.protect_user_feedback_operation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.operation_key, NEW.tenant_id, NEW.project_id, NEW.actor_id,
         NEW.request_digest, NEW.feedback, NEW.feedback_digest,
         NEW.workflow_id, NEW.action_id, NEW.previous_conversation_id,
         NEW.previous_spec_revision_id, NEW.previous_test_plan_revision_id,
         NEW.evidence_invalidation_id,
         NEW.signal_id, NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.operation_key, OLD.tenant_id, OLD.project_id, OLD.actor_id,
         OLD.request_digest, OLD.feedback, OLD.feedback_digest,
         OLD.workflow_id, OLD.action_id, OLD.previous_conversation_id,
         OLD.previous_spec_revision_id, OLD.previous_test_plan_revision_id,
         OLD.evidence_invalidation_id,
         OLD.signal_id, OLD.created_at)
     OR OLD.state = 'COMPLETED'
     OR (OLD.state = 'DRAFT_READY' AND (
          NEW.state <> 'COMPLETED'
          OR ROW(NEW.next_conversation_id, NEW.next_spec_revision_id,
                 NEW.next_test_plan_revision_id, NEW.draft_snapshot,
                 NEW.draft_created_at)
             IS DISTINCT FROM
             ROW(OLD.next_conversation_id, OLD.next_spec_revision_id,
                 OLD.next_test_plan_revision_id, OLD.draft_snapshot,
                 OLD.draft_created_at)
        ))
     OR (OLD.state = 'GENERATING' AND NEW.state NOT IN ('GENERATING', 'DRAFT_READY')) THEN
    RAISE EXCEPTION 'user feedback operation binding is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER user_feedback_operation_guard
BEFORE UPDATE ON deviludo.user_feedback_operations
FOR EACH ROW EXECUTE FUNCTION deviludo.protect_user_feedback_operation();
CREATE TRIGGER user_feedback_operation_no_delete
BEFORE DELETE ON deviludo.user_feedback_operations
FOR EACH ROW EXECUTE FUNCTION deviludo.reject_mutation();

ALTER TABLE deviludo.user_feedback_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE deviludo.user_feedback_operations FORCE ROW LEVEL SECURITY;
CREATE POLICY user_feedback_operations_tenant_isolation
  ON deviludo.user_feedback_operations
  USING (tenant_id = deviludo.current_tenant_id())
  WITH CHECK (tenant_id = deviludo.current_tenant_id());

CREATE INDEX user_feedback_operation_claim_idx
  ON deviludo.user_feedback_operations (tenant_id, state, claim_expires_at);

COMMIT;
