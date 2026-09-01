BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'deviludo_api') THEN
    CREATE ROLE deviludo_api NOLOGIN NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'deviludo_scheduler') THEN
    CREATE ROLE deviludo_scheduler NOLOGIN NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'deviludo_sandbox') THEN
    CREATE ROLE deviludo_sandbox NOLOGIN NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'deviludo_claim_executor') THEN
    CREATE ROLE deviludo_claim_executor NOLOGIN BYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'deviludo_conversation_writer') THEN
    CREATE ROLE deviludo_conversation_writer NOLOGIN BYPASSRLS;
  END IF;
  EXECUTE format(
    'GRANT deviludo_api, deviludo_scheduler, deviludo_sandbox, deviludo_conversation_writer TO %I',
    current_user
  );
END
$roles$;

CREATE SCHEMA deviludo;
REVOKE ALL ON SCHEMA deviludo FROM PUBLIC;
GRANT USAGE ON SCHEMA deviludo TO
  deviludo_api, deviludo_scheduler, deviludo_sandbox, deviludo_claim_executor,
  deviludo_conversation_writer;

CREATE TYPE deviludo.server_pool_kind AS ENUM (
  'WEB', 'CORE', 'E2E_LINUX', 'E2E_WINDOWS', 'E2E_MACOS'
);
CREATE TYPE deviludo.server_os AS ENUM ('linux', 'windows', 'macos');
CREATE TYPE deviludo.server_node_state AS ENUM (
  'PROVISIONING', 'ACTIVE', 'DRAINING', 'DISABLED', 'REIMAGING'
);
CREATE TYPE deviludo.workflow_state AS ENUM (
  'DRAFT', 'ANALYZING', 'DESIGNING', 'UI_DESIGNING', 'DEVELOPING', 'BUILDING', 'TEST_PLANNING',
  'TESTING', 'RELEASE_APPROVAL_PENDING', 'STEAM_PUBLISHING',
  'SUCCEEDED', 'BLOCKED', 'STOPPED', 'FAILED', 'CANCELLED'
);
CREATE TYPE deviludo.job_kind AS ENUM (
  'AGENT_TURN', 'BUILD', 'E2E_PLATFORM_RUN', 'STEAM_PUBLISH'
);
CREATE TYPE deviludo.job_state AS ENUM (
  'QUEUED', 'RUNNING', 'RETRY', 'SUCCEEDED', 'FAILED', 'CANCELLED'
);
CREATE TYPE deviludo.operation_state AS ENUM (
  'REGISTERED', 'IN_PROGRESS', 'RECEIPTED', 'RECONCILIATION_REQUIRED', 'VOID'
);
CREATE TYPE deviludo.agent_runtime AS ENUM ('CLAUDE_CODE', 'CODEX_CLI');
CREATE TYPE deviludo.agent_role AS ENUM ('INTENT', 'ANALYSIS', 'DESIGN', 'UI_DESIGN', 'DEVELOPMENT', 'TEST');
CREATE TYPE deviludo.agent_container_state AS ENUM (
  'CREATING', 'RUNNING', 'PAUSING', 'PAUSED', 'COMPACTING', 'DESTROYED', 'STOPPED', 'FAILED'
);
CREATE TYPE deviludo.agent_turn_state AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED');
CREATE TYPE deviludo.agent_turn_mode AS ENUM ('PRIMARY', 'READ_ONLY_BRANCH', 'COMPACT');
CREATE TYPE deviludo.agent_lifecycle_action AS ENUM ('PAUSE', 'DESTROY');
CREATE TYPE deviludo.workflow_profile AS ENUM ('VALIDATE', 'RELEASE');
CREATE TYPE deviludo.artifact_kind AS ENUM (
  'SPECIFICATION', 'PROJECT_DOCUMENT', 'BUILD', 'E2E_REPORT', 'E2E_REGRESSION', 'SIGNED_BUILD',
  'PUBLISH_RECEIPT', 'CLEAN_INSTALL_REPORT'
);
CREATE TYPE deviludo.steam_release_channel AS ENUM ('TEST', 'DEFAULT');
CREATE TYPE deviludo.steam_release_state AS ENUM (
  'UPLOADING', 'FAILED', 'LIVE_TEST', 'AWAITING_DEFAULT_PROMOTION', 'LIVE_DEFAULT'
);

