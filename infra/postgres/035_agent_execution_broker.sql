BEGIN;

-- Durable execution operation. It never stores a DLRT token or an upstream
-- credential; the isolated Worker receives only an expiring secret reference.
CREATE TABLE deviludo.agent_execution_operations (
  tenant_id uuid NOT NULL REFERENCES deviludo.tenants(id),
  project_id uuid NOT NULL REFERENCES deviludo.projects(id),
  run_id uuid NOT NULL,
  operation_key text NOT NULL CHECK (operation_key ~ '^workflow-job:[a-f0-9-]{36}$'),
  request_digest char(64) NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  workflow_id text NOT NULL CHECK (length(workflow_id) BETWEEN 3 AND 200),
  provider_revision_id text NOT NULL
    CHECK (provider_revision_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'),
  request_payload jsonb NOT NULL CHECK (jsonb_typeof(request_payload) = 'object'),
  state text NOT NULL CHECK (state IN (
    'QUEUED', 'PREPARING', 'RUNNING', 'WAITING_PROVIDER',
    'SUCCEEDED', 'FAILED', 'CANCELLED'
  )),
  submitter_spiffe_id text NOT NULL CHECK (submitter_spiffe_id LIKE 'spiffe://%'),
  enqueue_count integer NOT NULL DEFAULT 0 CHECK (enqueue_count >= 0),
  last_enqueued_at timestamptz,
  available_at timestamptz NOT NULL,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  claim_token uuid,
  claim_expires_at timestamptz,
  attempt_id uuid,
  retry_at timestamptz,
  receipt_payload jsonb,
  receipt_digest char(64)
    CHECK (receipt_digest IS NULL OR receipt_digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  completed_at timestamptz,
  PRIMARY KEY (tenant_id, run_id),
  UNIQUE (tenant_id, operation_key),
  FOREIGN KEY (tenant_id, project_id, run_id)
    REFERENCES deviludo.agent_runs(tenant_id, project_id, id),
  FOREIGN KEY (tenant_id, provider_revision_id)
    REFERENCES deviludo.inference_provider_revisions(tenant_id, provider_revision_id),
  CHECK (
    (state IN ('QUEUED', 'WAITING_PROVIDER')
      AND claim_token IS NULL AND claim_expires_at IS NULL
      AND receipt_payload IS NULL AND receipt_digest IS NULL AND completed_at IS NULL)
    OR (state IN ('PREPARING', 'RUNNING')
      AND claim_token IS NOT NULL AND claim_expires_at IS NOT NULL
      AND attempt_id IS NOT NULL AND receipt_payload IS NULL
      AND receipt_digest IS NULL AND completed_at IS NULL)
    OR (state IN ('SUCCEEDED', 'FAILED')
      AND claim_token IS NULL AND claim_expires_at IS NULL AND attempt_id IS NOT NULL
      AND jsonb_typeof(receipt_payload) = 'object'
      AND receipt_digest IS NOT NULL AND completed_at IS NOT NULL)
    OR (state = 'CANCELLED' AND claim_token IS NULL AND claim_expires_at IS NULL
      AND receipt_payload IS NULL AND receipt_digest IS NULL AND completed_at IS NOT NULL)
  )
);

CREATE TABLE deviludo.agent_execution_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES deviludo.tenants(id),
  project_id uuid NOT NULL REFERENCES deviludo.projects(id),
  run_id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  state text NOT NULL CHECK (state IN (
    'PREPARING', 'RUNNING', 'WAITING_PROVIDER', 'SUCCEEDED', 'FAILED', 'CANCELLED'
  )),
  payload_digest char(64) NOT NULL CHECK (payload_digest ~ '^[a-f0-9]{64}$'),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  recorded_at timestamptz NOT NULL,
  FOREIGN KEY (tenant_id, project_id, run_id)
    REFERENCES deviludo.agent_runs(tenant_id, project_id, id)
);

CREATE OR REPLACE FUNCTION deviludo.protect_agent_execution_operation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.tenant_id, NEW.project_id, NEW.run_id, NEW.operation_key,
         NEW.request_digest, NEW.workflow_id, NEW.provider_revision_id,
         NEW.request_payload, NEW.submitter_spiffe_id, NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.tenant_id, OLD.project_id, OLD.run_id, OLD.operation_key,
         OLD.request_digest, OLD.workflow_id, OLD.provider_revision_id,
         OLD.request_payload, OLD.submitter_spiffe_id, OLD.created_at)
     OR OLD.state IN ('SUCCEEDED', 'FAILED', 'CANCELLED')
     OR (OLD.state = 'QUEUED' AND NEW.state NOT IN ('QUEUED', 'RUNNING', 'WAITING_PROVIDER', 'CANCELLED'))
     OR (OLD.state = 'PREPARING' AND NEW.state NOT IN ('RUNNING', 'QUEUED', 'WAITING_PROVIDER', 'FAILED', 'CANCELLED'))
     OR (OLD.state = 'RUNNING' AND NEW.state NOT IN ('RUNNING', 'QUEUED', 'WAITING_PROVIDER', 'SUCCEEDED', 'FAILED', 'CANCELLED'))
     OR (OLD.state = 'WAITING_PROVIDER' AND NEW.state NOT IN ('QUEUED', 'WAITING_PROVIDER', 'CANCELLED')) THEN
    RAISE EXCEPTION 'Agent execution operation binding or transition is invalid' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER agent_execution_operation_guard
