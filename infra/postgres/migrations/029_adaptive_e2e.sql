-- Replace every historical E2E wire shape with the single current contract.

ALTER TABLE deviludo.project_source_revisions
  RENAME COLUMN test_manifest_protocol TO test_manifest_schema;
ALTER TABLE deviludo.project_source_revisions
  DROP CONSTRAINT IF EXISTS project_source_revisions_test_manifest_protocol_check;
ALTER TABLE deviludo.project_source_revisions
  DROP CONSTRAINT IF EXISTS project_source_revisions_test_manifest_schema_check;
ALTER TABLE deviludo.project_source_revisions
  ADD CONSTRAINT project_source_revisions_test_manifest_schema_check
  CHECK (test_manifest_schema = 'deviludo.test-manifest');
ALTER TABLE deviludo.project_source_revisions
  ADD COLUMN IF NOT EXISTS e2e_timeout_seconds integer CHECK (e2e_timeout_seconds BETWEEN 1800 AND 5400),
  ADD COLUMN IF NOT EXISTS e2e_contract_digest text CHECK (e2e_contract_digest ~ '^sha256:[0-9a-f]{64}$');

ALTER TABLE deviludo.instance_agent_settings
  ADD COLUMN IF NOT EXISTS test_policy_ready boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS test_policy_checked_revision bigint
    CHECK (test_policy_checked_revision IS NULL OR test_policy_checked_revision > 0);

