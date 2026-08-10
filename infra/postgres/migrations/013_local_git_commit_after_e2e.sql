-- Queue exactly one durable host-side Git commit when every target platform's
-- E2E job has succeeded. Git remains outside all task containers.
CREATE OR REPLACE FUNCTION deviludo.queue_local_git_commit_after_e2e()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, deviludo
AS $$
DECLARE
  workflow deviludo.workflow_instances%ROWTYPE;
  source_digest text;
  binding_id text;
  request_id uuid;
BEGIN
  IF NEW.kind <> 'E2E_TEST' OR NEW.state <> 'SUCCEEDED' OR OLD.state = 'SUCCEEDED' THEN RETURN NEW; END IF;
  SELECT * INTO workflow FROM deviludo.workflow_instances
   WHERE workspace_id = NEW.workspace_id AND id = NEW.workflow_id;
  IF workflow.id IS NULL OR workflow.state <> 'E2E_TESTING' THEN RETURN NEW; END IF;
  IF EXISTS (
    SELECT 1 FROM unnest(workflow.target_platforms) required(operating_system)
     WHERE NOT EXISTS (
       SELECT 1 FROM deviludo.jobs successful
        WHERE successful.workspace_id = NEW.workspace_id
          AND successful.workflow_id = NEW.workflow_id
          AND successful.kind = 'E2E_TEST'
          AND successful.target_operating_system = required.operating_system
          AND successful.state = 'SUCCEEDED'
     )
  ) THEN RETURN NEW; END IF;
  binding_id := workflow.state_data #>> '{source,localDirectoryBindingId}';
  IF coalesce(binding_id, '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN RETURN NEW; END IF;
  SELECT source.content_digest INTO source_digest
    FROM deviludo.project_source_revisions source
   WHERE source.workspace_id = NEW.workspace_id
     AND source.project_id = NEW.project_id
     AND source.workflow_id = NEW.workflow_id
   ORDER BY source.revision DESC LIMIT 1;
  IF source_digest IS NULL THEN RETURN NEW; END IF;
  request_id := gen_random_uuid();
  UPDATE deviludo.workflow_instances
     SET state_data = jsonb_set(
       coalesce(state_data, '{}'::jsonb), '{gitCommit}',
       jsonb_build_object(
         'requestId', request_id, 'state', 'PENDING', 'bindingId', binding_id,
         'expectedSourceDigest', source_digest, 'iterationNumber', workflow.iteration_number,
         'attempts', 0, 'availableAt', clock_timestamp(), 'requestedAt', clock_timestamp(),
         'leaseToken', NULL, 'leaseExpiresAt', NULL, 'error', NULL
       )
     ),
     version = version + 1,
     updated_at = clock_timestamp()
   WHERE workspace_id = NEW.workspace_id AND id = NEW.workflow_id;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS jobs_queue_local_git_commit ON deviludo.jobs;
CREATE TRIGGER jobs_queue_local_git_commit
AFTER UPDATE OF state ON deviludo.jobs
FOR EACH ROW
WHEN (OLD.state IS DISTINCT FROM NEW.state)
EXECUTE FUNCTION deviludo.queue_local_git_commit_after_e2e();

CREATE OR REPLACE FUNCTION deviludo.claim_local_git_commit(p_lease_seconds integer)
RETURNS TABLE (
  "workspaceId" uuid,
  "projectId" uuid,
  "workflowId" uuid,
  "requestId" uuid,
  "leaseToken" uuid,
  "bindingId" uuid,
  "expectedSourceDigest" text,
  "iterationNumber" integer,
  "attempt" integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, deviludo
SET row_security = off
AS $$
DECLARE
  candidate record;
  next_token uuid;
  next_expiry timestamptz;
  next_attempt integer;
BEGIN
  IF p_lease_seconds NOT BETWEEN 30 AND 600 THEN RAISE EXCEPTION 'invalid local Git commit lease'; END IF;
  SELECT workflow.workspace_id, workflow.project_id, workflow.id AS workflow_id, workflow.state_data
    INTO candidate
    FROM deviludo.workflow_instances workflow
   WHERE (
       workflow.state_data #>> '{gitCommit,state}' IN ('PENDING', 'RETRY')
       AND coalesce((workflow.state_data #>> '{gitCommit,availableAt}')::timestamptz, '-infinity') <= clock_timestamp()
     ) OR (
       workflow.state_data #>> '{gitCommit,state}' = 'RUNNING'
       AND coalesce((workflow.state_data #>> '{gitCommit,leaseExpiresAt}')::timestamptz, '-infinity') <= clock_timestamp()
     )
   ORDER BY workflow.updated_at, workflow.id
   FOR UPDATE OF workflow SKIP LOCKED
   LIMIT 1;
  IF NOT FOUND THEN RETURN; END IF;
  next_token := gen_random_uuid();
  next_expiry := clock_timestamp() + make_interval(secs => p_lease_seconds);
  next_attempt := coalesce((candidate.state_data #>> '{gitCommit,attempts}')::integer, 0) + 1;
  UPDATE deviludo.workflow_instances
     SET state_data = jsonb_set(
       candidate.state_data, '{gitCommit}',
       candidate.state_data->'gitCommit' || jsonb_build_object(
         'state', 'RUNNING', 'attempts', next_attempt, 'leaseToken', next_token,
         'leaseExpiresAt', next_expiry, 'startedAt', clock_timestamp(), 'error', NULL
       )
     ),
     version = version + 1,
     updated_at = clock_timestamp()
   WHERE workspace_id = candidate.workspace_id AND id = candidate.workflow_id;
  RETURN QUERY SELECT
    candidate.workspace_id, candidate.project_id, candidate.workflow_id,
    (candidate.state_data #>> '{gitCommit,requestId}')::uuid, next_token,
    (candidate.state_data #>> '{gitCommit,bindingId}')::uuid,
    candidate.state_data #>> '{gitCommit,expectedSourceDigest}',
    (candidate.state_data #>> '{gitCommit,iterationNumber}')::integer, next_attempt;
END
$$;
ALTER FUNCTION deviludo.claim_local_git_commit(integer) OWNER TO deviludo_claim_executor;

CREATE OR REPLACE FUNCTION deviludo.complete_local_git_commit(
  p_workflow_id uuid, p_request_id uuid, p_lease_token uuid,
  p_outcome text, p_commit_hash text, p_branch text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, deviludo
SET row_security = off
AS $$
DECLARE
  workflow deviludo.workflow_instances%ROWTYPE;
  next_state text;
BEGIN
  IF p_outcome NOT IN ('COMMITTED', 'NO_CHANGES', 'NOT_GIT')
    OR (p_commit_hash IS NOT NULL AND p_commit_hash !~ '^[0-9a-fA-F]{40,64}$')
    OR (p_branch IS NOT NULL AND length(p_branch) NOT BETWEEN 1 AND 255)
  THEN RAISE EXCEPTION 'invalid local Git commit result'; END IF;
  SELECT * INTO workflow FROM deviludo.workflow_instances
   WHERE id = p_workflow_id
     AND state_data #>> '{gitCommit,requestId}' = p_request_id::text
     AND state_data #>> '{gitCommit,state}' = 'RUNNING'
     AND state_data #>> '{gitCommit,leaseToken}' = p_lease_token::text
   FOR UPDATE;
  IF workflow.id IS NULL THEN RETURN false; END IF;
  next_state := CASE WHEN p_outcome = 'COMMITTED' THEN 'SUCCEEDED' ELSE 'SKIPPED' END;
  UPDATE deviludo.workflow_instances
     SET state_data = jsonb_set(
       state_data, '{gitCommit}',
       state_data->'gitCommit' || jsonb_build_object(
         'state', next_state, 'outcome', p_outcome, 'commitHash', p_commit_hash,
         'branch', p_branch, 'completedAt', clock_timestamp(),
         'leaseToken', NULL, 'leaseExpiresAt', NULL, 'error', NULL
       )
     ),
     version = version + 1,
     updated_at = clock_timestamp()
   WHERE workspace_id = workflow.workspace_id AND id = workflow.id;
  INSERT INTO deviludo.workflow_events(workspace_id, workflow_id, event_kind, event_data, idempotency_key)
  VALUES (
    workflow.workspace_id, workflow.id, 'GIT_COMMIT_COMPLETED',
    jsonb_build_object('outcome', p_outcome, 'commitHash', p_commit_hash, 'branch', p_branch),
    'git-commit:' || p_request_id::text
  ) ON CONFLICT (workspace_id, workflow_id, idempotency_key) DO NOTHING;
  RETURN true;
END
$$;
ALTER FUNCTION deviludo.complete_local_git_commit(uuid, uuid, uuid, text, text, text)
  OWNER TO deviludo_claim_executor;

CREATE OR REPLACE FUNCTION deviludo.fail_local_git_commit(
  p_workflow_id uuid, p_request_id uuid, p_lease_token uuid, p_error text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, deviludo
SET row_security = off
AS $$
DECLARE
  workflow deviludo.workflow_instances%ROWTYPE;
  attempts integer;
  terminal boolean;
BEGIN
  SELECT * INTO workflow FROM deviludo.workflow_instances
   WHERE id = p_workflow_id
     AND state_data #>> '{gitCommit,requestId}' = p_request_id::text
     AND state_data #>> '{gitCommit,state}' = 'RUNNING'
     AND state_data #>> '{gitCommit,leaseToken}' = p_lease_token::text
   FOR UPDATE;
  IF workflow.id IS NULL THEN RETURN false; END IF;
  attempts := coalesce((workflow.state_data #>> '{gitCommit,attempts}')::integer, 1);
  terminal := attempts >= 3;
  UPDATE deviludo.workflow_instances
     SET state_data = jsonb_set(
       state_data, '{gitCommit}',
       state_data->'gitCommit' || jsonb_build_object(
         'state', CASE WHEN terminal THEN 'FAILED' ELSE 'RETRY' END,
         'availableAt', clock_timestamp() + make_interval(secs => least(300, 5 * (2 ^ attempts)::integer)),
         'leaseToken', NULL, 'leaseExpiresAt', NULL, 'error', left(p_error, 2000),
         'failedAt', CASE WHEN terminal THEN clock_timestamp() ELSE NULL END
       )
     ),
     version = version + 1,
     updated_at = clock_timestamp()
   WHERE workspace_id = workflow.workspace_id AND id = workflow.id;
  IF terminal THEN
    INSERT INTO deviludo.workflow_events(workspace_id, workflow_id, event_kind, event_data, idempotency_key)
    VALUES (
      workflow.workspace_id, workflow.id, 'GIT_COMMIT_FAILED',
      jsonb_build_object('error', left(p_error, 2000), 'attempts', attempts),
      'git-commit:' || p_request_id::text
    ) ON CONFLICT (workspace_id, workflow_id, idempotency_key) DO NOTHING;
  END IF;
  RETURN true;
END
$$;
ALTER FUNCTION deviludo.fail_local_git_commit(uuid, uuid, uuid, text)
  OWNER TO deviludo_claim_executor;

REVOKE ALL ON FUNCTION deviludo.queue_local_git_commit_after_e2e() FROM PUBLIC;
REVOKE ALL ON FUNCTION deviludo.claim_local_git_commit(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION deviludo.complete_local_git_commit(uuid, uuid, uuid, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION deviludo.fail_local_git_commit(uuid, uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION deviludo.claim_local_git_commit(integer),
  deviludo.complete_local_git_commit(uuid, uuid, uuid, text, text, text),
  deviludo.fail_local_git_commit(uuid, uuid, uuid, text)
  TO deviludo_scheduler;
