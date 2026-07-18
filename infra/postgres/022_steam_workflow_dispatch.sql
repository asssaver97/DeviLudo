BEGIN;

-- The operation row is also the durable dispatch outbox. Broker crashes after
-- reserve cannot lose work, and isolated Workers poll only opaque tenant and
-- operation UUIDs before resolving the request under tenant RLS.
ALTER TABLE deviludo.steam_workflow_operations
  ADD COLUMN available_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN last_enqueued_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN enqueue_count integer NOT NULL DEFAULT 1,
  ADD CONSTRAINT steam_workflow_enqueue_count_positive CHECK (enqueue_count >= 1);

DROP INDEX deviludo.steam_workflow_operation_poll_idx;
CREATE INDEX steam_workflow_operation_poll_idx
  ON deviludo.steam_workflow_operations
    (tenant_id, available_at, state, claim_expires_at, updated_at, id)
  WHERE state IN ('PENDING', 'RUNNING');

COMMIT;
