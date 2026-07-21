BEGIN;

-- mTLS-authenticated Steam verifier observations are staged before they may
-- complete a WAIT_FOR_EXTERNAL_APPROVAL action. Raw Steam responses and
-- credentials stay in the verifier; this ledger retains only their digest.
CREATE TABLE deviludo.steam_external_approval_observations (
  operation_key char(64) NOT NULL CHECK (operation_key ~ '^[a-f0-9]{64}$'),
  request_digest char(64) NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  tenant_id uuid NOT NULL REFERENCES deviludo.tenants(id),
  project_id uuid NOT NULL,
  action_id uuid NOT NULL,
  workflow_id text NOT NULL CHECK (length(workflow_id) BETWEEN 3 AND 200),
  verifier_subject text NOT NULL CHECK (
    verifier_subject ~ '^spiffe://[A-Za-z0-9._~:/-]{3,500}$'
  ),
  gate text NOT NULL CHECK (gate IN (
    'VALVE_REVIEW', 'FIRST_RELEASE', 'DEFAULT_BRANCH_CONFIRMATION'
  )),
  observation_kind text NOT NULL CHECK (
    (gate = 'VALVE_REVIEW' AND observation_kind = 'VALVE_REVIEW_APPROVED')
    OR (gate = 'FIRST_RELEASE' AND observation_kind = 'FIRST_RELEASE_COMPLETED')
    OR (gate = 'DEFAULT_BRANCH_CONFIRMATION' AND observation_kind = 'DEFAULT_BRANCH_CONFIRMED')
  ),
  steam_app_id text NOT NULL CHECK (steam_app_id ~ '^[1-9][0-9]{0,19}$'),
  steam_build_id text NOT NULL CHECK (steam_build_id ~ '^[1-9][0-9]{0,19}$'),
  approval_id text NOT NULL CHECK (
    approval_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,159}$'
  ),
  observation_digest char(64) NOT NULL CHECK (observation_digest ~ '^[a-f0-9]{64}$'),
  observed_at timestamptz NOT NULL,
  signal_id text NOT NULL CHECK (signal_id ~ '^steam-approval-[a-f0-9-]{36}$'),
  state text NOT NULL DEFAULT 'PENDING' CHECK (state IN ('PENDING', 'COMPLETED')),
  claim_token uuid,
  claim_expires_at timestamptz,
  completion_outbox_id uuid,
  receipt jsonb CHECK (receipt IS NULL OR (
    jsonb_typeof(receipt) = 'object' AND pg_column_size(receipt) <= 65536
  )),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  PRIMARY KEY (tenant_id, operation_key),
  UNIQUE (tenant_id, project_id, action_id),
  UNIQUE (tenant_id, approval_id),
  UNIQUE (tenant_id, signal_id),
  FOREIGN KEY (tenant_id, project_id, workflow_id, action_id)
    REFERENCES deviludo.workflow_control_actions(tenant_id, project_id, workflow_id, id),
  FOREIGN KEY (tenant_id, project_id, workflow_id, completion_outbox_id)
    REFERENCES deviludo.workflow_signal_outbox(tenant_id, project_id, workflow_id, id),
  CHECK ((claim_token IS NULL) = (claim_expires_at IS NULL)),
  CHECK (
    (state = 'PENDING' AND completion_outbox_id IS NULL AND receipt IS NULL AND completed_at IS NULL)
    OR (state = 'COMPLETED' AND claim_token IS NULL AND completion_outbox_id IS NOT NULL
      AND receipt IS NOT NULL AND completed_at IS NOT NULL)
  )
);

CREATE OR REPLACE FUNCTION deviludo.protect_steam_external_approval_observation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.operation_key, NEW.request_digest, NEW.tenant_id, NEW.project_id,
         NEW.action_id, NEW.workflow_id, NEW.verifier_subject, NEW.gate,
         NEW.observation_kind, NEW.steam_app_id, NEW.steam_build_id,
         NEW.approval_id, NEW.observation_digest, NEW.observed_at,
         NEW.signal_id, NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.operation_key, OLD.request_digest, OLD.tenant_id, OLD.project_id,
         OLD.action_id, OLD.workflow_id, OLD.verifier_subject, OLD.gate,
         OLD.observation_kind, OLD.steam_app_id, OLD.steam_build_id,
         OLD.approval_id, OLD.observation_digest, OLD.observed_at,
         OLD.signal_id, OLD.created_at) THEN
    RAISE EXCEPTION 'Steam external approval binding is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.state = 'COMPLETED' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'completed Steam external approval is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.state = 'PENDING' AND NEW.state = 'COMPLETED' AND
     (NEW.completion_outbox_id IS NULL OR NEW.receipt IS NULL OR NEW.completed_at IS NULL) THEN
    RAISE EXCEPTION 'Steam external approval completion is incomplete' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER steam_external_approval_observation_guard
BEFORE UPDATE ON deviludo.steam_external_approval_observations
FOR EACH ROW EXECUTE FUNCTION deviludo.protect_steam_external_approval_observation();

CREATE TRIGGER steam_external_approval_observation_no_delete
BEFORE DELETE ON deviludo.steam_external_approval_observations
FOR EACH ROW EXECUTE FUNCTION deviludo.reject_mutation();

ALTER TABLE deviludo.steam_external_approval_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE deviludo.steam_external_approval_observations FORCE ROW LEVEL SECURITY;
CREATE POLICY steam_external_approval_tenant_isolation
  ON deviludo.steam_external_approval_observations
  USING (tenant_id = deviludo.current_tenant_id())
  WITH CHECK (tenant_id = deviludo.current_tenant_id());

CREATE INDEX steam_external_approval_pending_idx
  ON deviludo.steam_external_approval_observations (tenant_id, claim_expires_at, created_at)
  WHERE state = 'PENDING';

COMMIT;