-- This is a destructive compatibility baseline, not an incremental migration
-- series. `source_digest` records the exact baseline bytes after this file is
-- loaded; any other shape requires an explicit reset instead of ALTER replay.
CREATE TABLE deviludo.schema_metadata (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  baseline text NOT NULL,
  compatibility text NOT NULL,
  current_version text NOT NULL DEFAULT '001_persistent_multi_agent',
  source_digest text CHECK (source_digest IS NULL OR source_digest ~ '^sha256:[0-9a-f]{64}$'),
  applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO deviludo.schema_metadata(singleton, baseline, compatibility, current_version)
VALUES (true, '003', 'deviludo-persistent-multi-agent-v3', '001_persistent_multi_agent');

-- The ledger contains exactly one entry whose checksum is the full baseline
-- digest. Historical migration rows are incompatible with this release.
CREATE TABLE deviludo.schema_migrations (
  version text PRIMARY KEY CHECK (version ~ '^[0-9]{3}_[a-z0-9_]+$'),
  checksum text NOT NULL CHECK (checksum ~ '^sha256:[0-9a-f]{64}$'),
  applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE deviludo.server_pools (
  kind deviludo.server_pool_kind PRIMARY KEY,
  operating_system deviludo.server_os NOT NULL,
  minimum_nodes integer NOT NULL CHECK (minimum_nodes >= 0),
  maximum_nodes integer NOT NULL CHECK (maximum_nodes >= minimum_nodes),
  desired_nodes integer NOT NULL CHECK (desired_nodes BETWEEN minimum_nodes AND maximum_nodes),
  capabilities text[] NOT NULL CHECK (cardinality(capabilities) > 0),
  public_ingress boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (
    (kind IN ('WEB', 'CORE', 'E2E_LINUX') AND operating_system = 'linux')
    OR (kind = 'E2E_WINDOWS' AND operating_system = 'windows')
    OR (kind = 'E2E_MACOS' AND operating_system = 'macos')
  ),
  CHECK (public_ingress = (kind = 'WEB'))
);

INSERT INTO deviludo.server_pools
  (kind, operating_system, minimum_nodes, maximum_nodes, desired_nodes, capabilities, public_ingress)
VALUES
  ('WEB', 'linux', 1, 1, 1, ARRAY['SELF_HOSTED_WEB', 'STREAMING_BFF'], true),
  ('CORE', 'linux', 1, 1, 1, ARRAY[
    'AUTOMATION_API', 'WORKFLOW_SCHEDULER', 'AGENT_TURN', 'BUILD', 'STEAM_PUBLISH',
    'RESTRICTED_CONTAINER', 'NETWORK_POLICY'
  ], false),
  ('E2E_LINUX', 'linux', 1, 1, 1, ARRAY['E2E_PLATFORM_RUN'], false),
  ('E2E_WINDOWS', 'windows', 1, 1, 1, ARRAY['E2E_PLATFORM_RUN'], false),
  ('E2E_MACOS', 'macos', 0, 1, 0, ARRAY['E2E_PLATFORM_RUN'], false);

CREATE TABLE deviludo.server_nodes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pool_kind deviludo.server_pool_kind NOT NULL REFERENCES deviludo.server_pools(kind),
  operating_system deviludo.server_os NOT NULL,
  state deviludo.server_node_state NOT NULL DEFAULT 'PROVISIONING',
  capabilities text[] NOT NULL DEFAULT ARRAY[]::text[],
  isolation_generation bigint NOT NULL DEFAULT 1 CHECK (isolation_generation > 0),
  current_workspace_id uuid,
  agent_installed boolean NOT NULL DEFAULT false CHECK (agent_installed = false),
  development_auth_token_hash text CHECK (
    development_auth_token_hash IS NULL OR development_auth_token_hash ~ '^sha256:[0-9a-f]{64}$'
  ),
  last_heartbeat_at timestamptz,
  last_reimage_proof_at timestamptz,
  preparation_state text CHECK (preparation_state IS NULL OR preparation_state IN ('PREPARING', 'READY', 'FAILED')),
  preparation_stage text CHECK (preparation_stage IS NULL OR preparation_stage ~ '^[A-Z][A-Z0-9_]{1,39}$'),
  preparation_progress smallint CHECK (preparation_progress IS NULL OR preparation_progress BETWEEN 0 AND 100),
  preparation_message text CHECK (preparation_message IS NULL OR char_length(preparation_message) BETWEEN 1 AND 240),
  preparation_updated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (
    (pool_kind IN ('WEB', 'CORE', 'E2E_LINUX') AND operating_system = 'linux')
    OR (pool_kind = 'E2E_WINDOWS' AND operating_system = 'windows')
    OR (pool_kind = 'E2E_MACOS' AND operating_system = 'macos')
  )
);
CREATE INDEX server_nodes_pool_state ON deviludo.server_nodes(pool_kind, state);

CREATE TABLE deviludo.executor_identities (
  executor_id text PRIMARY KEY CHECK (executor_id ~ '^[A-Za-z0-9][A-Za-z0-9:._-]{2,199}$'),
  identity_kind text NOT NULL CHECK (identity_kind IN ('CORE', 'E2E')),
  node_id uuid UNIQUE REFERENCES deviludo.server_nodes(id) ON DELETE CASCADE,
  public_key_pem text NOT NULL CHECK (
    public_key_pem LIKE '-----BEGIN PUBLIC KEY-----%'
    AND length(public_key_pem) BETWEEN 100 AND 2000
  ),
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((identity_kind = 'E2E') = (node_id IS NOT NULL))
);

CREATE TABLE deviludo.pool_capacity_intents (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  pool_kind deviludo.server_pool_kind NOT NULL REFERENCES deviludo.server_pools(kind),
  desired_nodes integer NOT NULL CHECK (desired_nodes BETWEEN 0 AND 1),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 200),
  operation_key text NOT NULL UNIQUE CHECK (length(operation_key) BETWEEN 8 AND 300),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

INSERT INTO deviludo.pool_capacity_intents(pool_kind, desired_nodes, reason, operation_key)
SELECT kind, desired_nodes, 'P0_BASELINE', 'p0-baseline:' || kind::text
FROM deviludo.server_pools;

CREATE TABLE deviludo.workspaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- Steam build credentials are workspace-scoped. Only the opaque secret
-- reference and a display mask are stored in Postgres; the credential itself
-- remains in Vault (or the local development secret store).
CREATE TABLE deviludo.workspace_steam_settings (
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

CREATE TABLE deviludo.e2e_enrollment_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^sha256:[0-9a-f]{64}$'),
  pool_kind deviludo.server_pool_kind NOT NULL CHECK (pool_kind IN ('E2E_LINUX', 'E2E_WINDOWS', 'E2E_MACOS')),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  node_id uuid REFERENCES deviludo.server_nodes(id),
  created_by_actor_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (expires_at > created_at),
  CHECK ((used_at IS NULL) = (node_id IS NULL))
);

CREATE TABLE deviludo.e2e_node_certificates (
  node_id uuid PRIMARY KEY REFERENCES deviludo.server_nodes(id) ON DELETE CASCADE,
  serial_number text NOT NULL UNIQUE,
  spiffe_uri text NOT NULL UNIQUE CHECK (spiffe_uri ~ '^spiffe://deviludo/e2e-node/[0-9a-f-]{36}$'),
  not_after timestamptz NOT NULL,
  renewed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE deviludo.instance_agent_settings (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  agent_runtime deviludo.agent_runtime NOT NULL,
  base_url text NOT NULL CHECK (
    length(base_url) BETWEEN 8 AND 2048
    AND base_url ~ '^https?://'
  ),
  primary_model text NOT NULL CHECK (primary_model ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'),
  model_overrides jsonb NOT NULL CHECK (
    jsonb_typeof(model_overrides) = 'object'
    AND model_overrides ?& ARRAY['intent', 'analysis', 'design', 'uiDesign', 'development', 'test']
    AND model_overrides - ARRAY['intent', 'analysis', 'design', 'uiDesign', 'development', 'test']::text[] = '{}'::jsonb
    AND (model_overrides->'intent' = 'null'::jsonb OR (model_overrides->>'intent') ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$')
    AND (model_overrides->'analysis' = 'null'::jsonb OR (model_overrides->>'analysis') ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$')
    AND (model_overrides->'design' = 'null'::jsonb OR (model_overrides->>'design') ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$')
    AND (model_overrides->'uiDesign' = 'null'::jsonb OR (model_overrides->>'uiDesign') ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$')
    AND (model_overrides->'development' = 'null'::jsonb OR (model_overrides->>'development') ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$')
    AND (model_overrides->'test' = 'null'::jsonb OR (model_overrides->>'test') ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$')
  ),
  image_model text CHECK (image_model IS NULL OR image_model ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'),
  credential_secret_ref text NOT NULL CHECK (
    length(credential_secret_ref) BETWEEN 32 AND 1000
    AND credential_secret_ref LIKE 'vault://instance/agent-runtime/api-key/versions/%'
  ),
  api_key_mask text NOT NULL CHECK (api_key_mask ~ '^.{3}\*{8}.{4}$'),
  api_key_fingerprint text NOT NULL CHECK (api_key_fingerprint ~ '^sha256:[0-9a-f]{12}$'),
  credential_version uuid NOT NULL,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  test_policy_ready boolean NOT NULL DEFAULT false,
  test_policy_checked_revision bigint CHECK (test_policy_checked_revision IS NULL OR test_policy_checked_revision > 0),
  updated_by text NOT NULL CHECK (length(updated_by) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE deviludo.runtime_images (
  runtime_key text PRIMARY KEY CHECK (runtime_key IN (
    'AGENT_CLAUDE', 'AGENT_CODEX', 'GODOT_BUILDER', 'STEAM_PUBLISHER',
    'E2E_LINUX', 'E2E_WINDOWS', 'E2E_MACOS'
  )),
  image_reference text NOT NULL CHECK (image_reference ~ '^(.+@)?sha256:[0-9a-f]{64}$'),
  release_version text NOT NULL CHECK (length(release_version) BETWEEN 1 AND 100),
  verified_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE deviludo.projects (
  workspace_id uuid NOT NULL REFERENCES deviludo.workspaces(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  created_by_actor_id uuid NOT NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  last_activity_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, id)
);

CREATE TABLE deviludo.project_steam_settings (
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

CREATE TABLE deviludo.project_source_revisions (
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  revision bigint NOT NULL CHECK (revision > 0),
  relative_path text NOT NULL CHECK (
    relative_path = 'workspaces/' || workspace_id::text || '/projects/' || project_id::text
      || '/revisions/r' || lpad(revision::text, 12, '0') || '-' || substring(content_digest from 8 for 16)
  ),
  content_digest text NOT NULL CHECK (content_digest ~ '^sha256:[0-9a-f]{64}$'),
  file_count integer NOT NULL CHECK (file_count BETWEEN 1 AND 20000),
  total_bytes bigint NOT NULL CHECK (total_bytes BETWEEN 1 AND 1073741824),
  workflow_id uuid,
  job_id uuid,
  actor_id uuid NOT NULL,
  fencing_token bigint CHECK (fencing_token IS NULL OR fencing_token > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, project_id, revision),
  FOREIGN KEY (workspace_id, project_id) REFERENCES deviludo.projects(workspace_id, id) ON DELETE CASCADE
);

CREATE TABLE deviludo.project_documents (
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  content jsonb NOT NULL CHECK (
    jsonb_typeof(content) = 'object'
    AND jsonb_typeof(content->'introduction') = 'string'
    AND jsonb_typeof(content->'gameplay') = 'string'
    AND jsonb_typeof(content->'uiDesign') = 'string'
    AND jsonb_typeof(content->'categories') = 'array'
    AND jsonb_array_length(content->'categories') BETWEEN 1 AND 32
    AND jsonb_typeof(content->'features') = 'array'
    AND jsonb_array_length(content->'features') BETWEEN 1 AND 32
  ),
  markdown text NOT NULL CHECK (length(markdown) BETWEEN 1 AND 100000),
  maintained_by text NOT NULL CHECK (maintained_by IN ('SYSTEM', 'USER', 'AGENT')),
  updated_by_actor_id uuid,
  last_agent_maintained_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, project_id),
  FOREIGN KEY (workspace_id, project_id)
    REFERENCES deviludo.projects(workspace_id, id) ON DELETE CASCADE
);

CREATE TABLE deviludo.project_document_revisions (
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  revision bigint NOT NULL CHECK (revision > 0),
  content jsonb NOT NULL CHECK (jsonb_typeof(content) = 'object'),
  markdown text NOT NULL CHECK (length(markdown) BETWEEN 1 AND 100000),
  source text NOT NULL CHECK (source IN ('PROJECT_CREATED', 'PROJECT_IMPORTED', 'USER_EDIT', 'AGENT_CONVERSATION', 'AGENT_IDLE_MAINTENANCE')),
  author_actor_id uuid,
  maintenance_job_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, project_id, revision),
  FOREIGN KEY (workspace_id, project_id)
    REFERENCES deviludo.project_documents(workspace_id, project_id) ON DELETE CASCADE
);

CREATE TABLE deviludo.project_conversations (
  workspace_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  mode text NOT NULL CHECK (mode IN ('NEW_GAME', 'PROJECT_FEEDBACK')),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id) REFERENCES deviludo.workspaces(id),
  FOREIGN KEY (workspace_id, project_id) REFERENCES deviludo.projects(workspace_id, id),
  CHECK (mode IN ('NEW_GAME', 'PROJECT_FEEDBACK'))
);
CREATE INDEX project_conversations_recent
  ON deviludo.project_conversations(workspace_id, updated_at DESC);

CREATE TABLE deviludo.conversation_messages (
  workspace_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  message_id bigint GENERATED ALWAYS AS IDENTITY,
  role text NOT NULL CHECK (role IN ('USER', 'ASSISTANT')),
  content text NOT NULL CHECK (length(content) BETWEEN 1 AND 4000),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, message_id),
  FOREIGN KEY (workspace_id, conversation_id)
    REFERENCES deviludo.project_conversations(workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT conversation_messages_completed_after_creation CHECK (completed_at >= created_at)
);
CREATE INDEX conversation_messages_thread
  ON deviludo.conversation_messages(workspace_id, conversation_id, message_id);

CREATE TABLE deviludo.agent_installations (
  workspace_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  project_id uuid,
  agent_kind text NOT NULL CHECK (length(agent_kind) BETWEEN 1 AND 80),
  exact_version text NOT NULL CHECK (length(exact_version) BETWEEN 1 AND 120),
  image_digest text NOT NULL CHECK (image_digest ~ '^sha256:[0-9a-f]{64}$'),
  execution_pool deviludo.server_pool_kind NOT NULL DEFAULT 'CORE' CHECK (execution_pool = 'CORE'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id) REFERENCES deviludo.workspaces(id),
  FOREIGN KEY (workspace_id, project_id) REFERENCES deviludo.projects(workspace_id, id)
);

CREATE TABLE deviludo.workflow_instances (
  workspace_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  iteration_number integer NOT NULL DEFAULT 1 CHECK (iteration_number > 0),
  parent_workflow_id uuid,
  development_actor_id uuid,
  profile deviludo.workflow_profile NOT NULL DEFAULT 'VALIDATE',
  target_platforms deviludo.server_os[] NOT NULL DEFAULT ARRAY['macos']::deviludo.server_os[]
    CHECK (cardinality(target_platforms) BETWEEN 1 AND 3),
  state deviludo.workflow_state NOT NULL DEFAULT 'DRAFT',
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
  state_data jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(state_data) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, project_id, iteration_number),
  UNIQUE (workspace_id, parent_workflow_id),
  FOREIGN KEY (workspace_id) REFERENCES deviludo.workspaces(id),
  FOREIGN KEY (workspace_id, project_id) REFERENCES deviludo.projects(workspace_id, id),
  FOREIGN KEY (workspace_id, parent_workflow_id)
    REFERENCES deviludo.workflow_instances(workspace_id, id)
);

CREATE TABLE deviludo.host_source_events (
  event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  workflow_id uuid NOT NULL,
  source_revision bigint NOT NULL,
  content_digest text NOT NULL CHECK (content_digest ~ '^sha256:[0-9a-f]{64}$'),
  actor_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  acknowledged_at timestamptz,
  UNIQUE (workspace_id, project_id, workflow_id, source_revision),
  FOREIGN KEY (workspace_id, project_id, source_revision)
    REFERENCES deviludo.project_source_revisions(workspace_id, project_id, revision)
    ON DELETE CASCADE
);
CREATE INDEX host_source_events_pending
  ON deviludo.host_source_events(created_at, event_id)
  WHERE acknowledged_at IS NULL;

CREATE OR REPLACE FUNCTION deviludo.enqueue_host_source_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, deviludo
SET row_security = off
AS $$
BEGIN
  IF NEW.state = 'SUCCEEDED' AND OLD.state IS DISTINCT FROM NEW.state THEN
    INSERT INTO deviludo.host_source_events(
      workspace_id, project_id, workflow_id, source_revision, content_digest, actor_id
    )
    SELECT NEW.workspace_id, NEW.project_id, NEW.id, source.revision,
           source.content_digest, coalesce(NEW.development_actor_id, source.actor_id)
      FROM deviludo.project_source_revisions source
     WHERE source.workspace_id = NEW.workspace_id AND source.project_id = NEW.project_id
     ORDER BY source.revision DESC
     LIMIT 1
    ON CONFLICT (workspace_id, project_id, workflow_id, source_revision) DO NOTHING;
  END IF;
  RETURN NEW;
END
$$;
ALTER FUNCTION deviludo.enqueue_host_source_event() OWNER TO deviludo_claim_executor;
CREATE TRIGGER workflow_host_source_event
AFTER UPDATE OF state ON deviludo.workflow_instances
FOR EACH ROW EXECUTE FUNCTION deviludo.enqueue_host_source_event();

CREATE OR REPLACE FUNCTION deviludo.pull_host_source_events(p_limit integer DEFAULT 100)
RETURNS TABLE (
  event_id uuid,
  workspace_id uuid,
  project_id uuid,
  workflow_id uuid,
  source_revision bigint,
  content_digest text,
  actor_id uuid,
  created_at timestamptz
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = pg_catalog, deviludo
SET row_security = off
AS $$
  SELECT event.event_id, event.workspace_id, event.project_id, event.workflow_id,
         event.source_revision, event.content_digest, event.actor_id, event.created_at
    FROM deviludo.host_source_events event
   WHERE event.acknowledged_at IS NULL
   ORDER BY event.created_at, event.event_id
   LIMIT greatest(1, least(p_limit, 500))
$$;
ALTER FUNCTION deviludo.pull_host_source_events(integer) OWNER TO deviludo_claim_executor;

CREATE OR REPLACE FUNCTION deviludo.acknowledge_host_source_events(p_event_ids uuid[])
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, deviludo
SET row_security = off
AS $$
DECLARE
  acknowledged bigint;
BEGIN
  IF cardinality(p_event_ids) NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'source event acknowledgement size is invalid';
  END IF;
  UPDATE deviludo.host_source_events
     SET acknowledged_at = coalesce(acknowledged_at, clock_timestamp())
   WHERE event_id = ANY(p_event_ids);
  GET DIAGNOSTICS acknowledged = ROW_COUNT;
  RETURN acknowledged;
END
$$;
ALTER FUNCTION deviludo.acknowledge_host_source_events(uuid[]) OWNER TO deviludo_claim_executor;

CREATE TABLE deviludo.implementation_change_requests (
  workspace_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  workflow_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  source_message_id bigint NOT NULL,
  state text NOT NULL CHECK (state IN ('PENDING', 'WAITING_FOR_ANALYSIS', 'APPLIED', 'REJECTED', 'SUPERSEDED')),
  summary text NOT NULL CHECK (length(summary) BETWEEN 1 AND 2000),
  implementation_brief text NOT NULL CHECK (length(implementation_brief) BETWEEN 1 AND 12000),
  base_document_revision bigint NOT NULL CHECK (base_document_revision > 0),
  project_document_patch jsonb NOT NULL CHECK (jsonb_typeof(project_document_patch) = 'object'),
  e2e_goal_delta jsonb NOT NULL CHECK (jsonb_typeof(e2e_goal_delta) = 'object'),
  explicit_execution boolean NOT NULL,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 300),
  decision text CHECK (decision IS NULL OR decision IN ('CONFIRM', 'REJECT')),
  decision_idempotency_key text CHECK (decision_idempotency_key IS NULL OR length(decision_idempotency_key) BETWEEN 8 AND 300),
  applied_workflow_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, idempotency_key),
  UNIQUE (workspace_id, decision_idempotency_key),
  FOREIGN KEY (workspace_id, project_id) REFERENCES deviludo.projects(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, workflow_id) REFERENCES deviludo.workflow_instances(workspace_id, id),
  FOREIGN KEY (workspace_id, conversation_id) REFERENCES deviludo.project_conversations(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, source_message_id) REFERENCES deviludo.conversation_messages(workspace_id, message_id),
  FOREIGN KEY (workspace_id, applied_workflow_id) REFERENCES deviludo.workflow_instances(workspace_id, id)
);
CREATE UNIQUE INDEX implementation_change_requests_one_pending
  ON deviludo.implementation_change_requests(workspace_id, project_id)
  WHERE state IN ('PENDING', 'WAITING_FOR_ANALYSIS');

CREATE TABLE deviludo.workflow_e2e_goal_revisions (
  workspace_id uuid NOT NULL,
  workflow_id uuid NOT NULL,
  revision bigint NOT NULL CHECK (revision > 0),
  change_request_id uuid,
  goals jsonb NOT NULL CHECK (jsonb_typeof(goals) = 'array'),
  goals_digest text NOT NULL CHECK (goals_digest ~ '^sha256:[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, workflow_id, revision),
  FOREIGN KEY (workspace_id, workflow_id) REFERENCES deviludo.workflow_instances(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, change_request_id) REFERENCES deviludo.implementation_change_requests(workspace_id, id)
);

-- A release is immutable after upload succeeds and belongs to exactly one
-- workflow iteration. Failed uploads reuse the same row and release number.
CREATE TABLE deviludo.steam_releases (
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

CREATE TABLE deviludo.workflow_events (
  workspace_id uuid NOT NULL,
  event_id bigint GENERATED ALWAYS AS IDENTITY,
  workflow_id uuid NOT NULL,
  event_kind text NOT NULL CHECK (length(event_kind) BETWEEN 1 AND 120),
  event_data jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(event_data) = 'object'),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 300),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, event_id),
  UNIQUE (workspace_id, workflow_id, idempotency_key),
  FOREIGN KEY (workspace_id, workflow_id)
    REFERENCES deviludo.workflow_instances(workspace_id, id)
);

CREATE TABLE deviludo.jobs (
  workspace_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  workflow_id uuid NOT NULL,
  project_id uuid NOT NULL,
  kind deviludo.job_kind NOT NULL,
  pool_kind deviludo.server_pool_kind NOT NULL,
  target_operating_system deviludo.server_os,
  required_capabilities text[] NOT NULL CHECK (cardinality(required_capabilities) > 0),
  exclusive boolean NOT NULL,
  isolation_generation bigint NOT NULL DEFAULT 1 CHECK (isolation_generation > 0),
  runtime_image text NOT NULL CHECK (runtime_image ~ '^(.+@)?sha256:[0-9a-f]{64}$'),
  timeout_seconds integer NOT NULL DEFAULT 1800 CHECK (timeout_seconds BETWEEN 1 AND 86400),
  budget jsonb NOT NULL DEFAULT '{"cpuMillis":900000,"memoryBytes":4294967296,"networkBytes":1073741824}'::jsonb
    CHECK (jsonb_typeof(budget) = 'object'),
  output_contract jsonb NOT NULL DEFAULT '{"kinds":[],"maxBytes":1073741824}'::jsonb
    CHECK (jsonb_typeof(output_contract) = 'object'),
  state deviludo.job_state NOT NULL DEFAULT 'QUEUED',
  payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
  receipt jsonb CHECK (receipt IS NULL OR jsonb_typeof(receipt) = 'object'),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 300),
  priority integer NOT NULL DEFAULT 100 CHECK (priority BETWEEN 0 AND 1000),
  attempt integer NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  max_attempts integer NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 20),
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  lease_owner text,
  lease_token uuid,
  lease_expires_at timestamptz,
  heartbeat_at timestamptz,
  fencing_token bigint NOT NULL DEFAULT 0 CHECK (fencing_token >= 0),
  last_error text,
  before_reimage_proof text,
  cleanup_proof text,
  after_reimage_proof text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, idempotency_key),
  FOREIGN KEY (workspace_id) REFERENCES deviludo.workspaces(id),
  FOREIGN KEY (workspace_id, project_id) REFERENCES deviludo.projects(workspace_id, id),
  FOREIGN KEY (workspace_id, workflow_id) REFERENCES deviludo.workflow_instances(workspace_id, id),
  CHECK (
    (
      kind IN ('AGENT_TURN', 'BUILD', 'STEAM_PUBLISH')
      AND pool_kind = 'CORE'
      AND target_operating_system IS NULL
      AND exclusive = false
    )
    OR (
      kind = 'E2E_PLATFORM_RUN'
      AND exclusive = true
      AND (
        (pool_kind = 'E2E_LINUX' AND target_operating_system = 'linux')
        OR (pool_kind = 'E2E_WINDOWS' AND target_operating_system = 'windows')
        OR (pool_kind = 'E2E_MACOS' AND target_operating_system = 'macos')
      )
    )
  ),
  CHECK (
    (state IN ('QUEUED', 'RETRY', 'SUCCEEDED', 'FAILED', 'CANCELLED')
      AND lease_owner IS NULL AND lease_token IS NULL AND lease_expires_at IS NULL)
    OR
    (state = 'RUNNING'
      AND lease_owner IS NOT NULL AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
  )
);
CREATE INDEX jobs_claim_order
  ON deviludo.jobs(pool_kind, state, available_at, priority DESC, created_at);
CREATE UNIQUE INDEX jobs_one_active_lease_per_executor
  ON deviludo.jobs(lease_owner) WHERE state = 'RUNNING';

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

ALTER TABLE deviludo.project_document_revisions
  ADD FOREIGN KEY (workspace_id, maintenance_job_id)
  REFERENCES deviludo.jobs(workspace_id, id);

CREATE TABLE deviludo.external_signals (
  workspace_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  workflow_id uuid NOT NULL,
  signal_kind text NOT NULL CHECK (length(signal_kind) BETWEEN 1 AND 120),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 300),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, workflow_id, idempotency_key),
  FOREIGN KEY (workspace_id, workflow_id)
    REFERENCES deviludo.workflow_instances(workspace_id, id)
);

CREATE TABLE deviludo.job_progress_events (
  workspace_id uuid NOT NULL,
  sequence bigint GENERATED ALWAYS AS IDENTITY,
  project_id uuid NOT NULL,
  workflow_id uuid NOT NULL,
  job_id uuid NOT NULL,
  event_kind text NOT NULL CHECK (event_kind IN ('PHASE', 'AGENT_OUTPUT', 'SUPERSEDED', 'COMPLETED', 'FAILED')),
  content text NOT NULL CHECK (length(content) BETWEEN 1 AND 4000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, sequence),
  FOREIGN KEY (workspace_id, project_id) REFERENCES deviludo.projects(workspace_id, id),
  FOREIGN KEY (workspace_id, workflow_id) REFERENCES deviludo.workflow_instances(workspace_id, id),
  FOREIGN KEY (workspace_id, job_id) REFERENCES deviludo.jobs(workspace_id, id)
);
CREATE INDEX job_progress_events_project_sequence
  ON deviludo.job_progress_events(workspace_id, project_id, sequence);

CREATE TABLE deviludo.operation_receipts (
  workspace_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  workflow_id uuid NOT NULL,
  job_id uuid NOT NULL,
  operation_kind text NOT NULL CHECK (length(operation_kind) BETWEEN 1 AND 120),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 300),
  state deviludo.operation_state NOT NULL,
  request jsonb NOT NULL CHECK (jsonb_typeof(request) = 'object'),
  receipt jsonb CHECK (receipt IS NULL OR jsonb_typeof(receipt) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, idempotency_key),
  FOREIGN KEY (workspace_id) REFERENCES deviludo.workspaces(id),
  FOREIGN KEY (workspace_id, project_id) REFERENCES deviludo.projects(workspace_id, id),
  FOREIGN KEY (workspace_id, workflow_id) REFERENCES deviludo.workflow_instances(workspace_id, id),
  FOREIGN KEY (workspace_id, job_id) REFERENCES deviludo.jobs(workspace_id, id)
);

CREATE TABLE deviludo.artifacts (
  workspace_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  workflow_id uuid NOT NULL,
  producing_job_id uuid,
  kind deviludo.artifact_kind NOT NULL,
  target_platform deviludo.server_os,
  bucket text NOT NULL CHECK (length(bucket) BETWEEN 3 AND 255),
  object_key text NOT NULL,
  sha256 text NOT NULL CHECK (sha256 ~ '^sha256:[0-9a-f]{64}$'),
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  state text NOT NULL DEFAULT 'AVAILABLE' CHECK (state IN ('AVAILABLE', 'DELETING', 'DELETED')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, workflow_id, object_key, sha256),
  FOREIGN KEY (workspace_id) REFERENCES deviludo.workspaces(id),
  FOREIGN KEY (workspace_id, project_id) REFERENCES deviludo.projects(workspace_id, id),
  FOREIGN KEY (workspace_id, workflow_id) REFERENCES deviludo.workflow_instances(workspace_id, id),
  FOREIGN KEY (workspace_id, producing_job_id) REFERENCES deviludo.jobs(workspace_id, id),
  CHECK (object_key LIKE 'workspaces/' || workspace_id::text || '/projects/' || project_id::text || '/%')
);

CREATE TABLE deviludo.pending_object_uploads (
  workspace_id uuid NOT NULL,
  job_id uuid NOT NULL,
  bucket text NOT NULL CHECK (length(bucket) BETWEEN 3 AND 255),
  object_key text NOT NULL CHECK (object_key LIKE 'workspaces/' || workspace_id::text || '/%'),
  kind deviludo.artifact_kind NOT NULL,
  target_platform deviludo.server_os,
  sha256 text NOT NULL CHECK (sha256 ~ '^sha256:[0-9a-f]{64}$'),
  size_bytes bigint NOT NULL CHECK (size_bytes > 0),
  cleanup_after timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, bucket, object_key),
  FOREIGN KEY (workspace_id, job_id) REFERENCES deviludo.jobs(workspace_id, id) ON DELETE CASCADE
);

CREATE OR REPLACE FUNCTION deviludo.clear_pending_upload_on_artifact()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, deviludo AS $$
BEGIN
  DELETE FROM deviludo.pending_object_uploads
   WHERE workspace_id = NEW.workspace_id AND bucket = NEW.bucket AND object_key = NEW.object_key;
  RETURN NEW;
END
$$;
CREATE TRIGGER artifacts_clear_pending_upload
AFTER INSERT ON deviludo.artifacts
FOR EACH ROW EXECUTE FUNCTION deviludo.clear_pending_upload_on_artifact();
REVOKE ALL ON FUNCTION deviludo.clear_pending_upload_on_artifact() FROM PUBLIC;

CREATE TABLE deviludo.object_cleanup_queue (
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

CREATE TABLE deviludo.project_cleanup_requests (
  workspace_id uuid NOT NULL REFERENCES deviludo.workspaces(id) ON DELETE CASCADE,
  project_id uuid NOT NULL,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 10),
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  lease_token uuid,
  lease_expires_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, project_id),
  CHECK ((lease_token IS NULL) = (lease_expires_at IS NULL))
);

-- Managed hosts reserve quota before an executor starts. The reservation is
-- attached to the leased job and its terminal state is converted into this
-- durable outbox, so a scheduler restart cannot lose settlement or cancel it
-- twice. Self-hosted mode never attaches a reservation and creates no events.
CREATE TABLE deviludo.host_admission_events (
  workspace_id uuid NOT NULL REFERENCES deviludo.workspaces(id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL,
  reservation_id text NOT NULL CHECK (length(reservation_id) BETWEEN 1 AND 2000),
  action text NOT NULL CHECK (action IN ('SETTLE', 'CANCEL')),
  actual_units integer CHECK (
    (action = 'SETTLE' AND actual_units > 0)
    OR (action = 'CANCEL' AND actual_units IS NULL)
  ),
  state text NOT NULL DEFAULT 'PENDING' CHECK (state IN ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 20),
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  lease_token uuid,
  lease_expires_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, reservation_id),
  FOREIGN KEY (workspace_id, job_id) REFERENCES deviludo.jobs(workspace_id, id) ON DELETE CASCADE,
  CHECK ((lease_token IS NULL) = (lease_expires_at IS NULL))
);

CREATE TABLE deviludo.artifact_inputs (
  workspace_id uuid NOT NULL,
  job_id uuid NOT NULL,
  artifact_id uuid NOT NULL,
  expected_sha256 text NOT NULL CHECK (expected_sha256 ~ '^sha256:[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, job_id, artifact_id),
  FOREIGN KEY (workspace_id, job_id) REFERENCES deviludo.jobs(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, artifact_id) REFERENCES deviludo.artifacts(workspace_id, id)
);

-- Evidence screenshots, videos, logs, and traces live together in the
-- E2E_REPORT ZIP. A rerun replaces that ZIP for the same iteration/platform;
-- retaining older copies only consumes object storage and the product never
-- presents them. Queue the superseded object before removing its database row
-- so object deletion remains durable across scheduler restarts.
CREATE OR REPLACE FUNCTION deviludo.retain_latest_e2e_report()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, deviludo
SET row_security = off
AS $$
BEGIN
  INSERT INTO deviludo.object_cleanup_queue(workspace_id, bucket, object_key, reason)
  SELECT artifact.workspace_id, artifact.bucket, artifact.object_key,
         'superseded E2E report'
    FROM deviludo.artifacts artifact
   WHERE artifact.workspace_id = NEW.workspace_id
     AND artifact.workflow_id = NEW.workflow_id
     AND artifact.kind = 'E2E_REPORT'
     AND artifact.target_platform IS NOT DISTINCT FROM NEW.target_platform
     AND artifact.id <> NEW.id
     -- Output keys normally contain the producing job id. If imported data ever
     -- reused a key, that key now names the current object and must not be deleted.
     AND (artifact.bucket, artifact.object_key) IS DISTINCT FROM (NEW.bucket, NEW.object_key)
  ON CONFLICT (workspace_id, bucket, object_key) DO NOTHING;

  DELETE FROM deviludo.artifact_inputs input
   USING deviludo.artifacts artifact
   WHERE artifact.workspace_id = NEW.workspace_id
     AND artifact.workflow_id = NEW.workflow_id
     AND artifact.kind = 'E2E_REPORT'
     AND artifact.target_platform IS NOT DISTINCT FROM NEW.target_platform
     AND artifact.id <> NEW.id
     AND input.workspace_id = artifact.workspace_id
     AND input.artifact_id = artifact.id;
  DELETE FROM deviludo.artifacts artifact
   WHERE artifact.workspace_id = NEW.workspace_id
     AND artifact.workflow_id = NEW.workflow_id
     AND artifact.kind = 'E2E_REPORT'
     AND artifact.target_platform IS NOT DISTINCT FROM NEW.target_platform
     AND artifact.id <> NEW.id;
  RETURN NEW;
END
$$;
CREATE TRIGGER artifacts_retain_latest_e2e_report
BEFORE INSERT ON deviludo.artifacts
FOR EACH ROW WHEN (NEW.kind = 'E2E_REPORT')
EXECUTE FUNCTION deviludo.retain_latest_e2e_report();

CREATE TABLE deviludo.e2e_policy_locks (
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

CREATE TABLE deviludo.e2e_policy_decisions (
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

CREATE TABLE deviludo.e2e_regression_traces (
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

-- v2 project Runtime state. The compressed context is stored on the project
-- volume; PostgreSQL records only its immutable revision and digest.
CREATE TABLE deviludo.project_contexts (
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  revision bigint NOT NULL CHECK (revision > 0),
  relative_path text NOT NULL CHECK (
    relative_path = 'workspaces/' || workspace_id::text || '/projects/' || project_id::text
      || '/context/project-context.json.zst'
  ),
  sha256 text NOT NULL CHECK (sha256 ~ '^sha256:[0-9a-f]{64}$'),
  size_bytes bigint NOT NULL CHECK (size_bytes BETWEEN 1 AND 67108864),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, project_id),
  UNIQUE (workspace_id, project_id, revision),
  FOREIGN KEY (workspace_id, project_id)
    REFERENCES deviludo.projects(workspace_id, id) ON DELETE CASCADE
);

CREATE TABLE deviludo.agent_containers (
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  runtime deviludo.agent_runtime NOT NULL,
  generation bigint NOT NULL DEFAULT 1 CHECK (generation > 0),
  fencing_token bigint NOT NULL DEFAULT 1 CHECK (fencing_token > 0),
  state deviludo.agent_container_state NOT NULL DEFAULT 'CREATING',
  executor_id text,
  container_id text CHECK (container_id IS NULL OR container_id ~ '^[a-f0-9]{12,64}$'),
  last_activity_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  paused_at timestamptz,
  destroyed_at timestamptz,
  lease_token uuid,
  lease_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, project_id),
  FOREIGN KEY (workspace_id, project_id)
    REFERENCES deviludo.projects(workspace_id, id) ON DELETE CASCADE,
  CHECK ((state = 'PAUSED') = (paused_at IS NOT NULL)),
  CHECK ((state = 'DESTROYED') = (destroyed_at IS NOT NULL)),
  CHECK ((lease_token IS NULL) = (lease_expires_at IS NULL))
);
CREATE INDEX agent_containers_lifecycle
  ON deviludo.agent_containers(state, last_activity_at, paused_at);

CREATE TABLE deviludo.agent_sessions (
  workspace_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  role deviludo.agent_role NOT NULL,
  runtime deviludo.agent_runtime NOT NULL,
  container_generation bigint NOT NULL CHECK (container_generation > 0),
  native_session_id text CHECK (native_session_id IS NULL OR length(native_session_id) BETWEEN 1 AND 500),
  active_turn_id uuid,
  summary text NOT NULL DEFAULT '' CHECK (length(summary) <= 64000),
  context_revision bigint NOT NULL CHECK (context_revision > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, project_id, role, container_generation),
  FOREIGN KEY (workspace_id, project_id)
    REFERENCES deviludo.projects(workspace_id, id) ON DELETE CASCADE
);

CREATE TABLE deviludo.agent_turns (
  workspace_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  session_id uuid NOT NULL,
  branch_id uuid,
  role deviludo.agent_role NOT NULL,
  mode deviludo.agent_turn_mode NOT NULL,
  state deviludo.agent_turn_state NOT NULL DEFAULT 'QUEUED',
  context_revision bigint NOT NULL CHECK (context_revision > 0),
  source_revision bigint,
  response_language text NOT NULL CHECK (response_language IN ('en', 'zh')),
  output_summary text CHECK (output_summary IS NULL OR length(output_summary) <= 64000),
  structured_output jsonb CHECK (structured_output IS NULL OR jsonb_typeof(structured_output) = 'object'),
  tool_summary jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(tool_summary) = 'array'),
  lease_token uuid,
  mcp_token_hash text CHECK (mcp_token_hash IS NULL OR mcp_token_hash ~ '^sha256:[0-9a-f]{64}$'),
  mcp_token_expires_at timestamptz,
  fencing_token bigint NOT NULL CHECK (fencing_token > 0),
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, session_id)
    REFERENCES deviludo.agent_sessions(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, project_id)
    REFERENCES deviludo.projects(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, project_id, source_revision)
    REFERENCES deviludo.project_source_revisions(workspace_id, project_id, revision),
  CHECK ((state = 'RUNNING') = (lease_token IS NOT NULL)),
  CHECK ((state = 'RUNNING') = (mcp_token_hash IS NOT NULL AND mcp_token_expires_at IS NOT NULL)),
  CHECK ((state IN ('SUCCEEDED', 'FAILED', 'CANCELLED')) = (completed_at IS NOT NULL))
);
CREATE INDEX agent_turns_project_created
  ON deviludo.agent_turns(workspace_id, project_id, created_at);

CREATE OR REPLACE FUNCTION deviludo.claim_agent_container_lifecycle(
  p_idle_seconds integer DEFAULT 300,
  p_paused_seconds integer DEFAULT 1800,
  p_lease_seconds integer DEFAULT 180
)
RETURNS TABLE(
  workspace_id uuid,
  project_id uuid,
  runtime deviludo.agent_runtime,
  generation bigint,
  fencing_token bigint,
  container_id text,
  action deviludo.agent_lifecycle_action,
  lease_token uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, deviludo
SET row_security = off
AS $$
DECLARE
  candidate record;
  claimed_token uuid := gen_random_uuid();
BEGIN
  IF p_idle_seconds NOT BETWEEN 60 AND 3600
    OR p_paused_seconds NOT BETWEEN 60 AND 86400
    OR p_lease_seconds NOT BETWEEN 30 AND 900 THEN
    RAISE EXCEPTION 'invalid Agent Runtime lifecycle interval';
  END IF;
  SELECT container.*,
         CASE
           WHEN container.state = 'PAUSED'
             OR container.state = 'FAILED'
             OR (container.state = 'CREATING' AND container.container_id IS NULL)
             THEN 'DESTROY'::deviludo.agent_lifecycle_action
           ELSE 'PAUSE'::deviludo.agent_lifecycle_action
         END AS lifecycle_action
    INTO candidate
    FROM deviludo.agent_containers container
   WHERE NOT EXISTS (
     SELECT 1 FROM deviludo.agent_turns running_turn
      WHERE running_turn.workspace_id = container.workspace_id
        AND running_turn.project_id = container.project_id
        AND running_turn.state = 'RUNNING'
   )
     AND NOT EXISTS (
       SELECT 1 FROM deviludo.jobs running_test
        WHERE running_test.workspace_id = container.workspace_id
          AND running_test.project_id = container.project_id
          AND running_test.kind = 'E2E_PLATFORM_RUN'
          AND running_test.state = 'RUNNING'
     )
     AND (container.lease_expires_at IS NULL OR container.lease_expires_at < clock_timestamp())
     AND (
       (container.state = 'RUNNING'
         AND container.last_activity_at <= clock_timestamp() - make_interval(secs => p_idle_seconds))
       OR (container.state = 'PAUSED'
         AND container.paused_at <= clock_timestamp() - make_interval(secs => p_paused_seconds))
       OR container.state = 'FAILED'
       OR (container.state = 'CREATING' AND container.container_id IS NULL
         AND container.last_activity_at <= clock_timestamp() - make_interval(secs => p_idle_seconds))
     )
   ORDER BY
     CASE WHEN container.state IN ('PAUSED', 'FAILED') THEN 0 ELSE 1 END,
     coalesce(container.paused_at, container.last_activity_at),
     container.project_id
   FOR UPDATE SKIP LOCKED
   LIMIT 1;
  IF candidate.project_id IS NULL THEN RETURN; END IF;
  UPDATE deviludo.agent_containers container
     SET lease_token = claimed_token,
         lease_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds),
         state = CASE WHEN candidate.lifecycle_action = 'PAUSE'
           THEN 'COMPACTING'::deviludo.agent_container_state ELSE container.state END,
         updated_at = clock_timestamp()
   WHERE container.workspace_id = candidate.workspace_id
     AND container.project_id = candidate.project_id;
  RETURN QUERY SELECT candidate.workspace_id, candidate.project_id, candidate.runtime,
    candidate.generation, candidate.fencing_token, candidate.container_id,
    candidate.lifecycle_action, claimed_token;
END
$$;

CREATE OR REPLACE FUNCTION deviludo.complete_agent_container_lifecycle(
  p_workspace_id uuid,
  p_project_id uuid,
  p_lease_token uuid,
  p_action deviludo.agent_lifecycle_action
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, deviludo
SET row_security = off
AS $$
BEGIN
  IF p_action = 'PAUSE' THEN
    UPDATE deviludo.agent_containers container
       SET state = 'PAUSED', paused_at = clock_timestamp(), destroyed_at = NULL,
           lease_token = NULL, lease_expires_at = NULL, updated_at = clock_timestamp()
     WHERE container.workspace_id = p_workspace_id AND container.project_id = p_project_id
       AND container.lease_token = p_lease_token
       AND NOT EXISTS (
         SELECT 1 FROM deviludo.agent_turns running_turn
          WHERE running_turn.workspace_id = container.workspace_id
            AND running_turn.project_id = container.project_id
            AND running_turn.state = 'RUNNING'
       );
  ELSE
    UPDATE deviludo.agent_containers container
       SET state = 'DESTROYED', container_id = NULL,
           generation = generation + 1, fencing_token = fencing_token + 1,
           paused_at = NULL, destroyed_at = clock_timestamp(), lease_token = NULL,
           lease_expires_at = NULL, updated_at = clock_timestamp()
     WHERE container.workspace_id = p_workspace_id AND container.project_id = p_project_id
       AND container.lease_token = p_lease_token
       AND NOT EXISTS (
         SELECT 1 FROM deviludo.agent_turns running_turn
          WHERE running_turn.workspace_id = container.workspace_id
            AND running_turn.project_id = container.project_id
            AND running_turn.state = 'RUNNING'
       );
  END IF;
  RETURN FOUND;
END
$$;

CREATE OR REPLACE FUNCTION deviludo.claim_paused_agent_container_for_pressure(
  p_lease_seconds integer DEFAULT 180
)
RETURNS TABLE(
  workspace_id uuid,
  project_id uuid,
  runtime deviludo.agent_runtime,
  generation bigint,
  fencing_token bigint,
  container_id text,
  action deviludo.agent_lifecycle_action,
  lease_token uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, deviludo
SET row_security = off
AS $$
DECLARE
  candidate record;
  claimed_token uuid := gen_random_uuid();
BEGIN
  IF p_lease_seconds NOT BETWEEN 30 AND 900 THEN
    RAISE EXCEPTION 'invalid Agent Runtime pressure-reclaim lease';
  END IF;
  SELECT container.* INTO candidate
    FROM deviludo.agent_containers container
   WHERE container.state = 'PAUSED'
     AND container.container_id IS NOT NULL
     AND (container.lease_expires_at IS NULL OR container.lease_expires_at < clock_timestamp())
     AND NOT EXISTS (
       SELECT 1 FROM deviludo.agent_turns running_turn
        WHERE running_turn.workspace_id = container.workspace_id
          AND running_turn.project_id = container.project_id
          AND running_turn.state = 'RUNNING'
     )
   ORDER BY container.last_activity_at, container.paused_at, container.project_id
   FOR UPDATE SKIP LOCKED
   LIMIT 1;
  IF candidate.project_id IS NULL THEN RETURN; END IF;
  UPDATE deviludo.agent_containers container
     SET lease_token = claimed_token,
         lease_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds),
         updated_at = clock_timestamp()
   WHERE container.workspace_id = candidate.workspace_id
     AND container.project_id = candidate.project_id;
  RETURN QUERY SELECT candidate.workspace_id, candidate.project_id, candidate.runtime,
    candidate.generation, candidate.fencing_token, candidate.container_id,
    'DESTROY'::deviludo.agent_lifecycle_action, claimed_token;
END
$$;

CREATE OR REPLACE FUNCTION deviludo.fail_agent_container_lifecycle(
  p_workspace_id uuid,
  p_project_id uuid,
  p_lease_token uuid
)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, deviludo
SET row_security = off
AS $$
  UPDATE deviludo.agent_containers container
     SET state = CASE WHEN container.state = 'COMPACTING' THEN 'RUNNING' ELSE container.state END,
         lease_token = NULL, lease_expires_at = NULL, updated_at = clock_timestamp()
   WHERE container.workspace_id = p_workspace_id AND container.project_id = p_project_id
     AND container.lease_token = p_lease_token
  RETURNING true
$$;
ALTER FUNCTION deviludo.claim_agent_container_lifecycle(integer, integer, integer)
  OWNER TO deviludo_claim_executor;
ALTER FUNCTION deviludo.claim_paused_agent_container_for_pressure(integer)
  OWNER TO deviludo_claim_executor;
ALTER FUNCTION deviludo.complete_agent_container_lifecycle(uuid, uuid, uuid, deviludo.agent_lifecycle_action)
  OWNER TO deviludo_claim_executor;
ALTER FUNCTION deviludo.fail_agent_container_lifecycle(uuid, uuid, uuid)
  OWNER TO deviludo_claim_executor;
REVOKE ALL ON FUNCTION deviludo.claim_agent_container_lifecycle(integer, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION deviludo.claim_paused_agent_container_for_pressure(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION deviludo.complete_agent_container_lifecycle(uuid, uuid, uuid, deviludo.agent_lifecycle_action) FROM PUBLIC;
REVOKE ALL ON FUNCTION deviludo.fail_agent_container_lifecycle(uuid, uuid, uuid) FROM PUBLIC;

CREATE TABLE deviludo.agent_tool_calls (
  workspace_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  session_id uuid NOT NULL,
  turn_id uuid NOT NULL,
  role deviludo.agent_role NOT NULL,
  tool_name text NOT NULL CHECK (tool_name ~ '^[a-z][a-z0-9_.]{2,100}$'),
  argument_summary jsonb NOT NULL CHECK (jsonb_typeof(argument_summary) = 'object'),
  result_summary jsonb CHECK (result_summary IS NULL OR jsonb_typeof(result_summary) = 'object'),
  state text NOT NULL CHECK (state IN ('RUNNING', 'SUCCEEDED', 'FAILED')),
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, project_id)
    REFERENCES deviludo.projects(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, session_id)
    REFERENCES deviludo.agent_sessions(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, turn_id)
    REFERENCES deviludo.agent_turns(workspace_id, id) ON DELETE CASCADE,
  CHECK ((state = 'RUNNING') = (completed_at IS NULL))
);

CREATE TABLE deviludo.role_handoffs (
  workspace_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  source_turn_id uuid NOT NULL,
  from_role deviludo.agent_role NOT NULL,
  to_role deviludo.agent_role NOT NULL,
  handoff_kind text NOT NULL CHECK (handoff_kind IN ('WORKFLOW', 'PRODUCT_FAILURE', 'QUESTION_SUMMARY')),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  consumed_by_turn_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, project_id)
    REFERENCES deviludo.projects(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, source_turn_id)
    REFERENCES deviludo.agent_turns(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, consumed_by_turn_id)
    REFERENCES deviludo.agent_turns(workspace_id, id),
  CHECK (from_role <> to_role)
);

CREATE TABLE deviludo.test_plans_v2 (
  workspace_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  requirement_revision bigint NOT NULL CHECK (requirement_revision > 0),
  source_revision bigint NOT NULL CHECK (source_revision > 0),
  plan_revision bigint NOT NULL CHECK (plan_revision > 0),
  plan_sha256 text NOT NULL CHECK (plan_sha256 ~ '^sha256:[0-9a-f]{64}$'),
  plan jsonb NOT NULL CHECK (jsonb_typeof(plan) = 'object'),
  created_by_turn_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, project_id, source_revision, plan_revision),
  FOREIGN KEY (workspace_id, project_id)
    REFERENCES deviludo.projects(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, project_id, source_revision)
    REFERENCES deviludo.project_source_revisions(workspace_id, project_id, revision),
  FOREIGN KEY (workspace_id, created_by_turn_id)
    REFERENCES deviludo.agent_turns(workspace_id, id)
);

CREATE TABLE deviludo.platform_test_runs (
  workspace_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  plan_id uuid NOT NULL,
  source_revision bigint NOT NULL CHECK (source_revision > 0),
  target_platform deviludo.server_os NOT NULL,
  node_id uuid,
  state deviludo.agent_turn_state NOT NULL DEFAULT 'QUEUED',
  failure_class text CHECK (failure_class IS NULL OR failure_class IN ('PRODUCT', 'INFRASTRUCTURE', 'CONFIGURATION')),
  deterministic_result jsonb CHECK (deterministic_result IS NULL OR jsonb_typeof(deterministic_result) = 'object'),
  evidence_summary jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(evidence_summary) = 'object'),
  verdict text CHECK (verdict IS NULL OR verdict IN ('PASS', 'FAIL', 'BLOCKED')),
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, plan_id, target_platform),
  FOREIGN KEY (workspace_id, plan_id) REFERENCES deviludo.test_plans_v2(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, project_id)
    REFERENCES deviludo.projects(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (node_id) REFERENCES deviludo.server_nodes(id)
);

