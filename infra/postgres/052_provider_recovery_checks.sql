BEGIN;

-- Authority-free scheduler requests are bound to the exact WAIT_FOR_PROVIDER
-- action before the Provider is probed. The ledger stores only a probe digest;
-- upstream responses and credentials remain inside the Inference Gateway.
CREATE TABLE deviludo.provider_recovery_checks (
  operation_key char(64) NOT NULL CHECK (operation_key ~ '^[a-f0-9]{64}$'),
  request_digest char(64) NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  tenant_id uuid NOT NULL REFERENCES deviludo.tenants(id),
  project_id uuid NOT NULL,
  action_id uuid NOT NULL,
  workflow_id text NOT NULL CHECK (length(workflow_id) BETWEEN 3 AND 200),
  run_id uuid NOT NULL,
  provider_revision_id text NOT NULL CHECK (
    provider_revision_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'
  ),
  scheduler_subject text NOT NULL CHECK (
    scheduler_subject ~ '^spiffe://[A-Za-z0-9._~:/-]{3,500}$'
  ),
  signal_id text NOT NULL CHECK (signal_id ~ '^provider-recovery-[a-f0-9-]{36}$'),
  state text NOT NULL DEFAULT 'PENDING' CHECK (state IN ('PENDING', 'COMPLETED')),
  claim_token uuid,
  claim_expires_at timestamptz,
  probe_digest char(64) CHECK (probe_digest IS NULL OR probe_digest ~ '^[a-f0-9]{64}$'),
  probed_at timestamptz,
  completion_outbox_id uuid,
  receipt jsonb CHECK (receipt IS NULL OR (
    jsonb_typeof(receipt) = 'object' AND pg_column_size(receipt) <= 65536
  )),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  PRIMARY KEY (tenant_id, operation_key),
  UNIQUE (tenant_id, project_id, action_id),
  UNIQUE (tenant_id, signal_id),
  FOREIGN KEY (tenant_id, project_id, workflow_id, action_id)
    REFERENCES deviludo.workflow_control_actions(tenant_id, project_id, workflow_id, id),
  FOREIGN KEY (tenant_id, project_id, run_id)
    REFERENCES deviludo.agent_runs(tenant_id, project_id, id),
  FOREIGN KEY (tenant_id, provider_revision_id)
    REFERENCES deviludo.inference_provider_revisions(tenant_id, provider_revision_id),
  FOREIGN KEY (tenant_id, project_id, workflow_id, completion_outbox_id)
    REFERENCES deviludo.workflow_signal_outbox(tenant_id, project_id, workflow_id, id),
  CHECK ((claim_token IS NULL) = (claim_expires_at IS NULL)),
  CHECK (
    (state = 'PENDING' AND probe_digest IS NULL AND probed_at IS NULL
      AND completion_outbox_id IS NULL AND receipt IS NULL AND completed_at IS NULL)
    OR (state = 'COMPLETED' AND claim_token IS NULL AND probe_digest IS NOT NULL
      AND probed_at IS NOT NULL AND completion_outbox_id IS NOT NULL
      AND receipt IS NOT NULL AND completed_at IS NOT NULL)
  )
);

CREATE OR REPLACE FUNCTION deviludo.protect_provider_recovery_check()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.operation_key, NEW.request_digest, NEW.tenant_id, NEW.project_id,
         NEW.action_id, NEW.workflow_id, NEW.run_id, NEW.provider_revision_id,
         NEW.scheduler_subject, NEW.signal_id, NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.operation_key, OLD.request_digest, OLD.tenant_id, OLD.project_id,
         OLD.action_id, OLD.workflow_id, OLD.run_id, OLD.provider_revision_id,
         OLD.scheduler_subject, OLD.signal_id, OLD.created_at) THEN
    RAISE EXCEPTION 'Provider recovery binding is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.state = 'COMPLETED' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'completed Provider recovery is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.state = 'PENDING' AND NEW.state = 'COMPLETED' AND
     (NEW.probe_digest IS NULL OR NEW.probed_at IS NULL
       OR NEW.completion_outbox_id IS NULL OR NEW.receipt IS NULL OR NEW.completed_at IS NULL) THEN
    RAISE EXCEPTION 'Provider recovery completion is incomplete' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER provider_recovery_check_guard
BEFORE UPDATE ON deviludo.provider_recovery_checks
FOR EACH ROW EXECUTE FUNCTION deviludo.protect_provider_recovery_check();
CREATE TRIGGER provider_recovery_check_no_delete
BEFORE DELETE ON deviludo.provider_recovery_checks
FOR EACH ROW EXECUTE FUNCTION deviludo.reject_mutation();

ALTER TABLE deviludo.provider_recovery_checks ENABLE ROW LEVEL SECURITY;
ALTER TABLE deviludo.provider_recovery_checks FORCE ROW LEVEL SECURITY;
CREATE POLICY provider_recovery_tenant_isolation ON deviludo.provider_recovery_checks
  USING (tenant_id = deviludo.current_tenant_id())
  WITH CHECK (tenant_id = deviludo.current_tenant_id());

CREATE INDEX provider_recovery_pending_idx
  ON deviludo.provider_recovery_checks (tenant_id, claim_expires_at, created_at)
  WHERE state = 'PENDING';

COMMIT;
