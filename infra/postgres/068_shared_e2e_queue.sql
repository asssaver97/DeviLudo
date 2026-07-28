BEGIN;

-- E2E machines are a shared fleet. Queue metadata is derived by PostgreSQL
-- from the immutable workflow mode so neither a tenant nor a Runner can buy or
-- forge dispatch priority. Release work leads, interactive candidate work
-- follows, and old background work eventually wins through bounded aging.
ALTER TABLE deviludo.e2e_attempts
  ADD COLUMN queue_lane text,
  ADD COLUMN queue_priority smallint,
  ADD COLUMN queued_at timestamptz,
  ADD COLUMN queue_deadline_at timestamptz,
  ADD COLUMN estimated_duration_seconds integer,
  ADD COLUMN dispatch_not_before timestamptz;

DROP TRIGGER e2e_attempt_workspace_fairness ON deviludo.e2e_attempts;

UPDATE deviludo.e2e_attempts
   SET queue_lane = CASE
         WHEN mode IN ('MAIN_RELEASE_GATE', 'STEAM_CLEAN_INSTALL') THEN 'RELEASE'
         WHEN mode = 'CANDIDATE' THEN 'INTERACTIVE'
         ELSE 'BACKGROUND'
       END,
       queue_priority = CASE
         WHEN mode IN ('MAIN_RELEASE_GATE', 'STEAM_CLEAN_INSTALL') THEN 300
         WHEN mode = 'CANDIDATE' THEN 200
         ELSE 100
       END,
       queued_at = created_at,
       queue_deadline_at = created_at + CASE
         WHEN mode IS NULL THEN interval '24 hours'
         WHEN 'macos' = ANY(target_matrix) THEN interval '10 minutes'
         ELSE interval '5 minutes'
       END,
       estimated_duration_seconds = CASE
         WHEN mode = 'STEAM_CLEAN_INSTALL' THEN 2400 + cardinality(target_matrix) * 900
         WHEN mode = 'MAIN_RELEASE_GATE' THEN 1200 + cardinality(target_matrix) * 600
         WHEN mode = 'CANDIDATE' THEN 900 + cardinality(target_matrix) * 300
         ELSE 1800
       END,
       dispatch_not_before = created_at,
       runner_workload_class = CASE
         WHEN mode = 'STEAM_CLEAN_INSTALL' THEN 'STEAM_INSTALL'
         ELSE runner_workload_class
       END;

CREATE TRIGGER e2e_attempt_workspace_fairness
BEFORE UPDATE OF state,runner_workload_class ON deviludo.e2e_attempts
FOR EACH ROW EXECUTE FUNCTION deviludo.enforce_workspace_e2e_concurrency();

ALTER TABLE deviludo.e2e_attempts
  ALTER COLUMN queue_lane SET NOT NULL,
  ALTER COLUMN queue_priority SET NOT NULL,
  ALTER COLUMN queued_at SET NOT NULL,
  ALTER COLUMN queue_deadline_at SET NOT NULL,
  ALTER COLUMN estimated_duration_seconds SET NOT NULL,
  ALTER COLUMN dispatch_not_before SET NOT NULL,
  ALTER COLUMN queue_lane SET DEFAULT 'BACKGROUND',
  ALTER COLUMN queue_priority SET DEFAULT 100,
  ALTER COLUMN queued_at SET DEFAULT now(),
  ALTER COLUMN queue_deadline_at SET DEFAULT (now() + interval '24 hours'),
  ALTER COLUMN estimated_duration_seconds SET DEFAULT 1800,
  ALTER COLUMN dispatch_not_before SET DEFAULT now(),
  ADD CONSTRAINT e2e_attempt_queue_lane_shape
    CHECK (queue_lane IN ('RELEASE','INTERACTIVE','BACKGROUND')),
  ADD CONSTRAINT e2e_attempt_queue_priority_shape
    CHECK (
      (queue_lane='RELEASE' AND queue_priority=300)
      OR (queue_lane='INTERACTIVE' AND queue_priority=200)
      OR (queue_lane='BACKGROUND' AND queue_priority=100)
    ),
  ADD CONSTRAINT e2e_attempt_queue_mode_binding
    CHECK (
      (mode IN ('MAIN_RELEASE_GATE','STEAM_CLEAN_INSTALL') AND queue_lane='RELEASE')
      OR (mode='CANDIDATE' AND queue_lane='INTERACTIVE')
      OR (mode IS NULL AND queue_lane='BACKGROUND')
    ),
  ADD CONSTRAINT e2e_attempt_queue_time_shape
    CHECK (
      queued_at >= created_at
      AND queue_deadline_at > queued_at
      AND dispatch_not_before >= queued_at
      AND estimated_duration_seconds BETWEEN 60 AND 21600
    ),
  ADD CONSTRAINT e2e_attempt_steam_workload_binding
    CHECK (
      (mode='STEAM_CLEAN_INSTALL' AND runner_workload_class='STEAM_INSTALL')
      OR mode IS DISTINCT FROM 'STEAM_CLEAN_INSTALL'
    );