BEFORE UPDATE ON deviludo.agent_execution_operations
FOR EACH ROW EXECUTE FUNCTION deviludo.protect_agent_execution_operation();
CREATE TRIGGER agent_execution_operation_no_delete
BEFORE DELETE ON deviludo.agent_execution_operations
FOR EACH ROW EXECUTE FUNCTION deviludo.reject_mutation();
CREATE TRIGGER agent_execution_event_append_only
BEFORE UPDATE OR DELETE ON deviludo.agent_execution_events
FOR EACH ROW EXECUTE FUNCTION deviludo.reject_mutation();

CREATE OR REPLACE FUNCTION deviludo.protect_agent_run_state()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state IN ('SUCCEEDED', 'FAILED', 'CANCELLED') AND NEW.state <> OLD.state
     OR OLD.state = 'QUEUED' AND NEW.state NOT IN ('QUEUED', 'PREPARING', 'RUNNING', 'WAITING_PROVIDER', 'CANCELLING')
     OR OLD.state = 'PREPARING' AND NEW.state NOT IN ('PREPARING', 'RUNNING', 'QUEUED', 'WAITING_PROVIDER', 'FAILED', 'CANCELLING')
     OR OLD.state = 'RUNNING' AND NEW.state NOT IN ('RUNNING', 'QUEUED', 'WAITING_PROVIDER', 'SUCCEEDED', 'FAILED', 'CANCELLING')
     OR OLD.state = 'WAITING_PROVIDER' AND NEW.state NOT IN ('WAITING_PROVIDER', 'QUEUED', 'CANCELLING')
     OR OLD.state = 'CANCELLING' AND NEW.state NOT IN ('CANCELLING', 'CANCELLED') THEN
    RAISE EXCEPTION 'AgentRun state transition is invalid' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER agent_run_state_guard
BEFORE UPDATE OF state ON deviludo.agent_runs
FOR EACH ROW EXECUTE FUNCTION deviludo.protect_agent_run_state();

-- Existing immutable authorization bindings gain an irreversible lifecycle.
CREATE OR REPLACE FUNCTION deviludo.protect_inference_run_authorization()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.run_id, NEW.tenant_id, NEW.project_id, NEW.profile_revision_id,
         NEW.provider_revision_id, NEW.credential_version_id, NEW.models,
         NEW.budget, NEW.nonce, NEW.expires_at, NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.run_id, OLD.tenant_id, OLD.project_id, OLD.profile_revision_id,
         OLD.provider_revision_id, OLD.credential_version_id, OLD.models,
         OLD.budget, OLD.nonce, OLD.expires_at, OLD.created_at)
     OR OLD.state IN ('REVOKED', 'COMPLETED') AND NEW.state <> OLD.state
     OR OLD.state = 'ACTIVE' AND NEW.state NOT IN ('ACTIVE', 'REVOKED', 'COMPLETED') THEN
    RAISE EXCEPTION 'inference run authorization binding or transition is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;

ALTER TABLE deviludo.agent_execution_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE deviludo.agent_execution_operations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON deviludo.agent_execution_operations
  USING (tenant_id = deviludo.current_tenant_id())
  WITH CHECK (tenant_id = deviludo.current_tenant_id());
ALTER TABLE deviludo.agent_execution_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE deviludo.agent_execution_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON deviludo.agent_execution_events
  USING (tenant_id = deviludo.current_tenant_id())
  WITH CHECK (tenant_id = deviludo.current_tenant_id());

CREATE INDEX agent_execution_claim_idx ON deviludo.agent_execution_operations
  (tenant_id, state, available_at, retry_at, claim_expires_at, created_at);
CREATE INDEX agent_execution_event_run_idx ON deviludo.agent_execution_events
  (tenant_id, project_id, run_id, id);

COMMIT;
