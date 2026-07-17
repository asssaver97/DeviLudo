BEGIN;

-- A workflow request may be scheduled only after artifact preparation has
-- frozen every executable input. The payload is content-addressed and the
-- request digest is its tenant-scoped idempotency key; no Runner receives an
-- object key, toolchain or Steam install grant reconstructed from mutable data.
CREATE TABLE deviludo.runner_execution_locks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES deviludo.tenants(id),
  project_id uuid NOT NULL REFERENCES deviludo.projects(id),
  run_id uuid NOT NULL REFERENCES deviludo.agent_runs(id),
  lock_key char(64) NOT NULL CHECK (lock_key ~ '^[a-f0-9]{64}$'),
  mode text NOT NULL CHECK (mode IN ('CANDIDATE', 'MAIN_RELEASE_GATE', 'STEAM_CLEAN_INSTALL')),
  commit_sha text NOT NULL CHECK (commit_sha ~ '^[a-f0-9]{40}$'),
  source_digest text NOT NULL CHECK (source_digest ~ '^[a-f0-9]{64}$'),
  steam_build_id text CHECK (steam_build_id ~ '^[1-9][0-9]{0,19}$'),
  target_matrix text[] NOT NULL,
  payload jsonb NOT NULL,
  payload_digest char(64) NOT NULL CHECK (payload_digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, lock_key),
  UNIQUE (tenant_id, project_id, run_id, id),
  CHECK (jsonb_typeof(payload) = 'object' AND pg_column_size(payload) <= 262144),
  CHECK (
    cardinality(target_matrix) BETWEEN 1 AND 3
      AND target_matrix <@ ARRAY['windows', 'linux', 'macos']::text[]
      AND array_lower(target_matrix, 1) = 1
      AND array_position(target_matrix, NULL) IS NULL
      AND (target_matrix[2] IS NULL OR target_matrix[2] <> target_matrix[1])
      AND (target_matrix[3] IS NULL OR
        (target_matrix[3] <> target_matrix[1] AND target_matrix[3] <> target_matrix[2]))
  ),
  CHECK (
    (mode IN ('CANDIDATE', 'MAIN_RELEASE_GATE') AND steam_build_id IS NULL)
    OR (mode = 'STEAM_CLEAN_INSTALL' AND steam_build_id IS NOT NULL)
  )
);

ALTER TABLE deviludo.runner_execution_locks ENABLE ROW LEVEL SECURITY;
ALTER TABLE deviludo.runner_execution_locks FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON deviludo.runner_execution_locks
  USING (tenant_id = deviludo.current_tenant_id())
  WITH CHECK (tenant_id = deviludo.current_tenant_id());

CREATE TRIGGER runner_execution_locks_append_only
BEFORE UPDATE OR DELETE ON deviludo.runner_execution_locks
FOR EACH ROW EXECUTE FUNCTION deviludo.reject_mutation();

ALTER TABLE deviludo.e2e_attempts
  ADD COLUMN execution_lock_id uuid,
  ADD CONSTRAINT e2e_attempt_execution_lock_fk
    FOREIGN KEY (tenant_id, project_id, run_id, execution_lock_id)
    REFERENCES deviludo.runner_execution_locks (tenant_id, project_id, run_id, id),
  ADD CONSTRAINT e2e_attempt_workflow_requires_execution_lock CHECK (
    workflow_operation_key IS NULL OR execution_lock_id IS NOT NULL
  ) NOT VALID;

CREATE INDEX runner_execution_lock_run_idx
  ON deviludo.runner_execution_locks (tenant_id, project_id, run_id, created_at);
CREATE INDEX e2e_attempt_execution_lock_idx
  ON deviludo.e2e_attempts (execution_lock_id)
  WHERE execution_lock_id IS NOT NULL;

CREATE OR REPLACE FUNCTION deviludo.protect_e2e_attempt_workflow_binding()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.tenant_id, NEW.project_id, NEW.run_id, NEW.attempt_number,
         NEW.commit_sha, NEW.source_digest, NEW.binding, NEW.target_matrix,
         NEW.workflow_id, NEW.workflow_operation_key,
         NEW.workflow_request_digest, NEW.mode, NEW.draft_pull_request,
         NEW.steam_build_id, NEW.execution_lock_id, NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.tenant_id, OLD.project_id, OLD.run_id, OLD.attempt_number,
         OLD.commit_sha, OLD.source_digest, OLD.binding, OLD.target_matrix,
         OLD.workflow_id, OLD.workflow_operation_key,
         OLD.workflow_request_digest, OLD.mode, OLD.draft_pull_request,
         OLD.steam_build_id, OLD.execution_lock_id, OLD.created_at) THEN
    RAISE EXCEPTION 'e2e attempt workflow binding is immutable' USING ERRCODE = '55000';
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

COMMIT;
