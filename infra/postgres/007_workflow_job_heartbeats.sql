BEGIN;

-- Permit lease heartbeats without incrementing an attempt. A RUNNING job only
-- increments its attempt when a different claim token reclaims the lease.
CREATE OR REPLACE FUNCTION deviludo.protect_workflow_job_binding()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.id, NEW.tenant_id, NEW.project_id, NEW.workflow_id,
         NEW.idempotency_key, NEW.destination, NEW.operation,
         NEW.request_digest, NEW.request_body, NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.id, OLD.tenant_id, OLD.project_id, OLD.workflow_id,
         OLD.idempotency_key, OLD.destination, OLD.operation,
         OLD.request_digest, OLD.request_body, OLD.created_at) THEN
    RAISE EXCEPTION 'workflow job binding is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.state IN ('COMPLETED', 'TERMINAL_FAILED', 'CANCELLED') THEN
    RAISE EXCEPTION 'terminal workflow job is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.state = 'RUNNING' AND NEW.state NOT IN (
    'RUNNING', 'COMPLETED', 'RETRYABLE_FAILED', 'TERMINAL_FAILED', 'CANCELLED'
  ) THEN
    RAISE EXCEPTION 'invalid running workflow job transition' USING ERRCODE = '55000';
  END IF;
  IF OLD.state IN ('QUEUED', 'RETRYABLE_FAILED') AND NEW.state NOT IN (
    'QUEUED', 'RUNNING', 'CANCELLED'
  ) THEN
    RAISE EXCEPTION 'invalid queued workflow job transition' USING ERRCODE = '55000';
  END IF;
  IF NEW.state = 'RUNNING' AND OLD.state <> 'RUNNING'
     AND NEW.attempt <> OLD.attempt + 1 THEN
    RAISE EXCEPTION 'workflow job attempt must advance exactly once' USING ERRCODE = '55000';
  END IF;
  IF OLD.state = 'RUNNING' AND NEW.state = 'RUNNING' THEN
    IF NEW.claim_token IS NOT DISTINCT FROM OLD.claim_token THEN
      IF NEW.attempt <> OLD.attempt OR NEW.claimed_by IS DISTINCT FROM OLD.claimed_by THEN
        RAISE EXCEPTION 'workflow job heartbeat changed its claim' USING ERRCODE = '55000';
      END IF;
    ELSIF NEW.attempt <> OLD.attempt + 1 THEN
      RAISE EXCEPTION 'expired workflow job reclaim must advance attempt' USING ERRCODE = '55000';
    END IF;
  END IF;
  IF NEW.state <> 'RUNNING' AND NEW.attempt <> OLD.attempt THEN
    RAISE EXCEPTION 'workflow job attempt changed outside a claim' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;

COMMIT;
