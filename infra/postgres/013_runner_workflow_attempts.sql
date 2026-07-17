BEGIN;

-- A merged main head is a new source snapshot. It must never inherit the
-- candidate digest implicitly because GitHub may create a merge commit or the
-- protected branch may advance before the merge receipt is recorded.
ALTER TABLE deviludo.github_merge_receipts
  ADD COLUMN main_source_digest text
    CHECK (main_source_digest IS NULL OR main_source_digest ~ '^[a-f0-9]{64}$');

ALTER TABLE deviludo.e2e_attempts
  ADD COLUMN workflow_id text,
  ADD COLUMN workflow_operation_key text,
  ADD COLUMN workflow_request_digest char(64),
  ADD COLUMN mode text,
  ADD COLUMN draft_pull_request bigint,
  ADD COLUMN steam_build_id text,
  ADD COLUMN repair_prompt_id text,
  ADD COLUMN completed_at timestamptz,
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE deviludo.e2e_attempts
  ADD CONSTRAINT e2e_attempt_workflow_operation_unique
    UNIQUE (tenant_id, workflow_operation_key),
  ADD CONSTRAINT e2e_attempt_workflow_id_shape CHECK (
    workflow_id IS NULL OR length(workflow_id) BETWEEN 1 AND 512
  ) NOT VALID,
  ADD CONSTRAINT e2e_attempt_workflow_operation_shape CHECK (
    workflow_operation_key IS NULL OR workflow_operation_key ~ '^workflow-job:[a-f0-9-]{36}$'
  ) NOT VALID,
  ADD CONSTRAINT e2e_attempt_workflow_digest_shape CHECK (
    workflow_request_digest IS NULL OR workflow_request_digest ~ '^[a-f0-9]{64}$'
  ) NOT VALID,
  ADD CONSTRAINT e2e_attempt_mode_shape CHECK (
    mode IS NULL OR mode IN ('CANDIDATE', 'MAIN_RELEASE_GATE', 'STEAM_CLEAN_INSTALL')
  ) NOT VALID,
  ADD CONSTRAINT e2e_attempt_state_shape CHECK (
    state IN ('QUEUED', 'RUNNING', 'PASSED', 'FAILED', 'INVALIDATED')
  ) NOT VALID,
  ADD CONSTRAINT e2e_attempt_target_matrix_shape CHECK (
    cardinality(target_matrix) BETWEEN 1 AND 3
      AND target_matrix <@ ARRAY['windows', 'linux', 'macos']::text[]
      AND array_lower(target_matrix, 1) = 1
      AND array_position(target_matrix, NULL) IS NULL
      AND (target_matrix[2] IS NULL OR target_matrix[2] <> target_matrix[1])
      AND (target_matrix[3] IS NULL OR
        (target_matrix[3] <> target_matrix[1] AND target_matrix[3] <> target_matrix[2]))
  ) NOT VALID,
  ADD CONSTRAINT e2e_attempt_terminal_shape CHECK (
    (state IN ('PASSED', 'FAILED')) = (completed_at IS NOT NULL)
      AND (state = 'FAILED') = (repair_prompt_id IS NOT NULL)
  ) NOT VALID,
  ADD CONSTRAINT e2e_attempt_mode_binding_shape CHECK (
    mode IS NULL OR
    (mode = 'CANDIDATE' AND draft_pull_request > 0 AND steam_build_id IS NULL) OR
    (mode = 'MAIN_RELEASE_GATE' AND draft_pull_request IS NULL AND steam_build_id IS NULL) OR
    (mode = 'STEAM_CLEAN_INSTALL' AND draft_pull_request IS NULL
      AND steam_build_id ~ '^[1-9][0-9]{0,19}$')
  ) NOT VALID,
  ADD CONSTRAINT e2e_attempt_workflow_columns_together CHECK (
    (workflow_id IS NULL AND workflow_operation_key IS NULL
      AND workflow_request_digest IS NULL AND mode IS NULL)
    OR
    (workflow_id IS NOT NULL AND workflow_operation_key IS NOT NULL
      AND workflow_request_digest IS NOT NULL AND mode IS NOT NULL)
  ) NOT VALID,
  ADD CONSTRAINT e2e_attempt_binding_object CHECK (
    jsonb_typeof(binding) = 'object' AND pg_column_size(binding) <= 65536
  ) NOT VALID;

CREATE INDEX e2e_attempt_workflow_poll_idx
  ON deviludo.e2e_attempts (tenant_id, workflow_id, state, updated_at)
  WHERE workflow_operation_key IS NOT NULL;

ALTER TABLE deviludo.evidence_bundles
  ADD CONSTRAINT evidence_bundle_attempt_unique UNIQUE (attempt_id),
  ADD CONSTRAINT evidence_bundle_content_shape CHECK (
    jsonb_typeof(binding) = 'object'
      AND jsonb_typeof(manifest) = 'object'
      AND pg_column_size(binding) <= 65536
      AND pg_column_size(manifest) <= 1048576
      AND (invalidated_at IS NULL OR invalidated_at >= created_at)
  ) NOT VALID;

CREATE OR REPLACE FUNCTION deviludo.protect_e2e_attempt_workflow_binding()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.tenant_id, NEW.project_id, NEW.run_id, NEW.attempt_number,
         NEW.commit_sha, NEW.source_digest, NEW.binding, NEW.target_matrix,
         NEW.workflow_id, NEW.workflow_operation_key,
         NEW.workflow_request_digest, NEW.mode, NEW.draft_pull_request,
         NEW.steam_build_id, NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.tenant_id, OLD.project_id, OLD.run_id, OLD.attempt_number,
         OLD.commit_sha, OLD.source_digest, OLD.binding, OLD.target_matrix,
         OLD.workflow_id, OLD.workflow_operation_key,
         OLD.workflow_request_digest, OLD.mode, OLD.draft_pull_request,
         OLD.steam_build_id, OLD.created_at) THEN
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

CREATE TRIGGER e2e_attempt_workflow_binding_immutable
BEFORE UPDATE ON deviludo.e2e_attempts
FOR EACH ROW EXECUTE FUNCTION deviludo.protect_e2e_attempt_workflow_binding();

CREATE TRIGGER e2e_attempt_no_delete
BEFORE DELETE ON deviludo.e2e_attempts
FOR EACH ROW EXECUTE FUNCTION deviludo.reject_mutation();

CREATE OR REPLACE FUNCTION deviludo.protect_evidence_bundle()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.id, NEW.tenant_id, NEW.project_id, NEW.attempt_id,
         NEW.commit_sha, NEW.source_digest, NEW.binding, NEW.manifest,
         NEW.bundle_digest, NEW.object_key, NEW.status, NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.id, OLD.tenant_id, OLD.project_id, OLD.attempt_id,
         OLD.commit_sha, OLD.source_digest, OLD.binding, OLD.manifest,
         OLD.bundle_digest, OLD.object_key, OLD.status, OLD.created_at)
     OR OLD.invalidated_at IS NOT NULL
     OR NEW.invalidated_at IS NULL THEN
    RAISE EXCEPTION 'evidence bundle content and invalidation are immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER evidence_bundle_immutable
BEFORE UPDATE ON deviludo.evidence_bundles
FOR EACH ROW EXECUTE FUNCTION deviludo.protect_evidence_bundle();

CREATE TRIGGER evidence_bundle_no_delete
BEFORE DELETE ON deviludo.evidence_bundles
FOR EACH ROW EXECUTE FUNCTION deviludo.reject_mutation();

COMMIT;
