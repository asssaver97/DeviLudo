BEGIN;

-- A browser never supplies workflow or execution authority when cancelling a
-- delivery. The user-acceptance workload resolves the current replay-validated
-- projection under tenant RLS and records that exact state/history binding
-- before sending one idempotent Temporal signal.
CREATE TABLE deviludo.delivery_cancellation_requests (
  operation_key text PRIMARY KEY CHECK (operation_key ~ '^[a-f0-9]{64}$'),
  tenant_id uuid NOT NULL REFERENCES deviludo.tenants(id),
  project_id uuid NOT NULL,
  actor_id uuid NOT NULL,
  request_digest char(64) NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 2000),
  workflow_id text NOT NULL CHECK (workflow_id ~ '^delivery-[a-f0-9-]{36}$'),
  projection_sequence bigint NOT NULL CHECK (projection_sequence BETWEEN 0 AND 100000),
  projection_key text NOT NULL CHECK (
    length(projection_key) BETWEEN 32 AND 512 AND projection_key !~ '[[:cntrl:]]'
  ),
  projection_state text NOT NULL CHECK (projection_state IN (
    'IDEATION', 'WAITING_SPEC_APPROVAL', 'RESOLVING_AGENT_CONFIGURATION',
    'DEVELOPMENT_QUEUED', 'DEVELOPING', 'WAITING_PROVIDER',
    'CROSS_PLATFORM_E2E', 'WAITING_USER_ACCEPTANCE', 'MERGING',
    'MAIN_SHA_E2E', 'WAITING_MFA', 'STEAM_PRIVATE_BETA',
    'STEAM_INSTALL_E2E', 'EXTERNAL_APPROVAL_REQUIRED'
  )),
  projection_digest char(64) NOT NULL CHECK (projection_digest ~ '^[a-f0-9]{64}$'),
  signal_id text NOT NULL CHECK (signal_id ~ '^cancel-[a-f0-9-]{36}$'),
  state text NOT NULL CHECK (state IN ('PENDING_DELIVERY', 'DELIVERED')),
  completion_receipt jsonb,
  requested_at timestamptz NOT NULL,
  delivered_at timestamptz,
  UNIQUE (tenant_id, signal_id),
  UNIQUE (tenant_id, project_id, workflow_id, operation_key),
  FOREIGN KEY (tenant_id, project_id)
    REFERENCES deviludo.projects(tenant_id, id),
  FOREIGN KEY (tenant_id, actor_id)
    REFERENCES deviludo.users(tenant_id, id),
  FOREIGN KEY (tenant_id, project_id, workflow_id)
    REFERENCES deviludo.spec_delivery_workflows(tenant_id, project_id, workflow_id),
  FOREIGN KEY (
    tenant_id, project_id, workflow_id, projection_sequence,
    projection_key, projection_state, projection_digest
  ) REFERENCES deviludo.delivery_state_projection_events(
    tenant_id, project_id, workflow_id, projection_sequence,
    projection_key, state, snapshot_digest
  ),
  CHECK (
    (state = 'PENDING_DELIVERY' AND completion_receipt IS NULL AND delivered_at IS NULL)
    OR
    (state = 'DELIVERED' AND jsonb_typeof(completion_receipt) = 'object'
      AND completion_receipt->>'state' = 'CANCEL_REQUESTED'
      AND completion_receipt->>'operationKey' = operation_key
      AND completion_receipt->>'tenantId' = tenant_id::text
      AND completion_receipt->>'projectId' = project_id::text
      AND completion_receipt->>'actorId' = actor_id::text
      AND completion_receipt->>'reason' = reason
      AND completion_receipt->>'workflowId' = workflow_id
      AND (completion_receipt->>'projectionSequence')::bigint = projection_sequence
      AND completion_receipt->>'projectionKey' = projection_key
      AND completion_receipt->>'projectionState' = projection_state
      AND completion_receipt->>'projectionDigest' = projection_digest
      AND completion_receipt->>'signalId' = signal_id
      AND delivered_at IS NOT NULL)
  ),
  CHECK (pg_column_size(completion_receipt) <= 65536)
);

CREATE OR REPLACE FUNCTION deviludo.protect_delivery_cancellation_request()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.operation_key, NEW.tenant_id, NEW.project_id, NEW.actor_id,
         NEW.request_digest, NEW.reason, NEW.workflow_id,
         NEW.projection_sequence, NEW.projection_key, NEW.projection_state,
         NEW.projection_digest, NEW.signal_id, NEW.requested_at)
     IS DISTINCT FROM
     ROW(OLD.operation_key, OLD.tenant_id, OLD.project_id, OLD.actor_id,
         OLD.request_digest, OLD.reason, OLD.workflow_id,
         OLD.projection_sequence, OLD.projection_key, OLD.projection_state,
         OLD.projection_digest, OLD.signal_id, OLD.requested_at)
     OR OLD.state = 'DELIVERED'
     OR OLD.state <> 'PENDING_DELIVERY'
     OR NEW.state <> 'DELIVERED' THEN
    RAISE EXCEPTION 'delivery cancellation request is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER delivery_cancellation_request_guard
BEFORE UPDATE ON deviludo.delivery_cancellation_requests
FOR EACH ROW EXECUTE FUNCTION deviludo.protect_delivery_cancellation_request();
CREATE TRIGGER delivery_cancellation_request_no_delete
BEFORE DELETE ON deviludo.delivery_cancellation_requests
FOR EACH ROW EXECUTE FUNCTION deviludo.reject_mutation();

ALTER TABLE deviludo.delivery_cancellation_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE deviludo.delivery_cancellation_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY delivery_cancellation_requests_tenant_isolation
  ON deviludo.delivery_cancellation_requests
  USING (tenant_id = deviludo.current_tenant_id())
  WITH CHECK (tenant_id = deviludo.current_tenant_id());

CREATE INDEX delivery_cancellation_request_delivery_idx
  ON deviludo.delivery_cancellation_requests (tenant_id, state, requested_at)
  WHERE state = 'PENDING_DELIVERY';

-- Cancellation completion is the terminal owner of this workflow binding.
-- Existing rows are repaired during upgrade; fresh cancellations are handled
-- by the revocation trigger below after the control plane fences authorities.
UPDATE deviludo.spec_delivery_workflows workflow
   SET state = 'TERMINAL'
 WHERE workflow.state = 'ACTIVE'
   AND EXISTS (
     SELECT 1 FROM deviludo.delivery_cancellation_revocations cancellation
      WHERE cancellation.tenant_id = workflow.tenant_id
        AND cancellation.project_id = workflow.project_id
        AND cancellation.workflow_id = workflow.workflow_id
   );

CREATE OR REPLACE FUNCTION deviludo.mark_cancelled_delivery_workflow_terminal()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE deviludo.spec_delivery_workflows
     SET state = 'TERMINAL'
   WHERE tenant_id = NEW.tenant_id
     AND project_id = NEW.project_id
     AND workflow_id = NEW.workflow_id
     AND state = 'ACTIVE';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'cancelled delivery workflow was not active' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER delivery_cancellation_workflow_terminal
AFTER INSERT ON deviludo.delivery_cancellation_revocations
FOR EACH ROW EXECUTE FUNCTION deviludo.mark_cancelled_delivery_workflow_terminal();

COMMIT;
