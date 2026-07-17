BEGIN;

CREATE TABLE IF NOT EXISTS deviludo.workflow_control_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  workflow_id text NOT NULL CHECK (length(workflow_id) BETWEEN 1 AND 512),
  operation_key text NOT NULL CHECK (length(operation_key) BETWEEN 1 AND 512),
  request_digest char(64) NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  operation text NOT NULL CHECK (operation IN (
    'CONTINUE_IDEA_DIALOGUE',
    'REQUEST_SPEC_APPROVAL',
    'WAIT_FOR_PROVIDER',
    'REQUEST_USER_ACCEPTANCE',
    'REQUEST_FRESH_MFA',
    'WAIT_FOR_EXTERNAL_APPROVAL',
    'CANCEL_DELIVERY'
  )),
  status text NOT NULL CHECK (status IN ('WAITING', 'ACKNOWLEDGED', 'COMPLETED', 'INVALIDATED')),
  binding jsonb NOT NULL CHECK (jsonb_typeof(binding) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (tenant_id, operation_key),
  CHECK (
    (operation = 'CANCEL_DELIVERY' AND status = 'ACKNOWLEDGED')
    OR (operation <> 'CANCEL_DELIVERY' AND status <> 'ACKNOWLEDGED')
  )
);

ALTER TABLE deviludo.workflow_control_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE deviludo.workflow_control_actions FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS workflow_control_actions_tenant_isolation
  ON deviludo.workflow_control_actions;
CREATE POLICY workflow_control_actions_tenant_isolation
  ON deviludo.workflow_control_actions
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

CREATE INDEX IF NOT EXISTS workflow_control_actions_waiting_idx
  ON deviludo.workflow_control_actions (tenant_id, project_id, status, created_at)
  WHERE status = 'WAITING';

COMMIT;
