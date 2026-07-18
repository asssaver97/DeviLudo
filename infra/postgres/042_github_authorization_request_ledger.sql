BEGIN;

-- This ledger intentionally stores no response body: begin/setup responses
-- contain raw OAuth state. Completed retries must restart authorization rather
-- than recover that secret-bearing response from PostgreSQL.
CREATE TABLE deviludo.github_authorization_request_ledger (
  tenant_id uuid NOT NULL REFERENCES deviludo.tenants(id),
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$'),
  operation text NOT NULL CHECK (operation IN ('BEGIN', 'SETUP', 'COMPLETE')),
  request_digest text NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  status text NOT NULL CHECK (status IN ('CLAIMED', 'COMPLETED')),
  claim_token uuid,
  claim_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  PRIMARY KEY (tenant_id, idempotency_key),
  CHECK ((status = 'CLAIMED' AND claim_token IS NOT NULL AND claim_expires_at IS NOT NULL AND completed_at IS NULL)
    OR (status = 'COMPLETED' AND claim_token IS NULL AND claim_expires_at IS NULL AND completed_at IS NOT NULL))
);

ALTER TABLE deviludo.github_authorization_request_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE deviludo.github_authorization_request_ledger FORCE ROW LEVEL SECURITY;
CREATE POLICY github_authorization_request_ledger_tenant_isolation
  ON deviludo.github_authorization_request_ledger
  USING (tenant_id = deviludo.current_tenant_id())
  WITH CHECK (tenant_id = deviludo.current_tenant_id());

CREATE INDEX github_authorization_request_claim_expiry_idx
  ON deviludo.github_authorization_request_ledger (claim_expires_at)
  WHERE status = 'CLAIMED';

CREATE OR REPLACE FUNCTION deviludo.protect_completed_github_authorization_request()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'COMPLETED' THEN
    RAISE EXCEPTION 'completed GitHub authorization request ledger rows are immutable';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE TRIGGER github_authorization_request_terminal_guard
BEFORE UPDATE OR DELETE ON deviludo.github_authorization_request_ledger
FOR EACH ROW EXECUTE FUNCTION deviludo.protect_completed_github_authorization_request();

COMMIT;