CREATE TABLE deviludo.test_evidence (
  workspace_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  platform_run_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('PROBE', 'ASSET_BINDING', 'SCREENSHOT', 'VIDEO', 'CRASH', 'PERFORMANCE', 'INPUT_RESPONSE')),
  bucket text NOT NULL CHECK (length(bucket) BETWEEN 3 AND 255),
  object_key text NOT NULL,
  sha256 text NOT NULL CHECK (sha256 ~ '^sha256:[0-9a-f]{64}$'),
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
  summary jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(summary) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, platform_run_id)
    REFERENCES deviludo.platform_test_runs(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, project_id)
    REFERENCES deviludo.projects(workspace_id, id) ON DELETE CASCADE
);

CREATE TABLE deviludo.executor_receipts (
  workspace_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  workflow_id uuid NOT NULL,
  job_id uuid NOT NULL,
  executor_id text NOT NULL CHECK (length(executor_id) BETWEEN 3 AND 200),
  isolation_generation bigint NOT NULL CHECK (isolation_generation > 0),
  fencing_token bigint NOT NULL CHECK (fencing_token > 0),
  receipt jsonb NOT NULL CHECK (
    jsonb_typeof(receipt) = 'object'
    AND receipt->>'schemaVersion' = 'deviludo.executor-receipt.v2'
    AND receipt->>'simulated' = 'false'
  ),
  signature text NOT NULL CHECK (length(signature) BETWEEN 32 AND 4096),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, job_id),
  FOREIGN KEY (workspace_id, project_id) REFERENCES deviludo.projects(workspace_id, id),
  FOREIGN KEY (workspace_id, workflow_id) REFERENCES deviludo.workflow_instances(workspace_id, id),
  FOREIGN KEY (workspace_id, job_id) REFERENCES deviludo.jobs(workspace_id, id)
);

CREATE TABLE deviludo.workspace_claim_fairness (
  workspace_id uuid PRIMARY KEY REFERENCES deviludo.workspaces(id),
  last_claimed_at timestamptz NOT NULL
);

-- Cross-workspace creation receipts contain only opaque identities. They make
-- retries safe before a workspace exists and are never exposed as product data.
CREATE TABLE deviludo.project_creation_receipts (
  idempotency_key text PRIMARY KEY CHECK (length(idempotency_key) BETWEEN 8 AND 300),
  operation_kind text NOT NULL CHECK (operation_kind IN ('PROJECT', 'CONVERSATION')),
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  conversation_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (workspace_id, project_id) REFERENCES deviludo.projects(workspace_id, id),
  FOREIGN KEY (workspace_id, conversation_id)
    REFERENCES deviludo.project_conversations(workspace_id, id),
  CHECK (
    (operation_kind = 'PROJECT' AND conversation_id IS NULL)
    OR (operation_kind = 'CONVERSATION' AND conversation_id IS NOT NULL)
  )
);

CREATE TABLE deviludo.asset_manifests (
  workspace_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  workflow_id uuid,
  -- Auto-generation is enabled only when the instance can actually render the
  -- plan. Without a provider the build continues with the Agent's placeholders;
  -- the player can still upload art and explicitly rebuild later.
  auto_generate_enabled boolean NOT NULL DEFAULT true,
  planned_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, project_id),
  FOREIGN KEY (workspace_id) REFERENCES deviludo.workspaces(id),
  FOREIGN KEY (workspace_id, project_id) REFERENCES deviludo.projects(workspace_id, id),
  FOREIGN KEY (workspace_id, workflow_id) REFERENCES deviludo.workflow_instances(workspace_id, id)
);

CREATE TABLE deviludo.asset_items (
  workspace_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  manifest_id uuid NOT NULL,
  asset_key text NOT NULL CHECK (
    length(asset_key) BETWEEN 1 AND 200
    AND asset_key ~ '^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$'
    AND asset_key !~ '(^|/)\.{1,2}(/|$)'
    AND asset_key !~ '//'
    AND asset_key !~ '/$'
  ),
  asset_type text NOT NULL
    CHECK (asset_type IN ('sprite', 'animation', 'background', 'ui', 'icon', 'tileset', 'music')),
  description text NOT NULL CHECK (length(description) BETWEEN 1 AND 2000),
  generation_prompt text CHECK (generation_prompt IS NULL OR length(generation_prompt) BETWEEN 1 AND 4000),
  frame_count integer CHECK (frame_count IS NULL OR frame_count BETWEEN 1 AND 4096),
  dimensions text CHECK (dimensions IS NULL OR dimensions ~ '^[0-9]{1,5}x[0-9]{1,5}$'),
  status text NOT NULL DEFAULT 'planned'
    CHECK (status IN ('planned', 'generating', 'generated', 'uploaded', 'existing', 'failed')),
  source_path text CHECK (
    source_path IS NULL OR (
      length(source_path) BETWEEN 1 AND 500
      AND source_path !~ '(^|/)\.{1,2}(/|$)'
      AND source_path !~ '//'
      AND source_path !~ '^/'
    )
  ),
  bucket text,
  object_key text,
  sha256 text CHECK (sha256 IS NULL OR sha256 ~ '^sha256:[0-9a-f]{64}$'),
  size_bytes bigint CHECK (size_bytes IS NULL OR size_bytes > 0),
  error_message text CHECK (error_message IS NULL OR length(error_message) BETWEEN 1 AND 2000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, manifest_id, asset_key),
  FOREIGN KEY (workspace_id) REFERENCES deviludo.workspaces(id),
  FOREIGN KEY (workspace_id, manifest_id) REFERENCES deviludo.asset_manifests(workspace_id, id)
    ON DELETE CASCADE,
  CHECK (
    (status IN ('generated', 'uploaded'))
      = (object_key IS NOT NULL AND bucket IS NOT NULL AND sha256 IS NOT NULL AND size_bytes IS NOT NULL)
  ),
  CHECK ((status = 'existing') = (source_path IS NOT NULL)),
  CONSTRAINT asset_items_music_upload_only CHECK (
    asset_type <> 'music'
    OR (generation_prompt IS NULL AND frame_count IS NULL AND dimensions IS NULL AND source_path IS NULL)
  )
);

-- Re-planning an existing-source item changes its status before the repository
-- can reconcile the new source tree. Clear the old path in that same statement
-- so the row never crosses the status/source-path invariant in an invalid state.
CREATE OR REPLACE FUNCTION deviludo.normalize_asset_item_existing_source()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, deviludo
AS $$
BEGIN
  IF NEW.status <> 'existing' THEN
    NEW.source_path := NULL;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER asset_items_normalize_existing_source
BEFORE INSERT OR UPDATE OF status, source_path ON deviludo.asset_items
FOR EACH ROW EXECUTE FUNCTION deviludo.normalize_asset_item_existing_source();
REVOKE ALL ON FUNCTION deviludo.normalize_asset_item_existing_source() FROM PUBLIC;

CREATE INDEX asset_items_manifest_status
  ON deviludo.asset_items (workspace_id, manifest_id, status);

-- Generation attempts are bounded per item so a prompt the provider always
-- rejects cannot be retried forever, and the lease columns let one generator
-- claim an item without a second one picking it up.
ALTER TABLE deviludo.asset_items
  ADD COLUMN generation_attempt integer NOT NULL DEFAULT 0
    CHECK (generation_attempt BETWEEN 0 AND 3),
  ADD COLUMN generation_lease_expires_at timestamptz,
  ADD COLUMN generation_lease_token uuid,
  ADD CONSTRAINT asset_items_lease_requires_generating CHECK (
    (generation_lease_expires_at IS NOT NULL) = (status = 'generating')
    AND (status <> 'generating' OR generation_lease_token IS NOT NULL)
  );

-- complete_job historically enabled the image gate only for Claude. Resolve the
-- default at manifest insertion instead: Codex has its built-in ImageGen backend,
-- while Claude requires an explicit image model. User updates are not affected,
-- so the project-level switch can still disable automatic generation later.
CREATE OR REPLACE FUNCTION deviludo.default_asset_auto_generation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, deviludo
AS $$
BEGIN
  NEW.auto_generate_enabled := EXISTS (
    SELECT 1 FROM deviludo.instance_agent_settings
     WHERE singleton = true
       AND (
         agent_runtime = 'CODEX_CLI'
         OR (agent_runtime = 'CLAUDE_CODE' AND image_model IS NOT NULL)
       )
  );
  RETURN NEW;
END
$$;
CREATE TRIGGER asset_manifests_default_auto_generation
BEFORE INSERT ON deviludo.asset_manifests
FOR EACH ROW EXECUTE FUNCTION deviludo.default_asset_auto_generation();

-- Freeze the exact supplied asset objects into every artifact-build job. The builder
-- reads this immutable snapshot rather than whichever upload happens to be the
-- latest when a queued job is eventually claimed.
CREATE OR REPLACE FUNCTION deviludo.snapshot_artifact_build_assets()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, deviludo
AS $$
DECLARE
  inputs jsonb;
  unresolved_assets integer;
BEGIN
  IF NEW.kind <> 'BUILD' THEN RETURN NEW; END IF;
  SELECT count(*)::integer
    INTO unresolved_assets
    FROM deviludo.asset_manifests manifest
    JOIN deviludo.asset_items item
      ON item.workspace_id = manifest.workspace_id AND item.manifest_id = manifest.id
   WHERE manifest.workspace_id = NEW.workspace_id
     AND manifest.project_id = NEW.project_id
     AND manifest.workflow_id = NEW.workflow_id
     AND item.asset_type <> 'music'
     AND item.status NOT IN ('generated', 'uploaded', 'existing');
  IF unresolved_assets > 0 THEN
    RAISE EXCEPTION 'BUILD requires every planned visual asset to be supplied';
  END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'assetKey', item.asset_key,
    'bucket', item.bucket,
    'objectKey', item.object_key,
    'sha256', item.sha256,
    'sizeBytes', item.size_bytes
  ) ORDER BY item.asset_key), '[]'::jsonb)
    INTO inputs
    FROM deviludo.asset_manifests manifest
    JOIN deviludo.asset_items item
      ON item.workspace_id = manifest.workspace_id AND item.manifest_id = manifest.id
   WHERE manifest.workspace_id = NEW.workspace_id
     AND manifest.project_id = NEW.project_id
     AND manifest.workflow_id = NEW.workflow_id
     AND item.status IN ('generated', 'uploaded');
  NEW.payload := NEW.payload || jsonb_build_object('assetInputs', inputs);
  RETURN NEW;
END
$$;

CREATE TRIGGER jobs_snapshot_artifact_build_assets
BEFORE INSERT ON deviludo.jobs
FOR EACH ROW EXECUTE FUNCTION deviludo.snapshot_artifact_build_assets();

-- Every existing-project Agent task receives the immutable source from the
-- start of its workflow iteration. The current source remains authoritative;
-- this snapshot exists only so a repair can recover accidentally deleted
-- declarations without guessing or depending on a host-specific Git checkout.
CREATE OR REPLACE FUNCTION deviludo.snapshot_agent_baseline_source()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, deviludo
AS $$
DECLARE
  baseline deviludo.project_source_revisions%ROWTYPE;
BEGIN
  IF NEW.kind <> 'AGENT_TURN' THEN RETURN NEW; END IF;
  SELECT source.* INTO baseline
    FROM deviludo.project_source_revisions source
   WHERE source.workspace_id = NEW.workspace_id
     AND source.project_id = NEW.project_id
     AND source.revision = coalesce(
       (SELECT nullif(workflow.state_data #>> '{iteration,baseSourceRevision}', '')::bigint
          FROM deviludo.workflow_instances workflow
         WHERE workflow.workspace_id = NEW.workspace_id AND workflow.id = NEW.workflow_id),
       (SELECT min(initial.revision)
          FROM deviludo.project_source_revisions initial
         WHERE initial.workspace_id = NEW.workspace_id AND initial.project_id = NEW.project_id)
     )
   LIMIT 1;
  IF baseline.revision IS NOT NULL THEN
    NEW.payload := NEW.payload || jsonb_build_object(
      'baselineSourceRevision', baseline.revision,
      'baselineSourceRelativePath', baseline.relative_path,
      'baselineSourceDigest', baseline.content_digest
    );
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION deviludo.snapshot_agent_baseline_source() FROM PUBLIC;

CREATE TRIGGER jobs_snapshot_agent_baseline_source
BEFORE INSERT ON deviludo.jobs
FOR EACH ROW EXECUTE FUNCTION deviludo.snapshot_agent_baseline_source();

CREATE OR REPLACE FUNCTION deviludo.current_workspace_id()
RETURNS uuid
LANGUAGE sql
STABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $$
  SELECT nullif(current_setting('app.workspace_id', true), '')::uuid
$$;

ALTER TABLE deviludo.workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE deviludo.workspaces FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON deviludo.workspaces
  USING (id = deviludo.current_workspace_id())
  WITH CHECK (id = deviludo.current_workspace_id());

DO $rls$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'workspace_steam_settings', 'projects', 'project_steam_settings',
    'project_source_revisions', 'host_source_events',
    'project_documents', 'project_document_revisions',
    'project_conversations', 'conversation_messages',
    'agent_installations', 'workflow_instances', 'implementation_change_requests',
    'workflow_e2e_goal_revisions', 'steam_releases', 'workflow_events',
    'jobs', 'external_signals', 'job_progress_events',
    'operation_receipts', 'workspace_claim_fairness',
    'artifacts', 'artifact_inputs', 'pending_object_uploads', 'object_cleanup_queue',
    'project_cleanup_requests', 'host_admission_events', 'e2e_policy_locks', 'e2e_policy_decisions',
    'e2e_regression_traces', 'executor_receipts', 'project_creation_receipts',
    'asset_manifests', 'asset_items',
    'project_contexts', 'agent_containers', 'agent_sessions', 'agent_turns', 'agent_tool_calls',
    'role_handoffs', 'test_plans_v2', 'platform_test_runs', 'test_evidence'
  ]
  LOOP
    EXECUTE format('ALTER TABLE deviludo.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE deviludo.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY workspace_isolation ON deviludo.%I USING (workspace_id = deviludo.current_workspace_id()) WITH CHECK (workspace_id = deviludo.current_workspace_id())',
      table_name
    );
  END LOOP;
END
$rls$;

-- Ordered delivery stages. Steam remains the separately approved final stage.
CREATE OR REPLACE FUNCTION deviludo.delivery_stages(p_profile deviludo.workflow_profile)
RETURNS deviludo.job_kind[]
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $$
  SELECT ARRAY[
    'AGENT_TURN', 'BUILD', 'E2E_PLATFORM_RUN', 'STEAM_PUBLISH'
  ]::deviludo.job_kind[]
$$;