CREATE OR REPLACE FUNCTION deviludo.derive_e2e_queue_binding()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.queued_at := NEW.created_at;
  NEW.dispatch_not_before := NEW.created_at;
  IF NEW.mode IN ('MAIN_RELEASE_GATE','STEAM_CLEAN_INSTALL') THEN
    NEW.queue_lane := 'RELEASE';
    NEW.queue_priority := 300;
  ELSIF NEW.mode = 'CANDIDATE' THEN
    NEW.queue_lane := 'INTERACTIVE';
    NEW.queue_priority := 200;
  ELSE
    NEW.queue_lane := 'BACKGROUND';
    NEW.queue_priority := 100;
  END IF;
  NEW.queue_deadline_at := NEW.created_at + CASE
    WHEN NEW.mode IS NULL THEN interval '24 hours'
    WHEN 'macos' = ANY(NEW.target_matrix) THEN interval '10 minutes'
    ELSE interval '5 minutes'
  END;
  NEW.estimated_duration_seconds := CASE
    WHEN NEW.mode = 'STEAM_CLEAN_INSTALL' THEN 2400 + cardinality(NEW.target_matrix) * 900
    WHEN NEW.mode = 'MAIN_RELEASE_GATE' THEN 1200 + cardinality(NEW.target_matrix) * 600
    WHEN NEW.mode = 'CANDIDATE' THEN 900 + cardinality(NEW.target_matrix) * 300
    ELSE 1800
  END;
  IF NEW.mode = 'STEAM_CLEAN_INSTALL' THEN
    NEW.runner_workload_class := 'STEAM_INSTALL';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER e2e_attempt_queue_binding
BEFORE INSERT ON deviludo.e2e_attempts
FOR EACH ROW EXECUTE FUNCTION deviludo.derive_e2e_queue_binding();

CREATE OR REPLACE FUNCTION deviludo.protect_e2e_attempt_workflow_binding()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.tenant_id, NEW.project_id, NEW.run_id, NEW.attempt_number,
         NEW.commit_sha, NEW.source_digest, NEW.binding, NEW.target_matrix,
         NEW.workflow_id, NEW.workflow_operation_key,
         NEW.workflow_request_digest, NEW.mode, NEW.draft_pull_request,
         NEW.steam_build_id, NEW.created_at, NEW.runner_workload_class,
         NEW.queue_lane, NEW.queue_priority, NEW.queued_at,
         NEW.queue_deadline_at, NEW.estimated_duration_seconds,
         NEW.dispatch_not_before)
     IS DISTINCT FROM
     ROW(OLD.tenant_id, OLD.project_id, OLD.run_id, OLD.attempt_number,
         OLD.commit_sha, OLD.source_digest, OLD.binding, OLD.target_matrix,
         OLD.workflow_id, OLD.workflow_operation_key,
         OLD.workflow_request_digest, OLD.mode, OLD.draft_pull_request,
         OLD.steam_build_id, OLD.created_at, OLD.runner_workload_class,
         OLD.queue_lane, OLD.queue_priority, OLD.queued_at,
         OLD.queue_deadline_at, OLD.estimated_duration_seconds,
         OLD.dispatch_not_before) THEN
    RAISE EXCEPTION 'e2e attempt workflow and queue binding is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.state IN ('PASSED', 'FAILED', 'INVALIDATED') AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'terminal e2e attempt is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.state = 'QUEUED' AND NEW.state NOT IN ('QUEUED', 'RUNNING', 'INVALIDATED') THEN
    RAISE EXCEPTION 'invalid queued e2e attempt transition' USING ERRCODE = '55000';
  END IF;
  IF OLD.state = 'RUNNING' AND NEW.state NOT IN ('RUNNING', 'PASSED', 'FAILED', 'INVALIDATED') THEN
    RAISE EXCEPTION 'invalid running e2e attempt transition' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;

CREATE INDEX e2e_attempt_shared_queue_idx
  ON deviludo.e2e_attempts
    (tenant_id, state, dispatch_not_before, queue_priority DESC, queued_at, estimated_duration_seconds)
  WHERE state IN ('QUEUED','RUNNING');

CREATE INDEX e2e_attempt_shared_queue_targets_idx
  ON deviludo.e2e_attempts USING gin(target_matrix)
  WHERE state IN ('QUEUED','RUNNING');

COMMIT;
