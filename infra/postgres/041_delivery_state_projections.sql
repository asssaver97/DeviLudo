BEGIN;

-- Temporal is the only workflow authority. These rows are a replay-validated,
-- append-only event stream plus a monotonic current projection for Web reads.
CREATE TABLE deviludo.delivery_state_projection_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES deviludo.tenants(id),
  project_id uuid NOT NULL,
  workflow_id text NOT NULL,
  projection_sequence bigint NOT NULL CHECK (projection_sequence BETWEEN 0 AND 100000),
  projection_key text NOT NULL CHECK (
    length(projection_key) BETWEEN 32 AND 512
      AND projection_key !~ '[[:cntrl:]]'
  ),
  state text NOT NULL CHECK (state IN (
    'IDEATION', 'WAITING_SPEC_APPROVAL', 'RESOLVING_AGENT_CONFIGURATION',
    'DEVELOPMENT_QUEUED', 'DEVELOPING', 'WAITING_PROVIDER',
    'CROSS_PLATFORM_E2E', 'WAITING_USER_ACCEPTANCE', 'MERGING',
    'MAIN_SHA_E2E', 'WAITING_MFA', 'STEAM_PRIVATE_BETA',
    'STEAM_INSTALL_E2E', 'EXTERNAL_APPROVAL_REQUIRED', 'READY_TO_PUBLISH',
    'RELEASED', 'CANCELLED'
  )),
  snapshot_digest char(64) NOT NULL CHECK (snapshot_digest ~ '^[a-f0-9]{64}$'),
  snapshot jsonb NOT NULL CHECK (
    jsonb_typeof(snapshot) = 'object'
      AND jsonb_typeof(snapshot->'history') = 'array'
      AND jsonb_array_length(snapshot->'history') = projection_sequence
      AND snapshot->>'tenantId' = tenant_id::text
      AND snapshot->>'projectId' = project_id::text
      AND snapshot->>'workflowId' = workflow_id
      AND snapshot->>'state' = state
      AND pg_column_size(snapshot) <= 4194304
  ),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, project_id, workflow_id)
    REFERENCES deviludo.spec_delivery_workflows(tenant_id, project_id, workflow_id),
  UNIQUE (tenant_id, projection_key),
  UNIQUE (tenant_id, project_id, workflow_id, projection_sequence),
  UNIQUE (
    tenant_id, project_id, workflow_id, projection_sequence,
    projection_key, state, snapshot_digest
  )
);

CREATE TABLE deviludo.delivery_state_projections (
  tenant_id uuid NOT NULL REFERENCES deviludo.tenants(id),
  project_id uuid NOT NULL,
  workflow_id text NOT NULL,
  projection_sequence bigint NOT NULL CHECK (projection_sequence BETWEEN 0 AND 100000),
  projection_key text NOT NULL,
  state text NOT NULL,
  snapshot_digest char(64) NOT NULL,
  snapshot jsonb NOT NULL CHECK (
    jsonb_typeof(snapshot) = 'object'
      AND jsonb_typeof(snapshot->'history') = 'array'
      AND jsonb_array_length(snapshot->'history') = projection_sequence
      AND snapshot->>'tenantId' = tenant_id::text
      AND snapshot->>'projectId' = project_id::text
      AND snapshot->>'workflowId' = workflow_id
      AND snapshot->>'state' = state
      AND pg_column_size(snapshot) <= 4194304
  ),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, project_id),
  FOREIGN KEY (
    tenant_id, project_id, workflow_id, projection_sequence,
    projection_key, state, snapshot_digest
  ) REFERENCES deviludo.delivery_state_projection_events(
    tenant_id, project_id, workflow_id, projection_sequence,
    projection_key, state, snapshot_digest
  )
);

CREATE OR REPLACE FUNCTION deviludo.protect_delivery_state_projection()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.tenant_id, NEW.project_id, NEW.workflow_id)
       IS DISTINCT FROM ROW(OLD.tenant_id, OLD.project_id, OLD.workflow_id)
     OR NEW.projection_sequence <> OLD.projection_sequence + 1
     OR OLD.state IN ('RELEASED', 'CANCELLED')
     OR NEW.updated_at <= OLD.updated_at THEN
    RAISE EXCEPTION 'delivery state projection must advance monotonically' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER delivery_state_projection_event_append_only
BEFORE UPDATE OR DELETE ON deviludo.delivery_state_projection_events
FOR EACH ROW EXECUTE FUNCTION deviludo.reject_mutation();
CREATE TRIGGER delivery_state_projection_guard
BEFORE UPDATE ON deviludo.delivery_state_projections
FOR EACH ROW EXECUTE FUNCTION deviludo.protect_delivery_state_projection();
CREATE TRIGGER delivery_state_projection_no_delete
BEFORE DELETE ON deviludo.delivery_state_projections
FOR EACH ROW EXECUTE FUNCTION deviludo.reject_mutation();

ALTER TABLE deviludo.delivery_state_projection_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE deviludo.delivery_state_projection_events FORCE ROW LEVEL SECURITY;
CREATE POLICY delivery_state_projection_events_tenant_isolation
  ON deviludo.delivery_state_projection_events
  USING (tenant_id = deviludo.current_tenant_id())
  WITH CHECK (tenant_id = deviludo.current_tenant_id());

ALTER TABLE deviludo.delivery_state_projections ENABLE ROW LEVEL SECURITY;
ALTER TABLE deviludo.delivery_state_projections FORCE ROW LEVEL SECURITY;
CREATE POLICY delivery_state_projections_tenant_isolation
  ON deviludo.delivery_state_projections
  USING (tenant_id = deviludo.current_tenant_id())
  WITH CHECK (tenant_id = deviludo.current_tenant_id());

CREATE INDEX delivery_state_projection_event_history_idx
  ON deviludo.delivery_state_projection_events
  (tenant_id, project_id, workflow_id, projection_sequence DESC);
CREATE INDEX delivery_state_projection_state_idx
  ON deviludo.delivery_state_projections (tenant_id, state, updated_at DESC);

COMMIT;
