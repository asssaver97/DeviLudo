BEGIN;

DO $types$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typnamespace = 'deviludo'::regnamespace AND typname = 'steam_release_channel') THEN
    CREATE TYPE deviludo.steam_release_channel AS ENUM ('TEST', 'DEFAULT');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typnamespace = 'deviludo'::regnamespace AND typname = 'steam_release_state') THEN
    CREATE TYPE deviludo.steam_release_state AS ENUM (
      'UPLOADING', 'FAILED', 'LIVE_TEST', 'AWAITING_DEFAULT_PROMOTION', 'LIVE_DEFAULT'
    );
  END IF;
END
$types$;

CREATE TABLE IF NOT EXISTS deviludo.workspace_steam_settings (
  workspace_id uuid PRIMARY KEY REFERENCES deviludo.workspaces(id) ON DELETE CASCADE,
  builder_username text NOT NULL CHECK (builder_username ~ '^[A-Za-z0-9_.-]{3,64}$'),
  credential_secret_ref text NOT NULL CHECK (
    credential_secret_ref LIKE 'vault://workspaces/' || workspace_id::text || '/steam/build-token/versions/%'
  ),
  credential_mask text NOT NULL CHECK (length(credential_mask) BETWEEN 8 AND 80),
  credential_fingerprint text NOT NULL CHECK (credential_fingerprint ~ '^sha256:[0-9a-f]{12}$'),
  credential_version uuid NOT NULL,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_by_actor_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS deviludo.project_steam_settings (
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  app_id bigint NOT NULL CHECK (app_id BETWEEN 1 AND 999999999999),
  depot_linux bigint CHECK (depot_linux BETWEEN 1 AND 999999999999),
  depot_windows bigint CHECK (depot_windows BETWEEN 1 AND 999999999999),
  depot_macos bigint CHECK (depot_macos BETWEEN 1 AND 999999999999),
  test_branch text NOT NULL DEFAULT 'deviludo-test'
    CHECK (test_branch ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$' AND test_branch <> 'default'),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_by_actor_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, project_id),
  FOREIGN KEY (workspace_id, project_id)
    REFERENCES deviludo.projects(workspace_id, id) ON DELETE CASCADE,
  CHECK (depot_linux IS NOT NULL OR depot_windows IS NOT NULL OR depot_macos IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS deviludo.steam_releases (
  workspace_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  workflow_id uuid NOT NULL,
  version text NOT NULL CHECK (
    version ~ '^(0|[1-9][0-9]*)[.](0|[1-9][0-9]*)[.](0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?([+][0-9A-Za-z.-]+)?$'
  ),
  release_number bigint NOT NULL CHECK (release_number > 0),
  channel deviludo.steam_release_channel NOT NULL,
  target_branch text NOT NULL CHECK (target_branch ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
  state deviludo.steam_release_state NOT NULL DEFAULT 'UPLOADING',
  app_id bigint NOT NULL CHECK (app_id > 0),
  depot_linux bigint,
  depot_windows bigint,
  depot_macos bigint,
  project_settings_revision bigint NOT NULL CHECK (project_settings_revision > 0),
  builder_username text NOT NULL,
  credential_secret_ref text NOT NULL,
  credential_revision bigint NOT NULL CHECK (credential_revision > 0),
  build_digests jsonb NOT NULL CHECK (jsonb_typeof(build_digests) = 'object'),
  steam_build_id text,
  failure_message text,
  requested_by_actor_id uuid NOT NULL,
  uploaded_at timestamptz,
  live_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, workflow_id),
  UNIQUE (workspace_id, project_id, version),
  UNIQUE (workspace_id, project_id, release_number),
  FOREIGN KEY (workspace_id, project_id) REFERENCES deviludo.projects(workspace_id, id),
  FOREIGN KEY (workspace_id, workflow_id) REFERENCES deviludo.workflow_instances(workspace_id, id),
  CHECK ((channel = 'DEFAULT' AND target_branch = 'default') OR (channel = 'TEST' AND target_branch <> 'default'))
);

ALTER TABLE deviludo.workspace_steam_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE deviludo.workspace_steam_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON deviludo.workspace_steam_settings
  USING (workspace_id = deviludo.current_workspace_id())
  WITH CHECK (workspace_id = deviludo.current_workspace_id());
ALTER TABLE deviludo.project_steam_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE deviludo.project_steam_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON deviludo.project_steam_settings
  USING (workspace_id = deviludo.current_workspace_id())
  WITH CHECK (workspace_id = deviludo.current_workspace_id());
ALTER TABLE deviludo.steam_releases ENABLE ROW LEVEL SECURITY;
ALTER TABLE deviludo.steam_releases FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON deviludo.steam_releases
  USING (workspace_id = deviludo.current_workspace_id())
  WITH CHECK (workspace_id = deviludo.current_workspace_id());

UPDATE deviludo.server_pools
   SET capabilities = ARRAY['E2E_TEST'], updated_at = clock_timestamp()
 WHERE kind IN ('E2E_LINUX', 'E2E_WINDOWS', 'E2E_MACOS');

-- Retire old active nodes without deleting their jobs or artifacts. A legacy
-- upload already in progress may finish; all signing and clean-install work is
-- cancelled because those capabilities are no longer deployed.
UPDATE deviludo.jobs
   SET state = 'CANCELLED', lease_owner = NULL, lease_token = NULL,
       lease_expires_at = NULL, heartbeat_at = NULL,
       fencing_token = fencing_token + 1,
       last_error = 'legacy signing/clean-install stage retired',
       updated_at = clock_timestamp()
 WHERE kind IN ('ARTIFACT_SIGN', 'STEAM_CLEAN_INSTALL')
   AND state IN ('QUEUED', 'RETRY', 'RUNNING');

UPDATE deviludo.workflow_instances
   SET state = 'RELEASE_DECISION_PENDING', version = version + 1, updated_at = clock_timestamp()
 WHERE state IN ('SIGNING', 'RELEASE_APPROVAL_PENDING');

UPDATE deviludo.workflow_instances workflow
   SET state = CASE WHEN EXISTS (
         SELECT 1 FROM deviludo.artifacts artifact
          WHERE artifact.workspace_id = workflow.workspace_id
            AND artifact.workflow_id = workflow.id
            AND artifact.kind = 'PUBLISH_RECEIPT'
       ) THEN 'SUCCEEDED'::deviludo.workflow_state
       ELSE 'RELEASE_DECISION_PENDING'::deviludo.workflow_state END,
       version = version + 1,
       updated_at = clock_timestamp()
 WHERE workflow.state = 'CLEAN_INSTALL_VERIFYING';

CREATE OR REPLACE FUNCTION deviludo.delivery_stages(p_profile deviludo.workflow_profile)
RETURNS deviludo.job_kind[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog
AS $$
  SELECT ARRAY['AGENT_GENERATION', 'ARTIFACT_BUILD', 'E2E_TEST', 'STEAM_PUBLISH']::deviludo.job_kind[]
$$;

DO $enqueue_patch$
DECLARE
  target regprocedure := 'deviludo.enqueue_job(uuid,uuid,uuid,deviludo.job_kind,deviludo.server_os,text,jsonb)'::regprocedure;
  definition text;
  old_input text := $old$WHEN 'STEAM_PUBLISH' THEN artifact.kind = 'SIGNED_BUILD'$old$;
  new_input text := $new$WHEN 'STEAM_PUBLISH' THEN artifact.kind = 'BUILD'
         AND artifact.target_platform::text IN (
           SELECT jsonb_array_elements_text(p_payload->'targetPlatforms')
         )
         AND artifact.producing_job_id = (
           SELECT build_job.id FROM deviludo.jobs build_job
            WHERE build_job.workspace_id = p_workspace_id
              AND build_job.workflow_id = p_workflow_id
              AND build_job.kind = 'ARTIFACT_BUILD'
              AND build_job.state = 'SUCCEEDED'
            ORDER BY build_job.updated_at DESC, build_job.created_at DESC LIMIT 1
         )$new$;
BEGIN
  SELECT pg_get_functiondef(target) INTO definition;
  IF position(old_input IN definition) = 0 THEN
    RAISE EXCEPTION 'enqueue_job Steam input contract no longer matches the expected definition';
  END IF;
  definition := replace(definition, old_input, new_input);
  definition := replace(
    definition,
    $$p_kind = 'STEAM_PUBLISH' AND v_input_count < coalesce(jsonb_array_length(p_payload->'targetPlatforms'), 1)$$,
    $$p_kind = 'STEAM_PUBLISH' AND v_input_count <> coalesce(jsonb_array_length(p_payload->'targetPlatforms'), 0)$$
  );
  EXECUTE definition;
END
$enqueue_patch$;

CREATE OR REPLACE FUNCTION deviludo.start_steam_release(
  p_workflow_id uuid, p_release_id uuid, p_idempotency_key text, p_payload jsonb
)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog, deviludo
AS $$
DECLARE
  workflow deviludo.workflow_instances%ROWTYPE;
  release deviludo.steam_releases%ROWTYPE;
  signal_id uuid;
BEGIN
  SELECT * INTO workflow FROM deviludo.workflow_instances WHERE id = p_workflow_id FOR UPDATE;
  IF workflow.id IS NULL OR workflow.state <> 'RELEASE_DECISION_PENDING' THEN
    RAISE EXCEPTION 'Steam upload requires a workflow awaiting a release decision';
  END IF;
  SELECT * INTO release FROM deviludo.steam_releases
   WHERE workspace_id = workflow.workspace_id AND id = p_release_id
     AND workflow_id = workflow.id AND state = 'UPLOADING' FOR UPDATE;
  IF release.id IS NULL THEN RAISE EXCEPTION 'Steam release approval is invalid'; END IF;
  INSERT INTO deviludo.external_signals(workspace_id, workflow_id, signal_kind, payload, idempotency_key)
  VALUES (workflow.workspace_id, workflow.id, 'RELEASE_APPROVED',
          p_payload || jsonb_build_object('releaseId', release.id), p_idempotency_key)
  ON CONFLICT (workspace_id, workflow_id, idempotency_key) DO NOTHING RETURNING id INTO signal_id;
  IF signal_id IS NULL THEN RETURN false; END IF;
  INSERT INTO deviludo.workflow_events(workspace_id, workflow_id, event_kind, event_data, idempotency_key)
  VALUES (workflow.workspace_id, workflow.id, 'RELEASE_APPROVED',
          p_payload || jsonb_build_object('releaseId', release.id), 'signal:' || p_idempotency_key);
  UPDATE deviludo.workflow_instances SET state = 'STEAM_PUBLISHING', version = version + 1,
    updated_at = clock_timestamp() WHERE workspace_id = workflow.workspace_id AND id = workflow.id;
  PERFORM deviludo.enqueue_job(
    workflow.workspace_id, workflow.id, workflow.project_id, 'STEAM_PUBLISH', NULL,
    workflow.id::text || ':publish:approved:' || signal_id::text,
    jsonb_build_object(
      'targetPlatforms', workflow.target_platforms,
      'approvalSignalId', signal_id,
      'approvedByActorId', p_payload->>'requestedByActorId',
      'steamRelease', jsonb_build_object(
        'releaseId', release.id, 'version', release.version,
        'releaseNumber', release.release_number, 'channel', release.channel,
        'targetBranch', release.target_branch, 'appId', release.app_id,
        'depots', jsonb_build_object('linux', release.depot_linux, 'windows', release.depot_windows, 'macos', release.depot_macos),
        'builderUsername', release.builder_username, 'credentialRef', release.credential_secret_ref
      )
    )
  );
  RETURN true;
END
$$;

CREATE OR REPLACE FUNCTION deviludo.complete_workflow_iteration(
  p_workflow_id uuid, p_idempotency_key text, p_payload jsonb
)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog, deviludo
AS $$
DECLARE
  workflow deviludo.workflow_instances%ROWTYPE;
  signal_id uuid;
BEGIN
  SELECT * INTO workflow FROM deviludo.workflow_instances WHERE id = p_workflow_id FOR UPDATE;
  IF workflow.id IS NULL OR workflow.state <> 'RELEASE_DECISION_PENDING' THEN
    RAISE EXCEPTION 'Finishing without Steam requires a workflow awaiting a release decision';
  END IF;
  INSERT INTO deviludo.external_signals(workspace_id, workflow_id, signal_kind, payload, idempotency_key)
  VALUES (workflow.workspace_id, workflow.id, 'RELEASE_SKIPPED', p_payload, p_idempotency_key)
  ON CONFLICT (workspace_id, workflow_id, idempotency_key) DO NOTHING RETURNING id INTO signal_id;
  IF signal_id IS NULL THEN RETURN false; END IF;
  INSERT INTO deviludo.workflow_events(workspace_id, workflow_id, event_kind, event_data, idempotency_key)
  VALUES (workflow.workspace_id, workflow.id, 'RELEASE_SKIPPED', p_payload, 'signal:' || p_idempotency_key);
  UPDATE deviludo.workflow_instances SET state = 'SUCCEEDED', version = version + 1,
    updated_at = clock_timestamp() WHERE workspace_id = workflow.workspace_id AND id = workflow.id;
  RETURN true;
END
$$;

CREATE OR REPLACE FUNCTION deviludo.retry_steam_release(
  p_workflow_id uuid, p_idempotency_key text, p_payload jsonb
)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog, deviludo
AS $$
DECLARE
  workflow deviludo.workflow_instances%ROWTYPE;
  release deviludo.steam_releases%ROWTYPE;
  signal_id uuid;
BEGIN
  SELECT * INTO workflow FROM deviludo.workflow_instances WHERE id = p_workflow_id FOR UPDATE;
  IF workflow.id IS NULL OR workflow.state <> 'FAILED' THEN
    RAISE EXCEPTION 'Steam retry requires a failed workflow';
  END IF;
  SELECT * INTO release FROM deviludo.steam_releases
   WHERE workspace_id = workflow.workspace_id AND workflow_id = workflow.id AND state = 'FAILED' FOR UPDATE;
  IF release.id IS NULL THEN RAISE EXCEPTION 'Failed Steam release was not found'; END IF;
  INSERT INTO deviludo.external_signals(workspace_id, workflow_id, signal_kind, payload, idempotency_key)
  VALUES (workflow.workspace_id, workflow.id, 'STAGE_RERUN_REQUESTED',
          p_payload || jsonb_build_object('stage', 'STEAM_PUBLISH'), p_idempotency_key)
  ON CONFLICT (workspace_id, workflow_id, idempotency_key) DO NOTHING RETURNING id INTO signal_id;
  IF signal_id IS NULL THEN RETURN false; END IF;
  INSERT INTO deviludo.workflow_events(workspace_id, workflow_id, event_kind, event_data, idempotency_key)
  VALUES (workflow.workspace_id, workflow.id, 'STAGE_RERUN_REQUESTED',
          p_payload || jsonb_build_object('stage', 'STEAM_PUBLISH'), 'signal:' || p_idempotency_key);
  UPDATE deviludo.jobs SET state = 'CANCELLED', last_error = 'superseded by Steam upload retry',
    updated_at = clock_timestamp()
   WHERE workspace_id = workflow.workspace_id AND workflow_id = workflow.id
     AND kind = 'STEAM_PUBLISH' AND state <> 'CANCELLED';
  UPDATE deviludo.steam_releases SET state = 'UPLOADING', failure_message = NULL,
    updated_at = clock_timestamp()
   WHERE workspace_id = workflow.workspace_id AND id = release.id;
  UPDATE deviludo.workflow_instances SET state = 'STEAM_PUBLISHING', version = version + 1,
    updated_at = clock_timestamp() WHERE workspace_id = workflow.workspace_id AND id = workflow.id;
  PERFORM deviludo.enqueue_job(
    workflow.workspace_id, workflow.id, workflow.project_id, 'STEAM_PUBLISH', NULL,
    workflow.id::text || ':rerun:STEAM_PUBLISH:' || signal_id::text,
    jsonb_build_object(
      'targetPlatforms', workflow.target_platforms,
      'steamRelease', jsonb_build_object(
        'releaseId', release.id, 'version', release.version,
        'releaseNumber', release.release_number, 'channel', release.channel,
        'targetBranch', release.target_branch, 'appId', release.app_id,
        'depots', jsonb_build_object('linux', release.depot_linux, 'windows', release.depot_windows, 'macos', release.depot_macos),
        'builderUsername', release.builder_username, 'credentialRef', release.credential_secret_ref
      )
    )
  );
  RETURN true;
END
$$;

DO $complete_patch$
DECLARE
  target regprocedure := 'deviludo.complete_job(uuid,uuid,bigint,bigint,jsonb,jsonb,text,text,text)'::regprocedure;
  definition text;
  old_flow text := $old$  THEN
    IF workflow.profile = 'VALIDATE' THEN
      UPDATE deviludo.workflow_instances SET state = 'SUCCEEDED', version = version + 1,
        updated_at = clock_timestamp() WHERE workspace_id = workflow.workspace_id AND id = workflow.id;
    ELSE
      UPDATE deviludo.workflow_instances SET state = 'SIGNING', version = version + 1,
        updated_at = clock_timestamp() WHERE workspace_id = workflow.workspace_id AND id = workflow.id;
      FOREACH platform IN ARRAY workflow.target_platforms
      LOOP
        PERFORM deviludo.enqueue_job(job.workspace_id, job.workflow_id, job.project_id, 'ARTIFACT_SIGN', platform,
          job.workflow_id::text || ':sign:' || platform::text || ':after:' || job.id::text);
      END LOOP;
    END IF;
  ELSIF workflow.state = 'SIGNING' AND job.kind = 'ARTIFACT_SIGN'
    AND NOT EXISTS (
      SELECT 1 FROM deviludo.jobs
       WHERE workspace_id = job.workspace_id AND workflow_id = job.workflow_id
         AND kind = 'ARTIFACT_SIGN' AND state <> 'SUCCEEDED'
    )
  THEN
    -- Signing is reversible; publishing to Steam is not. Hold the exact signed
    -- builds until a workspace administrator explicitly approves this release.
    UPDATE deviludo.workflow_instances SET state = 'RELEASE_APPROVAL_PENDING', version = version + 1,
      updated_at = clock_timestamp() WHERE workspace_id = workflow.workspace_id AND id = workflow.id;
  ELSIF workflow.state = 'STEAM_PUBLISHING' AND job.kind = 'STEAM_PUBLISH' THEN
    UPDATE deviludo.workflow_instances SET state = 'CLEAN_INSTALL_VERIFYING', version = version + 1,
      updated_at = clock_timestamp() WHERE workspace_id = workflow.workspace_id AND id = workflow.id;
    FOREACH platform IN ARRAY workflow.target_platforms
    LOOP
      PERFORM deviludo.enqueue_job(job.workspace_id, job.workflow_id, job.project_id, 'STEAM_CLEAN_INSTALL', platform,
        job.workflow_id::text || ':clean-install:' || platform::text || ':after:' || job.id::text);
    END LOOP;
  ELSIF workflow.state = 'CLEAN_INSTALL_VERIFYING' AND job.kind = 'STEAM_CLEAN_INSTALL'
    AND NOT EXISTS (
      SELECT 1 FROM deviludo.jobs
       WHERE workspace_id = job.workspace_id AND workflow_id = job.workflow_id
         AND kind = 'STEAM_CLEAN_INSTALL' AND state <> 'SUCCEEDED'
    )
  THEN
    UPDATE deviludo.workflow_instances SET state = 'SUCCEEDED', version = version + 1,
      updated_at = clock_timestamp() WHERE workspace_id = workflow.workspace_id AND id = workflow.id;
$old$;
  new_flow text := $new$  THEN
    UPDATE deviludo.workflow_instances SET state = 'RELEASE_DECISION_PENDING', version = version + 1,
      updated_at = clock_timestamp() WHERE workspace_id = workflow.workspace_id AND id = workflow.id;
  ELSIF workflow.state = 'STEAM_PUBLISHING' AND job.kind = 'STEAM_PUBLISH' THEN
    UPDATE deviludo.steam_releases
       SET state = CASE channel WHEN 'TEST' THEN 'LIVE_TEST'::deviludo.steam_release_state
             ELSE 'AWAITING_DEFAULT_PROMOTION'::deviludo.steam_release_state END,
           steam_build_id = nullif(p_receipt->>'steamBuildId', ''),
           uploaded_at = clock_timestamp(),
           live_at = CASE WHEN channel = 'TEST' THEN clock_timestamp() ELSE NULL END,
           failure_message = NULL, updated_at = clock_timestamp()
     WHERE workspace_id = job.workspace_id
       AND id = (job.payload #>> '{steamRelease,releaseId}')::uuid;
    UPDATE deviludo.workflow_instances SET state = 'SUCCEEDED', version = version + 1,
      updated_at = clock_timestamp() WHERE workspace_id = workflow.workspace_id AND id = workflow.id;
$new$;
BEGIN
  SELECT pg_get_functiondef(target) INTO definition;
  IF position(old_flow IN definition) = 0 THEN
    RAISE EXCEPTION 'complete_job delivery flow no longer matches the expected definition';
  END IF;
  EXECUTE replace(definition, old_flow, new_flow);
END
$complete_patch$;

CREATE OR REPLACE FUNCTION deviludo.sync_steam_release_job_state()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog, deviludo
AS $$
BEGIN
  IF NEW.kind = 'STEAM_PUBLISH' AND NEW.state = 'FAILED' AND OLD.state IS DISTINCT FROM NEW.state THEN
    UPDATE deviludo.steam_releases
       SET state = 'FAILED', failure_message = left(NEW.last_error, 2000), updated_at = clock_timestamp()
     WHERE workspace_id = NEW.workspace_id
       AND id = (NEW.payload #>> '{steamRelease,releaseId}')::uuid;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER sync_steam_release_job_state
AFTER UPDATE OF state ON deviludo.jobs
FOR EACH ROW EXECUTE FUNCTION deviludo.sync_steam_release_job_state();

REVOKE ALL ON deviludo.workspace_steam_settings, deviludo.project_steam_settings,
  deviludo.steam_releases FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON deviludo.workspace_steam_settings,
  deviludo.project_steam_settings, deviludo.steam_releases TO deviludo_api;
GRANT SELECT, UPDATE ON deviludo.steam_releases TO deviludo_scheduler, deviludo_sandbox, deviludo_claim_executor;
GRANT EXECUTE ON FUNCTION deviludo.start_steam_release(uuid, uuid, text, jsonb),
  deviludo.complete_workflow_iteration(uuid, text, jsonb),
  deviludo.retry_steam_release(uuid, text, jsonb) TO deviludo_api;

ALTER FUNCTION deviludo.complete_job(uuid, uuid, bigint, bigint, jsonb, jsonb, text, text, text)
  OWNER TO deviludo_claim_executor;

COMMIT;
