BEGIN;

ALTER TABLE deviludo.workflow_command_inbox
  ADD CONSTRAINT workflow_command_inbox_tenant_binding_unique
  UNIQUE (tenant_id, idempotency_key, destination, operation, request_digest);

CREATE TABLE deviludo.workflow_command_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES deviludo.tenants(id),
  project_id uuid NOT NULL,
  workflow_id text NOT NULL CHECK (length(workflow_id) BETWEEN 1 AND 512),
  idempotency_key text NOT NULL,
  destination text NOT NULL CHECK (destination IN (
    'control-plane', 'agent-worker', 'runner-control', 'scm-proxy', 'steam-publisher'
  )),
  operation text NOT NULL,
  request_digest text NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  request_body jsonb NOT NULL CHECK (pg_column_size(request_body) <= 2097152),
  state text NOT NULL CHECK (state IN (
    'QUEUED', 'RUNNING', 'COMPLETED', 'RETRYABLE_FAILED', 'TERMINAL_FAILED', 'CANCELLED'
  )) DEFAULT 'QUEUED',
  attempt integer NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  claimed_by text,
  claim_token uuid,
  claim_expires_at timestamptz,
  result jsonb,
  error_code text,
  available_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CHECK ((claim_token IS NULL) = (claim_expires_at IS NULL)),
  CHECK ((claim_token IS NULL) = (claimed_by IS NULL)),
  CHECK (state = 'RUNNING' OR claim_token IS NULL),
  CHECK ((state = 'COMPLETED') = (result IS NOT NULL)),
  CHECK (state NOT IN ('COMPLETED', 'TERMINAL_FAILED', 'CANCELLED') OR completed_at IS NOT NULL),
  FOREIGN KEY (tenant_id, project_id)
    REFERENCES deviludo.projects(tenant_id, id),
  FOREIGN KEY (tenant_id, idempotency_key, destination, operation, request_digest)
    REFERENCES deviludo.workflow_command_inbox(
      tenant_id, idempotency_key, destination, operation, request_digest
    ),
  UNIQUE (tenant_id, idempotency_key)
);

CREATE OR REPLACE FUNCTION deviludo.protect_workflow_job_binding()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.id, NEW.tenant_id, NEW.project_id, NEW.workflow_id,
         NEW.idempotency_key, NEW.destination, NEW.operation,
         NEW.request_digest, NEW.request_body, NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.id, OLD.tenant_id, OLD.project_id, OLD.workflow_id,
         OLD.idempotency_key, OLD.destination, OLD.operation,
         OLD.request_digest, OLD.request_body, OLD.created_at) THEN
    RAISE EXCEPTION 'workflow job binding is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.state IN ('COMPLETED', 'TERMINAL_FAILED', 'CANCELLED') THEN
    RAISE EXCEPTION 'terminal workflow job is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.state = 'RUNNING' AND NEW.state NOT IN (
    'RUNNING', 'COMPLETED', 'RETRYABLE_FAILED', 'TERMINAL_FAILED', 'CANCELLED'
  ) THEN
    RAISE EXCEPTION 'invalid running workflow job transition' USING ERRCODE = '55000';
  END IF;
  IF OLD.state IN ('QUEUED', 'RETRYABLE_FAILED') AND NEW.state NOT IN (
    'QUEUED', 'RUNNING', 'CANCELLED'
  ) THEN
    RAISE EXCEPTION 'invalid queued workflow job transition' USING ERRCODE = '55000';
  END IF;
  IF NEW.state = 'RUNNING' AND OLD.state <> 'RUNNING'
     AND NEW.attempt <> OLD.attempt + 1 THEN
    RAISE EXCEPTION 'workflow job attempt must advance exactly once' USING ERRCODE = '55000';
  END IF;
  IF OLD.state = 'RUNNING' AND NEW.state = 'RUNNING'
     AND NEW.attempt <> OLD.attempt + 1 THEN
    RAISE EXCEPTION 'expired workflow job reclaim must advance attempt' USING ERRCODE = '55000';
  END IF;
  IF NEW.state <> 'RUNNING' AND NEW.attempt <> OLD.attempt THEN
    RAISE EXCEPTION 'workflow job attempt changed outside a claim' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER workflow_job_binding_immutable
BEFORE UPDATE ON deviludo.workflow_command_jobs
FOR EACH ROW EXECUTE FUNCTION deviludo.protect_workflow_job_binding();

CREATE TRIGGER workflow_job_no_delete
BEFORE DELETE ON deviludo.workflow_command_jobs
FOR EACH ROW EXECUTE FUNCTION deviludo.reject_mutation();

ALTER TABLE deviludo.workflow_command_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE deviludo.workflow_command_jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON deviludo.workflow_command_jobs
  USING (tenant_id = deviludo.current_tenant_id())
  WITH CHECK (tenant_id = deviludo.current_tenant_id());

CREATE INDEX workflow_job_poll_idx
  ON deviludo.workflow_command_jobs (tenant_id, destination, available_at, created_at)
  WHERE state IN ('QUEUED', 'RETRYABLE_FAILED', 'RUNNING');
CREATE INDEX workflow_job_project_idx
  ON deviludo.workflow_command_jobs (tenant_id, project_id, created_at DESC);

COMMIT;
