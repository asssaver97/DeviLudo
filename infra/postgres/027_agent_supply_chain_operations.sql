BEGIN;

-- Global Agent binary/image operations are platform-scoped rather than tenant
-- scoped. Workload identity is enforced by the mTLS Broker; only immutable
-- request/receipt digests cross this durable boundary.
CREATE TABLE deviludo.agent_supply_chain_operations (
  operation_key char(64) PRIMARY KEY CHECK (operation_key ~ '^[a-f0-9]{64}$'),
  request_digest char(64) NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  kind text NOT NULL CHECK (kind IN ('DISCOVER', 'VALIDATE', 'BUILD', 'ROLLOUT')),
  payload_digest char(64) NOT NULL CHECK (payload_digest ~ '^[a-f0-9]{64}$'),
  request_payload jsonb NOT NULL CHECK (
    jsonb_typeof(request_payload) = 'object' AND pg_column_size(request_payload) <= 262144
  ),
  state text NOT NULL CHECK (state IN ('PENDING', 'RUNNING', 'COMPLETED')),
  claim_token uuid,
  claim_expires_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  response_payload jsonb CHECK (
    response_payload IS NULL OR (jsonb_typeof(response_payload) = 'object' AND pg_column_size(response_payload) <= 2097152)
  ),
  response_digest char(64) CHECK (response_digest IS NULL OR response_digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  completed_at timestamptz,
  CHECK ((claim_token IS NULL) = (claim_expires_at IS NULL)),
  CHECK (
    (state = 'PENDING' AND claim_token IS NULL AND response_payload IS NULL
      AND response_digest IS NULL AND completed_at IS NULL)
    OR (state = 'RUNNING' AND claim_token IS NOT NULL AND attempt_count > 0
      AND response_payload IS NULL AND response_digest IS NULL AND completed_at IS NULL)
    OR (state = 'COMPLETED' AND claim_token IS NULL AND attempt_count > 0
      AND response_payload IS NOT NULL AND response_digest IS NOT NULL AND completed_at IS NOT NULL)
  )
);

CREATE OR REPLACE FUNCTION deviludo.protect_agent_supply_chain_operation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.operation_key, NEW.request_digest, NEW.kind, NEW.payload_digest,
         NEW.request_payload, NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.operation_key, OLD.request_digest, OLD.kind, OLD.payload_digest,
         OLD.request_payload, OLD.created_at) THEN
    RAISE EXCEPTION 'agent supply-chain operation binding is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.state = 'COMPLETED' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'completed agent supply-chain operation is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.state = 'PENDING' AND NEW.state NOT IN ('PENDING', 'RUNNING') THEN
    RAISE EXCEPTION 'invalid pending agent supply-chain transition' USING ERRCODE = '55000';
  END IF;
  IF OLD.state = 'RUNNING' AND NEW.state NOT IN ('PENDING', 'RUNNING', 'COMPLETED') THEN
    RAISE EXCEPTION 'invalid running agent supply-chain transition' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER agent_supply_chain_operation_binding_immutable
BEFORE UPDATE ON deviludo.agent_supply_chain_operations
FOR EACH ROW EXECUTE FUNCTION deviludo.protect_agent_supply_chain_operation();

CREATE TRIGGER agent_supply_chain_operation_no_delete
BEFORE DELETE ON deviludo.agent_supply_chain_operations
FOR EACH ROW EXECUTE FUNCTION deviludo.reject_mutation();

CREATE INDEX agent_supply_chain_operation_claim_idx
  ON deviludo.agent_supply_chain_operations (state, claim_expires_at, updated_at)
  WHERE state IN ('PENDING', 'RUNNING');

COMMIT;
