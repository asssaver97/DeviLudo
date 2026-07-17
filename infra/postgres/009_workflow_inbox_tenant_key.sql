BEGIN;

-- Idempotency is scoped to the authorized tenant. A global primary key lets a
-- row hidden by RLS prevent another tenant from claiming the same deterministic
-- workflow key, which is both an availability bug and a cross-tenant signal.
ALTER TABLE deviludo.workflow_command_inbox
  DROP CONSTRAINT workflow_command_inbox_pkey;

ALTER TABLE deviludo.workflow_command_inbox
  ADD CONSTRAINT workflow_command_inbox_pkey
  PRIMARY KEY (tenant_id, idempotency_key);

COMMIT;
