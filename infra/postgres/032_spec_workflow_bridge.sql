BEGIN;

-- User approval and Agent configuration resolution are separate authorities.
-- Temporal must record the approved immutable specification before a different
-- workload resolves moving Agent defaults into a run configuration lock.
ALTER TABLE deviludo.workflow_command_inbox
  DROP CONSTRAINT workflow_command_inbox_operation_check;
ALTER TABLE deviludo.workflow_command_inbox
  ADD CONSTRAINT workflow_command_inbox_operation_check CHECK (operation IN (
    'CONTINUE_IDEA_DIALOGUE', 'REQUEST_SPEC_APPROVAL',
    'RESOLVE_AGENT_RUN_CONFIGURATION', 'START_LOCKED_AGENT_RUN',
    'WAIT_FOR_PROVIDER', 'START_TARGET_MATRIX_E2E', 'REQUEST_USER_ACCEPTANCE',
    'MERGE_DRAFT_PULL_REQUEST', 'START_MAIN_SHA_RELEASE_GATE', 'REQUEST_FRESH_MFA',
    'UPLOAD_AND_ACTIVATE_PRIVATE_BETA', 'INSTALL_FROM_CLEAN_STEAM_CLIENT',
    'WAIT_FOR_EXTERNAL_APPROVAL', 'PUBLISH_STEAM_DEFAULT_BRANCH', 'CANCEL_DELIVERY'
  ));
ALTER TABLE deviludo.workflow_command_inbox
  DROP CONSTRAINT workflow_command_inbox_check;
ALTER TABLE deviludo.workflow_command_inbox
  ADD CONSTRAINT workflow_command_inbox_check CHECK (
    (destination = 'control-plane' AND operation IN (
      'CONTINUE_IDEA_DIALOGUE', 'REQUEST_SPEC_APPROVAL',
      'RESOLVE_AGENT_RUN_CONFIGURATION', 'WAIT_FOR_PROVIDER',
      'REQUEST_USER_ACCEPTANCE', 'REQUEST_FRESH_MFA',
      'WAIT_FOR_EXTERNAL_APPROVAL', 'CANCEL_DELIVERY'
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
  );

ALTER TABLE deviludo.workflow_control_actions
  DROP CONSTRAINT workflow_control_actions_operation_check;
ALTER TABLE deviludo.workflow_control_actions
  ADD CONSTRAINT workflow_control_actions_operation_check CHECK (operation IN (
    'CONTINUE_IDEA_DIALOGUE', 'REQUEST_SPEC_APPROVAL',
    'RESOLVE_AGENT_RUN_CONFIGURATION', 'WAIT_FOR_PROVIDER',
    'REQUEST_USER_ACCEPTANCE', 'REQUEST_FRESH_MFA',
    'WAIT_FOR_EXTERNAL_APPROVAL', 'CANCEL_DELIVERY'
  ));
ALTER TABLE deviludo.workflow_control_actions
  DROP CONSTRAINT workflow_control_action_source_shape;
ALTER TABLE deviludo.workflow_control_actions
  ADD CONSTRAINT workflow_control_action_source_shape
    CHECK (completion_source IS NULL OR completion_source IN (
      'SPEC_SERVICE', 'AGENT_CONFIGURATION_SERVICE', 'USER_ACCEPTANCE_SERVICE',
      'PROVIDER_MONITOR', 'MFA_BROKER', 'STEAM_APPROVAL_MONITOR'
    ));

ALTER TABLE deviludo.workflow_signal_outbox
  ADD CONSTRAINT workflow_signal_outbox_tenant_binding_key
    UNIQUE (tenant_id, project_id, workflow_id, id);

CREATE TABLE deviludo.spec_delivery_workflows (
  tenant_id uuid NOT NULL REFERENCES deviludo.tenants(id),
  project_id uuid NOT NULL REFERENCES deviludo.projects(id),
  workflow_id text NOT NULL CHECK (workflow_id ~ '^delivery-[a-f0-9-]{36}$'),
  target_matrix text[] NOT NULL CHECK (
    target_matrix = ARRAY['linux']::text[]
    OR target_matrix = ARRAY['macos']::text[]
    OR target_matrix = ARRAY['windows']::text[]
    OR target_matrix = ARRAY['linux', 'macos']::text[]
    OR target_matrix = ARRAY['linux', 'windows']::text[]
    OR target_matrix = ARRAY['macos', 'windows']::text[]
    OR target_matrix = ARRAY['linux', 'macos', 'windows']::text[]
  ),
  temporal_run_id text,
  state text NOT NULL DEFAULT 'PENDING_START'
    CHECK (state IN ('PENDING_START', 'ACTIVE', 'TERMINAL')),
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  PRIMARY KEY (tenant_id, project_id),
  UNIQUE (tenant_id, workflow_id),
  CHECK ((state = 'PENDING_START' AND temporal_run_id IS NULL AND started_at IS NULL)
    OR (state IN ('ACTIVE', 'TERMINAL') AND temporal_run_id IS NOT NULL AND started_at IS NOT NULL))
);

CREATE TABLE deviludo.spec_workflow_events (
  event_key text NOT NULL CHECK (event_key ~ '^[a-f0-9]{64}$'),
  tenant_id uuid NOT NULL REFERENCES deviludo.tenants(id),
  project_id uuid NOT NULL,
  workflow_id text NOT NULL,
  conversation_id uuid NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('SPEC_READY', 'SPEC_APPROVED')),
  request_digest text NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  state text NOT NULL DEFAULT 'PENDING'
    CHECK (state IN ('PENDING', 'CLAIMED', 'COMPLETED')),
  claim_token uuid,
  claim_expires_at timestamptz,
  workflow_action_id uuid,
  completion_outbox_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  PRIMARY KEY (tenant_id, event_key),
  FOREIGN KEY (tenant_id, project_id, workflow_id)
    REFERENCES deviludo.spec_delivery_workflows(tenant_id, project_id, workflow_id),
  FOREIGN KEY (tenant_id, project_id, conversation_id)
    REFERENCES deviludo.spec_conversations(tenant_id, project_id, id),
  FOREIGN KEY (tenant_id, project_id, workflow_id, workflow_action_id)
    REFERENCES deviludo.workflow_control_actions(tenant_id, project_id, workflow_id, id),
  FOREIGN KEY (tenant_id, project_id, workflow_id, completion_outbox_id)
    REFERENCES deviludo.workflow_signal_outbox(tenant_id, project_id, workflow_id, id),
  CHECK ((state = 'PENDING' AND claim_token IS NULL AND claim_expires_at IS NULL
      AND workflow_action_id IS NULL AND completion_outbox_id IS NULL AND completed_at IS NULL)
    OR (state = 'CLAIMED' AND claim_token IS NOT NULL AND claim_expires_at IS NOT NULL
      AND workflow_action_id IS NULL AND completion_outbox_id IS NULL AND completed_at IS NULL)
    OR (state = 'COMPLETED' AND claim_token IS NULL AND claim_expires_at IS NULL
      AND workflow_action_id IS NOT NULL AND completion_outbox_id IS NOT NULL
      AND completed_at IS NOT NULL))
);

CREATE OR REPLACE FUNCTION deviludo.protect_spec_delivery_workflow()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.tenant_id, NEW.project_id, NEW.workflow_id, NEW.target_matrix, NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.tenant_id, OLD.project_id, OLD.workflow_id, OLD.target_matrix, OLD.created_at)
     OR OLD.state = 'TERMINAL'
     OR (OLD.state = 'PENDING_START' AND NEW.state <> 'ACTIVE')
     OR (OLD.state = 'ACTIVE' AND (
       NEW.state <> 'TERMINAL'
       OR NEW.temporal_run_id IS DISTINCT FROM OLD.temporal_run_id
       OR NEW.started_at IS DISTINCT FROM OLD.started_at
     )) THEN
    RAISE EXCEPTION 'spec delivery workflow binding is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION deviludo.protect_spec_workflow_event()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.event_key, NEW.tenant_id, NEW.project_id, NEW.workflow_id,
         NEW.conversation_id, NEW.event_type, NEW.request_digest,
         NEW.payload, NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.event_key, OLD.tenant_id, OLD.project_id, OLD.workflow_id,
         OLD.conversation_id, OLD.event_type, OLD.request_digest,
         OLD.payload, OLD.created_at)
     OR OLD.state = 'COMPLETED'
     OR (OLD.state = 'PENDING' AND NEW.state <> 'CLAIMED')
     OR (OLD.state = 'CLAIMED' AND NEW.state = 'CLAIMED'
       AND OLD.claim_expires_at > now())
     OR (OLD.state = 'CLAIMED' AND NEW.state NOT IN ('PENDING', 'CLAIMED', 'COMPLETED')) THEN
    RAISE EXCEPTION 'spec workflow event binding is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER spec_delivery_workflow_guard
