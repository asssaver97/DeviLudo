BEGIN;

ALTER TABLE deviludo.projects
  ADD CONSTRAINT projects_tenant_id_unique UNIQUE (tenant_id, id);
ALTER TABLE deviludo.steam_releases
  ADD CONSTRAINT steam_releases_tenant_project_id_unique UNIQUE (tenant_id, project_id, id);

-- Durable service-side inbox for Temporal activities. An accepted receipt is
-- written only after the destination has durably enqueued the command. The
-- request binding can never be changed to turn an Agent retry into an SCM or
-- Steam operation.
CREATE TABLE deviludo.workflow_command_inbox (
  idempotency_key text PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES deviludo.tenants(id),
  project_id uuid NOT NULL,
  workflow_id text NOT NULL CHECK (length(workflow_id) BETWEEN 1 AND 512),
  destination text NOT NULL CHECK (destination IN (
    'control-plane', 'agent-worker', 'runner-control', 'scm-proxy', 'steam-publisher'
  )),
  operation text NOT NULL CHECK (operation IN (
    'CONTINUE_IDEA_DIALOGUE', 'REQUEST_SPEC_APPROVAL', 'START_LOCKED_AGENT_RUN',
    'WAIT_FOR_PROVIDER', 'START_TARGET_MATRIX_E2E', 'REQUEST_USER_ACCEPTANCE',
    'MERGE_DRAFT_PULL_REQUEST', 'START_MAIN_SHA_RELEASE_GATE', 'REQUEST_FRESH_MFA',
    'UPLOAD_AND_ACTIVATE_PRIVATE_BETA', 'INSTALL_FROM_CLEAN_STEAM_CLIENT',
    'WAIT_FOR_EXTERNAL_APPROVAL', 'PUBLISH_STEAM_DEFAULT_BRANCH', 'CANCEL_DELIVERY'
  )),
  request_digest text NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  claim_token uuid,
  claim_expires_at timestamptz,
  receipt_id uuid,
  receipt jsonb,
  accepted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((claim_token IS NULL) = (claim_expires_at IS NULL)),
  CHECK ((receipt_id IS NULL) = (receipt IS NULL)),
  CHECK ((receipt_id IS NULL) = (accepted_at IS NULL)),
  CHECK (receipt_id IS NULL OR claim_token IS NULL),
  CHECK (
    (destination = 'control-plane' AND operation IN (
      'CONTINUE_IDEA_DIALOGUE', 'REQUEST_SPEC_APPROVAL', 'WAIT_FOR_PROVIDER',
      'REQUEST_USER_ACCEPTANCE', 'REQUEST_FRESH_MFA', 'WAIT_FOR_EXTERNAL_APPROVAL',
      'CANCEL_DELIVERY'
    )) OR
    (destination = 'agent-worker' AND operation = 'START_LOCKED_AGENT_RUN') OR
    (destination = 'runner-control' AND operation IN (
      'START_TARGET_MATRIX_E2E', 'START_MAIN_SHA_RELEASE_GATE',
      'INSTALL_FROM_CLEAN_STEAM_CLIENT'
    )) OR
    (destination = 'scm-proxy' AND operation = 'MERGE_DRAFT_PULL_REQUEST') OR
    (destination = 'steam-publisher' AND operation IN (
      'UPLOAD_AND_ACTIVATE_PRIVATE_BETA', 'PUBLISH_STEAM_DEFAULT_BRANCH'
    ))
  ),
  FOREIGN KEY (tenant_id, project_id)
    REFERENCES deviludo.projects(tenant_id, id),
  UNIQUE (tenant_id, workflow_id, idempotency_key)
);

-- Human/external approvals are append-only verified receipts. The gate and
-- signal ID are both persisted so a delayed callback cannot satisfy the next
-- gate in the same workflow.
CREATE TABLE deviludo.workflow_external_approval_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES deviludo.tenants(id),
  project_id uuid NOT NULL,
  release_id uuid NOT NULL,
  workflow_id text NOT NULL CHECK (length(workflow_id) BETWEEN 1 AND 512),
  signal_id text NOT NULL CHECK (signal_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$'),
  gate text NOT NULL CHECK (gate IN (
    'VALVE_REVIEW', 'FIRST_RELEASE', 'DEFAULT_BRANCH_CONFIRMATION'
  )),
  approval_id text NOT NULL,
  verifier_subject text NOT NULL,
  evidence_digest text NOT NULL CHECK (evidence_digest ~ '^[a-f0-9]{64}$'),
  receipt jsonb NOT NULL,
  verified_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, project_id)
    REFERENCES deviludo.projects(tenant_id, id),
  FOREIGN KEY (tenant_id, project_id, release_id)
    REFERENCES deviludo.steam_releases(tenant_id, project_id, id),
  UNIQUE (release_id, gate),
  UNIQUE (tenant_id, workflow_id, signal_id),
  UNIQUE (tenant_id, approval_id)
);

CREATE OR REPLACE FUNCTION deviludo.protect_workflow_command_binding()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.idempotency_key, NEW.tenant_id, NEW.project_id, NEW.workflow_id,
         NEW.destination, NEW.operation, NEW.request_digest, NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.idempotency_key, OLD.tenant_id, OLD.project_id, OLD.workflow_id,
         OLD.destination, OLD.operation, OLD.request_digest, OLD.created_at) THEN
    RAISE EXCEPTION 'workflow command binding is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.receipt_id IS NOT NULL AND ROW(NEW.receipt_id, NEW.receipt, NEW.accepted_at)
     IS DISTINCT FROM ROW(OLD.receipt_id, OLD.receipt, OLD.accepted_at) THEN
    RAISE EXCEPTION 'workflow command receipt is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.receipt_id IS NOT NULL AND NEW.claim_token IS NOT NULL THEN
    RAISE EXCEPTION 'completed workflow command cannot be reclaimed' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER workflow_command_binding_immutable
BEFORE UPDATE ON deviludo.workflow_command_inbox
FOR EACH ROW EXECUTE FUNCTION deviludo.protect_workflow_command_binding();

CREATE TRIGGER workflow_command_no_delete
BEFORE DELETE ON deviludo.workflow_command_inbox
FOR EACH ROW EXECUTE FUNCTION deviludo.reject_mutation();

CREATE TRIGGER workflow_external_approval_append_only
BEFORE UPDATE OR DELETE ON deviludo.workflow_external_approval_receipts
FOR EACH ROW EXECUTE FUNCTION deviludo.reject_mutation();

ALTER TABLE deviludo.workflow_command_inbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE deviludo.workflow_command_inbox FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON deviludo.workflow_command_inbox
  USING (tenant_id = deviludo.current_tenant_id())
  WITH CHECK (tenant_id = deviludo.current_tenant_id());

ALTER TABLE deviludo.workflow_external_approval_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE deviludo.workflow_external_approval_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON deviludo.workflow_external_approval_receipts
  USING (tenant_id = deviludo.current_tenant_id())
  WITH CHECK (tenant_id = deviludo.current_tenant_id());

CREATE INDEX workflow_command_claim_idx
  ON deviludo.workflow_command_inbox (destination, claim_expires_at)
  WHERE receipt_id IS NULL;
CREATE INDEX workflow_command_project_idx
  ON deviludo.workflow_command_inbox (tenant_id, project_id, created_at DESC);
CREATE INDEX workflow_external_approval_workflow_idx
  ON deviludo.workflow_external_approval_receipts (tenant_id, workflow_id, verified_at);

COMMIT;
