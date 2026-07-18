BEGIN;

-- Durable queue/status boundary between the Temporal Steam destination and the
-- isolated Steam executor. The request contains authorization identifiers only;
-- account passwords, Guard codes and config.vdf bytes are never valid fields.
ALTER TABLE deviludo.agent_runs
  ADD CONSTRAINT agent_runs_tenant_project_id_unique UNIQUE (tenant_id, project_id, id);

CREATE TABLE deviludo.steam_workflow_operations (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES deviludo.tenants(id),
  project_id uuid NOT NULL REFERENCES deviludo.projects(id),
  submitter_spiffe_id text NOT NULL CHECK (submitter_spiffe_id LIKE 'spiffe://%'),
  workflow_id text NOT NULL CHECK (length(workflow_id) BETWEEN 1 AND 512),
  run_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('PRIVATE_BETA_UPLOAD', 'DEFAULT_BRANCH_PUBLISH')),
  operation_key text NOT NULL CHECK (operation_key ~ '^workflow-job:[a-f0-9-]{36}$'),
  request_digest char(64) NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  payload_digest char(64) NOT NULL CHECK (payload_digest ~ '^[a-f0-9]{64}$'),
  request_payload jsonb NOT NULL CHECK (
    jsonb_typeof(request_payload) = 'object' AND pg_column_size(request_payload) <= 131072
  ),
  state text NOT NULL CHECK (state IN ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED')),
  claim_token uuid,
  claim_expires_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  receipt jsonb CHECK (receipt IS NULL OR (jsonb_typeof(receipt) = 'object' AND pg_column_size(receipt) <= 65536)),
  error_code text CHECK (error_code IS NULL OR error_code ~ '^[A-Z][A-Z0-9_]{2,99}$'),
  terminal boolean,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  completed_at timestamptz,
  UNIQUE (tenant_id, operation_key),
  UNIQUE (tenant_id, project_id, id),
  FOREIGN KEY (tenant_id, project_id, run_id)
    REFERENCES deviludo.agent_runs(tenant_id, project_id, id),
  CHECK ((claim_token IS NULL) = (claim_expires_at IS NULL)),
  CHECK (
    (state = 'PENDING' AND claim_token IS NULL AND attempt_count >= 0
      AND receipt IS NULL AND error_code IS NULL AND terminal IS NULL AND completed_at IS NULL)
    OR (state = 'RUNNING' AND claim_token IS NOT NULL AND attempt_count > 0
      AND receipt IS NULL AND error_code IS NULL AND terminal IS NULL AND completed_at IS NULL)
    OR (state = 'COMPLETED' AND claim_token IS NULL AND attempt_count > 0
      AND receipt IS NOT NULL AND error_code IS NULL AND terminal IS NULL AND completed_at IS NOT NULL)
    OR (state = 'FAILED' AND claim_token IS NULL AND attempt_count > 0
      AND receipt IS NULL AND error_code IS NOT NULL AND terminal IS NOT NULL AND completed_at IS NOT NULL)
  )
);

CREATE OR REPLACE FUNCTION deviludo.protect_steam_workflow_operation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.id, NEW.tenant_id, NEW.project_id, NEW.submitter_spiffe_id, NEW.workflow_id, NEW.run_id,
         NEW.kind, NEW.operation_key, NEW.request_digest, NEW.payload_digest,
         NEW.request_payload, NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.id, OLD.tenant_id, OLD.project_id, OLD.submitter_spiffe_id, OLD.workflow_id, OLD.run_id,
         OLD.kind, OLD.operation_key, OLD.request_digest, OLD.payload_digest,
         OLD.request_payload, OLD.created_at) THEN
    RAISE EXCEPTION 'steam workflow operation binding is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.state IN ('COMPLETED', 'FAILED') AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'terminal steam workflow operation is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.state = 'PENDING' AND NEW.state NOT IN ('PENDING', 'RUNNING') THEN
    RAISE EXCEPTION 'invalid pending steam workflow transition' USING ERRCODE = '55000';
  END IF;
  IF OLD.state = 'RUNNING' AND NEW.state NOT IN ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED') THEN
    RAISE EXCEPTION 'invalid running steam workflow transition' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER steam_workflow_operation_binding_immutable
BEFORE UPDATE ON deviludo.steam_workflow_operations
FOR EACH ROW EXECUTE FUNCTION deviludo.protect_steam_workflow_operation();

CREATE TRIGGER steam_workflow_operation_no_delete
BEFORE DELETE ON deviludo.steam_workflow_operations
FOR EACH ROW EXECUTE FUNCTION deviludo.reject_mutation();

ALTER TABLE deviludo.steam_workflow_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE deviludo.steam_workflow_operations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON deviludo.steam_workflow_operations
  USING (tenant_id = deviludo.current_tenant_id())
  WITH CHECK (tenant_id = deviludo.current_tenant_id());

CREATE INDEX steam_workflow_operation_poll_idx
  ON deviludo.steam_workflow_operations (tenant_id, state, claim_expires_at, updated_at)
  WHERE state IN ('PENDING', 'RUNNING');

COMMIT;