BEFORE UPDATE ON deviludo.spec_delivery_workflows
FOR EACH ROW EXECUTE FUNCTION deviludo.protect_spec_delivery_workflow();
CREATE TRIGGER spec_delivery_workflow_no_delete
BEFORE DELETE ON deviludo.spec_delivery_workflows
FOR EACH ROW EXECUTE FUNCTION deviludo.reject_mutation();
CREATE TRIGGER spec_workflow_event_guard
BEFORE UPDATE ON deviludo.spec_workflow_events
FOR EACH ROW EXECUTE FUNCTION deviludo.protect_spec_workflow_event();
CREATE TRIGGER spec_workflow_event_no_delete
BEFORE DELETE ON deviludo.spec_workflow_events
FOR EACH ROW EXECUTE FUNCTION deviludo.reject_mutation();

ALTER TABLE deviludo.spec_delivery_workflows ENABLE ROW LEVEL SECURITY;
ALTER TABLE deviludo.spec_delivery_workflows FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON deviludo.spec_delivery_workflows
  USING (tenant_id = deviludo.current_tenant_id())
  WITH CHECK (tenant_id = deviludo.current_tenant_id());
ALTER TABLE deviludo.spec_workflow_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE deviludo.spec_workflow_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON deviludo.spec_workflow_events
  USING (tenant_id = deviludo.current_tenant_id())
  WITH CHECK (tenant_id = deviludo.current_tenant_id());

CREATE INDEX spec_workflow_event_claim_idx
  ON deviludo.spec_workflow_events (tenant_id, state, claim_expires_at, created_at);
CREATE INDEX spec_delivery_workflow_state_idx
  ON deviludo.spec_delivery_workflows (tenant_id, state, created_at);

COMMIT;
