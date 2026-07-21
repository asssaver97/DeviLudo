BEGIN;

-- Automatic recovery attempts are scheduled in the same RLS-protected ledger.
-- The bounded backoff is operational metadata only; no Provider response or
-- credential material is persisted here.
ALTER TABLE deviludo.provider_recovery_checks
  ADD COLUMN attempt_count integer NOT NULL DEFAULT 0
    CHECK (attempt_count BETWEEN 0 AND 1000000),
  ADD COLUMN next_probe_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN last_failure_code text CHECK (
    last_failure_code IS NULL OR last_failure_code IN (
      'PROVIDER_PROBE_FAILED',
      'PROVIDER_RECOVERY_DELIVERY_FAILED'
    )
  );

CREATE INDEX provider_recovery_due_idx
  ON deviludo.provider_recovery_checks (tenant_id, next_probe_at, created_at)
  WHERE state = 'PENDING';

CREATE OR REPLACE FUNCTION deviludo.protect_provider_recovery_check()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.operation_key, NEW.request_digest, NEW.tenant_id, NEW.project_id,
         NEW.action_id, NEW.workflow_id, NEW.run_id, NEW.provider_revision_id,
         NEW.scheduler_subject, NEW.signal_id, NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.operation_key, OLD.request_digest, OLD.tenant_id, OLD.project_id,
         OLD.action_id, OLD.workflow_id, OLD.run_id, OLD.provider_revision_id,
         OLD.scheduler_subject, OLD.signal_id, OLD.created_at) THEN
    RAISE EXCEPTION 'Provider recovery binding is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.state = 'COMPLETED' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'completed Provider recovery is immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW.attempt_count < OLD.attempt_count OR NEW.attempt_count > OLD.attempt_count + 1 THEN
    RAISE EXCEPTION 'Provider recovery attempt sequence is invalid' USING ERRCODE = '55000';
  END IF;
  IF OLD.state = 'PENDING' AND NEW.state = 'COMPLETED' AND
     (NEW.probe_digest IS NULL OR NEW.probed_at IS NULL
       OR NEW.completion_outbox_id IS NULL OR NEW.receipt IS NULL OR NEW.completed_at IS NULL) THEN
    RAISE EXCEPTION 'Provider recovery completion is incomplete' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;

COMMIT;
