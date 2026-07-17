BEGIN;

ALTER TABLE deviludo.workflow_control_actions
  ADD COLUMN completion_signal_id text,
  ADD COLUMN completion_signal_digest char(64),
  ADD COLUMN completion_source text,
  ADD COLUMN completion_receipt_id text;

ALTER TABLE deviludo.workflow_control_actions
  ADD CONSTRAINT workflow_control_action_completion_shape CHECK (
    (status = 'COMPLETED') =
    (completion_signal_id IS NOT NULL
      AND completion_signal_digest IS NOT NULL
      AND completion_source IS NOT NULL
      AND completion_receipt_id IS NOT NULL
      AND completed_at IS NOT NULL)
  ),
  ADD CONSTRAINT workflow_control_action_signal_digest_shape
    CHECK (completion_signal_digest IS NULL OR completion_signal_digest ~ '^[a-f0-9]{64}$'),
  ADD CONSTRAINT workflow_control_action_source_shape
    CHECK (completion_source IS NULL OR completion_source IN (
      'SPEC_SERVICE', 'USER_ACCEPTANCE_SERVICE', 'PROVIDER_MONITOR',
      'MFA_BROKER', 'STEAM_APPROVAL_MONITOR'
    )),
  ADD CONSTRAINT workflow_control_action_tenant_binding_key
    UNIQUE (tenant_id, project_id, workflow_id, id);

CREATE TABLE deviludo.workflow_signal_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  workflow_id text NOT NULL CHECK (length(workflow_id) BETWEEN 1 AND 512),
  action_id uuid NOT NULL,
  signal_id text NOT NULL CHECK (length(signal_id) BETWEEN 8 AND 200),
  signal_digest char(64) NOT NULL CHECK (signal_digest ~ '^[a-f0-9]{64}$'),
  signal jsonb NOT NULL CHECK (jsonb_typeof(signal) = 'object'),
  state text NOT NULL DEFAULT 'PENDING'
    CHECK (state IN ('PENDING', 'DELIVERING', 'RETRYABLE_FAILED', 'DELIVERED')),
  attempt integer NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  available_at timestamptz NOT NULL DEFAULT now(),
  claimed_by text,
  claim_token uuid,
  claim_expires_at timestamptz,
  error_code text,
  delivered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, signal_id),
  UNIQUE (action_id),
  FOREIGN KEY (tenant_id, project_id, workflow_id, action_id)
    REFERENCES deviludo.workflow_control_actions(tenant_id, project_id, workflow_id, id),
  CHECK ((state = 'DELIVERING') = (claim_token IS NOT NULL)),
  CHECK ((state = 'DELIVERING') = (claimed_by IS NOT NULL)),
  CHECK ((claim_token IS NULL) = (claim_expires_at IS NULL)),
  CHECK ((state = 'DELIVERED') = (delivered_at IS NOT NULL)),
  CHECK (claimed_by IS NULL OR length(claimed_by) BETWEEN 3 AND 160),
  CHECK (error_code IS NULL OR error_code ~ '^[A-Z][A-Z0-9_]{2,99}$'),
  CHECK (pg_column_size(signal) <= 65536)
);

ALTER TABLE deviludo.workflow_signal_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE deviludo.workflow_signal_outbox FORCE ROW LEVEL SECURITY;
CREATE POLICY workflow_signal_outbox_tenant_isolation
  ON deviludo.workflow_signal_outbox
  USING (tenant_id = deviludo.current_tenant_id())
  WITH CHECK (tenant_id = deviludo.current_tenant_id());

CREATE INDEX workflow_signal_outbox_delivery_idx
  ON deviludo.workflow_signal_outbox (tenant_id, available_at, created_at)
  WHERE state IN ('PENDING', 'RETRYABLE_FAILED', 'DELIVERING');

CREATE OR REPLACE FUNCTION deviludo.protect_workflow_action_completion()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'COMPLETED' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'completed workflow action is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER workflow_action_completion_immutable
BEFORE UPDATE ON deviludo.workflow_control_actions
FOR EACH ROW EXECUTE FUNCTION deviludo.protect_workflow_action_completion();

CREATE OR REPLACE FUNCTION deviludo.protect_workflow_signal_outbox_binding()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.id, NEW.tenant_id, NEW.project_id, NEW.workflow_id,
         NEW.action_id, NEW.signal_id, NEW.signal_digest, NEW.signal, NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.id, OLD.tenant_id, OLD.project_id, OLD.workflow_id,
         OLD.action_id, OLD.signal_id, OLD.signal_digest, OLD.signal, OLD.created_at) THEN
    RAISE EXCEPTION 'workflow signal outbox binding is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.state = 'DELIVERED' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'delivered workflow signal is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER workflow_signal_outbox_binding_immutable
BEFORE UPDATE ON deviludo.workflow_signal_outbox
FOR EACH ROW EXECUTE FUNCTION deviludo.protect_workflow_signal_outbox_binding();

CREATE TRIGGER workflow_signal_outbox_no_delete
BEFORE DELETE ON deviludo.workflow_signal_outbox
FOR EACH ROW EXECUTE FUNCTION deviludo.reject_mutation();

COMMIT;