CREATE OR REPLACE FUNCTION deviludo.complete_agent_turn_job(
  p_workspace_id uuid,
  p_job_id uuid,
  p_lease_token uuid,
  p_fencing_token bigint,
  p_output jsonb
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, deviludo
AS $$
DECLARE
  job deviludo.jobs%ROWTYPE;
  workflow deviludo.workflow_instances%ROWTYPE;
  role text;
  purpose text;
  platform deviludo.server_os;
  verdict text;
  verdict_plan_id uuid;
  configuration_failed boolean;
  assets_ready boolean;
  current_test_plan_available boolean;
BEGIN
  SELECT * INTO job FROM deviludo.jobs
   WHERE workspace_id = p_workspace_id AND id = p_job_id FOR UPDATE;
  IF job.id IS NULL OR job.kind <> 'AGENT_TURN' OR job.state <> 'RUNNING'
    OR job.lease_token <> p_lease_token OR job.fencing_token <> p_fencing_token THEN
    RETURN false;
  END IF;
  role := coalesce(job.payload->>'role', 'DEVELOPMENT');
  purpose := coalesce(job.payload->>'purpose', CASE role
    WHEN 'DESIGN' THEN 'DESIGN' WHEN 'UI_DESIGN' THEN 'UI_DESIGN'
    WHEN 'TEST' THEN 'TEST_PLAN' ELSE 'DEVELOPMENT' END);
  IF role NOT IN ('DESIGN', 'UI_DESIGN', 'DEVELOPMENT', 'TEST')
    OR purpose NOT IN ('DESIGN', 'UI_DESIGN', 'DEVELOPMENT', 'TEST_PLAN', 'TEST_VERDICT')
    OR jsonb_typeof(p_output) <> 'object' THEN
    RAISE EXCEPTION 'invalid persistent Agent turn completion';
  END IF;
  SELECT * INTO workflow FROM deviludo.workflow_instances
   WHERE workspace_id = job.workspace_id AND id = job.workflow_id FOR UPDATE;
  IF role = 'DESIGN' AND (
    jsonb_typeof(p_output->'handoff') IS DISTINCT FROM 'object'
    OR p_output #>> '{handoff,toRole}' IS DISTINCT FROM 'UI_DESIGN'
    OR length(btrim(coalesce(p_output #>> '{handoff,summary}', ''))) = 0
  ) THEN
    RAISE EXCEPTION 'Design Agent did not create a complete UI_DESIGN handoff';
  END IF;
  IF role = 'UI_DESIGN' AND (
    jsonb_typeof(p_output->'handoff') IS DISTINCT FROM 'object'
    OR p_output #>> '{handoff,toRole}' IS DISTINCT FROM 'DEVELOPMENT'
    OR length(btrim(coalesce(p_output #>> '{handoff,summary}', ''))) = 0
  ) THEN
    RAISE EXCEPTION 'UI Design Agent did not create a complete DEVELOPMENT handoff';
  END IF;
  UPDATE deviludo.jobs SET state = 'SUCCEEDED', receipt = jsonb_build_object('agentTurn', p_output),
      lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL, heartbeat_at = NULL,
      updated_at = clock_timestamp()
   WHERE workspace_id = job.workspace_id AND id = job.id;
  INSERT INTO deviludo.workflow_events(workspace_id, workflow_id, event_kind, event_data, idempotency_key)
  VALUES (job.workspace_id, job.workflow_id, 'AGENT_TURN_SUCCEEDED',
    jsonb_build_object('jobId', job.id, 'role', role, 'purpose', purpose,
      'turnId', p_output->>'turnId', 'contextRevision', p_output->'contextRevision'),
    'agent-turn-succeeded:' || job.id::text)
  ON CONFLICT (workspace_id, workflow_id, idempotency_key) DO NOTHING;

  IF role = 'DESIGN' THEN
    UPDATE deviludo.workflow_instances SET state = 'UI_DESIGNING', version = version + 1,
      updated_at = clock_timestamp() WHERE workspace_id = job.workspace_id AND id = job.workflow_id;
    PERFORM deviludo.enqueue_job(job.workspace_id, job.workflow_id, job.project_id, 'AGENT_TURN', NULL,
      job.workflow_id::text || ':ui-design:after:' || job.id::text,
      jsonb_build_object('role', 'UI_DESIGN', 'purpose', 'UI_DESIGN',
        'designHandoff', p_output->'handoff'));
  ELSIF role = 'UI_DESIGN' THEN
    UPDATE deviludo.workflow_instances SET state = 'DEVELOPING', version = version + 1,
      updated_at = clock_timestamp() WHERE workspace_id = job.workspace_id AND id = job.workflow_id;
    PERFORM deviludo.enqueue_job(job.workspace_id, job.workflow_id, job.project_id, 'AGENT_TURN', NULL,
      job.workflow_id::text || ':development:after:' || job.id::text,
      jsonb_build_object('role', 'DEVELOPMENT', 'purpose', 'DEVELOPMENT',
        'uiDesignHandoff', p_output->'handoff'));
  ELSIF role = 'DEVELOPMENT' THEN
    SELECT NOT EXISTS (
      SELECT 1
        FROM deviludo.asset_manifests manifest
       WHERE manifest.workspace_id = job.workspace_id
         AND manifest.project_id = job.project_id
         AND manifest.workflow_id = job.workflow_id
         AND EXISTS (
           SELECT 1
             FROM deviludo.asset_items item
            WHERE item.workspace_id = manifest.workspace_id
              AND item.manifest_id = manifest.id
              AND item.asset_type <> 'music'
              AND item.status NOT IN ('generated', 'uploaded', 'existing')
         )
    ) INTO assets_ready;
    IF assets_ready THEN
      UPDATE deviludo.workflow_instances SET state = 'BUILDING', version = version + 1,
        updated_at = clock_timestamp()
       WHERE workspace_id = job.workspace_id AND id = job.workflow_id
         AND state = 'DEVELOPING';
      IF FOUND THEN
        PERFORM deviludo.enqueue_job(job.workspace_id, job.workflow_id, job.project_id, 'BUILD', NULL,
          job.workflow_id::text || ':build:after:' || job.id::text,
          jsonb_build_object('targetPlatforms', workflow.target_platforms));
      END IF;
    END IF;
  ELSIF purpose = 'TEST_PLAN' THEN
    SELECT EXISTS (
      SELECT 1 FROM deviludo.test_plans_v2 plan
       WHERE plan.workspace_id = job.workspace_id AND plan.project_id = job.project_id
         AND plan.source_revision = (p_output->>'sourceRevision')::bigint
         AND plan.plan_revision = (p_output->>'planRevision')::bigint
         AND plan.created_by_turn_id = (p_output->>'turnId')::uuid
    ) INTO current_test_plan_available;
    IF current_test_plan_available THEN
      UPDATE deviludo.workflow_instances SET state = 'TESTING', version = version + 1,
        updated_at = clock_timestamp() WHERE workspace_id = job.workspace_id AND id = job.workflow_id;
      FOREACH platform IN ARRAY workflow.target_platforms LOOP
        PERFORM deviludo.enqueue_job(job.workspace_id, job.workflow_id, job.project_id,
          'E2E_PLATFORM_RUN', platform,
          job.workflow_id::text || ':e2e:' || platform::text
            || ':source:' || coalesce(p_output->>'sourceRevision', '0')
            || ':plan:' || coalesce(p_output->>'planRevision', '0'),
          jsonb_build_object('planRevision', coalesce((p_output->>'planRevision')::bigint, 0)));
      END LOOP;
    ELSE
      verdict := upper(coalesce(p_output->>'verdict', p_output #>> '{structured,verdict}', ''));
      IF verdict <> 'FAIL'
        OR p_output #>> '{handoff,toRole}' IS DISTINCT FROM 'DEVELOPMENT'
        OR length(btrim(coalesce(p_output #>> '{handoff,summary}', ''))) = 0 THEN
        RAISE EXCEPTION 'Test Agent did not persist the complete current-source plan or a DEVELOPMENT source-contract handoff';
      END IF;
      UPDATE deviludo.workflow_instances SET state = 'DEVELOPING', version = version + 1,
        updated_at = clock_timestamp() WHERE workspace_id = job.workspace_id AND id = job.workflow_id;
      PERFORM deviludo.enqueue_job(job.workspace_id, job.workflow_id, job.project_id, 'AGENT_TURN', NULL,
        job.workflow_id::text || ':development:test-plan-handoff:' || job.id::text,
        jsonb_build_object('role', 'DEVELOPMENT', 'purpose', 'DEVELOPMENT',
          'testHandoff', p_output->'handoff'));
    END IF;
  ELSE
    verdict := upper(coalesce(p_output->>'verdict', p_output #>> '{structured,verdict}', ''));
    verdict_plan_id := nullif(job.payload->>'testPlanId', '')::uuid;
    IF verdict_plan_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM deviludo.test_plans_v2 plan
       WHERE plan.workspace_id = job.workspace_id AND plan.id = verdict_plan_id
         AND plan.project_id = job.project_id
         AND plan.source_revision = (p_output->>'sourceRevision')::bigint
         AND plan.plan_revision = (p_output->>'planRevision')::bigint
    ) THEN RAISE EXCEPTION 'Test Agent verdict does not match the current frozen plan'; END IF;
    SELECT EXISTS (
      SELECT 1 FROM deviludo.platform_test_runs run
       WHERE run.workspace_id = job.workspace_id AND run.project_id = job.project_id
         AND run.plan_id = verdict_plan_id AND run.failure_class = 'CONFIGURATION'
    ) INTO configuration_failed;
    IF configuration_failed THEN verdict := 'REPLAN'; END IF;
    IF verdict = 'PASS' THEN
      IF EXISTS (
        SELECT 1 FROM deviludo.platform_test_runs run
        WHERE run.workspace_id = job.workspace_id AND run.project_id = job.project_id
          AND run.plan_id = verdict_plan_id
          AND run.verdict <> 'PASS'
      ) OR EXISTS (
        SELECT 1 FROM unnest(workflow.target_platforms) required(target_platform)
         WHERE NOT EXISTS (
           SELECT 1 FROM deviludo.platform_test_runs run
           WHERE run.workspace_id = job.workspace_id AND run.project_id = job.project_id
             AND run.plan_id = verdict_plan_id
             AND run.target_platform = required.target_platform
             AND run.verdict = 'PASS'
         )
      ) THEN RAISE EXCEPTION 'PASS contradicts deterministic platform evidence'; END IF;
      UPDATE deviludo.workflow_instances SET state = 'RELEASE_APPROVAL_PENDING', version = version + 1,
        updated_at = clock_timestamp() WHERE workspace_id = job.workspace_id AND id = job.workflow_id;
    ELSIF verdict = 'BLOCKED' THEN
      UPDATE deviludo.workflow_instances SET state = 'BLOCKED', version = version + 1,
        updated_at = clock_timestamp() WHERE workspace_id = job.workspace_id AND id = job.workflow_id;
    ELSIF verdict = 'REPLAN' THEN
      UPDATE deviludo.workflow_instances SET state = 'TEST_PLANNING', version = version + 1,
        updated_at = clock_timestamp() WHERE workspace_id = job.workspace_id AND id = job.workflow_id;
      PERFORM deviludo.enqueue_job(job.workspace_id, job.workflow_id, job.project_id, 'AGENT_TURN', NULL,
        job.workflow_id::text || ':test-replan:plan:' || verdict_plan_id::text,
        jsonb_build_object('role', 'TEST', 'purpose', 'TEST_PLAN',
          'replacesTestPlanId', verdict_plan_id,
          'replanReason', 'CONFIGURATION'));
    ELSIF verdict = 'FAIL' THEN
      UPDATE deviludo.workflow_instances SET state = 'DEVELOPING', version = version + 1,
        updated_at = clock_timestamp() WHERE workspace_id = job.workspace_id AND id = job.workflow_id;
      PERFORM deviludo.enqueue_job(job.workspace_id, job.workflow_id, job.project_id, 'AGENT_TURN', NULL,
        job.workflow_id::text || ':development:test-handoff:' || job.id::text,
        jsonb_build_object('role', 'DEVELOPMENT', 'purpose', 'DEVELOPMENT',
          'testHandoff', coalesce(p_output->'handoff', p_output)));
    ELSE
      RAISE EXCEPTION 'Test Agent verdict must be PASS, FAIL, BLOCKED, or REPLAN';
    END IF;
  END IF;
  RETURN true;
END
$$;

-- Persistent Development and Test Agents complete under the sandbox role, but
-- that role must not receive general access to player conversations. This narrow
-- definer function validates the completed workflow Agent job and publishes only
-- its player-facing result to the conversation associated with that workflow.
-- The legacy function name is retained so compatible development baselines can
-- refresh it in place without granting the sandbox broader database privileges.
CREATE OR REPLACE FUNCTION deviludo.publish_development_agent_message(
  p_workspace_id uuid,
  p_job_id uuid,
  p_content text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, deviludo
SET row_security = off
AS $$
DECLARE
  job deviludo.jobs%ROWTYPE;
  turn_output jsonb;
  selected_conversation_id uuid;
  response_language text;
  project_name text;
  agent_role text;
BEGIN
  IF nullif(current_setting('app.workspace_id', true), '')::uuid IS DISTINCT FROM p_workspace_id THEN
    RAISE EXCEPTION 'Workflow Agent message workspace mismatch';
  END IF;
  IF length(p_content) NOT BETWEEN 1 AND 4000 THEN
    RAISE EXCEPTION 'Workflow Agent message content is invalid';
  END IF;

  SELECT candidate.* INTO job
    FROM deviludo.jobs candidate
   WHERE candidate.workspace_id = p_workspace_id AND candidate.id = p_job_id
     AND candidate.kind = 'AGENT_TURN' AND candidate.state = 'SUCCEEDED'
     AND coalesce(candidate.payload->>'role', 'DEVELOPMENT') IN ('UI_DESIGN', 'DEVELOPMENT', 'TEST');
  turn_output := job.receipt->'agentTurn';
  agent_role := coalesce(job.payload->>'role', 'DEVELOPMENT');
  IF job.id IS NULL OR jsonb_typeof(turn_output) <> 'object'
    OR turn_output->>'role' IS DISTINCT FROM agent_role THEN
    RAISE EXCEPTION 'Workflow Agent message job is invalid';
  END IF;

  SELECT selected.id INTO selected_conversation_id
    FROM (
      SELECT request.conversation_id AS id, 0 AS priority, request.updated_at
        FROM deviludo.implementation_change_requests request
       WHERE request.workspace_id = p_workspace_id
         AND request.project_id = job.project_id
         AND request.applied_workflow_id = job.workflow_id
      UNION ALL
      SELECT conversation.id, 1 AS priority, conversation.updated_at
        FROM deviludo.project_conversations conversation
       WHERE conversation.workspace_id = p_workspace_id
         AND conversation.project_id = job.project_id
    ) selected
   ORDER BY selected.priority, selected.updated_at DESC
   LIMIT 1;

  response_language := CASE WHEN turn_output->>'responseLanguage' = 'zh' THEN 'zh' ELSE 'en' END;
  IF selected_conversation_id IS NULL THEN
    SELECT project.name INTO project_name
      FROM deviludo.projects project
     WHERE project.workspace_id = p_workspace_id AND project.id = job.project_id;
    IF project_name IS NULL THEN
      RAISE EXCEPTION 'Workflow Agent message project is unavailable';
    END IF;
    selected_conversation_id := gen_random_uuid();
    INSERT INTO deviludo.project_conversations(workspace_id, id, project_id, mode, title)
    VALUES (
      p_workspace_id,
      selected_conversation_id,
      job.project_id,
      'PROJECT_FEEDBACK',
      CASE WHEN response_language = 'zh'
        THEN project_name || CASE agent_role WHEN 'TEST' THEN ' · 测试' WHEN 'UI_DESIGN' THEN ' · UI 设计' ELSE ' · 游戏生成' END
        ELSE project_name || CASE agent_role WHEN 'TEST' THEN ' · Testing' WHEN 'UI_DESIGN' THEN ' · UI design' ELSE ' · Game generation' END
      END
    );
  END IF;

  INSERT INTO deviludo.conversation_messages(
    workspace_id, conversation_id, role, content, metadata
  )
  SELECT p_workspace_id, selected_conversation_id, 'ASSISTANT', p_content,
         jsonb_strip_nulls(jsonb_build_object(
           'source', 'WORKFLOW_AGENT',
           'agentRole', agent_role,
           'agentName', CASE agent_role
             WHEN 'TEST' THEN 'DeviLudo Test Agent'
             WHEN 'UI_DESIGN' THEN 'DeviLudo UI Design Agent'
             ELSE 'DeviLudo Development Agent'
           END,
           'agentRuntime', turn_output->'agentRuntime',
           'model', turn_output->'model',
           'settingsRevision', turn_output->'settingsRevision',
           'runtimeTurnId', turn_output->'turnId',
           'runtimeSessionId', turn_output->'sessionId',
           'workflowJobId', job.id,
           'purpose', turn_output->'purpose',
           'sourceRevision', turn_output->'sourceRevision',
           'planRevision', turn_output->'planRevision',
           'verdict', turn_output->'verdict'
         ))
   WHERE NOT EXISTS (
     SELECT 1
       FROM deviludo.conversation_messages existing
      WHERE existing.workspace_id = p_workspace_id
        AND existing.conversation_id = selected_conversation_id
        AND existing.metadata->>'workflowJobId' = job.id::text
   );
  IF FOUND THEN
    UPDATE deviludo.project_conversations
       SET updated_at = clock_timestamp()
     WHERE workspace_id = p_workspace_id AND id = selected_conversation_id;
  END IF;
  RETURN selected_conversation_id;
END
$$;
ALTER FUNCTION deviludo.publish_development_agent_message(uuid, uuid, text)
  OWNER TO deviludo_conversation_writer;
-- Agent turns execute in the project's persistent Runtime container. Build,
-- platform E2E and Steam remain controlled host jobs.
CREATE OR REPLACE FUNCTION deviludo.stage_running_state(p_kind deviludo.job_kind)
RETURNS deviludo.workflow_state
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $$
  SELECT CASE p_kind
    WHEN 'AGENT_TURN' THEN 'DESIGNING'
    WHEN 'BUILD' THEN 'BUILDING'
    WHEN 'E2E_PLATFORM_RUN' THEN 'TESTING'
    WHEN 'STEAM_PUBLISH' THEN 'STEAM_PUBLISHING'
  END::deviludo.workflow_state
$$;

CREATE OR REPLACE FUNCTION deviludo.required_capabilities(p_kind deviludo.job_kind)
RETURNS text[]
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $$
  SELECT CASE p_kind
    WHEN 'AGENT_TURN' THEN ARRAY['PROJECT_RUNTIME', 'ROLE_SCOPED_MCP']
    WHEN 'BUILD' THEN ARRAY['RESTRICTED_CONTAINER', 'BUILD_TOOLCHAIN']
    WHEN 'E2E_PLATFORM_RUN' THEN ARRAY['GAME_RUNTIME', 'TRUSTED_REIMAGE']
    WHEN 'STEAM_PUBLISH' THEN ARRAY['RESTRICTED_CONTAINER', 'STEAMCMD']
  END
$$;

CREATE OR REPLACE FUNCTION deviludo.enqueue_job(
  p_workspace_id uuid,
  p_workflow_id uuid,
  p_project_id uuid,
  p_kind deviludo.job_kind,
  p_operating_system deviludo.server_os,
  p_idempotency_key text,
  p_payload jsonb DEFAULT '{}'::jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, deviludo
AS $$
DECLARE
  v_pool deviludo.server_pool_kind;
  v_id uuid;
  v_runtime_key text;
  v_runtime_image text;
  v_source deviludo.project_source_revisions%ROWTYPE;
  v_goal deviludo.workflow_e2e_goal_revisions%ROWTYPE;
  v_plan deviludo.test_plans_v2%ROWTYPE;
  v_input_count integer;
BEGIN
  v_pool := CASE
    WHEN p_kind IN ('AGENT_TURN', 'BUILD', 'STEAM_PUBLISH') THEN 'CORE'
    WHEN p_operating_system = 'linux' THEN 'E2E_LINUX'
    WHEN p_operating_system = 'windows' THEN 'E2E_WINDOWS'
    WHEN p_operating_system = 'macos' THEN 'E2E_MACOS'
  END;
  IF v_pool IS NULL OR ((p_kind = 'E2E_PLATFORM_RUN') <> (p_operating_system IS NOT NULL)) THEN
    RAISE EXCEPTION 'invalid fixed job placement';
  END IF;
  v_runtime_key := CASE
    WHEN p_kind = 'AGENT_TURN' AND coalesce(p_payload->>'runtime', p_payload #>> '{agentConfiguration,runtime}', '') = 'CODEX_CLI' THEN 'AGENT_CODEX'
    WHEN p_kind = 'AGENT_TURN' THEN 'AGENT_CLAUDE'
    WHEN p_kind = 'BUILD' THEN 'GODOT_BUILDER'
    WHEN p_kind = 'STEAM_PUBLISH' THEN 'STEAM_PUBLISHER'
    WHEN p_operating_system = 'linux' THEN 'E2E_LINUX'
    WHEN p_operating_system = 'windows' THEN 'E2E_WINDOWS'
    WHEN p_operating_system = 'macos' THEN 'E2E_MACOS'
  END;
  SELECT image_reference INTO v_runtime_image
    FROM deviludo.runtime_images WHERE runtime_key = v_runtime_key;
  IF v_runtime_image IS NULL THEN RAISE EXCEPTION 'verified runtime image is not configured: %', v_runtime_key; END IF;

  SELECT * INTO v_source
    FROM deviludo.project_source_revisions
   WHERE workspace_id = p_workspace_id AND project_id = p_project_id
   ORDER BY revision DESC LIMIT 1;
  IF p_kind IN ('BUILD', 'E2E_PLATFORM_RUN', 'STEAM_PUBLISH') AND v_source.revision IS NULL THEN
    RAISE EXCEPTION '% requires a published source revision', p_kind;
  END IF;
  IF v_source.revision IS NOT NULL THEN
    p_payload := p_payload || jsonb_build_object(
      'sourceRevision', v_source.revision,
      'sourceRelativePath', v_source.relative_path,
      'sourceDigest', v_source.content_digest
    );
  END IF;
  IF p_kind = 'AGENT_TURN' AND p_payload->>'role' = 'TEST' THEN
    -- Build completions, resume signals and retries can arrive through distinct
    -- idempotency keys while still describing the same Test Agent work. Serialize
    -- that semantic key and reuse the one active turn instead of racing the
    -- persistent TEST session with duplicate primary turns.
    PERFORM pg_advisory_xact_lock(hashtextextended(
      p_workspace_id::text || ':' || p_workflow_id::text || ':TEST:'
        || coalesce(p_payload->>'purpose', 'TEST_PLAN') || ':'
        || coalesce(p_payload->>'sourceRevision', '') || ':'
        || coalesce(p_payload->>'testPlanId', ''),
      0
    ));
    SELECT candidate.id INTO v_id
      FROM deviludo.jobs candidate
     WHERE candidate.workspace_id = p_workspace_id
       AND candidate.workflow_id = p_workflow_id
       AND candidate.project_id = p_project_id
       AND candidate.kind = 'AGENT_TURN'
       AND candidate.payload->>'role' = 'TEST'
       AND coalesce(candidate.payload->>'purpose', 'TEST_PLAN')
         = coalesce(p_payload->>'purpose', 'TEST_PLAN')
       AND coalesce(candidate.payload->>'sourceRevision', '')
         = coalesce(p_payload->>'sourceRevision', '')
       AND coalesce(candidate.payload->>'testPlanId', '')
         = coalesce(p_payload->>'testPlanId', '')
       AND candidate.state IN ('QUEUED', 'RUNNING', 'RETRY')
     ORDER BY CASE candidate.state WHEN 'RUNNING' THEN 0 ELSE 1 END,
              candidate.created_at, candidate.id
     LIMIT 1;
    IF v_id IS NOT NULL THEN RETURN v_id; END IF;
  END IF;
  IF p_kind = 'E2E_PLATFORM_RUN' THEN
    SELECT * INTO v_goal
      FROM deviludo.workflow_e2e_goal_revisions
     WHERE workspace_id = p_workspace_id AND workflow_id = p_workflow_id
     ORDER BY revision DESC LIMIT 1;
    IF v_goal.revision IS NULL THEN RAISE EXCEPTION 'platform E2E requires a frozen goal revision'; END IF;
    p_payload := p_payload || jsonb_build_object(
      'e2eGoalRevision', v_goal.revision,
      'e2eGoalDigest', v_goal.goals_digest
    );
    SELECT * INTO v_plan
      FROM deviludo.test_plans_v2
     WHERE workspace_id = p_workspace_id AND project_id = p_project_id
       AND source_revision = v_source.revision
     ORDER BY plan_revision DESC LIMIT 1;
    IF v_plan.id IS NULL THEN RAISE EXCEPTION 'platform E2E requires the current frozen Test Agent plan'; END IF;
    p_payload := p_payload || jsonb_build_object(
      'testPlanId', v_plan.id,
      'testPlanRevision', v_plan.plan_revision,
      'testPlanDigest', v_plan.plan_sha256,
      'testPlan', v_plan.plan
    );
  END IF;

  INSERT INTO deviludo.jobs(
    workspace_id, workflow_id, project_id, kind, pool_kind, target_operating_system,
    required_capabilities, exclusive, runtime_image, timeout_seconds, max_attempts,
    output_contract, idempotency_key, payload
  ) VALUES (
    p_workspace_id, p_workflow_id, p_project_id, p_kind, v_pool,
    CASE WHEN p_kind = 'E2E_PLATFORM_RUN' THEN p_operating_system ELSE NULL END,
    deviludo.required_capabilities(p_kind), p_kind = 'E2E_PLATFORM_RUN', v_runtime_image,
    CASE WHEN p_kind IN ('AGENT_TURN', 'E2E_PLATFORM_RUN') THEN 86400 ELSE 3600 END,
    3,
    jsonb_build_object(
      'kinds', CASE p_kind
        WHEN 'AGENT_TURN' THEN jsonb_build_array('AGENT_RESULT')
        WHEN 'BUILD' THEN jsonb_build_array('BUILD')
        WHEN 'E2E_PLATFORM_RUN' THEN jsonb_build_array('E2E_REPORT', 'E2E_REGRESSION')
        WHEN 'STEAM_PUBLISH' THEN jsonb_build_array('PUBLISH_RECEIPT')
      END,
      'maxBytes', CASE WHEN p_kind = 'E2E_PLATFORM_RUN' THEN 1090519040 ELSE 1073741824 END
    ),
    p_idempotency_key,
    p_payload
  )
  ON CONFLICT (workspace_id, idempotency_key) DO UPDATE SET updated_at = deviludo.jobs.updated_at
  RETURNING id INTO v_id;

  IF p_kind = 'E2E_PLATFORM_RUN' THEN
    INSERT INTO deviludo.artifact_inputs(workspace_id, job_id, artifact_id, expected_sha256)
    SELECT artifact.workspace_id, v_id, artifact.id, artifact.sha256
      FROM deviludo.artifacts artifact
     WHERE artifact.workspace_id = p_workspace_id AND artifact.workflow_id = p_workflow_id
       AND artifact.kind = 'BUILD' AND artifact.target_platform = p_operating_system
       AND artifact.id = (
         SELECT candidate.id FROM deviludo.artifacts candidate
          JOIN deviludo.jobs producer ON producer.workspace_id = candidate.workspace_id
            AND producer.id = candidate.producing_job_id
         WHERE candidate.workspace_id = p_workspace_id AND candidate.workflow_id = p_workflow_id
           AND candidate.kind = 'BUILD' AND candidate.target_platform = p_operating_system
           AND producer.kind = 'BUILD' AND producer.state = 'SUCCEEDED'
           AND (producer.payload->>'sourceRevision')::bigint = v_source.revision
         ORDER BY candidate.created_at DESC, candidate.id DESC LIMIT 1
       );
  ELSIF p_kind = 'STEAM_PUBLISH' THEN
    INSERT INTO deviludo.artifact_inputs(workspace_id, job_id, artifact_id, expected_sha256)
    SELECT artifact.workspace_id, v_id, artifact.id, artifact.sha256
      FROM deviludo.artifacts artifact
     WHERE artifact.workspace_id = p_workspace_id AND artifact.workflow_id = p_workflow_id
       AND artifact.kind = 'BUILD'
       AND artifact.target_platform::text IN (SELECT jsonb_array_elements_text(p_payload->'targetPlatforms'))
       AND artifact.producing_job_id = (
         SELECT producer.id FROM deviludo.jobs producer
          WHERE producer.workspace_id = p_workspace_id AND producer.workflow_id = p_workflow_id
            AND producer.kind = 'BUILD' AND producer.state = 'SUCCEEDED'
            AND (producer.payload->>'sourceRevision')::bigint = v_source.revision
          ORDER BY producer.updated_at DESC LIMIT 1
       );
  END IF;
  SELECT count(*)::integer INTO v_input_count FROM deviludo.artifact_inputs
   WHERE workspace_id = p_workspace_id AND job_id = v_id;
  IF (p_kind = 'E2E_PLATFORM_RUN' AND v_input_count <> 1)
    OR (p_kind = 'STEAM_PUBLISH' AND v_input_count <> coalesce(jsonb_array_length(p_payload->'targetPlatforms'), 0)) THEN
    RAISE EXCEPTION 'verified artifact inputs are incomplete for %', p_kind;
  END IF;
  RETURN v_id;
END
$$;

-- Claim one durable initial-analysis task. The directory link itself is stored
-- in workflow state_data before this function can see it; the lease makes the
-- work safe across API restarts and multiple replicas.
CREATE OR REPLACE FUNCTION deviludo.claim_project_import_analysis(p_lease_seconds integer)
RETURNS TABLE (
  "workspaceId" uuid,
  "projectId" uuid,
  "workflowId" uuid,
  "actorId" uuid,
  "leaseToken" uuid,
  "sourceKind" text,
  "repositoryUrl" text,
  "localDirectoryBindingId" uuid,
  "gitBranch" text,
  "displayName" text
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
  IF p_lease_seconds NOT BETWEEN 60 AND 3600 THEN
    RAISE EXCEPTION 'invalid project import analysis lease';
  END IF;
  SELECT workflow.workspace_id, workflow.id AS workflow_id, workflow.project_id,
         workflow.state_data, project.created_by_actor_id
    INTO candidate
    FROM deviludo.workflow_instances workflow
    JOIN deviludo.projects project
      ON project.workspace_id = workflow.workspace_id AND project.id = workflow.project_id
   WHERE workflow.state_data #>> '{importAnalysis,status}' = 'PENDING'
      OR (
        workflow.state_data #>> '{importAnalysis,status}' = 'ANALYZING'
        AND (workflow.state_data #>> '{importAnalysis,leaseExpiresAt}')::timestamptz <= clock_timestamp()
      )
   ORDER BY workflow.created_at, workflow.id
   FOR UPDATE OF workflow SKIP LOCKED
   LIMIT 1;
  IF NOT FOUND THEN RETURN; END IF;

  next_token := gen_random_uuid();
  next_expiry := clock_timestamp() + make_interval(secs => p_lease_seconds);
  next_attempt := coalesce((candidate.state_data #>> '{importAnalysis,attempts}')::integer, 0) + 1;
  UPDATE deviludo.workflow_instances
     SET state_data = jsonb_set(
       candidate.state_data,
       '{importAnalysis}',
       coalesce(candidate.state_data->'importAnalysis', '{}'::jsonb) || jsonb_build_object(
         'status', 'ANALYZING',
         'attempts', next_attempt,
         'error', NULL,
         'startedAt', clock_timestamp(),
         'leaseToken', next_token,
         'leaseExpiresAt', next_expiry
       )
     ),
     version = version + 1,
     updated_at = clock_timestamp()
   WHERE workspace_id = candidate.workspace_id AND id = candidate.workflow_id;

  RETURN QUERY SELECT
    candidate.workspace_id,
    candidate.project_id,
    candidate.workflow_id,
    candidate.created_by_actor_id,
    next_token,
    candidate.state_data #>> '{source,kind}',
    candidate.state_data #>> '{source,repositoryUrl}',
    (candidate.state_data #>> '{source,localDirectoryBindingId}')::uuid,
    candidate.state_data #>> '{source,gitBranch}',
    candidate.state_data #>> '{source,displayName}';
END
$$;
ALTER FUNCTION deviludo.claim_project_import_analysis(integer)
  OWNER TO deviludo_claim_executor;

-- A final successful E2E platform job queues one durable local Git commit for
-- the workflow. The scheduler leases this state_data request and delegates the
-- actual filesystem/Git operation to the host bridge; no Git credential or
-- project-directory authority is exposed to E2E or Agent executors.
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
  IF NEW.kind <> 'E2E_PLATFORM_RUN' OR NEW.state <> 'SUCCEEDED' OR OLD.state = 'SUCCEEDED' THEN
    RETURN NEW;
  END IF;
  SELECT * INTO workflow
    FROM deviludo.workflow_instances
   WHERE workspace_id = NEW.workspace_id AND id = NEW.workflow_id;
  IF workflow.id IS NULL OR workflow.state <> 'TESTING' THEN RETURN NEW; END IF;
  IF EXISTS (
    SELECT 1 FROM unnest(workflow.target_platforms) required(operating_system)
     WHERE NOT EXISTS (
       SELECT 1 FROM deviludo.jobs successful
        WHERE successful.workspace_id = NEW.workspace_id
          AND successful.workflow_id = NEW.workflow_id
          AND successful.kind = 'E2E_PLATFORM_RUN'
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
   ORDER BY source.revision DESC
   LIMIT 1;
  IF source_digest IS NULL THEN RETURN NEW; END IF;

  request_id := gen_random_uuid();
  UPDATE deviludo.workflow_instances
     SET state_data = jsonb_set(
       coalesce(state_data, '{}'::jsonb),
       '{gitCommit}',
       jsonb_build_object(
         'requestId', request_id,
         'state', 'PENDING',
         'bindingId', binding_id,
         'expectedSourceDigest', source_digest,
         'iterationNumber', workflow.iteration_number,
         'attempts', 0,
         'availableAt', clock_timestamp(),
         'requestedAt', clock_timestamp(),
         'leaseToken', NULL,
         'leaseExpiresAt', NULL,
         'error', NULL
       )
     ),
     version = version + 1,
     updated_at = clock_timestamp()
   WHERE workspace_id = NEW.workspace_id AND id = NEW.workflow_id;
  RETURN NEW;
END
$$;

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
  SELECT workflow.workspace_id, workflow.project_id, workflow.id AS workflow_id,
         workflow.state_data
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
       candidate.state_data,
       '{gitCommit}',
       candidate.state_data->'gitCommit' || jsonb_build_object(
         'state', 'RUNNING',
         'attempts', next_attempt,
         'leaseToken', next_token,
         'leaseExpiresAt', next_expiry,
         'startedAt', clock_timestamp(),
         'error', NULL
       )
     ),
     version = version + 1,
     updated_at = clock_timestamp()
   WHERE workspace_id = candidate.workspace_id AND id = candidate.workflow_id;

  RETURN QUERY SELECT
    candidate.workspace_id,
    candidate.project_id,
    candidate.workflow_id,
    (candidate.state_data #>> '{gitCommit,requestId}')::uuid,
    next_token,
    (candidate.state_data #>> '{gitCommit,bindingId}')::uuid,
    candidate.state_data #>> '{gitCommit,expectedSourceDigest}',
    (candidate.state_data #>> '{gitCommit,iterationNumber}')::integer,
    next_attempt;
END
$$;
ALTER FUNCTION deviludo.claim_local_git_commit(integer) OWNER TO deviludo_claim_executor;

CREATE OR REPLACE FUNCTION deviludo.complete_local_git_commit(
  p_workflow_id uuid,
  p_request_id uuid,
  p_lease_token uuid,
  p_outcome text,
  p_commit_hash text,
  p_branch text
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
       state_data,
       '{gitCommit}',
       state_data->'gitCommit' || jsonb_build_object(
         'state', next_state,
         'outcome', p_outcome,
         'commitHash', p_commit_hash,
         'branch', p_branch,
         'completedAt', clock_timestamp(),
         'leaseToken', NULL,
         'leaseExpiresAt', NULL,
         'error', NULL
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
  p_workflow_id uuid,
  p_request_id uuid,
  p_lease_token uuid,
  p_error text
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
       state_data,
       '{gitCommit}',
       state_data->'gitCommit' || jsonb_build_object(
         'state', CASE WHEN terminal THEN 'FAILED' ELSE 'RETRY' END,
         'availableAt', clock_timestamp() + make_interval(secs => least(300, 5 * (2 ^ attempts)::integer)),
         'leaseToken', NULL,
         'leaseExpiresAt', NULL,
         'error', left(p_error, 2000),
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

-- Lease planned assets for generation.
--
-- Asset generation is not a delivery job: it has no `deviludo.jobs` row or pool,
-- but its durable manifest gates the build. This is its claim primitive, and it is deliberately
-- shaped like `claim_job` — a lease with an expiry, so a generator that dies mid
-- request cannot strand an item in 'generating' forever.
--
-- Only items whose manifest has auto-generate on are returned, and only when the
-- selected Agent connection actually has an image model configured: without a
-- credential there is nothing to call, and flipping to 'generating' would just
-- burn an attempt.
CREATE OR REPLACE FUNCTION deviludo.claim_asset_generation(
  p_lease_seconds integer,
  p_batch_size integer DEFAULT 4
)
RETURNS TABLE (
  "workspaceId" uuid,
  "projectId" uuid,
  "itemId" uuid,
  "assetKey" text,
  "assetType" text,
  "description" text,
  "generationPrompt" text,
  "dimensions" text,
  "frameCount" integer,
  "attempt" integer,
  "leaseToken" uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, deviludo
SET row_security = off
AS $$
BEGIN
  IF p_lease_seconds NOT BETWEEN 30 AND 3600 OR p_batch_size NOT BETWEEN 1 AND 50 THEN
    RAISE EXCEPTION 'invalid asset generation claim';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM deviludo.instance_agent_settings
     WHERE singleton = true
       AND (
         agent_runtime = 'CODEX_CLI'
         OR (agent_runtime = 'CLAUDE_CODE' AND image_model IS NOT NULL)
       )
  ) THEN RETURN; END IF;

  RETURN QUERY
  WITH candidate AS (
    SELECT item.workspace_id, item.id
      FROM deviludo.asset_items item
      JOIN deviludo.asset_manifests manifest
        ON manifest.workspace_id = item.workspace_id AND manifest.id = item.manifest_id
     WHERE manifest.auto_generate_enabled = true
       AND item.asset_type <> 'music'
       AND item.generation_prompt IS NOT NULL
       AND item.generation_attempt < 3
       AND (
         item.status = 'planned'
         -- An expired lease is a crashed generator, not a running one.
         OR (item.status = 'generating' AND item.generation_lease_expires_at <= clock_timestamp())
       )
     ORDER BY item.generation_attempt, item.created_at, item.id
     FOR UPDATE OF item SKIP LOCKED
     LIMIT p_batch_size
  )
  UPDATE deviludo.asset_items item
     SET status = 'generating',
         generation_attempt = item.generation_attempt + 1,
         generation_lease_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds),
         generation_lease_token = gen_random_uuid(),
         error_message = NULL,
         updated_at = clock_timestamp()
    FROM candidate
   WHERE item.workspace_id = candidate.workspace_id AND item.id = candidate.id
  RETURNING item.workspace_id, (
    SELECT manifest.project_id FROM deviludo.asset_manifests manifest
     WHERE manifest.workspace_id = item.workspace_id AND manifest.id = item.manifest_id
  ), item.id, item.asset_key, item.asset_type, item.description,
     item.generation_prompt, item.dimensions, item.frame_count, item.generation_attempt,
     item.generation_lease_token;
END
$$;
ALTER FUNCTION deviludo.claim_asset_generation(integer, integer)
  OWNER TO deviludo_claim_executor;

-- Record a generated asset. The status/object CHECK on asset_items requires
-- bucket, key, digest and size to arrive together, so this is the only supported
-- way to settle a leased item as generated.
CREATE OR REPLACE FUNCTION deviludo.complete_asset_generation(
  p_workspace_id uuid,
  p_item_id uuid,
  p_lease_token uuid,
  p_bucket text,
  p_object_key text,
  p_sha256 text,
  p_size_bytes bigint
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, deviludo
SET row_security = off
AS $$
DECLARE
  updated integer;
BEGIN
  UPDATE deviludo.asset_items
     SET status = 'generated', bucket = p_bucket, object_key = p_object_key,
         sha256 = p_sha256, size_bytes = p_size_bytes, error_message = NULL,
         generation_lease_expires_at = NULL, updated_at = clock_timestamp()
   WHERE workspace_id = p_workspace_id AND id = p_item_id
     -- A user upload that landed while generation was in flight wins: it is an
     -- explicit choice, and overwriting it with a generated image would silently
     -- discard their art.
     AND status = 'generating' AND generation_lease_token = p_lease_token;
  GET DIAGNOSTICS updated = ROW_COUNT;
  RETURN updated = 1;
END
$$;
ALTER FUNCTION deviludo.complete_asset_generation(uuid, uuid, uuid, text, text, text, bigint)
  OWNER TO deviludo_claim_executor;

-- Release a leased item after a failed attempt. Items go back to 'planned' while
-- attempts remain so a transient provider error is retried; the last attempt
-- settles as 'failed' so the panel stops showing it as pending work and the user
-- can upload the asset instead.
CREATE OR REPLACE FUNCTION deviludo.fail_asset_generation(
  p_workspace_id uuid,
  p_item_id uuid,
  p_lease_token uuid,
  p_error text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, deviludo
SET row_security = off
AS $$
DECLARE
  updated integer;
BEGIN
  UPDATE deviludo.asset_items
     SET status = CASE WHEN generation_attempt >= 3 THEN 'failed' ELSE 'planned' END,
         error_message = left(coalesce(nullif(btrim(p_error), ''), 'generation failed'), 2000),
         generation_lease_expires_at = NULL,
         updated_at = clock_timestamp()
   WHERE workspace_id = p_workspace_id AND id = p_item_id
     AND status = 'generating' AND generation_lease_token = p_lease_token;
  GET DIAGNOSTICS updated = ROW_COUNT;
  RETURN updated = 1;
END
$$;
ALTER FUNCTION deviludo.fail_asset_generation(uuid, uuid, uuid, text)
  OWNER TO deviludo_claim_executor;

-- Re-open the delivery gate when the user retries unresolved art after a build,
-- E2E run, or completed delivery. The mutation is deliberately atomic: the old
-- downstream jobs are superseded in the same transaction that requeues failed
-- images, so no executor can start from a mixture of old and new assets.
CREATE OR REPLACE FUNCTION deviludo.request_asset_rerun(
  p_workflow_id uuid,
  p_project_id uuid,
  p_idempotency_key text,
  p_payload jsonb
)
RETURNS TABLE (accepted boolean, queued integer, remaining integer)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, deviludo
AS $$
DECLARE
  workflow deviludo.workflow_instances%ROWTYPE;
  asset_manifest_id uuid;
  existing_kind text;
  inserted_id uuid;
  queued_count integer := 0;
  remaining_count integer := 0;
BEGIN
  SELECT * INTO workflow
    FROM deviludo.workflow_instances
   WHERE id = p_workflow_id AND project_id = p_project_id
   FOR UPDATE;
  IF workflow.id IS NULL THEN RAISE EXCEPTION 'workflow not found'; END IF;

  SELECT manifest.id INTO asset_manifest_id
    FROM deviludo.asset_manifests manifest
   WHERE manifest.workspace_id = workflow.workspace_id
     AND manifest.project_id = workflow.project_id
     AND manifest.workflow_id = workflow.id
   FOR UPDATE;
  IF asset_manifest_id IS NULL THEN RAISE EXCEPTION 'asset manifest not found'; END IF;

  SELECT signal.signal_kind INTO existing_kind
    FROM deviludo.external_signals signal
   WHERE signal.workspace_id = workflow.workspace_id
     AND signal.workflow_id = workflow.id
     AND signal.idempotency_key = p_idempotency_key;
  IF existing_kind IS NOT NULL THEN
    IF existing_kind <> 'ASSET_RERUN_REQUESTED' THEN
      RAISE EXCEPTION 'asset rerun idempotency key conflicts with another signal';
    END IF;
    SELECT count(*)::integer INTO remaining_count
      FROM deviludo.asset_items item
     WHERE item.workspace_id = workflow.workspace_id
       AND item.manifest_id = asset_manifest_id
       AND item.asset_type <> 'music'
       AND item.status IN ('planned', 'generating', 'failed');
    RETURN QUERY SELECT false, 0, remaining_count;
    RETURN;
  END IF;

  IF workflow.state NOT IN (
    'DEVELOPING', 'RELEASE_APPROVAL_PENDING', 'SUCCEEDED', 'FAILED', 'CANCELLED'
  ) THEN
    RAISE EXCEPTION 'Asset rerun requires an idle delivery or the active asset gate';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM deviludo.instance_agent_settings
     WHERE singleton = true
       AND (
         agent_runtime = 'CODEX_CLI'
         OR (agent_runtime = 'CLAUDE_CODE' AND image_model IS NOT NULL)
       )
  ) THEN
    RAISE EXCEPTION 'Image generation configuration is required before rerunning assets';
  END IF;

  SELECT count(*)::integer INTO remaining_count
    FROM deviludo.asset_items item
   WHERE item.workspace_id = workflow.workspace_id
     AND item.manifest_id = asset_manifest_id
     AND item.asset_type <> 'music'
     AND item.status IN ('planned', 'generating', 'failed');
  IF remaining_count = 0 THEN RAISE EXCEPTION 'No unresolved assets remain'; END IF;

  INSERT INTO deviludo.external_signals(
    workspace_id, workflow_id, signal_kind, payload, idempotency_key
  ) VALUES (
    workflow.workspace_id, workflow.id, 'ASSET_RERUN_REQUESTED', p_payload, p_idempotency_key
  ) RETURNING id INTO inserted_id;

  UPDATE deviludo.asset_manifests
     SET auto_generate_enabled = true, updated_at = clock_timestamp()
   WHERE workspace_id = workflow.workspace_id AND id = asset_manifest_id;
  UPDATE deviludo.asset_items
     SET status = 'planned', generation_attempt = 0,
         generation_lease_expires_at = NULL, error_message = NULL,
         updated_at = clock_timestamp()
   WHERE workspace_id = workflow.workspace_id
     AND manifest_id = asset_manifest_id
     AND asset_type <> 'music'
     AND status = 'failed';
  GET DIAGNOSTICS queued_count = ROW_COUNT;

  UPDATE deviludo.jobs
     SET state = 'CANCELLED',
         lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
         heartbeat_at = NULL, fencing_token = fencing_token + 1,
         last_error = 'superseded by asset rerun', updated_at = clock_timestamp()
     WHERE workspace_id = workflow.workspace_id AND workflow_id = workflow.id
       AND kind IN ('BUILD', 'E2E_PLATFORM_RUN', 'STEAM_PUBLISH')
     AND state IN ('QUEUED', 'RETRY', 'RUNNING');
  UPDATE deviludo.workflow_instances
     SET state = 'DEVELOPING', version = version + 1,
         updated_at = clock_timestamp()
   WHERE workspace_id = workflow.workspace_id AND id = workflow.id;
  INSERT INTO deviludo.workflow_events(
    workspace_id, workflow_id, event_kind, event_data, idempotency_key
  ) VALUES (
    workflow.workspace_id, workflow.id, 'ASSET_RERUN_REQUESTED',
    p_payload || jsonb_build_object('signalId', inserted_id, 'queued', queued_count),
    'signal:' || p_idempotency_key
  );

  SELECT count(*)::integer INTO remaining_count
    FROM deviludo.asset_items item
   WHERE item.workspace_id = workflow.workspace_id
     AND item.manifest_id = asset_manifest_id
     AND item.asset_type <> 'music'
     AND item.status IN ('planned', 'generating', 'failed');
  RETURN QUERY SELECT true, queued_count, remaining_count;
END
$$;

-- Advance deliveries whose generated/uploaded art is now complete. This is a
-- cross-workspace scheduler primitive, so it owns the same narrow BYPASSRLS role
-- as job claiming. Disabling automatic generation means the workflow waits for
-- player uploads; it must never reinterpret unresolved art as placeholders.
CREATE OR REPLACE FUNCTION deviludo.advance_asset_workflows(p_batch_size integer DEFAULT 20)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, deviludo
SET row_security = off
AS $$
DECLARE
  candidate record;
  advanced integer := 0;
BEGIN
  IF p_batch_size NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'invalid asset workflow batch size';
  END IF;
  FOR candidate IN
    SELECT workflow.workspace_id, workflow.id AS workflow_id, workflow.project_id,
           workflow.target_platforms, agent.id AS agent_job_id,
           asset_rerun.id AS asset_rerun_signal_id
      FROM deviludo.workflow_instances workflow
      JOIN deviludo.asset_manifests manifest
        ON manifest.workspace_id = workflow.workspace_id
       AND manifest.project_id = workflow.project_id
       AND manifest.workflow_id = workflow.id
      JOIN LATERAL (
        SELECT source.id
          FROM deviludo.jobs source
         WHERE source.workspace_id = workflow.workspace_id
           AND source.workflow_id = workflow.id
           AND source.kind = 'AGENT_TURN'
           AND source.state = 'SUCCEEDED'
           AND coalesce(source.payload->>'role', 'DEVELOPMENT') = 'DEVELOPMENT'
           AND coalesce(source.payload->>'purpose', 'DEVELOPMENT') = 'DEVELOPMENT'
         ORDER BY source.updated_at DESC, source.created_at DESC
         LIMIT 1
      ) agent ON true
      LEFT JOIN LATERAL (
        SELECT signal.id
          FROM deviludo.external_signals signal
         WHERE signal.workspace_id = workflow.workspace_id
           AND signal.workflow_id = workflow.id
           AND signal.signal_kind = 'ASSET_RERUN_REQUESTED'
         ORDER BY signal.created_at DESC, signal.id DESC
         LIMIT 1
      ) asset_rerun ON true
     WHERE workflow.state = 'DEVELOPING'
       AND NOT EXISTS (
         SELECT 1
           FROM deviludo.jobs active_development
          WHERE active_development.workspace_id = workflow.workspace_id
            AND active_development.workflow_id = workflow.id
            AND active_development.kind = 'AGENT_TURN'
            AND active_development.state IN ('QUEUED', 'RUNNING', 'RETRY')
            AND coalesce(active_development.payload->>'role', 'DEVELOPMENT') = 'DEVELOPMENT'
            AND coalesce(active_development.payload->>'purpose', 'DEVELOPMENT') = 'DEVELOPMENT'
       )
       AND NOT EXISTS (
         SELECT 1 FROM deviludo.asset_items item
          WHERE item.workspace_id = manifest.workspace_id
            AND item.manifest_id = manifest.id
            AND item.asset_type <> 'music'
            AND item.status NOT IN ('generated', 'uploaded', 'existing')
       )
     ORDER BY workflow.updated_at, workflow.id
     FOR UPDATE OF workflow SKIP LOCKED
     LIMIT p_batch_size
  LOOP
    UPDATE deviludo.workflow_instances
       SET state = 'BUILDING', version = version + 1,
           updated_at = clock_timestamp()
     WHERE workspace_id = candidate.workspace_id AND id = candidate.workflow_id
       AND state = 'DEVELOPING';
    IF FOUND THEN
      PERFORM deviludo.enqueue_job(
        candidate.workspace_id, candidate.workflow_id, candidate.project_id,
        'BUILD', NULL,
        candidate.workflow_id::text || ':artifact:assets:'
          || coalesce(candidate.asset_rerun_signal_id::text, 'initial')
          || ':after:' || candidate.agent_job_id::text,
        jsonb_build_object('targetPlatforms', candidate.target_platforms)
      );
      INSERT INTO deviludo.workflow_events(
        workspace_id, workflow_id, event_kind, event_data, idempotency_key
      ) VALUES (
        candidate.workspace_id, candidate.workflow_id, 'ASSETS_READY',
        jsonb_build_object(
          'agentJobId', candidate.agent_job_id,
          'assetRerunSignalId', candidate.asset_rerun_signal_id
        ),
        'assets-ready:' || coalesce(candidate.asset_rerun_signal_id::text, 'initial')
          || ':' || candidate.agent_job_id::text
      ) ON CONFLICT (workspace_id, workflow_id, idempotency_key) DO NOTHING;
      advanced := advanced + 1;
    END IF;
  END LOOP;
  RETURN advanced;
END
$$;
ALTER FUNCTION deviludo.advance_asset_workflows(integer)
  OWNER TO deviludo_claim_executor;

CREATE OR REPLACE FUNCTION deviludo.claim_job(
  p_executor_id text,
  p_pool_kind deviludo.server_pool_kind,
  p_lease_seconds integer
)
RETURNS TABLE ("jobId" uuid, "workspaceId" uuid, "leaseToken" uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, deviludo
SET row_security = off
AS $$
DECLARE
  candidate deviludo.jobs%ROWTYPE;
  next_token uuid;
BEGIN
  IF length(p_executor_id) NOT BETWEEN 3 AND 200
    OR p_lease_seconds NOT BETWEEN 15 AND 600
    OR p_pool_kind IN ('WEB')
  THEN
    RAISE EXCEPTION 'invalid job claim';
  END IF;

  -- Retire historical duplicates before one of them can briefly appear as a
  -- second Test Agent reply. Prefer an already running canonical turn, then the
  -- oldest queued/retry turn for the same workflow, source, purpose and plan.
  WITH ranked AS MATERIALIZED (
    SELECT job.workspace_id, job.id,
           first_value(job.id) OVER semantic AS canonical_id,
           row_number() OVER semantic AS semantic_rank
      FROM deviludo.jobs job
     WHERE job.kind = 'AGENT_TURN'
       AND job.payload->>'role' = 'TEST'
       AND job.state IN ('QUEUED', 'RUNNING', 'RETRY')
     WINDOW semantic AS (
       PARTITION BY job.workspace_id, job.workflow_id, job.project_id,
         coalesce(job.payload->>'purpose', 'TEST_PLAN'),
         coalesce(job.payload->>'sourceRevision', ''),
         coalesce(job.payload->>'testPlanId', '')
       ORDER BY CASE job.state WHEN 'RUNNING' THEN 0 ELSE 1 END,
                job.created_at, job.id
     )
  )
  UPDATE deviludo.jobs duplicate
     SET state = 'CANCELLED', fencing_token = fencing_token + 1,
         lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
         heartbeat_at = NULL,
         last_error = 'superseded by canonical Test Agent turn ' || ranked.canonical_id::text,
         updated_at = clock_timestamp()
    FROM ranked
   WHERE ranked.workspace_id = duplicate.workspace_id
     AND ranked.id = duplicate.id AND ranked.semantic_rank > 1;

  -- max_attempts is a durable contract, not display-only metadata. Reconcile
  -- old rows that predate enforcement and stop retry storms in a visible
  -- BLOCKED workflow instead of flashing a conversation every 15 seconds.
  WITH exhausted AS (
    UPDATE deviludo.jobs exhausted_job
       SET state = 'FAILED', lease_owner = NULL, lease_token = NULL,
           lease_expires_at = NULL, heartbeat_at = NULL,
           last_error = left('Retry limit reached: ' || coalesce(exhausted_job.last_error, 'Agent execution failed'), 2000),
           updated_at = clock_timestamp()
     WHERE exhausted_job.state IN ('QUEUED', 'RETRY')
       AND exhausted_job.attempt >= exhausted_job.max_attempts
     RETURNING exhausted_job.workspace_id, exhausted_job.project_id,
       exhausted_job.workflow_id, exhausted_job.id, exhausted_job.attempt,
       exhausted_job.last_error
  ), events AS (
    INSERT INTO deviludo.workflow_events(
      workspace_id, workflow_id, event_kind, event_data, idempotency_key
    )
    SELECT workspace_id, workflow_id, 'JOB_FAILED',
           jsonb_build_object('jobId', id, 'attempt', attempt, 'reason', last_error),
           'job-retry-exhausted:' || id::text
      FROM exhausted
    ON CONFLICT (workspace_id, workflow_id, idempotency_key) DO NOTHING
  )
  UPDATE deviludo.workflow_instances blocked
     SET state = 'BLOCKED', version = version + 1, updated_at = clock_timestamp()
   WHERE blocked.state NOT IN ('SUCCEEDED', 'FAILED', 'CANCELLED', 'BLOCKED')
     AND EXISTS (
       SELECT 1 FROM exhausted
        WHERE exhausted.workspace_id = blocked.workspace_id
          AND exhausted.workflow_id = blocked.id
     );

  IF EXISTS (
    SELECT 1 FROM deviludo.jobs
    WHERE lease_owner = p_executor_id AND state = 'RUNNING'
  ) THEN RETURN; END IF;

  SELECT job.*
    INTO candidate
    FROM deviludo.jobs job
    LEFT JOIN deviludo.workspace_claim_fairness fairness
      ON fairness.workspace_id = job.workspace_id
   WHERE job.pool_kind = p_pool_kind
     AND job.state IN ('QUEUED', 'RETRY')
     AND job.available_at <= clock_timestamp()
     AND NOT EXISTS (
       SELECT 1
         FROM deviludo.jobs prior
        WHERE prior.workspace_id = job.workspace_id
          AND prior.pool_kind = job.pool_kind
          AND prior.state IN ('QUEUED', 'RETRY')
          AND prior.available_at <= clock_timestamp()
          AND (
            prior.priority > job.priority
            OR (
              prior.priority = job.priority
              AND (prior.created_at, prior.id) < (job.created_at, job.id)
            )
          )
     )
   ORDER BY fairness.last_claimed_at ASC NULLS FIRST, job.priority DESC, job.created_at, job.id
   FOR UPDATE OF job SKIP LOCKED
   LIMIT 1;

  IF candidate.id IS NULL THEN RETURN; END IF;
  next_token := gen_random_uuid();
  UPDATE deviludo.jobs
     SET state = 'RUNNING',
         attempt = attempt + 1,
         last_error = NULL,
         lease_owner = p_executor_id,
         lease_token = next_token,
         lease_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds),
         heartbeat_at = clock_timestamp(),
         fencing_token = fencing_token + 1,
         updated_at = clock_timestamp()
   WHERE workspace_id = candidate.workspace_id AND id = candidate.id;
  INSERT INTO deviludo.workspace_claim_fairness(workspace_id, last_claimed_at)
  VALUES (candidate.workspace_id, clock_timestamp())
  ON CONFLICT (workspace_id) DO UPDATE SET last_claimed_at = EXCLUDED.last_claimed_at;
  RETURN QUERY SELECT candidate.id, candidate.workspace_id, next_token;
END
$$;
ALTER FUNCTION deviludo.claim_job(text, deviludo.server_pool_kind, integer)
  OWNER TO deviludo_claim_executor;

CREATE OR REPLACE FUNCTION deviludo.accept_workflow_signal(
  p_workflow_id uuid,
  p_signal_kind text,
  p_idempotency_key text,
  p_payload jsonb
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, deviludo
AS $$
DECLARE
  workflow deviludo.workflow_instances%ROWTYPE;
  agent_settings deviludo.instance_agent_settings%ROWTYPE;
  steam_release deviludo.steam_releases%ROWTYPE;
  inserted_id uuid;
  platform deviludo.server_os;
  rerun_stage deviludo.job_kind;
  rerun_agent_role text;
  stage_list deviludo.job_kind[];
  stage_index integer;
  downstream_stages deviludo.job_kind[];
  current_test_plan_available boolean := false;
  repair_e2e_job_id uuid;
  repair_e2e_platform deviludo.server_os;
  repair_e2e_updated_at timestamptz;
  repair_build_job_id uuid;
  repair_build_summary text;
  repair_build_updated_at timestamptz;
BEGIN
  -- The routing below is a chain of guarded branches, so a kind this version does
  -- not know falls through it: the signal row inserts, the function returns true,
  -- and nothing moves. That reaches the user as a button that does nothing, with
  -- no error anywhere to explain it -- the exact shape of a database whose
  -- functions predate the caller. Reject the kind up front instead, where it is
  -- still distinguishable from a known kind whose state guard legitimately did
  -- not match.
  IF p_signal_kind NOT IN (
    'SPEC_APPROVED', 'STAGE_RERUN_REQUESTED', 'CANCEL_REQUESTED',
    'RELEASE_APPROVED', 'RELEASE_SKIPPED', 'EXTERNAL_APPROVAL'
  ) THEN
    RAISE EXCEPTION 'Signal kind % cannot be routed by this schema version', p_signal_kind;
  END IF;
  SELECT * INTO workflow
    FROM deviludo.workflow_instances
   WHERE id = p_workflow_id
   FOR UPDATE;
  IF workflow.id IS NULL THEN RAISE EXCEPTION 'workflow not found'; END IF;
  IF p_signal_kind = 'STAGE_RERUN_REQUESTED' THEN
    -- A rerun is only meaningful from a terminal workflow. While work is still
    -- in flight, superseding jobs would race the executors currently holding
    -- their leases, so require an explicit cancel first.
    IF workflow.state NOT IN ('RELEASE_APPROVAL_PENDING', 'BLOCKED', 'FAILED', 'SUCCEEDED', 'CANCELLED') THEN
      RAISE EXCEPTION 'Stage rerun requires a terminal workflow; cancel the running delivery first';
    END IF;
    BEGIN
      rerun_stage := (p_payload->>'stage')::deviludo.job_kind;
    EXCEPTION WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'Stage rerun target is not a known job kind';
    END;
    stage_list := deviludo.delivery_stages(workflow.profile);
    stage_index := array_position(stage_list, rerun_stage);
    IF stage_index IS NULL THEN
      RAISE EXCEPTION 'Stage % is not part of the % delivery chain', rerun_stage, workflow.profile;
    END IF;
    IF rerun_stage = 'AGENT_TURN' THEN
      rerun_agent_role := p_payload->>'agentRole';
      IF rerun_agent_role NOT IN ('DESIGN', 'UI_DESIGN', 'DEVELOPMENT') THEN
        RAISE EXCEPTION 'Agent stage rerun requires DESIGN, UI_DESIGN, or DEVELOPMENT role';
      END IF;
      SELECT * INTO agent_settings
        FROM deviludo.instance_agent_settings
       WHERE singleton = true;
      IF agent_settings.singleton IS NULL THEN
        RAISE EXCEPTION 'Agent configuration is required before rerunning development';
      END IF;
      IF rerun_agent_role = 'DEVELOPMENT' THEN
        -- A manual Development rerun after a product-level E2E failure starts
        -- a fresh repair cycle and retains the evidence that explains it.
        -- Infrastructure failures deliberately never enter source repair.
        SELECT failed_job.id, failed_job.target_operating_system, failed_job.updated_at
          INTO repair_e2e_job_id, repair_e2e_platform, repair_e2e_updated_at
          FROM deviludo.jobs failed_job
         WHERE failed_job.workspace_id = workflow.workspace_id
           AND failed_job.workflow_id = workflow.id
           AND failed_job.kind = 'E2E_PLATFORM_RUN'
           AND failed_job.receipt #>> '{execution,outcome}' = 'FAILED'
           AND failed_job.receipt #>> '{execution,failureDomain}' = 'PRODUCT'
           AND EXISTS (
             SELECT 1
               FROM deviludo.artifacts evidence
              WHERE evidence.workspace_id = failed_job.workspace_id
                AND evidence.producing_job_id = failed_job.id
                AND evidence.kind = 'E2E_REPORT'
           )
         ORDER BY failed_job.updated_at DESC, failed_job.created_at DESC, failed_job.id DESC
         LIMIT 1;
        SELECT failed_job.id, left(failed_job.last_error, 1800), failed_job.updated_at
          INTO repair_build_job_id, repair_build_summary, repair_build_updated_at
          FROM deviludo.jobs failed_job
         WHERE failed_job.workspace_id = workflow.workspace_id
           AND failed_job.workflow_id = workflow.id
           AND failed_job.kind = 'BUILD'
           AND failed_job.state = 'FAILED'
           AND length(coalesce(failed_job.last_error, '')) > 0
         ORDER BY failed_job.updated_at DESC, failed_job.created_at DESC, failed_job.id DESC
         LIMIT 1;
        IF repair_build_updated_at > coalesce(repair_e2e_updated_at, '-infinity'::timestamptz) THEN
          repair_e2e_job_id := NULL;
        ELSE
          repair_build_job_id := NULL;
        END IF;
      END IF;
    END IF;
    IF rerun_stage = 'STEAM_PUBLISH' AND NOT EXISTS (
      SELECT 1 FROM deviludo.steam_releases release
       WHERE release.workspace_id = workflow.workspace_id
         AND release.workflow_id = workflow.id
         AND release.state = 'FAILED'
    ) THEN
      RAISE EXCEPTION 'Steam upload can only be retried for the failed release in this iteration';
    END IF;
  END IF;
  IF p_signal_kind = 'RELEASE_APPROVED' THEN
    IF workflow.state <> 'RELEASE_APPROVAL_PENDING' THEN
      RAISE EXCEPTION 'Steam upload requires a workflow awaiting a release decision';
    END IF;
    SELECT * INTO steam_release FROM deviludo.steam_releases release
     WHERE release.workspace_id = workflow.workspace_id
       AND release.workflow_id = workflow.id
       AND release.id = (p_payload->>'releaseId')::uuid
       AND release.state = 'UPLOADING'
     FOR UPDATE;
    IF steam_release.id IS NULL THEN RAISE EXCEPTION 'Steam release approval is invalid'; END IF;
  END IF;
  IF p_signal_kind = 'RELEASE_SKIPPED' AND workflow.state <> 'RELEASE_APPROVAL_PENDING' THEN
    RAISE EXCEPTION 'Finishing without Steam requires a workflow awaiting a release decision';
  END IF;
  INSERT INTO deviludo.external_signals(
    workspace_id, workflow_id, signal_kind, payload, idempotency_key
  )
  VALUES (
    workflow.workspace_id, workflow.id, p_signal_kind, p_payload, p_idempotency_key
  )
  ON CONFLICT (workspace_id, workflow_id, idempotency_key) DO NOTHING
  RETURNING id INTO inserted_id;
  IF inserted_id IS NULL THEN RETURN false; END IF;

  INSERT INTO deviludo.workflow_events(
    workspace_id, workflow_id, event_kind, event_data, idempotency_key
  )
  VALUES (
    workflow.workspace_id, workflow.id, p_signal_kind, p_payload, 'signal:' || p_idempotency_key
  );

  IF p_signal_kind = 'SPEC_APPROVED' AND workflow.state = 'DRAFT' THEN
    SELECT * INTO agent_settings
      FROM deviludo.instance_agent_settings
     WHERE singleton = true;
    UPDATE deviludo.workflow_instances
       SET state = 'DESIGNING', version = version + 1,
           development_actor_id = (p_payload->>'requestedByActorId')::uuid,
           updated_at = clock_timestamp()
     WHERE workspace_id = workflow.workspace_id AND id = workflow.id;
    PERFORM deviludo.enqueue_job(
      workflow.workspace_id, workflow.id, workflow.project_id, 'AGENT_TURN', NULL,
      workflow.id::text || ':agent',
      jsonb_build_object('role', 'DESIGN', 'purpose', 'DESIGN')
      || CASE WHEN agent_settings.singleton IS NULL THEN '{}'::jsonb ELSE jsonb_build_object(
        'agentConfiguration', jsonb_build_object(
          'runtime', agent_settings.agent_runtime::text,
          'baseUrl', agent_settings.base_url,
          'model', coalesce(agent_settings.model_overrides->>'design', agent_settings.primary_model),
          'credentialRef', agent_settings.credential_secret_ref,
          'revision', agent_settings.revision
        )
      ) END
    );
  ELSIF p_signal_kind = 'STAGE_RERUN_REQUESTED' THEN
    -- Rerunning a stage invalidates everything downstream of it: those results
    -- were derived from inputs this rerun is about to replace. Supersede the
    -- selected stage and every later stage, then enqueue only the selected
    -- stage; complete_job walks the chain forward from there as usual.
    downstream_stages := stage_list[stage_index:array_length(stage_list, 1)];
    UPDATE deviludo.jobs
       SET state = 'CANCELLED',
           lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
           heartbeat_at = NULL, fencing_token = fencing_token + 1,
           last_error = 'superseded by stage rerun from ' || rerun_stage::text,
           updated_at = clock_timestamp()
     WHERE workspace_id = workflow.workspace_id AND workflow_id = workflow.id
       AND kind = ANY(downstream_stages)
       AND state IN ('QUEUED', 'RETRY', 'RUNNING');
    UPDATE deviludo.agent_turns turn_row
       SET state = 'CANCELLED', lease_token = NULL,
           mcp_token_hash = NULL, mcp_token_expires_at = NULL,
           completed_at = clock_timestamp(),
           output_summary = 'superseded by stage rerun from ' || rerun_stage::text
      FROM deviludo.jobs job
     WHERE turn_row.workspace_id = workflow.workspace_id
       AND turn_row.project_id = workflow.project_id
       AND turn_row.state = 'RUNNING'
       AND job.workspace_id = turn_row.workspace_id
       AND job.workflow_id = workflow.id
       AND turn_row.output_summary = 'workflow-job:' || job.id::text
       AND job.state = 'CANCELLED';
    UPDATE deviludo.agent_sessions session
       SET active_turn_id = NULL, updated_at = clock_timestamp()
     WHERE session.workspace_id = workflow.workspace_id
       AND session.project_id = workflow.project_id
       AND session.active_turn_id IS NOT NULL
       AND EXISTS (
         SELECT 1
           FROM deviludo.agent_turns turn_row
           JOIN deviludo.jobs job
             ON job.workspace_id = turn_row.workspace_id
            AND turn_row.output_summary = 'workflow-job:' || job.id::text
          WHERE turn_row.workspace_id = session.workspace_id
            AND turn_row.id = session.active_turn_id
            AND job.workflow_id = workflow.id
            AND job.state = 'CANCELLED'
       );
    IF rerun_stage = 'E2E_PLATFORM_RUN' THEN
      SELECT EXISTS (
        SELECT 1
          FROM deviludo.test_plans_v2 plan
         WHERE plan.workspace_id = workflow.workspace_id
           AND plan.project_id = workflow.project_id
           AND plan.source_revision = (
             SELECT source.revision
               FROM deviludo.project_source_revisions source
              WHERE source.workspace_id = workflow.workspace_id
                AND source.project_id = workflow.project_id
              ORDER BY source.revision DESC
              LIMIT 1
           )
      ) INTO current_test_plan_available;
    END IF;
    UPDATE deviludo.workflow_instances
           SET state = CASE
             WHEN rerun_stage = 'E2E_PLATFORM_RUN' AND NOT current_test_plan_available
               THEN 'TEST_PLANNING'::deviludo.workflow_state
             WHEN rerun_stage = 'AGENT_TURN'
               THEN CASE rerun_agent_role
                 WHEN 'DESIGN' THEN 'DESIGNING'::deviludo.workflow_state
                 WHEN 'UI_DESIGN' THEN 'UI_DESIGNING'::deviludo.workflow_state
                 ELSE 'DEVELOPING'::deviludo.workflow_state
               END
             ELSE deviludo.stage_running_state(rerun_stage)
           END,
           version = version + 1,
           development_actor_id = (p_payload->>'requestedByActorId')::uuid,
           updated_at = clock_timestamp()
     WHERE workspace_id = workflow.workspace_id AND id = workflow.id;
    IF rerun_stage = 'E2E_PLATFORM_RUN' AND NOT current_test_plan_available THEN
      -- A platform run is defined by the current-source Test Agent plan. If
      -- that prerequisite is missing, regenerate it and let the normal Test
      -- Agent completion path fan out the platform jobs.
      PERFORM deviludo.enqueue_job(
        workflow.workspace_id, workflow.id, workflow.project_id, 'AGENT_TURN', NULL,
        workflow.id::text || ':rerun:test-plan:' || inserted_id::text,
        jsonb_build_object('role', 'TEST', 'purpose', 'TEST_PLAN', 'manualRerun', true)
      );
    ELSIF rerun_stage = 'E2E_PLATFORM_RUN' THEN
      -- Per-platform stages always rerun on every target platform. Skipping
      -- platforms that previously succeeded would leave results tied to the
      -- superseded upstream artifact.
      FOREACH platform IN ARRAY workflow.target_platforms
      LOOP
        PERFORM deviludo.enqueue_job(
          workflow.workspace_id, workflow.id, workflow.project_id, rerun_stage, platform,
          workflow.id::text || ':rerun:' || rerun_stage::text || ':' || platform::text
            || ':' || inserted_id::text
        );
      END LOOP;
    ELSIF rerun_stage = 'AGENT_TURN' THEN
      PERFORM deviludo.enqueue_job(
        workflow.workspace_id, workflow.id, workflow.project_id, 'AGENT_TURN', NULL,
        workflow.id::text || ':rerun:agent:' || inserted_id::text,
        jsonb_build_object(
          'role', rerun_agent_role,
          'purpose', rerun_agent_role,
          'manualRerun', true,
          'agentConfiguration', jsonb_build_object(
            'runtime', agent_settings.agent_runtime::text,
            'baseUrl', agent_settings.base_url,
            'model', coalesce(agent_settings.model_overrides->>(CASE rerun_agent_role
              WHEN 'DESIGN' THEN 'design'
              WHEN 'UI_DESIGN' THEN 'uiDesign'
              ELSE 'development'
            END), agent_settings.primary_model),
            'credentialRef', agent_settings.credential_secret_ref,
            'revision', agent_settings.revision
          )
        ) || CASE WHEN repair_e2e_job_id IS NOT NULL THEN jsonb_build_object(
          'repairFromE2eJobId', repair_e2e_job_id,
          'failedPlatform', repair_e2e_platform
        ) WHEN repair_build_job_id IS NOT NULL THEN jsonb_build_object(
          'repairFailureJobId', repair_build_job_id,
          'repairFailureKind', 'BUILD',
          'repairFailureSummary', repair_build_summary
        ) ELSE '{}'::jsonb END
      );
    ELSE
      PERFORM deviludo.enqueue_job(
        workflow.workspace_id, workflow.id, workflow.project_id, rerun_stage, NULL,
        workflow.id::text || ':rerun:' || rerun_stage::text || ':' || inserted_id::text,
        CASE WHEN rerun_stage = 'STEAM_PUBLISH' THEN (
          SELECT jsonb_build_object(
            'targetPlatforms', workflow.target_platforms,
            'steamRelease', jsonb_build_object(
              'releaseId', release.id,
              'version', release.version,
              'releaseNumber', release.release_number,
              'channel', release.channel,
              'targetBranch', release.target_branch,
              'appId', release.app_id,
              'depots', jsonb_build_object(
                'linux', release.depot_linux,
                'windows', release.depot_windows,
                'macos', release.depot_macos
              ),
              'builderUsername', release.builder_username,
              'credentialRef', release.credential_secret_ref
            )
          )
          FROM deviludo.steam_releases release
          WHERE release.workspace_id = workflow.workspace_id
            AND release.workflow_id = workflow.id
        ) ELSE jsonb_build_object('targetPlatforms', workflow.target_platforms) END
      );
      IF rerun_stage = 'STEAM_PUBLISH' THEN
        UPDATE deviludo.steam_releases SET state = 'UPLOADING', failure_message = NULL,
          updated_at = clock_timestamp()
         WHERE workspace_id = workflow.workspace_id AND workflow_id = workflow.id;
      END IF;
    END IF;
  ELSIF p_signal_kind = 'RELEASE_APPROVED' THEN
    UPDATE deviludo.workflow_instances
       SET state = 'STEAM_PUBLISHING', version = version + 1,
           updated_at = clock_timestamp()
     WHERE workspace_id = workflow.workspace_id AND id = workflow.id
       AND state = 'RELEASE_APPROVAL_PENDING';
    PERFORM deviludo.enqueue_job(
      workflow.workspace_id, workflow.id, workflow.project_id, 'STEAM_PUBLISH', NULL,
      workflow.id::text || ':publish:approved:' || inserted_id::text,
      jsonb_build_object(
        'targetPlatforms', workflow.target_platforms,
        'approvalSignalId', inserted_id,
        'approvedByActorId', p_payload->>'requestedByActorId',
        'steamRelease', jsonb_build_object(
          'releaseId', steam_release.id,
          'version', steam_release.version,
          'releaseNumber', steam_release.release_number,
          'channel', steam_release.channel,
          'targetBranch', steam_release.target_branch,
          'appId', steam_release.app_id,
          'depots', jsonb_build_object(
            'linux', steam_release.depot_linux,
            'windows', steam_release.depot_windows,
            'macos', steam_release.depot_macos
          ),
          'builderUsername', steam_release.builder_username,
          'credentialRef', steam_release.credential_secret_ref
        )
      )
    );
  ELSIF p_signal_kind = 'RELEASE_SKIPPED' THEN
    UPDATE deviludo.workflow_instances
       SET state = 'SUCCEEDED', version = version + 1, updated_at = clock_timestamp()
     WHERE workspace_id = workflow.workspace_id AND id = workflow.id
       AND state = 'RELEASE_APPROVAL_PENDING';
  ELSIF p_signal_kind = 'CANCEL_REQUESTED' THEN
    UPDATE deviludo.workflow_instances
       SET state = 'CANCELLED', version = version + 1, updated_at = clock_timestamp()
     WHERE workspace_id = workflow.workspace_id AND id = workflow.id
       AND state NOT IN ('SUCCEEDED', 'FAILED', 'CANCELLED');
    UPDATE deviludo.jobs
       SET state = 'CANCELLED',
           lease_owner = NULL,
           lease_token = NULL,
           lease_expires_at = NULL,
           heartbeat_at = NULL,
           fencing_token = fencing_token + 1,
           updated_at = clock_timestamp()
     WHERE workspace_id = workflow.workspace_id AND workflow_id = workflow.id
       AND state IN ('QUEUED', 'RETRY', 'RUNNING');
    UPDATE deviludo.agent_turns turn_row
       SET state = 'CANCELLED', lease_token = NULL,
           mcp_token_hash = NULL, mcp_token_expires_at = NULL,
           completed_at = clock_timestamp(), output_summary = 'workflow cancelled'
      FROM deviludo.jobs job
     WHERE turn_row.workspace_id = workflow.workspace_id
       AND turn_row.project_id = workflow.project_id
       AND turn_row.state = 'RUNNING'
       AND job.workspace_id = turn_row.workspace_id
       AND job.workflow_id = workflow.id
       AND turn_row.output_summary = 'workflow-job:' || job.id::text
       AND job.state = 'CANCELLED';
    UPDATE deviludo.agent_sessions session
       SET active_turn_id = NULL, updated_at = clock_timestamp()
     WHERE session.workspace_id = workflow.workspace_id
       AND session.project_id = workflow.project_id
       AND session.active_turn_id IS NOT NULL
       AND EXISTS (
         SELECT 1
           FROM deviludo.agent_turns turn_row
           JOIN deviludo.jobs job
             ON job.workspace_id = turn_row.workspace_id
            AND turn_row.output_summary = 'workflow-job:' || job.id::text
          WHERE turn_row.workspace_id = session.workspace_id
            AND turn_row.id = session.active_turn_id
            AND job.workflow_id = workflow.id
            AND job.state = 'CANCELLED'
       );
  END IF;
  RETURN true;
END
$$;

CREATE OR REPLACE FUNCTION deviludo.start_steam_release(
  p_workflow_id uuid,
  p_release_id uuid,
  p_idempotency_key text,
  p_payload jsonb
)
RETURNS boolean
LANGUAGE sql
SECURITY INVOKER
SET search_path = pg_catalog, deviludo
AS $$
  SELECT deviludo.accept_workflow_signal(
    p_workflow_id, 'RELEASE_APPROVED', p_idempotency_key,
    p_payload || jsonb_build_object('releaseId', p_release_id)
  )
$$;

-- Stage reruns use one explicit entry point so an idle release-decision state
-- is treated like the other quiescent workflow states.
CREATE OR REPLACE FUNCTION deviludo.request_stage_rerun(
  p_workflow_id uuid,
  p_idempotency_key text,
  p_payload jsonb
)
RETURNS boolean
LANGUAGE sql
SECURITY INVOKER
SET search_path = pg_catalog, deviludo
AS $$
  SELECT deviludo.accept_workflow_signal(
    p_workflow_id, 'STAGE_RERUN_REQUESTED', p_idempotency_key, p_payload
  )
$$;

CREATE OR REPLACE FUNCTION deviludo.complete_workflow_iteration(
  p_workflow_id uuid,
  p_idempotency_key text,
  p_payload jsonb
)
RETURNS boolean
LANGUAGE sql
SECURITY INVOKER
SET search_path = pg_catalog, deviludo
AS $$
  SELECT deviludo.accept_workflow_signal(
    p_workflow_id, 'RELEASE_SKIPPED', p_idempotency_key, p_payload
  )
$$;

CREATE OR REPLACE FUNCTION deviludo.retry_steam_release(
  p_workflow_id uuid,
  p_idempotency_key text,
  p_payload jsonb
)
RETURNS boolean
LANGUAGE sql
SECURITY INVOKER
SET search_path = pg_catalog, deviludo
AS $$
  SELECT deviludo.accept_workflow_signal(
    p_workflow_id, 'STAGE_RERUN_REQUESTED', p_idempotency_key,
    p_payload || jsonb_build_object('stage', 'STEAM_PUBLISH')
  )
$$;

CREATE OR REPLACE FUNCTION deviludo.complete_job(
  p_job_id uuid,
  p_lease_token uuid,
  p_fencing_token bigint,
  p_isolation_generation bigint,
  p_receipt jsonb,
  p_executor_receipt jsonb,
  p_before_reimage_proof text,
  p_cleanup_proof text,
  p_after_reimage_proof text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, deviludo
AS $$
DECLARE
  job deviludo.jobs%ROWTYPE;
  workflow deviludo.workflow_instances%ROWTYPE;
  output jsonb;
  artifact_id uuid;
  platform deviludo.server_os;
  v_plan_id uuid;
  outcome text;
  failure_class text;
BEGIN
  SELECT * INTO job FROM deviludo.jobs
   WHERE id = p_job_id AND state = 'RUNNING'
     AND lease_token = p_lease_token AND fencing_token = p_fencing_token
     AND isolation_generation = p_isolation_generation;
  IF job.id IS NULL THEN RETURN false; END IF;
  IF job.kind = 'AGENT_TURN' THEN
    RAISE EXCEPTION 'AGENT_TURN must be settled by the persistent Project Runtime';
  END IF;
  SELECT * INTO workflow FROM deviludo.workflow_instances
   WHERE workspace_id = job.workspace_id AND id = job.workflow_id FOR UPDATE;
  SELECT * INTO job FROM deviludo.jobs
   WHERE workspace_id = workflow.workspace_id AND id = p_job_id
     AND state = 'RUNNING' AND lease_token = p_lease_token
     AND fencing_token = p_fencing_token
     AND isolation_generation = p_isolation_generation FOR UPDATE;
  IF job.id IS NULL THEN RETURN false; END IF;
  IF p_executor_receipt->>'schemaVersion' <> 'deviludo.executor-receipt.v2'
    OR coalesce(p_executor_receipt->>'simulated', 'true') <> 'false'
    OR length(coalesce(p_executor_receipt->>'signature', '')) < 32
    OR jsonb_typeof(p_executor_receipt->'outputObjects') <> 'array'
  THEN RAISE EXCEPTION 'verified executor receipt v2 is required'; END IF;
  IF job.exclusive AND (
    length(coalesce(p_before_reimage_proof, '')) < 16
    OR length(coalesce(p_cleanup_proof, '')) < 16
    OR length(coalesce(p_after_reimage_proof, '')) < 16
  ) THEN RAISE EXCEPTION 'trusted reimage and cleanup proofs are required'; END IF;

  IF job.kind = 'E2E_PLATFORM_RUN' THEN
    outcome := upper(coalesce(p_receipt #>> '{execution,outcome}', ''));
    failure_class := upper(coalesce(p_receipt #>> '{execution,failureDomain}',
      CASE outcome WHEN 'PASSED' THEN 'PRODUCT' ELSE '' END));
    IF outcome NOT IN ('PASSED', 'FAILED')
      OR (outcome = 'FAILED' AND failure_class NOT IN ('PRODUCT', 'CONFIGURATION'))
      OR length(coalesce(p_receipt #>> '{execution,summary}', '')) NOT BETWEEN 1 AND 2000
      OR coalesce(job.payload->>'testPlanDigest', '') !~ '^sha256:[0-9a-f]{64}$'
      OR coalesce(job.payload->>'sourceDigest', '') !~ '^sha256:[0-9a-f]{64}$'
    THEN RAISE EXCEPTION 'classified platform evidence for the frozen plan is required'; END IF;
    v_plan_id := (job.payload->>'testPlanId')::uuid;
    IF NOT EXISTS (
      SELECT 1 FROM deviludo.test_plans_v2 plan
       WHERE plan.workspace_id = job.workspace_id AND plan.id = v_plan_id
         AND plan.project_id = job.project_id
         AND plan.source_revision = (job.payload->>'sourceRevision')::bigint
         AND plan.plan_revision = (job.payload->>'testPlanRevision')::bigint
         AND plan.plan_sha256 = job.payload->>'testPlanDigest'
    ) THEN RAISE EXCEPTION 'platform result does not match the current frozen plan'; END IF;
  END IF;

  INSERT INTO deviludo.executor_receipts(
    workspace_id, project_id, workflow_id, job_id, executor_id,
    isolation_generation, fencing_token, receipt, signature
  ) VALUES (
    job.workspace_id, job.project_id, job.workflow_id, job.id,
    p_executor_receipt->>'executorId', job.isolation_generation, job.fencing_token,
    p_executor_receipt, p_executor_receipt->>'signature'
  );

  FOR output IN SELECT value FROM jsonb_array_elements(p_executor_receipt->'outputObjects') LOOP
    INSERT INTO deviludo.artifacts(
      workspace_id, project_id, workflow_id, producing_job_id, kind,
      target_platform, bucket, object_key, sha256, size_bytes, metadata
    ) VALUES (
      job.workspace_id, job.project_id, job.workflow_id, job.id,
      (output->>'kind')::deviludo.artifact_kind,
      nullif(output->>'targetPlatform', '')::deviludo.server_os,
      output->>'bucket', output->>'key', output->>'sha256',
      (output->>'sizeBytes')::bigint, coalesce(output->'metadata', '{}'::jsonb)
    ) RETURNING id INTO artifact_id;
  END LOOP;

  UPDATE deviludo.jobs SET state = 'SUCCEEDED', receipt = p_receipt, last_error = NULL,
      before_reimage_proof = p_before_reimage_proof,
      cleanup_proof = p_cleanup_proof,
      after_reimage_proof = p_after_reimage_proof,
      lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
      heartbeat_at = NULL, updated_at = clock_timestamp()
   WHERE workspace_id = job.workspace_id AND id = job.id;
  UPDATE deviludo.operation_receipts SET state = 'RECEIPTED', receipt = p_receipt,
      updated_at = clock_timestamp()
   WHERE workspace_id = job.workspace_id AND job_id = job.id
     AND state IN ('REGISTERED', 'IN_PROGRESS');
  INSERT INTO deviludo.workflow_events(
    workspace_id, workflow_id, event_kind, event_data, idempotency_key
  ) VALUES (
    job.workspace_id, job.workflow_id, 'JOB_SUCCEEDED',
    jsonb_build_object('jobId', job.id, 'jobKind', job.kind,
      'operatingSystem', job.target_operating_system),
    'job-succeeded:' || job.id::text
  ) ON CONFLICT (workspace_id, workflow_id, idempotency_key) DO NOTHING;

  IF job.kind = 'BUILD' THEN
    UPDATE deviludo.workflow_instances SET state = 'TEST_PLANNING', version = version + 1,
      updated_at = clock_timestamp()
     WHERE workspace_id = workflow.workspace_id AND id = workflow.id
       AND state = 'BUILDING'
       AND NOT EXISTS (
         SELECT 1
           FROM deviludo.jobs active_build
          WHERE active_build.workspace_id = job.workspace_id
            AND active_build.workflow_id = job.workflow_id
            AND active_build.kind = 'BUILD'
            AND active_build.id <> job.id
            AND active_build.state IN ('QUEUED', 'RUNNING', 'RETRY')
       );
    IF FOUND THEN
      PERFORM deviludo.enqueue_job(job.workspace_id, job.workflow_id, job.project_id,
        'AGENT_TURN', NULL, job.workflow_id::text || ':test-plan:after:' || job.id::text,
        jsonb_build_object('role', 'TEST', 'purpose', 'TEST_PLAN'));
    END IF;
  ELSIF job.kind = 'E2E_PLATFORM_RUN' THEN
    INSERT INTO deviludo.platform_test_runs(
      workspace_id, project_id, plan_id, source_revision, target_platform,
      state, failure_class, deterministic_result, evidence_summary, verdict,
      started_at, completed_at
    ) VALUES (
      job.workspace_id, job.project_id, v_plan_id,
      (job.payload->>'sourceRevision')::bigint, job.target_operating_system,
      'SUCCEEDED', CASE WHEN outcome = 'FAILED' THEN failure_class ELSE NULL END,
      coalesce(p_receipt->'execution', '{}'::jsonb),
      jsonb_build_object('summary', p_receipt #>> '{execution,summary}',
        'outputObjects', p_executor_receipt->'outputObjects'),
      CASE outcome WHEN 'PASSED' THEN 'PASS' ELSE 'FAIL' END,
      coalesce((p_receipt #>> '{execution,startedAt}')::timestamptz, job.created_at),
      clock_timestamp()
    ) ON CONFLICT (workspace_id, plan_id, target_platform) DO UPDATE
      SET source_revision = EXCLUDED.source_revision, state = EXCLUDED.state,
          failure_class = EXCLUDED.failure_class,
          deterministic_result = EXCLUDED.deterministic_result,
          evidence_summary = EXCLUDED.evidence_summary, verdict = EXCLUDED.verdict,
          started_at = EXCLUDED.started_at, completed_at = EXCLUDED.completed_at;
    INSERT INTO deviludo.test_evidence(
      workspace_id, project_id, platform_run_id, kind,
      bucket, object_key, sha256, size_bytes, summary
    )
    SELECT job.workspace_id, job.project_id, run.id,
           CASE item->>'kind' WHEN 'E2E_REGRESSION' THEN 'INPUT_RESPONSE' ELSE 'PROBE' END,
           item->>'bucket', item->>'key', item->>'sha256', (item->>'sizeBytes')::bigint,
           coalesce(item->'metadata', '{}'::jsonb)
      FROM deviludo.platform_test_runs run,
           jsonb_array_elements(p_executor_receipt->'outputObjects') item
     WHERE run.workspace_id = job.workspace_id AND run.plan_id = v_plan_id
       AND run.target_platform = job.target_operating_system;
    IF NOT EXISTS (
      SELECT 1 FROM unnest(workflow.target_platforms) required(target_platform)
       WHERE NOT EXISTS (
         SELECT 1 FROM deviludo.platform_test_runs run
          WHERE run.workspace_id = job.workspace_id AND run.plan_id = v_plan_id
            AND run.target_platform = required.target_platform
            AND run.state = 'SUCCEEDED'
       )
    ) THEN
      UPDATE deviludo.workflow_instances SET state = 'TEST_PLANNING', version = version + 1,
        updated_at = clock_timestamp()
       WHERE workspace_id = workflow.workspace_id AND id = workflow.id;
      PERFORM deviludo.enqueue_job(job.workspace_id, job.workflow_id, job.project_id,
        'AGENT_TURN', NULL,
        job.workflow_id::text || ':test-verdict:e2e:' || job.id::text,
        jsonb_build_object('role', 'TEST', 'purpose', 'TEST_VERDICT',
          'testPlanId', v_plan_id));
    END IF;
  ELSIF job.kind = 'STEAM_PUBLISH' THEN
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
      updated_at = clock_timestamp()
     WHERE workspace_id = workflow.workspace_id AND id = workflow.id;
  END IF;
  RETURN true;
END
$$;

CREATE OR REPLACE FUNCTION deviludo.fail_job(
  p_job_id uuid,
  p_lease_token uuid,
  p_fencing_token bigint,
  p_reason text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, deviludo
AS $$
DECLARE
  job deviludo.jobs%ROWTYPE;
  workflow deviludo.workflow_instances%ROWTYPE;
  product_failure boolean;
  configuration_failure boolean;
  attempts_exhausted boolean;
BEGIN
  SELECT * INTO job FROM deviludo.jobs
   WHERE id = p_job_id AND state = 'RUNNING'
     AND lease_token = p_lease_token AND fencing_token = p_fencing_token;
  IF job.id IS NULL THEN RETURN false; END IF;
  SELECT * INTO workflow FROM deviludo.workflow_instances
   WHERE workspace_id = job.workspace_id AND id = job.workflow_id FOR UPDATE;
  SELECT * INTO job FROM deviludo.jobs
   WHERE workspace_id = workflow.workspace_id AND id = p_job_id
     AND state = 'RUNNING' AND lease_token = p_lease_token
     AND fencing_token = p_fencing_token FOR UPDATE;
  IF job.id IS NULL THEN RETURN false; END IF;
  product_failure := job.kind = 'BUILD' AND position('BUILD_PRODUCT:' IN p_reason) > 0;
  configuration_failure := position('CONFIGURATION:' IN p_reason) > 0
    OR position('CREDENTIAL:' IN p_reason) > 0;
  attempts_exhausted := job.attempt >= job.max_attempts;

  UPDATE deviludo.jobs SET
      state = CASE WHEN product_failure OR configuration_failure OR attempts_exhausted OR job.kind = 'STEAM_PUBLISH'
                   THEN 'FAILED'::deviludo.job_state ELSE 'RETRY'::deviludo.job_state END,
      available_at = clock_timestamp() + interval '15 seconds',
      lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
      heartbeat_at = NULL, last_error = left(p_reason, 2000),
      updated_at = clock_timestamp()
   WHERE workspace_id = job.workspace_id AND id = job.id;
  INSERT INTO deviludo.workflow_events(workspace_id, workflow_id, event_kind, event_data, idempotency_key)
  VALUES (job.workspace_id, job.workflow_id,
    CASE WHEN product_failure OR configuration_failure OR attempts_exhausted OR job.kind = 'STEAM_PUBLISH'
      THEN 'JOB_FAILED' ELSE 'JOB_RETRY_SCHEDULED' END,
    jsonb_build_object('jobId', job.id, 'attempt', job.attempt,
      'reason', left(p_reason, 2000)),
    'job-failure:' || job.id::text || ':' || job.attempt::text)
  ON CONFLICT (workspace_id, workflow_id, idempotency_key) DO NOTHING;

  IF product_failure THEN
    UPDATE deviludo.workflow_instances SET state = 'DEVELOPING', version = version + 1,
      updated_at = clock_timestamp()
     WHERE workspace_id = workflow.workspace_id AND id = workflow.id;
    PERFORM deviludo.enqueue_job(job.workspace_id, job.workflow_id, job.project_id,
      'AGENT_TURN', NULL, job.workflow_id::text || ':development:build-handoff:' || job.id::text,
      jsonb_build_object('role', 'DEVELOPMENT', 'purpose', 'DEVELOPMENT',
        'buildFailureJobId', job.id, 'buildFailureSummary', left(p_reason, 1800)));
  ELSIF configuration_failure THEN
    UPDATE deviludo.workflow_instances SET state = 'BLOCKED', version = version + 1,
      updated_at = clock_timestamp()
     WHERE workspace_id = workflow.workspace_id AND id = workflow.id;
  ELSIF job.kind = 'STEAM_PUBLISH' THEN
    UPDATE deviludo.steam_releases SET state = 'FAILED',
      failure_message = left(p_reason, 2000), updated_at = clock_timestamp()
     WHERE workspace_id = job.workspace_id
       AND id = (job.payload #>> '{steamRelease,releaseId}')::uuid;
    UPDATE deviludo.workflow_instances SET state = 'FAILED', version = version + 1,
      updated_at = clock_timestamp()
     WHERE workspace_id = workflow.workspace_id AND id = workflow.id;
  ELSIF attempts_exhausted THEN
    UPDATE deviludo.workflow_instances SET state = 'BLOCKED', version = version + 1,
      updated_at = clock_timestamp()
     WHERE workspace_id = workflow.workspace_id AND id = workflow.id
       AND state NOT IN ('SUCCEEDED', 'FAILED', 'CANCELLED', 'BLOCKED');
  END IF;
  RETURN true;
END
$$;

CREATE OR REPLACE FUNCTION deviludo.recover_expired_jobs()
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, deviludo
SET row_security = off
AS $$
DECLARE
  recovered bigint;
BEGIN
  WITH expired AS (
    UPDATE deviludo.jobs
       SET state = 'RETRY',
           available_at = clock_timestamp() + interval '15 seconds',
           lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
           heartbeat_at = NULL, last_error = 'lease expired',
           updated_at = clock_timestamp()
     WHERE state = 'RUNNING' AND lease_expires_at < clock_timestamp()
     RETURNING workspace_id, workflow_id, id, attempt
  ), events AS (
    INSERT INTO deviludo.workflow_events(
      workspace_id, workflow_id, event_kind, event_data, idempotency_key
    )
    SELECT workspace_id, workflow_id, 'JOB_RETRY_SCHEDULED',
      jsonb_build_object('jobId', id, 'attempt', attempt, 'reason', 'lease expired'),
      'lease-expired:' || id::text || ':' || attempt::text
      FROM expired
    ON CONFLICT (workspace_id, workflow_id, idempotency_key) DO NOTHING
  )
  SELECT count(*) INTO recovered FROM expired;
  RETURN recovered;
END
$$;
ALTER FUNCTION deviludo.recover_expired_jobs() OWNER TO deviludo_claim_executor;

CREATE OR REPLACE FUNCTION deviludo.reconcile_p0_capacity()
RETURNS void
LANGUAGE sql
SECURITY INVOKER
SET search_path = pg_catalog, deviludo
AS $$
  INSERT INTO deviludo.pool_capacity_intents(pool_kind, desired_nodes, reason, operation_key)
  SELECT pool.kind, pool.desired_nodes, 'P0_RECONCILIATION',
         'p0:' || pool.kind::text || ':' || pool.desired_nodes::text || ':'
           || extract(epoch FROM date_trunc('hour', clock_timestamp()))::text
    FROM deviludo.server_pools pool
   WHERE NOT EXISTS (
     SELECT 1 FROM deviludo.pool_capacity_intents intent
      WHERE intent.pool_kind = pool.kind
        AND intent.desired_nodes = pool.desired_nodes
        AND intent.created_at > clock_timestamp() - interval '1 hour'
   )
  ON CONFLICT (operation_key) DO NOTHING
$$;

CREATE OR REPLACE FUNCTION deviludo.reconcile_expired_uploads(p_limit integer)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, deviludo
SET row_security = off
AS $$
DECLARE enqueued integer;
BEGIN
  IF p_limit NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'invalid pending upload sweep'; END IF;
  WITH candidate AS (
    SELECT pending.workspace_id, pending.bucket, pending.object_key
      FROM deviludo.pending_object_uploads pending
      JOIN deviludo.jobs job ON job.workspace_id = pending.workspace_id AND job.id = pending.job_id
     WHERE pending.cleanup_after <= clock_timestamp()
       AND job.state IN ('SUCCEEDED', 'FAILED', 'CANCELLED')
       AND NOT EXISTS (
         SELECT 1 FROM deviludo.artifacts artifact
          WHERE artifact.workspace_id = pending.workspace_id
            AND artifact.bucket = pending.bucket AND artifact.object_key = pending.object_key
       )
     ORDER BY pending.cleanup_after, pending.created_at
     FOR UPDATE OF pending SKIP LOCKED LIMIT p_limit
  ), queued AS (
    INSERT INTO deviludo.object_cleanup_queue(workspace_id, bucket, object_key, reason)
    SELECT workspace_id, bucket, object_key, 'authorized upload did not become an artifact' FROM candidate
    ON CONFLICT (workspace_id, bucket, object_key) DO NOTHING
  ), removed AS (
    DELETE FROM deviludo.pending_object_uploads pending USING candidate
     WHERE pending.workspace_id = candidate.workspace_id AND pending.bucket = candidate.bucket
       AND pending.object_key = candidate.object_key
    RETURNING pending.workspace_id
  ) SELECT count(*)::integer INTO enqueued FROM removed;
  RETURN enqueued;
END
$$;
ALTER FUNCTION deviludo.reconcile_expired_uploads(integer) OWNER TO deviludo_claim_executor;
REVOKE ALL ON FUNCTION deviludo.reconcile_expired_uploads(integer) FROM PUBLIC;

CREATE OR REPLACE FUNCTION deviludo.claim_object_cleanup(p_lease_seconds integer)
RETURNS TABLE (
  "workspaceId" uuid,
  bucket text,
  "objectKey" text,
  "leaseToken" uuid,
  attempt integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, deviludo
SET row_security = off
AS $$
BEGIN
  IF p_lease_seconds NOT BETWEEN 30 AND 600 THEN
    RAISE EXCEPTION 'invalid object cleanup lease';
  END IF;
  RETURN QUERY
  WITH candidate AS (
    SELECT queue.workspace_id, queue.bucket, queue.object_key
      FROM deviludo.object_cleanup_queue queue
     WHERE queue.attempts < 10 AND queue.available_at <= clock_timestamp()
       AND (queue.lease_token IS NULL OR queue.lease_expires_at <= clock_timestamp())
     ORDER BY queue.available_at, queue.created_at
     FOR UPDATE SKIP LOCKED
     LIMIT 1
  )
  UPDATE deviludo.object_cleanup_queue queue
     SET attempts = queue.attempts + 1,
         lease_token = gen_random_uuid(),
         lease_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds),
         last_error = NULL
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
  UPDATE deviludo.artifacts
     SET state = 'DELETED'
   WHERE workspace_id = p_workspace_id AND bucket = p_bucket AND object_key = p_object_key
     AND state = 'DELETING'
     AND EXISTS (
       SELECT 1 FROM deviludo.object_cleanup_queue queue
        WHERE queue.workspace_id = p_workspace_id AND queue.bucket = p_bucket
          AND queue.object_key = p_object_key AND queue.lease_token = p_lease_token
          AND queue.lease_expires_at > clock_timestamp()
     );
  DELETE FROM deviludo.object_cleanup_queue
   WHERE workspace_id = p_workspace_id AND bucket = p_bucket AND object_key = p_object_key
     AND lease_token = p_lease_token AND lease_expires_at > clock_timestamp();
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed = 1;
END
$$;
ALTER FUNCTION deviludo.complete_object_cleanup(uuid, text, text, uuid) OWNER TO deviludo_claim_executor;

CREATE OR REPLACE FUNCTION deviludo.enqueue_expired_artifacts(
  p_retention_days integer, p_limit integer
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, deviludo
SET row_security = off
AS $$
DECLARE enqueued integer;
BEGIN
  IF p_retention_days NOT BETWEEN 1 AND 3650 OR p_limit NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'invalid artifact retention sweep';
  END IF;
  WITH candidate AS (
    SELECT artifact.workspace_id, artifact.id, artifact.bucket, artifact.object_key
      FROM deviludo.artifacts artifact
     WHERE artifact.state = 'AVAILABLE'
       AND artifact.kind IN ('BUILD', 'E2E_REPORT', 'SIGNED_BUILD', 'PUBLISH_RECEIPT', 'CLEAN_INSTALL_REPORT')
       AND artifact.created_at < clock_timestamp() - make_interval(days => p_retention_days)
       AND NOT EXISTS (
         SELECT 1 FROM deviludo.artifact_inputs input
         JOIN deviludo.jobs job ON job.workspace_id = input.workspace_id AND job.id = input.job_id
          WHERE input.workspace_id = artifact.workspace_id AND input.artifact_id = artifact.id
            AND job.state IN ('QUEUED', 'RUNNING', 'RETRY')
       )
     ORDER BY artifact.created_at, artifact.id
     FOR UPDATE SKIP LOCKED LIMIT p_limit
  ), queued AS (
    INSERT INTO deviludo.object_cleanup_queue(workspace_id, bucket, object_key, reason)
    SELECT workspace_id, bucket, object_key, 'artifact retention expired' FROM candidate
    ON CONFLICT (workspace_id, bucket, object_key) DO NOTHING
  )
  UPDATE deviludo.artifacts artifact SET state = 'DELETING'
    FROM candidate
   WHERE artifact.workspace_id = candidate.workspace_id AND artifact.id = candidate.id;
  GET DIAGNOSTICS enqueued = ROW_COUNT;
  RETURN enqueued;
END
$$;
ALTER FUNCTION deviludo.enqueue_expired_artifacts(integer, integer) OWNER TO deviludo_claim_executor;

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

CREATE OR REPLACE FUNCTION deviludo.claim_project_cleanup(p_lease_seconds integer)
RETURNS TABLE ("workspaceId" uuid, "projectId" uuid, "leaseToken" uuid, attempt integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, deviludo
SET row_security = off
AS $$
BEGIN
  IF p_lease_seconds NOT BETWEEN 30 AND 600 THEN RAISE EXCEPTION 'invalid project cleanup lease'; END IF;
  RETURN QUERY
  WITH candidate AS (
    SELECT request.workspace_id, request.project_id
      FROM deviludo.project_cleanup_requests request
     WHERE request.attempts < 10 AND request.available_at <= clock_timestamp()
       AND (request.lease_token IS NULL OR request.lease_expires_at <= clock_timestamp())
     ORDER BY request.available_at, request.created_at
     FOR UPDATE SKIP LOCKED LIMIT 1
  )
  UPDATE deviludo.project_cleanup_requests request
     SET attempts = request.attempts + 1, lease_token = gen_random_uuid(),
         lease_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds), last_error = NULL
    FROM candidate
   WHERE request.workspace_id = candidate.workspace_id AND request.project_id = candidate.project_id
  RETURNING request.workspace_id, request.project_id, request.lease_token, request.attempts;
END
$$;
ALTER FUNCTION deviludo.claim_project_cleanup(integer) OWNER TO deviludo_claim_executor;

CREATE OR REPLACE FUNCTION deviludo.complete_project_cleanup(p_workspace_id uuid, p_project_id uuid, p_lease_token uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, deviludo
SET row_security = off
AS $$
DECLARE removed integer;
BEGIN
  DELETE FROM deviludo.project_cleanup_requests
   WHERE workspace_id = p_workspace_id AND project_id = p_project_id
     AND lease_token = p_lease_token AND lease_expires_at > clock_timestamp();
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed = 1;
END
$$;
ALTER FUNCTION deviludo.complete_project_cleanup(uuid, uuid, uuid) OWNER TO deviludo_claim_executor;

CREATE OR REPLACE FUNCTION deviludo.fail_project_cleanup(p_workspace_id uuid, p_project_id uuid, p_lease_token uuid, p_error text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, deviludo
SET row_security = off
AS $$
DECLARE updated integer;
BEGIN
  UPDATE deviludo.project_cleanup_requests
     SET lease_token = NULL, lease_expires_at = NULL,
         available_at = clock_timestamp() + make_interval(secs => least(3600, 15 * power(2, attempts)::integer)),
         last_error = left(p_error, 2000)
   WHERE workspace_id = p_workspace_id AND project_id = p_project_id AND lease_token = p_lease_token;
  GET DIAGNOSTICS updated = ROW_COUNT;
  RETURN updated = 1;
END
$$;
ALTER FUNCTION deviludo.fail_project_cleanup(uuid, uuid, uuid, text) OWNER TO deviludo_claim_executor;

CREATE OR REPLACE FUNCTION deviludo.reconcile_host_admission_events()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, deviludo
SET row_security = off
AS $$
DECLARE inserted integer;
BEGIN
  INSERT INTO deviludo.host_admission_events(
    workspace_id, job_id, reservation_id, action, actual_units
  )
  SELECT job.workspace_id,
         job.id,
         job.payload->>'hostAdmissionReservationId',
         CASE WHEN job.state = 'SUCCEEDED' THEN 'SETTLE' ELSE 'CANCEL' END,
         CASE WHEN job.state = 'SUCCEEDED' THEN
           least(
             (job.payload->>'hostAdmissionReservedUnits')::integer,
             greatest(1, ceil(extract(epoch FROM (
               job.updated_at - (job.payload->>'hostAdmissionStartedAt')::timestamptz
             )))
           ))::integer
         ELSE NULL END
    FROM deviludo.jobs job
   WHERE job.state IN ('SUCCEEDED', 'FAILED', 'CANCELLED')
     AND length(coalesce(job.payload->>'hostAdmissionReservationId', '')) BETWEEN 1 AND 2000
     AND pg_input_is_valid(job.payload->>'hostAdmissionStartedAt', 'timestamptz')
     AND pg_input_is_valid(job.payload->>'hostAdmissionReservedUnits', 'integer')
     AND (job.payload->>'hostAdmissionReservedUnits')::integer BETWEEN 1 AND 86400
     AND job.updated_at >= (job.payload->>'hostAdmissionStartedAt')::timestamptz
  ON CONFLICT (workspace_id, reservation_id) DO NOTHING;
  GET DIAGNOSTICS inserted = ROW_COUNT;
  RETURN inserted;
END
$$;
ALTER FUNCTION deviludo.reconcile_host_admission_events() OWNER TO deviludo_claim_executor;
REVOKE ALL ON FUNCTION deviludo.reconcile_host_admission_events() FROM PUBLIC;

CREATE OR REPLACE FUNCTION deviludo.claim_host_admission_event(p_lease_seconds integer)
RETURNS TABLE (
  "workspaceId" uuid,
  "eventId" uuid,
  "reservationId" text,
  action text,
  "actualUnits" integer,
  "leaseToken" uuid,
  attempt integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, deviludo
SET row_security = off
AS $$
BEGIN
  IF p_lease_seconds NOT BETWEEN 30 AND 600 THEN
    RAISE EXCEPTION 'invalid host admission lease';
  END IF;
  RETURN QUERY
  WITH candidate AS (
    SELECT event.workspace_id, event.id
      FROM deviludo.host_admission_events event
     WHERE event.attempts < 20
       AND event.available_at <= clock_timestamp()
       AND (
         (event.state IN ('PENDING', 'FAILED')
           AND (event.lease_token IS NULL OR event.lease_expires_at <= clock_timestamp()))
         OR (event.state = 'RUNNING' AND event.lease_expires_at <= clock_timestamp())
       )
     ORDER BY event.available_at, event.created_at
     FOR UPDATE SKIP LOCKED
     LIMIT 1
  )
  UPDATE deviludo.host_admission_events event
     SET state = 'RUNNING',
         attempts = event.attempts + 1,
         lease_token = gen_random_uuid(),
         lease_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds),
         last_error = NULL
    FROM candidate
   WHERE event.workspace_id = candidate.workspace_id AND event.id = candidate.id
  RETURNING event.workspace_id, event.id, event.reservation_id, event.action,
            event.actual_units, event.lease_token, event.attempts;
END
$$;
ALTER FUNCTION deviludo.claim_host_admission_event(integer) OWNER TO deviludo_claim_executor;
REVOKE ALL ON FUNCTION deviludo.claim_host_admission_event(integer) FROM PUBLIC;

CREATE OR REPLACE FUNCTION deviludo.complete_host_admission_event(
  p_workspace_id uuid, p_event_id uuid, p_lease_token uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, deviludo
SET row_security = off
AS $$
DECLARE updated integer;
BEGIN
  UPDATE deviludo.host_admission_events
     SET state = 'SUCCEEDED', lease_token = NULL, lease_expires_at = NULL,
         completed_at = clock_timestamp(), last_error = NULL
   WHERE workspace_id = p_workspace_id AND id = p_event_id
     AND state = 'RUNNING' AND lease_token = p_lease_token
     AND lease_expires_at > clock_timestamp();
  GET DIAGNOSTICS updated = ROW_COUNT;
  RETURN updated = 1;
END
$$;
ALTER FUNCTION deviludo.complete_host_admission_event(uuid, uuid, uuid) OWNER TO deviludo_claim_executor;
REVOKE ALL ON FUNCTION deviludo.complete_host_admission_event(uuid, uuid, uuid) FROM PUBLIC;

CREATE OR REPLACE FUNCTION deviludo.fail_host_admission_event(
  p_workspace_id uuid, p_event_id uuid, p_lease_token uuid, p_error text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, deviludo
SET row_security = off
AS $$
DECLARE updated integer;
BEGIN
  UPDATE deviludo.host_admission_events
     SET state = 'FAILED', lease_token = NULL, lease_expires_at = NULL,
         available_at = clock_timestamp() + make_interval(
           secs => least(3600, 15 * power(2, attempts)::integer)
         ),
         last_error = left(p_error, 2000)
   WHERE workspace_id = p_workspace_id AND id = p_event_id
     AND state = 'RUNNING' AND lease_token = p_lease_token;
  GET DIAGNOSTICS updated = ROW_COUNT;
  RETURN updated = 1;
END
$$;
ALTER FUNCTION deviludo.fail_host_admission_event(uuid, uuid, uuid, text) OWNER TO deviludo_claim_executor;
REVOKE ALL ON FUNCTION deviludo.fail_host_admission_event(uuid, uuid, uuid, text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION deviludo.cleanup_expired_executor_state()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, deviludo
SET row_security = off
AS $$
DECLARE
  removed integer := 0;
BEGIN
  DELETE FROM deviludo.e2e_enrollment_tokens
   WHERE expires_at < clock_timestamp() - interval '1 day'
      OR used_at < clock_timestamp() - interval '1 day';
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END
$$;
ALTER FUNCTION deviludo.cleanup_expired_executor_state() OWNER TO deviludo_claim_executor;


REVOKE ALL ON ALL TABLES IN SCHEMA deviludo FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA deviludo FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA deviludo FROM PUBLIC;

GRANT SELECT ON deviludo.server_pools, deviludo.server_nodes, deviludo.pool_capacity_intents
  TO deviludo_api, deviludo_scheduler;
GRANT SELECT, INSERT, UPDATE ON deviludo.executor_identities TO deviludo_api;
GRANT SELECT ON deviludo.executor_identities TO deviludo_sandbox;
GRANT SELECT, INSERT, UPDATE ON deviludo.runtime_images TO deviludo_api;
GRANT SELECT ON deviludo.runtime_images TO deviludo_scheduler, deviludo_sandbox;
GRANT INSERT, UPDATE ON deviludo.server_nodes TO deviludo_api;
GRANT SELECT, INSERT, UPDATE ON deviludo.e2e_enrollment_tokens, deviludo.e2e_node_certificates TO deviludo_api;
GRANT INSERT, SELECT ON deviludo.pool_capacity_intents TO deviludo_scheduler;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA deviludo TO
  deviludo_api, deviludo_scheduler, deviludo_sandbox, deviludo_conversation_writer;

GRANT SELECT ON deviludo.jobs, deviludo.projects,
  deviludo.implementation_change_requests, deviludo.project_conversations,
  deviludo.conversation_messages
  TO deviludo_conversation_writer;
GRANT INSERT ON deviludo.project_conversations, deviludo.conversation_messages
  TO deviludo_conversation_writer;
GRANT UPDATE ON deviludo.project_conversations TO deviludo_conversation_writer;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  deviludo.workspaces, deviludo.workspace_steam_settings,
  deviludo.projects, deviludo.project_steam_settings, deviludo.steam_releases,
  deviludo.project_source_revisions, deviludo.project_documents,
  deviludo.project_document_revisions, deviludo.project_conversations,
  deviludo.conversation_messages, deviludo.agent_installations,
  deviludo.implementation_change_requests, deviludo.workflow_e2e_goal_revisions,
  deviludo.workflow_instances, deviludo.workflow_events, deviludo.jobs,
  deviludo.external_signals, deviludo.job_progress_events,
  deviludo.operation_receipts,
  deviludo.artifacts, deviludo.artifact_inputs, deviludo.executor_receipts,
  deviludo.asset_manifests, deviludo.asset_items,
  deviludo.e2e_policy_locks, deviludo.e2e_policy_decisions, deviludo.e2e_regression_traces,
  deviludo.project_contexts, deviludo.agent_containers, deviludo.agent_sessions,
  deviludo.agent_turns, deviludo.agent_tool_calls, deviludo.role_handoffs, deviludo.test_plans_v2,
  deviludo.platform_test_runs, deviludo.test_evidence
  TO deviludo_api;
GRANT SELECT, INSERT, UPDATE ON deviludo.instance_agent_settings TO deviludo_api;
-- complete_job is SECURITY INVOKER. Agent settlement checks whether the selected
-- connection has an image model before it decides between asset preparation and
-- the Builder, so the sandbox role needs this narrow read as part of its commit.
GRANT SELECT ON deviludo.instance_agent_settings TO deviludo_scheduler, deviludo_sandbox;
-- The scheduler owns Runtime reconciliation and idle compaction. It needs the
-- same durable Runtime records used by a normal Turn, but it never receives an
-- MCP token and therefore cannot invoke role tools.
GRANT SELECT, INSERT, UPDATE ON
  deviludo.project_contexts, deviludo.agent_containers, deviludo.agent_sessions,
  deviludo.agent_turns, deviludo.agent_tool_calls, deviludo.role_handoffs,
  deviludo.test_plans_v2, deviludo.platform_test_runs, deviludo.test_evidence
  TO deviludo_scheduler;
-- enqueue_job freezes the active E2E goal revision while a sandbox-completed
-- build fans out the platform jobs.
GRANT SELECT ON deviludo.workflow_e2e_goal_revisions TO deviludo_scheduler, deviludo_sandbox;
-- complete_job queues replaced regression objects with ON CONFLICT DO NOTHING.
-- PostgreSQL requires SELECT on the conflict-key columns in addition to INSERT;
-- keep that read capability column-scoped instead of exposing cleanup details.
GRANT SELECT (workspace_id, bucket, object_key), INSERT ON deviludo.object_cleanup_queue
  TO deviludo_api, deviludo_sandbox;
GRANT SELECT, INSERT, UPDATE, DELETE ON deviludo.pending_object_uploads
  TO deviludo_api, deviludo_sandbox;
GRANT SELECT, INSERT ON deviludo.project_cleanup_requests TO deviludo_api;
GRANT SELECT, INSERT, DELETE ON deviludo.project_creation_receipts TO deviludo_api;
GRANT SELECT, INSERT, UPDATE ON
  deviludo.projects, deviludo.project_source_revisions,
  deviludo.project_documents, deviludo.project_document_revisions,
  deviludo.workflow_instances, deviludo.workflow_events, deviludo.jobs,
  deviludo.external_signals, deviludo.job_progress_events,
  deviludo.operation_receipts,
  deviludo.artifacts, deviludo.artifact_inputs, deviludo.executor_receipts
  TO deviludo_scheduler;
GRANT SELECT ON deviludo.e2e_regression_traces
  TO deviludo_scheduler, deviludo_sandbox, deviludo_claim_executor;
GRANT SELECT, UPDATE ON deviludo.steam_releases TO deviludo_scheduler;
-- The asset generator resolves the configured provider and credential ref through
-- an ordinary pooled read before calling out, so the scheduler reads this row
-- directly rather than through a definer function.
-- complete_job is SECURITY INVOKER and persistent Agent turns are completed by the
-- sandbox role, which checks whether automatic image generation is configured.
GRANT SELECT, INSERT, UPDATE ON
  deviludo.projects, deviludo.project_source_revisions,
  deviludo.project_documents, deviludo.project_document_revisions,
  deviludo.workflow_instances, deviludo.jobs, deviludo.workflow_events, deviludo.operation_receipts,
  deviludo.job_progress_events,
  deviludo.artifacts, deviludo.artifact_inputs, deviludo.executor_receipts,
  deviludo.asset_manifests, deviludo.asset_items,
  deviludo.implementation_change_requests,
  deviludo.project_contexts, deviludo.agent_containers, deviludo.agent_sessions,
  deviludo.agent_turns, deviludo.agent_tool_calls, deviludo.role_handoffs,
  deviludo.test_plans_v2, deviludo.platform_test_runs, deviludo.test_evidence
  TO deviludo_sandbox;
GRANT SELECT, UPDATE ON deviludo.steam_releases TO deviludo_sandbox;
-- complete_job runs with the caller's privileges and persistent Agent turns are
-- completed by the sandbox role. Re-planning a manifest drops the asset keys the
-- Agent no longer asks for, so that role needs DELETE on the items themselves —
-- and only those; the manifest row is never removed here.
GRANT DELETE ON deviludo.asset_items TO deviludo_sandbox;

GRANT EXECUTE ON FUNCTION deviludo.current_workspace_id() TO
  deviludo_api, deviludo_scheduler, deviludo_sandbox;
GRANT SELECT ON deviludo.project_creation_receipts TO deviludo_claim_executor;
GRANT SELECT, INSERT, UPDATE ON deviludo.host_source_events TO deviludo_claim_executor;
GRANT EXECUTE ON FUNCTION deviludo.pull_host_source_events(integer),
  deviludo.acknowledge_host_source_events(uuid[]) TO deviludo_api;
GRANT EXECUTE ON FUNCTION deviludo.required_capabilities(deviludo.job_kind) TO
  deviludo_api, deviludo_scheduler, deviludo_sandbox, deviludo_claim_executor;
GRANT EXECUTE ON FUNCTION deviludo.delivery_stages(deviludo.workflow_profile) TO
  deviludo_api, deviludo_scheduler, deviludo_sandbox, deviludo_claim_executor;
GRANT EXECUTE ON FUNCTION deviludo.stage_running_state(deviludo.job_kind) TO
  deviludo_api, deviludo_scheduler, deviludo_sandbox, deviludo_claim_executor;
GRANT EXECUTE ON FUNCTION deviludo.enqueue_job(
  uuid, uuid, uuid, deviludo.job_kind, deviludo.server_os, text, jsonb
) TO deviludo_api, deviludo_scheduler, deviludo_sandbox, deviludo_claim_executor;
GRANT EXECUTE ON FUNCTION deviludo.claim_job(text, deviludo.server_pool_kind, integer)
  TO deviludo_api, deviludo_sandbox;
GRANT EXECUTE ON FUNCTION deviludo.accept_workflow_signal(uuid, text, text, jsonb)
  TO deviludo_api;
GRANT EXECUTE ON FUNCTION deviludo.accept_workflow_signal(uuid, text, text, jsonb)
  TO deviludo_claim_executor;
GRANT EXECUTE ON FUNCTION deviludo.start_steam_release(uuid, uuid, text, jsonb),
  deviludo.complete_workflow_iteration(uuid, text, jsonb),
  deviludo.retry_steam_release(uuid, text, jsonb),
  deviludo.request_stage_rerun(uuid, text, jsonb)
  TO deviludo_api;
GRANT EXECUTE ON FUNCTION deviludo.complete_job(uuid, uuid, bigint, bigint, jsonb, jsonb, text, text, text)
  TO deviludo_api, deviludo_sandbox;
GRANT EXECUTE ON FUNCTION deviludo.complete_agent_turn_job(uuid, uuid, uuid, bigint, jsonb)
  TO deviludo_sandbox;
GRANT EXECUTE ON FUNCTION deviludo.publish_development_agent_message(uuid, uuid, text)
  TO deviludo_sandbox;
GRANT EXECUTE ON FUNCTION deviludo.fail_job(uuid, uuid, bigint, text)
  TO deviludo_api, deviludo_sandbox;
GRANT EXECUTE ON FUNCTION deviludo.recover_expired_jobs(), deviludo.reconcile_p0_capacity()
  TO deviludo_scheduler;
-- Asset generation is driven by the scheduler role: it is periodic background work
-- like the other scheduler tasks, not something an executor leases.
GRANT EXECUTE ON FUNCTION deviludo.claim_asset_generation(integer, integer) TO deviludo_scheduler;
GRANT EXECUTE ON FUNCTION deviludo.complete_asset_generation(uuid, uuid, uuid, text, text, text, bigint)
  TO deviludo_scheduler;
GRANT EXECUTE ON FUNCTION deviludo.fail_asset_generation(uuid, uuid, uuid, text) TO deviludo_scheduler;
GRANT EXECUTE ON FUNCTION deviludo.advance_asset_workflows(integer) TO deviludo_scheduler;
GRANT EXECUTE ON FUNCTION deviludo.request_asset_rerun(uuid, uuid, text, jsonb) TO deviludo_api;
GRANT EXECUTE ON FUNCTION deviludo.claim_project_import_analysis(integer) TO deviludo_api;
GRANT EXECUTE ON FUNCTION deviludo.claim_local_git_commit(integer),
  deviludo.complete_local_git_commit(uuid, uuid, uuid, text, text, text),
  deviludo.fail_local_git_commit(uuid, uuid, uuid, text)
  TO deviludo_scheduler;
GRANT EXECUTE ON FUNCTION deviludo.claim_object_cleanup(integer),
  deviludo.complete_object_cleanup(uuid, text, text, uuid),
  deviludo.fail_object_cleanup(uuid, text, text, uuid, text),
  deviludo.reconcile_expired_uploads(integer),
  deviludo.enqueue_expired_artifacts(integer, integer)
  TO deviludo_scheduler;
GRANT EXECUTE ON FUNCTION deviludo.claim_project_cleanup(integer),
  deviludo.complete_project_cleanup(uuid, uuid, uuid),
  deviludo.fail_project_cleanup(uuid, uuid, uuid, text)
  TO deviludo_scheduler;
GRANT EXECUTE ON FUNCTION deviludo.reconcile_host_admission_events(),
  deviludo.claim_host_admission_event(integer),
  deviludo.complete_host_admission_event(uuid, uuid, uuid),
  deviludo.fail_host_admission_event(uuid, uuid, uuid, text)
  TO deviludo_scheduler;
GRANT EXECUTE ON FUNCTION deviludo.cleanup_expired_executor_state() TO deviludo_scheduler;
GRANT EXECUTE ON FUNCTION deviludo.claim_agent_container_lifecycle(integer, integer, integer),
  deviludo.claim_paused_agent_container_for_pressure(integer),
  deviludo.complete_agent_container_lifecycle(uuid, uuid, uuid, deviludo.agent_lifecycle_action),
  deviludo.fail_agent_container_lifecycle(uuid, uuid, uuid)
  TO deviludo_scheduler;

GRANT SELECT, UPDATE ON deviludo.jobs TO deviludo_claim_executor;
GRANT SELECT, UPDATE ON deviludo.agent_containers TO deviludo_claim_executor;
GRANT SELECT ON deviludo.agent_turns TO deviludo_claim_executor;
GRANT INSERT ON deviludo.jobs, deviludo.artifact_inputs, deviludo.external_signals
  TO deviludo_claim_executor;
GRANT SELECT, UPDATE ON deviludo.projects TO deviludo_claim_executor;
GRANT UPDATE ON deviludo.workflow_instances TO deviludo_claim_executor;
GRANT SELECT ON deviludo.project_documents,
  deviludo.project_source_revisions,
  deviludo.workflow_instances, deviludo.instance_agent_settings,
  deviludo.runtime_images, deviludo.artifacts, deviludo.artifact_inputs,
  deviludo.external_signals, deviludo.steam_releases, deviludo.e2e_regression_traces
  TO deviludo_claim_executor;
GRANT UPDATE (state) ON deviludo.artifacts TO deviludo_claim_executor;
GRANT UPDATE ON deviludo.steam_releases TO deviludo_claim_executor;
-- The asset generation lease and its settlement run as this role, which is the
-- owner of those SECURITY DEFINER functions.
GRANT SELECT, UPDATE ON deviludo.asset_items TO deviludo_claim_executor;
GRANT SELECT, INSERT, UPDATE, DELETE ON deviludo.object_cleanup_queue TO deviludo_claim_executor;
GRANT SELECT, INSERT, UPDATE, DELETE ON deviludo.pending_object_uploads TO deviludo_claim_executor;
GRANT INSERT ON deviludo.project_cleanup_requests TO deviludo_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON deviludo.project_cleanup_requests TO deviludo_claim_executor;
GRANT SELECT, INSERT, UPDATE, DELETE ON deviludo.host_admission_events TO deviludo_claim_executor;
GRANT SELECT ON deviludo.asset_manifests, deviludo.instance_agent_settings
  TO deviludo_claim_executor;
GRANT SELECT, INSERT, UPDATE ON deviludo.workspace_claim_fairness TO deviludo_claim_executor;
GRANT SELECT ON deviludo.workspaces TO deviludo_claim_executor;
GRANT SELECT, INSERT ON deviludo.workflow_events TO deviludo_claim_executor;
GRANT SELECT, DELETE ON deviludo.e2e_enrollment_tokens TO deviludo_claim_executor;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA deviludo TO deviludo_claim_executor;

COMMIT;
