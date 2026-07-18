BEGIN;

ALTER TABLE deviludo.projects
  ADD COLUMN created_by text;

CREATE TABLE deviludo.project_creation_operations (
  tenant_id uuid NOT NULL REFERENCES deviludo.tenants(id),
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$'),
  actor_id text NOT NULL,
  github_user_id bigint NOT NULL CHECK (github_user_id > 0),
  request_digest text NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  status text NOT NULL CHECK (status IN ('CLAIMED', 'COMPLETED')),
  claim_token uuid,
  claim_expires_at timestamptz,
  response jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  PRIMARY KEY (tenant_id, idempotency_key),
  CHECK ((status = 'CLAIMED' AND claim_token IS NOT NULL AND claim_expires_at IS NOT NULL
      AND response IS NULL AND completed_at IS NULL)
    OR (status = 'COMPLETED' AND claim_token IS NULL AND claim_expires_at IS NULL
      AND jsonb_typeof(response) = 'object' AND completed_at IS NOT NULL))
);

ALTER TABLE deviludo.project_creation_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE deviludo.project_creation_operations FORCE ROW LEVEL SECURITY;
CREATE POLICY project_creation_operation_tenant_isolation
  ON deviludo.project_creation_operations
  USING (tenant_id = deviludo.current_tenant_id())
  WITH CHECK (tenant_id = deviludo.current_tenant_id());

CREATE INDEX project_creation_operation_claim_idx
  ON deviludo.project_creation_operations (claim_expires_at)
  WHERE status = 'CLAIMED';

CREATE OR REPLACE FUNCTION deviludo.protect_completed_project_creation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'COMPLETED' THEN
    RAISE EXCEPTION 'completed project creation operations are immutable';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE TRIGGER project_creation_terminal_guard
BEFORE UPDATE OR DELETE ON deviludo.project_creation_operations
FOR EACH ROW EXECUTE FUNCTION deviludo.protect_completed_project_creation();

COMMIT;