CREATE TABLE IF NOT EXISTS deviludo.e2e_policy_locks (
  workspace_id uuid NOT NULL,
  job_id uuid NOT NULL,
  settings_revision bigint NOT NULL CHECK (settings_revision > 0),
  runtime deviludo.agent_runtime NOT NULL,
  base_url text NOT NULL,
  model text NOT NULL CHECK (model ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'),
  credential_secret_ref text NOT NULL,
  configuration_digest text NOT NULL CHECK (configuration_digest ~ '^sha256:[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, job_id),
  FOREIGN KEY (workspace_id, job_id) REFERENCES deviludo.jobs(workspace_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS deviludo.e2e_policy_decisions (
  workspace_id uuid NOT NULL,
  job_id uuid NOT NULL,
  rollout_index integer NOT NULL CHECK (rollout_index BETWEEN 0 AND 2),
  decision_index integer NOT NULL CHECK (decision_index BETWEEN 0 AND 39),
  request_digest text NOT NULL CHECK (request_digest ~ '^sha256:[0-9a-f]{64}$'),
  screenshot_digest text NOT NULL CHECK (screenshot_digest ~ '^sha256:[0-9a-f]{64}$'),
  decision jsonb NOT NULL CHECK (jsonb_typeof(decision) = 'object'),
  latency_ms integer NOT NULL CHECK (latency_ms >= 0),
  input_tokens integer NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens integer NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, job_id, rollout_index, decision_index),
  FOREIGN KEY (workspace_id, job_id) REFERENCES deviludo.jobs(workspace_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS deviludo.e2e_regression_traces (
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  target_platform deviludo.server_os NOT NULL,
  artifact_id uuid NOT NULL,
  source_digest text NOT NULL CHECK (source_digest ~ '^sha256:[0-9a-f]{64}$'),
  test_manifest_digest text NOT NULL CHECK (test_manifest_digest ~ '^sha256:[0-9a-f]{64}$'),
  contract_digest text NOT NULL CHECK (contract_digest ~ '^sha256:[0-9a-f]{64}$'),
  input_profile text NOT NULL CHECK (input_profile IN ('KEYBOARD_MOUSE', 'GAMEPAD')),
  estimated_duration_ms integer NOT NULL CHECK (estimated_duration_ms BETWEEN 1 AND 300000),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, project_id, target_platform),
  FOREIGN KEY (workspace_id, project_id) REFERENCES deviludo.projects(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, artifact_id) REFERENCES deviludo.artifacts(workspace_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS deviludo.object_cleanup_queue (
  workspace_id uuid NOT NULL,
  bucket text NOT NULL CHECK (length(bucket) BETWEEN 3 AND 255),
  object_key text NOT NULL CHECK (object_key LIKE 'workspaces/' || workspace_id::text || '/%'),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 200),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 10),
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  lease_token uuid,
  lease_expires_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, bucket, object_key),
  FOREIGN KEY (workspace_id) REFERENCES deviludo.workspaces(id) ON DELETE CASCADE,
  CHECK ((lease_token IS NULL) = (lease_expires_at IS NULL))
);

DO $rls$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['e2e_policy_locks', 'e2e_policy_decisions', 'e2e_regression_traces', 'object_cleanup_queue']
  LOOP
    EXECUTE format('ALTER TABLE deviludo.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE deviludo.%I FORCE ROW LEVEL SECURITY', table_name);
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
       WHERE schemaname = 'deviludo' AND tablename = table_name AND policyname = 'workspace_isolation'
    ) THEN
      EXECUTE format(
        'CREATE POLICY workspace_isolation ON deviludo.%I USING (workspace_id = deviludo.current_workspace_id()) WITH CHECK (workspace_id = deviludo.current_workspace_id())',
        table_name
      );
    END IF;
  END LOOP;
END
$rls$;

-- The current implementation deliberately does not open or retain old E2E evidence.
INSERT INTO deviludo.object_cleanup_queue(workspace_id, bucket, object_key, reason)
SELECT workspace_id, bucket, object_key, 'retired E2E evidence contract'
  FROM deviludo.artifacts WHERE kind = 'E2E_REPORT'
ON CONFLICT (workspace_id, bucket, object_key) DO NOTHING;
DELETE FROM deviludo.artifact_inputs input
USING deviludo.artifacts artifact
WHERE input.workspace_id = artifact.workspace_id AND input.artifact_id = artifact.id
  AND artifact.kind = 'E2E_REPORT';
DELETE FROM deviludo.artifacts WHERE kind = 'E2E_REPORT';
UPDATE deviludo.project_source_revisions
   SET test_manifest_schema = NULL, test_manifest_digest = NULL
 WHERE test_manifest_schema IS DISTINCT FROM 'deviludo.test-manifest';
UPDATE deviludo.jobs
   SET state = 'CANCELLED', lease_owner = NULL, lease_token = NULL,
       lease_expires_at = NULL, heartbeat_at = NULL, fencing_token = fencing_token + 1,
       last_error = 'superseded by current adaptive E2E implementation', updated_at = clock_timestamp()
 WHERE kind IN ('ARTIFACT_BUILD', 'E2E_TEST') AND state IN ('QUEUED', 'RETRY', 'RUNNING');

DROP FUNCTION IF EXISTS deviludo.schedule_e2e_protocol_revalidation(text, integer);

-- Keep existing databases on the same executable function bodies as the fresh baseline.
DO $migration$
DECLARE definition text;
BEGIN
  SELECT pg_get_functiondef('deviludo.complete_job(uuid,uuid,bigint,bigint,jsonb,jsonb,text,text,text)'::regprocedure)
    INTO definition;
  definition := replace(definition, '{testManifest,schemaVersion}', '{testManifest,schema}');
  definition := replace(definition, 'deviludo.test-manifest.v3', 'deviludo.test-manifest');
  definition := replace(definition, 'test_manifest_protocol', 'test_manifest_schema');
  EXECUTE definition;

  SELECT pg_get_functiondef('deviludo.enqueue_job(uuid,uuid,uuid,deviludo.job_kind,deviludo.server_os,text,jsonb)'::regprocedure)
    INTO definition;
  definition := replace(definition,
    'WHEN ''E2E_TEST'' THEN jsonb_build_array(''E2E_REPORT'')',
    'WHEN ''E2E_TEST'' THEN jsonb_build_array(''E2E_REPORT'', ''E2E_REGRESSION'')');
  definition := replace(definition,
    'IF p_kind IN (''AGENT_GENERATION'', ''ARTIFACT_BUILD'') THEN',
    'IF p_kind IN (''AGENT_GENERATION'', ''ARTIFACT_BUILD'', ''E2E_TEST'') THEN');
  definition := replace(definition,
    'IF p_kind = ''ARTIFACT_BUILD'' AND v_source.revision IS NULL THEN',
    'IF p_kind IN (''ARTIFACT_BUILD'', ''E2E_TEST'') AND v_source.revision IS NULL THEN');
  definition := replace(definition,
    '''sourceDigest'', v_source.content_digest',
    '''sourceDigest'', v_source.content_digest, ''testManifestDigest'', v_source.test_manifest_digest, ''e2eContractDigest'', v_source.e2e_contract_digest');
  definition := replace(definition,
    'CASE WHEN p_kind = ''AGENT_GENERATION'' THEN 5400 ELSE 1800 END',
    'CASE WHEN p_kind = ''AGENT_GENERATION'' THEN 5400 WHEN p_kind = ''E2E_TEST'' THEN v_source.e2e_timeout_seconds ELSE 1800 END');
  definition := replace(definition,
    '''maxBytes'', 1073741824',
    '''maxBytes'', CASE WHEN p_kind = ''E2E_TEST'' THEN 1090519040 ELSE 1073741824 END');
  definition := replace(definition,
    E'))\n       WHEN ''ARTIFACT_SIGN'' THEN artifact.kind = ''BUILD''',
    E')) OR (artifact.kind = ''E2E_REGRESSION'' AND artifact.target_platform = p_operating_system\n'
      ' AND artifact.id = (SELECT trace.artifact_id FROM deviludo.e2e_regression_traces trace\n'
      ' WHERE trace.workspace_id = p_workspace_id AND trace.project_id = p_project_id\n'
      ' AND trace.target_platform = p_operating_system AND trace.source_digest = v_source.content_digest\n'
      ' AND trace.test_manifest_digest = v_source.test_manifest_digest AND trace.contract_digest = v_source.e2e_contract_digest))\n'
      '       WHEN ''ARTIFACT_SIGN'' THEN artifact.kind = ''BUILD''');
  EXECUTE definition;
END
$migration$;

-- Existing complete_job functions learn the frozen budget fields without
-- retaining any previous E2E contract reader.
DO $migration$
DECLARE definition text;
BEGIN
  SELECT pg_get_functiondef('deviludo.complete_job(uuid,uuid,bigint,bigint,jsonb,jsonb,text,text,text)'::regprocedure)
    INTO definition;
  definition := replace(definition,
    'test_manifest_schema, test_manifest_digest,',
    'test_manifest_schema, test_manifest_digest, e2e_timeout_seconds, e2e_contract_digest,');
  definition := replace(definition,
    E'p_receipt->>''testManifestDigest'',\n      job.workflow_id',
    E'p_receipt->>''testManifestDigest'', (p_receipt #>> ''{e2eExecutionPlan,plannedTimeoutSeconds}'')::integer, p_receipt #>> ''{e2eExecutionPlan,contractDigest}'',\n      job.workflow_id');
  definition := replace(definition,
    'OR coalesce(p_receipt->>''testManifestDigest'', '''') !~ ''^sha256:[0-9a-f]{64}$''',
    'OR coalesce(p_receipt->>''testManifestDigest'', '''') !~ ''^sha256:[0-9a-f]{64}$'' OR (p_receipt #>> ''{e2eExecutionPlan,plannedTimeoutSeconds}'')::integer NOT BETWEEN 1800 AND 5400 OR coalesce(p_receipt #>> ''{e2eExecutionPlan,contractDigest}'', '''') !~ ''^sha256:[0-9a-f]{64}$''');
  EXECUTE definition;
END
$migration$;

CREATE OR REPLACE FUNCTION deviludo.refresh_current_e2e_regression()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, deviludo
AS $$
DECLARE job deviludo.jobs%ROWTYPE; previous_artifact_id uuid;
BEGIN
  IF NEW.kind <> 'E2E_REGRESSION' THEN RETURN NEW; END IF;
  SELECT * INTO job FROM deviludo.jobs
   WHERE workspace_id = NEW.workspace_id AND id = NEW.producing_job_id AND kind = 'E2E_TEST';
  IF job.id IS NULL
    OR NEW.metadata #>> '{e2eRegression,regressionContractDigest}' <> job.payload->>'e2eContractDigest'
    OR NEW.metadata #>> '{e2eRegression,regressionInputProfile}' NOT IN ('KEYBOARD_MOUSE', 'GAMEPAD')
    OR (NEW.metadata #>> '{e2eRegression,regressionEstimatedDurationMs}')::integer NOT BETWEEN 1 AND 300000
  THEN RAISE EXCEPTION 'validated current regression trace is required'; END IF;
  SELECT artifact_id INTO previous_artifact_id FROM deviludo.e2e_regression_traces
   WHERE workspace_id = NEW.workspace_id AND project_id = NEW.project_id AND target_platform = NEW.target_platform
   FOR UPDATE;
  INSERT INTO deviludo.e2e_regression_traces(
    workspace_id, project_id, target_platform, artifact_id, source_digest,
    test_manifest_digest, contract_digest, input_profile, estimated_duration_ms
  ) VALUES (
    NEW.workspace_id, NEW.project_id, NEW.target_platform, NEW.id,
    job.payload->>'sourceDigest', job.payload->>'testManifestDigest', job.payload->>'e2eContractDigest',
    NEW.metadata #>> '{e2eRegression,regressionInputProfile}',
    (NEW.metadata #>> '{e2eRegression,regressionEstimatedDurationMs}')::integer
  ) ON CONFLICT (workspace_id, project_id, target_platform) DO UPDATE SET
    artifact_id = excluded.artifact_id, source_digest = excluded.source_digest,
    test_manifest_digest = excluded.test_manifest_digest, contract_digest = excluded.contract_digest,
    input_profile = excluded.input_profile, estimated_duration_ms = excluded.estimated_duration_ms,
    updated_at = clock_timestamp();
  IF previous_artifact_id IS NOT NULL AND previous_artifact_id <> NEW.id THEN
    INSERT INTO deviludo.object_cleanup_queue(workspace_id, bucket, object_key, reason)
    SELECT workspace_id, bucket, object_key, 'replaced E2E regression trace'
      FROM deviludo.artifacts
     WHERE workspace_id = NEW.workspace_id AND id = previous_artifact_id
    ON CONFLICT (workspace_id, bucket, object_key) DO NOTHING;
    DELETE FROM deviludo.artifact_inputs WHERE workspace_id = NEW.workspace_id AND artifact_id = previous_artifact_id;
    DELETE FROM deviludo.artifacts WHERE workspace_id = NEW.workspace_id AND id = previous_artifact_id;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER artifacts_refresh_current_e2e_regression
AFTER INSERT ON deviludo.artifacts
FOR EACH ROW WHEN (NEW.kind = 'E2E_REGRESSION')
EXECUTE FUNCTION deviludo.refresh_current_e2e_regression();

-- Only the latest non-draft iteration of each project is regenerated. Running
-- leases are fenced before the terminal rerun signal is routed, so an old Agent
-- or Builder can never publish the retired contract after this migration.
DO $migration$
DECLARE candidate record;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM deviludo.instance_agent_settings WHERE singleton = true) THEN RETURN; END IF;
  FOR candidate IN
    SELECT workflow.workspace_id, workflow.id AS workflow_id,
           coalesce(workflow.development_actor_account_id, project.created_by_actor_account_id) AS requested_by
      FROM deviludo.workflow_instances workflow
      JOIN deviludo.projects project
        ON project.workspace_id = workflow.workspace_id AND project.id = workflow.project_id
     WHERE workflow.state <> 'DRAFT'
       AND NOT EXISTS (
         SELECT 1 FROM deviludo.workflow_instances newer
          WHERE newer.workspace_id = workflow.workspace_id AND newer.project_id = workflow.project_id
            AND newer.iteration_number > workflow.iteration_number
       )
       AND EXISTS (
         SELECT 1 FROM deviludo.artifacts specification
          WHERE specification.workspace_id = workflow.workspace_id
            AND specification.workflow_id = workflow.id
            AND specification.kind = 'SPECIFICATION' AND specification.producing_job_id IS NULL
       )
  LOOP
    UPDATE deviludo.jobs SET state = 'CANCELLED', lease_owner = NULL, lease_token = NULL,
           lease_expires_at = NULL, heartbeat_at = NULL, fencing_token = fencing_token + 1,
           last_error = 'superseded by current adaptive E2E contract', updated_at = clock_timestamp()
     WHERE workspace_id = candidate.workspace_id AND workflow_id = candidate.workflow_id
       AND state IN ('QUEUED', 'RETRY', 'RUNNING');
    UPDATE deviludo.workflow_instances SET state = 'CANCELLED', version = version + 1, updated_at = clock_timestamp()
     WHERE workspace_id = candidate.workspace_id AND id = candidate.workflow_id
       AND state NOT IN ('SUCCEEDED', 'FAILED', 'CANCELLED');
    PERFORM deviludo.accept_workflow_signal(
      candidate.workflow_id, 'STAGE_RERUN_REQUESTED', 'adaptive-e2e-current',
      jsonb_build_object('stage', 'AGENT_GENERATION', 'requestedByAccountId', candidate.requested_by,
        'reason', 'E2E_CONTRACT_REPLACED')
    );
  END LOOP;
END
$migration$;

CREATE OR REPLACE FUNCTION deviludo.claim_object_cleanup(p_lease_seconds integer)
RETURNS TABLE (
  "workspaceId" uuid, bucket text, "objectKey" text, "leaseToken" uuid, attempt integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, deviludo
SET row_security = off
AS $$
BEGIN
  IF p_lease_seconds NOT BETWEEN 30 AND 600 THEN RAISE EXCEPTION 'invalid object cleanup lease'; END IF;
  RETURN QUERY
  WITH candidate AS (
    SELECT queue.workspace_id, queue.bucket, queue.object_key
      FROM deviludo.object_cleanup_queue queue
     WHERE queue.attempts < 10 AND queue.available_at <= clock_timestamp()
       AND (queue.lease_token IS NULL OR queue.lease_expires_at <= clock_timestamp())
     ORDER BY queue.available_at, queue.created_at
     FOR UPDATE SKIP LOCKED LIMIT 1
  )
  UPDATE deviludo.object_cleanup_queue queue
     SET attempts = queue.attempts + 1, lease_token = gen_random_uuid(),
         lease_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds), last_error = NULL
    FROM candidate
   WHERE queue.workspace_id = candidate.workspace_id
     AND queue.bucket = candidate.bucket AND queue.object_key = candidate.object_key
  RETURNING queue.workspace_id, queue.bucket, queue.object_key, queue.lease_token, queue.attempts;
END
$$;
ALTER FUNCTION deviludo.claim_object_cleanup(integer) OWNER TO deviludo_claim_executor;

CREATE OR REPLACE FUNCTION deviludo.complete_object_cleanup(
  p_workspace_id uuid, p_bucket text, p_object_key text, p_lease_token uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, deviludo
SET row_security = off
AS $$
DECLARE removed integer;
BEGIN
  DELETE FROM deviludo.object_cleanup_queue
   WHERE workspace_id = p_workspace_id AND bucket = p_bucket AND object_key = p_object_key
     AND lease_token = p_lease_token AND lease_expires_at > clock_timestamp();
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed = 1;
END
$$;
ALTER FUNCTION deviludo.complete_object_cleanup(uuid, text, text, uuid) OWNER TO deviludo_claim_executor;

CREATE OR REPLACE FUNCTION deviludo.fail_object_cleanup(
  p_workspace_id uuid, p_bucket text, p_object_key text, p_lease_token uuid, p_error text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, deviludo
SET row_security = off
AS $$
DECLARE updated integer;
BEGIN
  UPDATE deviludo.object_cleanup_queue
     SET lease_token = NULL, lease_expires_at = NULL,
         available_at = clock_timestamp() + make_interval(secs => least(3600, 15 * power(2, attempts)::integer)),
         last_error = left(p_error, 2000)
   WHERE workspace_id = p_workspace_id AND bucket = p_bucket AND object_key = p_object_key
     AND lease_token = p_lease_token;
  GET DIAGNOSTICS updated = ROW_COUNT;
  RETURN updated = 1;
END
$$;
ALTER FUNCTION deviludo.fail_object_cleanup(uuid, text, text, uuid, text) OWNER TO deviludo_claim_executor;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  deviludo.e2e_policy_locks, deviludo.e2e_policy_decisions, deviludo.e2e_regression_traces
  TO deviludo_api;
GRANT INSERT ON deviludo.object_cleanup_queue TO deviludo_api, deviludo_sandbox;
GRANT SELECT, INSERT, UPDATE, DELETE ON deviludo.object_cleanup_queue TO deviludo_claim_executor;
GRANT SELECT ON deviludo.e2e_regression_traces TO deviludo_scheduler;
GRANT EXECUTE ON FUNCTION deviludo.claim_object_cleanup(integer),
  deviludo.complete_object_cleanup(uuid, text, text, uuid),
  deviludo.fail_object_cleanup(uuid, text, text, uuid, text)
  TO deviludo_scheduler;

UPDATE deviludo.schema_metadata
   SET current_version = '029_adaptive_e2e', applied_at = clock_timestamp()
 WHERE singleton = true;
