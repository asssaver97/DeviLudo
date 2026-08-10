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
  EXECUTE format(
    'GRANT deviludo_api, deviludo_scheduler, deviludo_sandbox TO %I',
    current_user
  );
END
$roles$;

CREATE SCHEMA deviludo;
REVOKE ALL ON SCHEMA deviludo FROM PUBLIC;
GRANT USAGE ON SCHEMA deviludo TO
  deviludo_api, deviludo_scheduler, deviludo_sandbox, deviludo_claim_executor;

CREATE TYPE deviludo.server_pool_kind AS ENUM (
  'WEB', 'CORE', 'E2E_LINUX', 'E2E_WINDOWS', 'E2E_MACOS'
);
CREATE TYPE deviludo.server_os AS ENUM ('linux', 'windows', 'macos');
CREATE TYPE deviludo.server_node_state AS ENUM (
  'PROVISIONING', 'ACTIVE', 'DRAINING', 'DISABLED', 'REIMAGING'
);
CREATE TYPE deviludo.workflow_state AS ENUM (
  'DRAFT', 'AGENT_RUNNING', 'ASSET_GENERATING', 'ARTIFACT_BUILDING', 'E2E_TESTING', 'SIGNING',
  'RELEASE_APPROVAL_PENDING', 'STEAM_PUBLISHING', 'CLEAN_INSTALL_VERIFYING',
  'SUCCEEDED', 'FAILED', 'CANCELLED'
);
CREATE TYPE deviludo.job_kind AS ENUM (
  'AGENT_GENERATION', 'PROJECT_DOCUMENT_MAINTENANCE', 'ARTIFACT_BUILD', 'STEAM_PUBLISH',
  'E2E_TEST', 'ARTIFACT_SIGN', 'STEAM_CLEAN_INSTALL'
);
CREATE TYPE deviludo.job_state AS ENUM (
  'QUEUED', 'RUNNING', 'RETRY', 'SUCCEEDED', 'FAILED', 'CANCELLED'
);
CREATE TYPE deviludo.operation_state AS ENUM (
  'REGISTERED', 'IN_PROGRESS', 'RECEIPTED', 'RECONCILIATION_REQUIRED', 'VOID'
);
CREATE TYPE deviludo.agent_runtime AS ENUM ('CLAUDE_CODE', 'CODEX_CLI');
CREATE TYPE deviludo.workflow_profile AS ENUM ('VALIDATE', 'RELEASE');
CREATE TYPE deviludo.artifact_kind AS ENUM (
  'SPECIFICATION', 'PROJECT_DOCUMENT', 'BUILD', 'E2E_REPORT', 'SIGNED_BUILD',
  'PUBLISH_RECEIPT', 'CLEAN_INSTALL_REPORT'
);

-- `compatibility` states which shape of the schema this is and only changes when
-- that shape changes incompatibly, so it cannot distinguish a current database
-- from one whose functions predate this file. `source_digest` records the exact
-- bytes that were applied, which is what lets the migration detect drift instead
-- of skipping over it. It is written by the migration after applying this file,
-- because the file cannot hash itself.
CREATE TABLE deviludo.schema_metadata (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  baseline text NOT NULL,
  compatibility text NOT NULL,
  current_version text NOT NULL DEFAULT '001',
  source_digest text CHECK (source_digest IS NULL OR source_digest ~ '^sha256:[0-9a-f]{64}$'),
  applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO deviludo.schema_metadata(singleton, baseline, compatibility)
VALUES (true, '001', 'deviludo-core-source-v1');

-- Every post-baseline change is immutable and checksummed. Fresh databases are
-- created from this full snapshot and then stamp the migrations incorporated by
-- it; existing databases apply the same files in lexical order.
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
  ('WEB', 'linux', 1, 1, 1, ARRAY['CUSTOMER_WEB', 'STREAMING_BFF'], true),
  ('CORE', 'linux', 1, 1, 1, ARRAY[
    'BUSINESS_API', 'WORKFLOW_SCHEDULER', 'AGENT_GENERATION', 'ARTIFACT_BUILD', 'STEAM_PUBLISH',
    'RESTRICTED_CONTAINER', 'NETWORK_POLICY'
  ], false),
  ('E2E_LINUX', 'linux', 1, 1, 1, ARRAY['E2E_TEST', 'ARTIFACT_SIGN', 'STEAM_CLEAN_INSTALL'], false),
  ('E2E_WINDOWS', 'windows', 1, 1, 1, ARRAY['E2E_TEST', 'ARTIFACT_SIGN', 'STEAM_CLEAN_INSTALL'], false),
  ('E2E_MACOS', 'macos', 0, 1, 0, ARRAY['E2E_TEST', 'ARTIFACT_SIGN', 'STEAM_CLEAN_INSTALL'], false);

CREATE TABLE deviludo.server_nodes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pool_kind deviludo.server_pool_kind NOT NULL REFERENCES deviludo.server_pools(kind),
  operating_system deviludo.server_os NOT NULL,
  state deviludo.server_node_state NOT NULL DEFAULT 'PROVISIONING',
  capabilities text[] NOT NULL DEFAULT ARRAY[]::text[],
  isolation_generation bigint NOT NULL DEFAULT 1 CHECK (isolation_generation > 0),
  current_workspace_id uuid,
  agent_installed boolean NOT NULL DEFAULT false CHECK (agent_installed = false),
  last_heartbeat_at timestamptz,
  last_reimage_proof_at timestamptz,
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

CREATE TABLE deviludo.e2e_enrollment_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^sha256:[0-9a-f]{64}$'),
  pool_kind deviludo.server_pool_kind NOT NULL CHECK (pool_kind IN ('E2E_LINUX', 'E2E_WINDOWS', 'E2E_MACOS')),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  node_id uuid REFERENCES deviludo.server_nodes(id),
  created_by_actor_account_id uuid NOT NULL,
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
  primary_model text CHECK (primary_model IS NULL OR primary_model ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'),
  opus_model text CHECK (opus_model IS NULL OR opus_model ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'),
  sonnet_model text CHECK (sonnet_model IS NULL OR sonnet_model ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'),
  haiku_model text CHECK (haiku_model IS NULL OR haiku_model ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'),
  subagent_model text CHECK (subagent_model IS NULL OR subagent_model ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'),
  credential_secret_ref text NOT NULL CHECK (
    length(credential_secret_ref) BETWEEN 32 AND 1000
    AND credential_secret_ref LIKE 'vault://instance/agent-runtime/api-key/versions/%'
  ),
  api_key_mask text NOT NULL CHECK (api_key_mask ~ '^.{3}\*{8}.{4}$'),
  api_key_fingerprint text NOT NULL CHECK (api_key_fingerprint ~ '^sha256:[0-9a-f]{12}$'),
  credential_version uuid NOT NULL,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_by text NOT NULL CHECK (length(updated_by) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (
    (primary_model IS NULL AND opus_model IS NULL AND sonnet_model IS NULL
      AND haiku_model IS NULL AND subagent_model IS NULL)
    OR
    (primary_model IS NOT NULL AND opus_model IS NOT NULL AND sonnet_model IS NOT NULL
      AND haiku_model IS NOT NULL AND subagent_model IS NOT NULL)
  )
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
  created_by_actor_account_id uuid NOT NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  last_activity_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, id)
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
  actor_account_id uuid NOT NULL,
  fencing_token bigint CHECK (fencing_token IS NULL OR fencing_token > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, project_id, revision),
  UNIQUE (workspace_id, project_id, content_digest),
  FOREIGN KEY (workspace_id, project_id) REFERENCES deviludo.projects(workspace_id, id) ON DELETE CASCADE
);

CREATE TABLE deviludo.project_source_ready_outbox (
  event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  workflow_id uuid NOT NULL,
  source_revision bigint NOT NULL,
  content_digest text NOT NULL CHECK (content_digest ~ '^sha256:[0-9a-f]{64}$'),
  development_actor_account_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  acknowledged_at timestamptz,
  UNIQUE (workspace_id, project_id, workflow_id, source_revision),
  FOREIGN KEY (workspace_id, project_id, source_revision)
    REFERENCES deviludo.project_source_revisions(workspace_id, project_id, revision) ON DELETE CASCADE
);
CREATE INDEX project_source_ready_outbox_pending
  ON deviludo.project_source_ready_outbox(created_at, event_id) WHERE acknowledged_at IS NULL;

CREATE TABLE deviludo.project_documents (
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  content jsonb NOT NULL CHECK (
    jsonb_typeof(content) = 'object'
    AND jsonb_typeof(content->'introduction') = 'string'
    AND jsonb_typeof(content->'gameplay') = 'string'
    AND jsonb_typeof(content->'categories') = 'array'
    AND jsonb_array_length(content->'categories') BETWEEN 1 AND 32
    AND jsonb_typeof(content->'features') = 'array'
    AND jsonb_array_length(content->'features') BETWEEN 1 AND 32
  ),
  markdown text NOT NULL CHECK (length(markdown) BETWEEN 1 AND 100000),
  maintained_by text NOT NULL CHECK (maintained_by IN ('SYSTEM', 'USER', 'AGENT')),
  updated_by_actor_account_id uuid,
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
  author_actor_account_id uuid,
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
  PRIMARY KEY (workspace_id, message_id),
  FOREIGN KEY (workspace_id, conversation_id)
    REFERENCES deviludo.project_conversations(workspace_id, id) ON DELETE CASCADE
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
  development_actor_account_id uuid,
  profile deviludo.workflow_profile NOT NULL DEFAULT 'VALIDATE',
  target_platforms deviludo.server_os[] NOT NULL DEFAULT ARRAY['macos']::deviludo.server_os[]
    CHECK (cardinality(target_platforms) BETWEEN 1 AND 3),
  state deviludo.workflow_state NOT NULL DEFAULT 'DRAFT',
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
  state_data jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(state_data) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id) REFERENCES deviludo.workspaces(id),
  FOREIGN KEY (workspace_id, project_id) REFERENCES deviludo.projects(workspace_id, id)
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
      kind IN ('AGENT_GENERATION', 'PROJECT_DOCUMENT_MAINTENANCE', 'ARTIFACT_BUILD', 'STEAM_PUBLISH')
      AND pool_kind = 'CORE'
      AND target_operating_system IS NULL
      AND exclusive = false
    )
    OR (
      kind IN ('E2E_TEST', 'ARTIFACT_SIGN', 'STEAM_CLEAN_INSTALL')
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
  event_kind text NOT NULL CHECK (event_kind IN ('PHASE', 'AGENT_OUTPUT', 'GUIDANCE_ACCEPTED', 'COMPLETED', 'FAILED')),
  content text NOT NULL CHECK (length(content) BETWEEN 1 AND 4000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, sequence),
  FOREIGN KEY (workspace_id, project_id) REFERENCES deviludo.projects(workspace_id, id),
  FOREIGN KEY (workspace_id, workflow_id) REFERENCES deviludo.workflow_instances(workspace_id, id),
  FOREIGN KEY (workspace_id, job_id) REFERENCES deviludo.jobs(workspace_id, id)
);
CREATE INDEX job_progress_events_project_sequence
  ON deviludo.job_progress_events(workspace_id, project_id, sequence);

CREATE TABLE deviludo.job_guidance_messages (
  workspace_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  workflow_id uuid NOT NULL,
  job_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  content text NOT NULL CHECK (length(content) BETWEEN 2 AND 4000),
  state text NOT NULL DEFAULT 'PENDING' CHECK (state IN ('PENDING', 'DELIVERED', 'REJECTED')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  delivered_at timestamptz,
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, project_id) REFERENCES deviludo.projects(workspace_id, id),
  FOREIGN KEY (workspace_id, workflow_id) REFERENCES deviludo.workflow_instances(workspace_id, id),
  FOREIGN KEY (workspace_id, job_id) REFERENCES deviludo.jobs(workspace_id, id),
  FOREIGN KEY (workspace_id, conversation_id) REFERENCES deviludo.project_conversations(workspace_id, id)
);
CREATE INDEX job_guidance_messages_pending
  ON deviludo.job_guidance_messages(workspace_id, job_id, created_at)
  WHERE state = 'PENDING';

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
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, object_key, sha256),
  FOREIGN KEY (workspace_id) REFERENCES deviludo.workspaces(id),
  FOREIGN KEY (workspace_id, project_id) REFERENCES deviludo.projects(workspace_id, id),
  FOREIGN KEY (workspace_id, workflow_id) REFERENCES deviludo.workflow_instances(workspace_id, id),
  FOREIGN KEY (workspace_id, producing_job_id) REFERENCES deviludo.jobs(workspace_id, id),
  CHECK (object_key LIKE 'workspaces/' || workspace_id::text || '/projects/' || project_id::text || '/%')
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

-- Instance-wide image generation provider. Like the Agent runtime settings this
-- is a singleton and keeps only a secret reference plus a mask; the API key
-- itself lives in the Secret store.
CREATE TABLE deviludo.instance_image_generation_settings (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  provider text NOT NULL
    CHECK (provider IN ('dalle-3', 'stable-diffusion-xl', 'midjourney', 'replicate')),
  api_endpoint text CHECK (
    api_endpoint IS NULL
    OR (length(api_endpoint) BETWEEN 8 AND 2048 AND api_endpoint ~ '^https?://')
  ),
  model text CHECK (model IS NULL OR model ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'),
  credential_secret_ref text NOT NULL CHECK (
    length(credential_secret_ref) BETWEEN 32 AND 1000
    AND credential_secret_ref LIKE 'vault://instance/image-generation/api-key/versions/%'
  ),
  api_key_mask text NOT NULL CHECK (api_key_mask ~ '^.{3}\*{8}.{4}$'),
  api_key_fingerprint text NOT NULL CHECK (api_key_fingerprint ~ '^sha256:[0-9a-f]{12}$'),
  credential_version uuid NOT NULL,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_by text NOT NULL CHECK (length(updated_by) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
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
    CHECK (asset_type IN ('sprite', 'animation', 'background', 'ui', 'icon', 'tileset')),
  description text NOT NULL CHECK (length(description) BETWEEN 1 AND 2000),
  generation_prompt text CHECK (generation_prompt IS NULL OR length(generation_prompt) BETWEEN 1 AND 4000),
  frame_count integer CHECK (frame_count IS NULL OR frame_count BETWEEN 1 AND 4096),
  dimensions text CHECK (dimensions IS NULL OR dimensions ~ '^[0-9]{1,5}x[0-9]{1,5}$'),
  status text NOT NULL DEFAULT 'planned'
    CHECK (status IN ('planned', 'generating', 'generated', 'uploaded', 'failed')),
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
  )
);

CREATE INDEX asset_items_manifest_status
  ON deviludo.asset_items (workspace_id, manifest_id, status);

-- Generation attempts are bounded per item so a prompt the provider always
-- rejects cannot be retried forever, and the lease columns let one generator
-- claim an item without a second one picking it up.
ALTER TABLE deviludo.asset_items
  ADD COLUMN generation_attempt integer NOT NULL DEFAULT 0
    CHECK (generation_attempt BETWEEN 0 AND 3),
  ADD COLUMN generation_lease_expires_at timestamptz,
  ADD CONSTRAINT asset_items_lease_requires_generating CHECK (
    (generation_lease_expires_at IS NOT NULL) = (status = 'generating')
  );

-- Freeze the exact image objects into every artifact-build job. The builder
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
BEGIN
  IF NEW.kind <> 'ARTIFACT_BUILD' THEN RETURN NEW; END IF;
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
    'projects', 'project_source_revisions', 'project_source_ready_outbox',
    'project_documents', 'project_document_revisions',
    'project_conversations', 'conversation_messages',
    'agent_installations', 'workflow_instances', 'workflow_events',
    'jobs', 'external_signals', 'job_progress_events', 'job_guidance_messages',
    'operation_receipts', 'workspace_claim_fairness',
    'artifacts', 'artifact_inputs', 'executor_receipts', 'project_creation_receipts',
    'asset_manifests', 'asset_items'
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

-- Ordered serial delivery stages for a profile. Index 1 is the first stage.
-- PROJECT_DOCUMENT_MAINTENANCE is deliberately absent: it is an out-of-band
-- idle task, not part of the serial delivery chain. Asset generation is also
-- absent because it runs asynchronously alongside this chain, never inside it.
CREATE OR REPLACE FUNCTION deviludo.delivery_stages(p_profile deviludo.workflow_profile)
RETURNS deviludo.job_kind[]
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $$
  SELECT CASE p_profile
    WHEN 'VALIDATE' THEN
      ARRAY['AGENT_GENERATION', 'ARTIFACT_BUILD', 'E2E_TEST']::deviludo.job_kind[]
    ELSE
      ARRAY[
        'AGENT_GENERATION', 'ARTIFACT_BUILD', 'E2E_TEST',
        'ARTIFACT_SIGN', 'STEAM_PUBLISH', 'STEAM_CLEAN_INSTALL'
      ]::deviludo.job_kind[]
  END
$$;

-- Workflow state a given stage runs in.
CREATE OR REPLACE FUNCTION deviludo.stage_running_state(p_kind deviludo.job_kind)
RETURNS deviludo.workflow_state
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $$
  SELECT CASE p_kind
    WHEN 'AGENT_GENERATION' THEN 'AGENT_RUNNING'
    WHEN 'ARTIFACT_BUILD' THEN 'ARTIFACT_BUILDING'
    WHEN 'E2E_TEST' THEN 'E2E_TESTING'
    WHEN 'ARTIFACT_SIGN' THEN 'SIGNING'
    WHEN 'STEAM_PUBLISH' THEN 'STEAM_PUBLISHING'
    WHEN 'STEAM_CLEAN_INSTALL' THEN 'CLEAN_INSTALL_VERIFYING'
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
    WHEN 'AGENT_GENERATION' THEN ARRAY['MICROVM', 'NETWORK_POLICY']
    WHEN 'PROJECT_DOCUMENT_MAINTENANCE' THEN ARRAY['MICROVM', 'NETWORK_POLICY']
    WHEN 'ARTIFACT_BUILD' THEN ARRAY['RESTRICTED_CONTAINER', 'BUILD_TOOLCHAIN']
    WHEN 'STEAM_PUBLISH' THEN ARRAY['RESTRICTED_CONTAINER', 'STEAMCMD']
    WHEN 'E2E_TEST' THEN ARRAY['GAME_RUNTIME', 'TRUSTED_REIMAGE']
    WHEN 'ARTIFACT_SIGN' THEN ARRAY['SIGNING', 'HSM', 'TRUSTED_REIMAGE']
    WHEN 'STEAM_CLEAN_INSTALL' THEN ARRAY['STEAM_CLIENT', 'TRUSTED_REIMAGE']
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
  v_input_count integer;
  v_source deviludo.project_source_revisions%ROWTYPE;
BEGIN
  v_pool := CASE
    WHEN p_kind IN ('AGENT_GENERATION', 'PROJECT_DOCUMENT_MAINTENANCE', 'ARTIFACT_BUILD', 'STEAM_PUBLISH') THEN 'CORE'
    WHEN p_operating_system = 'linux' THEN 'E2E_LINUX'
    WHEN p_operating_system = 'windows' THEN 'E2E_WINDOWS'
    WHEN p_operating_system = 'macos' THEN 'E2E_MACOS'
  END;
  IF v_pool IS NULL THEN RAISE EXCEPTION 'invalid fixed job placement'; END IF;
  v_runtime_key := CASE
    WHEN p_kind = 'AGENT_GENERATION' AND coalesce(p_payload #>> '{agentConfiguration,runtime}', '') = 'CODEX_CLI' THEN 'AGENT_CODEX'
    WHEN p_kind = 'AGENT_GENERATION' THEN 'AGENT_CLAUDE'
    WHEN p_kind = 'PROJECT_DOCUMENT_MAINTENANCE' AND coalesce(p_payload #>> '{agentConfiguration,runtime}', '') = 'CODEX_CLI' THEN 'AGENT_CODEX'
    WHEN p_kind = 'PROJECT_DOCUMENT_MAINTENANCE' THEN 'AGENT_CLAUDE'
    WHEN p_kind = 'ARTIFACT_BUILD' THEN 'GODOT_BUILDER'
    WHEN p_kind = 'STEAM_PUBLISH' THEN 'STEAM_PUBLISHER'
    WHEN p_operating_system = 'linux' THEN 'E2E_LINUX'
    WHEN p_operating_system = 'windows' THEN 'E2E_WINDOWS'
    WHEN p_operating_system = 'macos' THEN 'E2E_MACOS'
  END;
  SELECT image_reference INTO v_runtime_image
    FROM deviludo.runtime_images WHERE runtime_key = v_runtime_key;
  IF v_runtime_image IS NULL THEN
    RAISE EXCEPTION 'verified runtime image is not configured: %', v_runtime_key;
  END IF;
  IF p_kind IN ('AGENT_GENERATION', 'ARTIFACT_BUILD') THEN
    SELECT * INTO v_source
      FROM deviludo.project_source_revisions
     WHERE workspace_id = p_workspace_id AND project_id = p_project_id
     ORDER BY revision DESC LIMIT 1;
    IF p_kind = 'ARTIFACT_BUILD' AND v_source.revision IS NULL THEN
      RAISE EXCEPTION 'artifact build requires a published source revision';
    END IF;
    p_payload := p_payload
      || jsonb_build_object('publishSourceRevision', coalesce(v_source.revision, 0) + 1)
      || CASE WHEN v_source.revision IS NULL THEN '{}'::jsonb ELSE jsonb_build_object(
        'sourceRevision', v_source.revision,
        'sourceRelativePath', v_source.relative_path,
        'sourceDigest', v_source.content_digest
      ) END;
  END IF;
  INSERT INTO deviludo.jobs (
    workspace_id, workflow_id, project_id, kind, pool_kind, target_operating_system,
    required_capabilities, exclusive, runtime_image, timeout_seconds, max_attempts, output_contract, idempotency_key, payload
  )
  VALUES (
    p_workspace_id, p_workflow_id, p_project_id, p_kind, v_pool,
    CASE WHEN v_pool = 'CORE' THEN NULL ELSE p_operating_system END,
    deviludo.required_capabilities(p_kind), v_pool <> 'CORE', v_runtime_image,
    CASE WHEN p_kind = 'AGENT_GENERATION' THEN 5400 ELSE 1800 END,
    3,
    jsonb_build_object(
      'kinds', CASE p_kind
        WHEN 'AGENT_GENERATION' THEN jsonb_build_array('SPECIFICATION')
        WHEN 'PROJECT_DOCUMENT_MAINTENANCE' THEN jsonb_build_array('PROJECT_DOCUMENT')
        WHEN 'ARTIFACT_BUILD' THEN jsonb_build_array('BUILD')
        WHEN 'E2E_TEST' THEN jsonb_build_array('E2E_REPORT')
        WHEN 'ARTIFACT_SIGN' THEN jsonb_build_array('SIGNED_BUILD')
        WHEN 'STEAM_PUBLISH' THEN jsonb_build_array('PUBLISH_RECEIPT')
        WHEN 'STEAM_CLEAN_INSTALL' THEN jsonb_build_array('CLEAN_INSTALL_REPORT')
      END,
      'maxBytes', 1073741824
    ),
    p_idempotency_key, p_payload
  )
  ON CONFLICT (workspace_id, idempotency_key) DO UPDATE
    SET updated_at = deviludo.jobs.updated_at
  RETURNING id INTO v_id;
  INSERT INTO deviludo.artifact_inputs(workspace_id, job_id, artifact_id, expected_sha256)
  SELECT artifact.workspace_id, v_id, artifact.id, artifact.sha256
    FROM deviludo.artifacts artifact
   WHERE artifact.workspace_id = p_workspace_id
     AND artifact.workflow_id = p_workflow_id
     AND CASE p_kind
       WHEN 'AGENT_GENERATION' THEN
         CASE WHEN p_payload ? 'repairFromE2eJobId' THEN
           (artifact.kind = 'SPECIFICATION' AND artifact.producing_job_id IS NULL)
           OR (artifact.kind = 'E2E_REPORT'
             AND artifact.producing_job_id = (p_payload->>'repairFromE2eJobId')::uuid)
         ELSE artifact.kind = 'SPECIFICATION' AND artifact.producing_job_id IS NULL END
       WHEN 'PROJECT_DOCUMENT_MAINTENANCE' THEN false
       WHEN 'ARTIFACT_BUILD' THEN artifact.kind = 'SPECIFICATION'
         AND artifact.producing_job_id = (
           SELECT source_job.id
             FROM deviludo.jobs source_job
            WHERE source_job.workspace_id = p_workspace_id
              AND source_job.workflow_id = p_workflow_id
              AND source_job.kind = 'AGENT_GENERATION'
              AND source_job.state = 'SUCCEEDED'
            ORDER BY source_job.updated_at DESC, source_job.created_at DESC
            LIMIT 1
         )
       WHEN 'E2E_TEST' THEN artifact.kind = 'BUILD' AND artifact.target_platform = p_operating_system
         AND artifact.producing_job_id = (
           SELECT build_job.id FROM deviludo.jobs build_job
            WHERE build_job.workspace_id = p_workspace_id AND build_job.workflow_id = p_workflow_id
              AND build_job.kind = 'ARTIFACT_BUILD' AND build_job.state = 'SUCCEEDED'
            ORDER BY build_job.updated_at DESC, build_job.created_at DESC LIMIT 1
         )
       WHEN 'ARTIFACT_SIGN' THEN artifact.kind = 'BUILD' AND artifact.target_platform = p_operating_system
         AND artifact.producing_job_id = (
           SELECT build_job.id FROM deviludo.jobs build_job
            WHERE build_job.workspace_id = p_workspace_id AND build_job.workflow_id = p_workflow_id
              AND build_job.kind = 'ARTIFACT_BUILD' AND build_job.state = 'SUCCEEDED'
            ORDER BY build_job.updated_at DESC, build_job.created_at DESC LIMIT 1
         )
       WHEN 'STEAM_PUBLISH' THEN artifact.kind = 'SIGNED_BUILD'
       WHEN 'STEAM_CLEAN_INSTALL' THEN artifact.kind = 'PUBLISH_RECEIPT'
       ELSE false
     END
  ON CONFLICT DO NOTHING;
  SELECT count(*)::integer INTO v_input_count
    FROM deviludo.artifact_inputs
   WHERE workspace_id = p_workspace_id AND job_id = v_id;
  IF (p_kind = 'AGENT_GENERATION' AND p_payload ? 'repairFromE2eJobId' AND v_input_count <> 2)
    OR (p_kind = 'AGENT_GENERATION' AND NOT (p_payload ? 'repairFromE2eJobId') AND v_input_count <> 1)
    OR (p_kind = 'PROJECT_DOCUMENT_MAINTENANCE' AND v_input_count <> 0)
    OR (p_kind = 'ARTIFACT_BUILD' AND v_input_count < 1)
    OR (p_kind IN ('E2E_TEST', 'ARTIFACT_SIGN', 'STEAM_CLEAN_INSTALL') AND v_input_count < 1)
    OR (p_kind = 'STEAM_PUBLISH' AND v_input_count < coalesce(jsonb_array_length(p_payload->'targetPlatforms'), 1))
  THEN
    RAISE EXCEPTION 'verified artifact inputs are incomplete for %', p_kind;
  END IF;
  RETURN v_id;
END
$$;

CREATE OR REPLACE FUNCTION deviludo.schedule_idle_project_document_maintenance(
  p_idle_seconds integer,
  p_batch_size integer DEFAULT 20
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, deviludo
SET row_security = off
AS $$
DECLARE
  candidate record;
  agent_settings deviludo.instance_agent_settings%ROWTYPE;
  scheduled integer := 0;
BEGIN
  IF p_idle_seconds NOT BETWEEN 60 AND 2592000 OR p_batch_size NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'invalid project document maintenance schedule';
  END IF;
  SELECT * INTO agent_settings FROM deviludo.instance_agent_settings WHERE singleton = true;
  IF agent_settings.singleton IS NULL THEN RETURN 0; END IF;

  FOR candidate IN
    SELECT project.workspace_id, project.id AS project_id, project.name,
           project.last_activity_at, document.revision, document.content,
           workflow.id AS workflow_id, workflow.state_data
      FROM deviludo.projects project
      JOIN deviludo.project_documents document
        ON document.workspace_id = project.workspace_id AND document.project_id = project.id
      JOIN LATERAL (
        SELECT instance.id, instance.state_data
          FROM deviludo.workflow_instances instance
         WHERE instance.workspace_id = project.workspace_id AND instance.project_id = project.id
         ORDER BY instance.created_at DESC
         LIMIT 1
      ) workflow ON true
     WHERE project.last_activity_at <= clock_timestamp() - make_interval(secs => p_idle_seconds)
       AND (document.last_agent_maintained_at IS NULL
         OR document.last_agent_maintained_at < project.last_activity_at)
       AND NOT EXISTS (
         SELECT 1 FROM deviludo.jobs active_job
          WHERE active_job.workspace_id = project.workspace_id
            AND active_job.project_id = project.id
            AND active_job.state IN ('QUEUED', 'RETRY', 'RUNNING')
       )
     ORDER BY project.last_activity_at, project.id
     FOR UPDATE OF project SKIP LOCKED
     LIMIT p_batch_size
  LOOP
    PERFORM deviludo.enqueue_job(
      candidate.workspace_id,
      candidate.workflow_id,
      candidate.project_id,
      'PROJECT_DOCUMENT_MAINTENANCE',
      NULL,
      candidate.project_id::text || ':document-maintenance:'
        || extract(epoch FROM candidate.last_activity_at)::bigint::text,
      jsonb_build_object(
        'maintenanceReason', 'PROJECT_IDLE',
        'projectName', candidate.name,
        'baseRevision', candidate.revision,
        'activityAt', candidate.last_activity_at,
        'document', candidate.content,
        'specification', coalesce(candidate.state_data->'specification', '{}'::jsonb),
        'agentConfiguration', jsonb_build_object(
          'runtime', agent_settings.agent_runtime::text,
          'baseUrl', agent_settings.base_url,
          'models', CASE WHEN agent_settings.primary_model IS NULL THEN NULL ELSE jsonb_build_object(
            'primary', agent_settings.primary_model,
            'opus', agent_settings.opus_model,
            'sonnet', agent_settings.sonnet_model,
            'haiku', agent_settings.haiku_model,
            'subagent', agent_settings.subagent_model
          ) END,
          'credentialRef', agent_settings.credential_secret_ref,
          'revision', agent_settings.revision
        )
      )
    );
    scheduled := scheduled + 1;
  END LOOP;
  RETURN scheduled;
END
$$;
ALTER FUNCTION deviludo.schedule_idle_project_document_maintenance(integer, integer)
  OWNER TO deviludo_claim_executor;

-- Claim one durable initial-analysis task. The directory link itself is stored
-- in workflow state_data before this function can see it; the lease makes the
-- work safe across API restarts and multiple replicas.
CREATE OR REPLACE FUNCTION deviludo.claim_project_import_analysis(p_lease_seconds integer)
RETURNS TABLE (
  "workspaceId" uuid,
  "projectId" uuid,
  "workflowId" uuid,
  "actorUserId" uuid,
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
         workflow.state_data, project.created_by_actor_account_id
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
    candidate.created_by_actor_account_id,
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

-- Lease planned assets for generation.
--
-- Asset generation is not a delivery job: it has no `deviludo.jobs` row or pool,
-- but its durable manifest gates the build. This is its claim primitive, and it is deliberately
-- shaped like `claim_job` — a lease with an expiry, so a generator that dies mid
-- request cannot strand an item in 'generating' forever.
--
-- Only items whose manifest has auto-generate on are returned, and only when the
-- instance actually has image-generation settings configured: without a
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
  "attempt" integer
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
    SELECT 1 FROM deviludo.instance_image_generation_settings WHERE singleton = true
  ) THEN RETURN; END IF;

  RETURN QUERY
  WITH candidate AS (
    SELECT item.workspace_id, item.id
      FROM deviludo.asset_items item
      JOIN deviludo.asset_manifests manifest
        ON manifest.workspace_id = item.workspace_id AND manifest.id = item.manifest_id
     WHERE manifest.auto_generate_enabled = true
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
         error_message = NULL,
         updated_at = clock_timestamp()
    FROM candidate
   WHERE item.workspace_id = candidate.workspace_id AND item.id = candidate.id
  RETURNING item.workspace_id, (
    SELECT manifest.project_id FROM deviludo.asset_manifests manifest
     WHERE manifest.workspace_id = item.workspace_id AND manifest.id = item.manifest_id
  ), item.id, item.asset_key, item.asset_type, item.description,
     item.generation_prompt, item.dimensions, item.frame_count, item.generation_attempt;
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
     AND status = 'generating';
  GET DIAGNOSTICS updated = ROW_COUNT;
  RETURN updated = 1;
END
$$;
ALTER FUNCTION deviludo.complete_asset_generation(uuid, uuid, text, text, text, bigint)
  OWNER TO deviludo_claim_executor;

-- Release a leased item after a failed attempt. Items go back to 'planned' while
-- attempts remain so a transient provider error is retried; the last attempt
-- settles as 'failed' so the panel stops showing it as pending work and the user
-- can upload the asset instead.
CREATE OR REPLACE FUNCTION deviludo.fail_asset_generation(
  p_workspace_id uuid,
  p_item_id uuid,
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
   WHERE workspace_id = p_workspace_id AND id = p_item_id AND status = 'generating';
  GET DIAGNOSTICS updated = ROW_COUNT;
  RETURN updated = 1;
END
$$;
ALTER FUNCTION deviludo.fail_asset_generation(uuid, uuid, text)
  OWNER TO deviludo_claim_executor;

-- Advance deliveries whose generated/uploaded art is now complete. This is a
-- cross-workspace scheduler primitive, so it owns the same narrow BYPASSRLS role
-- as job claiming. Turning auto-generation off is an explicit request to use
-- placeholders and therefore also releases the gate.
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
           workflow.target_platforms, agent.id AS agent_job_id
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
           AND source.kind = 'AGENT_GENERATION'
           AND source.state = 'SUCCEEDED'
         ORDER BY source.updated_at DESC, source.created_at DESC
         LIMIT 1
      ) agent ON true
     WHERE workflow.state = 'ASSET_GENERATING'
       AND (
         manifest.auto_generate_enabled = false
         OR NOT EXISTS (
           SELECT 1 FROM deviludo.asset_items item
            WHERE item.workspace_id = manifest.workspace_id
              AND item.manifest_id = manifest.id
              AND item.status NOT IN ('generated', 'uploaded')
         )
       )
     ORDER BY workflow.updated_at, workflow.id
     FOR UPDATE OF workflow SKIP LOCKED
     LIMIT p_batch_size
  LOOP
    UPDATE deviludo.workflow_instances
       SET state = 'ARTIFACT_BUILDING', version = version + 1,
           updated_at = clock_timestamp()
     WHERE workspace_id = candidate.workspace_id AND id = candidate.workflow_id
       AND state = 'ASSET_GENERATING';
    IF FOUND THEN
      PERFORM deviludo.enqueue_job(
        candidate.workspace_id, candidate.workflow_id, candidate.project_id,
        'ARTIFACT_BUILD', NULL,
        candidate.workflow_id::text || ':artifact:after:' || candidate.agent_job_id::text,
        jsonb_build_object('targetPlatforms', candidate.target_platforms)
      );
      INSERT INTO deviludo.workflow_events(
        workspace_id, workflow_id, event_kind, event_data, idempotency_key
      ) VALUES (
        candidate.workspace_id, candidate.workflow_id, 'ASSETS_READY',
        jsonb_build_object('agentJobId', candidate.agent_job_id),
        'assets-ready:' || candidate.agent_job_id::text
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
  inserted_id uuid;
  platform deviludo.server_os;
  rerun_stage deviludo.job_kind;
  stage_list deviludo.job_kind[];
  stage_index integer;
  downstream_stages deviludo.job_kind[];
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
    'RELEASE_APPROVED', 'EXTERNAL_APPROVAL'
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
    IF workflow.state NOT IN ('FAILED', 'SUCCEEDED', 'CANCELLED') THEN
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
    IF rerun_stage = 'AGENT_GENERATION' THEN
      SELECT * INTO agent_settings
        FROM deviludo.instance_agent_settings
       WHERE singleton = true;
      IF agent_settings.singleton IS NULL THEN
        RAISE EXCEPTION 'Agent configuration is required before rerunning agent generation';
      END IF;
    END IF;
  END IF;
  IF p_signal_kind = 'RELEASE_APPROVED' THEN
    IF workflow.state <> 'RELEASE_APPROVAL_PENDING' THEN
      RAISE EXCEPTION 'Release approval requires signed builds awaiting approval';
    END IF;
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
       SET state = 'AGENT_RUNNING', version = version + 1,
           development_actor_account_id = (p_payload->>'requestedByAccountId')::uuid,
           updated_at = clock_timestamp()
     WHERE workspace_id = workflow.workspace_id AND id = workflow.id;
    PERFORM deviludo.enqueue_job(
      workflow.workspace_id, workflow.id, workflow.project_id, 'AGENT_GENERATION', NULL,
      workflow.id::text || ':agent',
      CASE WHEN agent_settings.singleton IS NULL THEN '{}'::jsonb ELSE jsonb_build_object(
        'agentConfiguration', jsonb_build_object(
          'runtime', agent_settings.agent_runtime::text,
          'baseUrl', agent_settings.base_url,
          'models', CASE WHEN agent_settings.primary_model IS NULL THEN NULL ELSE jsonb_build_object(
            'primary', agent_settings.primary_model,
            'opus', agent_settings.opus_model,
            'sonnet', agent_settings.sonnet_model,
            'haiku', agent_settings.haiku_model,
            'subagent', agent_settings.subagent_model
          ) END,
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
       AND state <> 'CANCELLED';
    UPDATE deviludo.workflow_instances
       SET state = deviludo.stage_running_state(rerun_stage), version = version + 1,
           development_actor_account_id = (p_payload->>'requestedByAccountId')::uuid,
           updated_at = clock_timestamp()
     WHERE workspace_id = workflow.workspace_id AND id = workflow.id;
    IF rerun_stage IN ('E2E_TEST', 'ARTIFACT_SIGN', 'STEAM_CLEAN_INSTALL') THEN
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
    ELSIF rerun_stage = 'AGENT_GENERATION' THEN
      PERFORM deviludo.enqueue_job(
        workflow.workspace_id, workflow.id, workflow.project_id, 'AGENT_GENERATION', NULL,
        workflow.id::text || ':rerun:agent:' || inserted_id::text,
        jsonb_build_object(
          'agentConfiguration', jsonb_build_object(
            'runtime', agent_settings.agent_runtime::text,
            'baseUrl', agent_settings.base_url,
            'models', CASE WHEN agent_settings.primary_model IS NULL THEN NULL ELSE jsonb_build_object(
              'primary', agent_settings.primary_model,
              'opus', agent_settings.opus_model,
              'sonnet', agent_settings.sonnet_model,
              'haiku', agent_settings.haiku_model,
              'subagent', agent_settings.subagent_model
            ) END,
            'credentialRef', agent_settings.credential_secret_ref,
            'revision', agent_settings.revision
          )
        )
      );
    ELSE
      PERFORM deviludo.enqueue_job(
        workflow.workspace_id, workflow.id, workflow.project_id, rerun_stage, NULL,
        workflow.id::text || ':rerun:' || rerun_stage::text || ':' || inserted_id::text,
        jsonb_build_object('targetPlatforms', workflow.target_platforms)
      );
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
        'approvedByAccountId', p_payload->>'requestedByAccountId'
      )
    );
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
  END IF;
  RETURN true;
END
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
  project deviludo.projects%ROWTYPE;
  platform deviludo.server_os;
  output jsonb;
  document jsonb;
  next_document_revision bigint;
  e2e_content_failure boolean := false;
  repair_count integer := 0;
  failure_summary text;
  agent_settings deviludo.instance_agent_settings%ROWTYPE;
  asset_manifest_id uuid;
  asset_auto_generate boolean := false;
BEGIN
  -- Serialize all terminal job mutations on the workflow before taking a job
  -- row lock. Platform workers complete sibling jobs concurrently, and taking
  -- those locks in the opposite order can deadlock during stage advancement.
  SELECT * INTO job
    FROM deviludo.jobs
   WHERE id = p_job_id
     AND state = 'RUNNING'
     AND lease_token = p_lease_token
     AND fencing_token = p_fencing_token
     AND isolation_generation = p_isolation_generation;
  IF job.id IS NULL THEN RETURN false; END IF;
  SELECT * INTO workflow
    FROM deviludo.workflow_instances
   WHERE workspace_id = job.workspace_id AND id = job.workflow_id
   FOR UPDATE;
  SELECT * INTO job
    FROM deviludo.jobs
   WHERE id = p_job_id
     AND state = 'RUNNING'
     AND lease_token = p_lease_token
     AND fencing_token = p_fencing_token
     AND isolation_generation = p_isolation_generation
   FOR UPDATE;
  IF job.id IS NULL THEN RETURN false; END IF;
  IF job.exclusive AND (
    length(coalesce(p_before_reimage_proof, '')) < 16
    OR length(coalesce(p_cleanup_proof, '')) < 16
    OR length(coalesce(p_after_reimage_proof, '')) < 16
  ) THEN RAISE EXCEPTION 'trusted reimage and cleanup proofs are required'; END IF;
  IF p_executor_receipt->>'schemaVersion' <> 'deviludo.executor-receipt.v2'
    OR coalesce(p_executor_receipt->>'simulated', 'true') <> 'false'
    OR length(coalesce(p_executor_receipt->>'signature', '')) < 32
    OR jsonb_typeof(p_executor_receipt->'outputObjects') <> 'array'
  THEN RAISE EXCEPTION 'verified executor receipt v2 is required'; END IF;
  IF job.kind = 'E2E_TEST' THEN
    IF coalesce(p_receipt #>> '{execution,outcome}', '') NOT IN ('PASSED', 'FAILED')
      OR (p_receipt #>> '{execution,outcome}' = 'FAILED'
        AND coalesce(p_receipt #>> '{execution,failureDomain}', '') <> 'PRODUCT')
      OR length(coalesce(p_receipt #>> '{execution,summary}', '')) NOT BETWEEN 1 AND 2000
    THEN RAISE EXCEPTION 'classified E2E execution report is required'; END IF;
    e2e_content_failure := p_receipt #>> '{execution,outcome}' = 'FAILED';
  END IF;
  IF job.kind = 'AGENT_GENERATION' THEN
    IF (p_receipt #>> '{sourceRevision,revision}')::bigint <> (job.payload->>'publishSourceRevision')::bigint
      OR p_receipt #>> '{sourceRevision,relativePath}' <> 'workspaces/' || job.workspace_id::text
        || '/projects/' || job.project_id::text || '/revisions/r'
        || lpad((job.payload->>'publishSourceRevision')::bigint::text, 12, '0') || '-'
        || substring(p_receipt #>> '{sourceRevision,digest}' from 8 for 16)
      OR coalesce(p_receipt #>> '{sourceRevision,digest}', '') !~ '^sha256:[0-9a-f]{64}$'
      OR (p_receipt #>> '{sourceRevision,fileCount}')::integer NOT BETWEEN 1 AND 20000
      OR (p_receipt #>> '{sourceRevision,totalBytes}')::bigint NOT BETWEEN 1 AND 1073741824
    THEN RAISE EXCEPTION 'validated persistent source revision is required'; END IF;
    INSERT INTO deviludo.project_source_revisions(
      workspace_id, project_id, revision, relative_path, content_digest,
      file_count, total_bytes, workflow_id, job_id, actor_account_id, fencing_token
    ) VALUES (
      job.workspace_id, job.project_id, (p_receipt #>> '{sourceRevision,revision}')::bigint,
      p_receipt #>> '{sourceRevision,relativePath}', p_receipt #>> '{sourceRevision,digest}',
      (p_receipt #>> '{sourceRevision,fileCount}')::integer,
      (p_receipt #>> '{sourceRevision,totalBytes}')::bigint,
      job.workflow_id, job.id, workflow.development_actor_account_id, job.fencing_token
    ) ON CONFLICT (workspace_id, project_id, revision) DO NOTHING;

    -- The Agent plans the game's assets while writing the source that expects
    -- them. When an image provider is configured this delivery waits for those
    -- exact assets before building; without one it deliberately keeps the
    -- placeholder path so a local/code-only project is never stranded.
    IF p_receipt ? 'assetManifest' THEN
      IF jsonb_typeof(p_receipt->'assetManifest') <> 'object'
        OR jsonb_typeof(p_receipt #> '{assetManifest,items}') <> 'array'
        OR jsonb_array_length(p_receipt #> '{assetManifest,items}') NOT BETWEEN 1 AND 500
      THEN RAISE EXCEPTION 'validated asset manifest is required when present'; END IF;
      -- Reject the whole manifest rather than silently dropping rows: a source
      -- tree referencing an asset that never got planned fails at build time,
      -- which is far harder to diagnose than a rejected receipt.
      IF EXISTS (
        SELECT 1 FROM jsonb_array_elements(p_receipt #> '{assetManifest,items}') item
         WHERE jsonb_typeof(item) <> 'object'
           OR length(coalesce(item->>'assetKey', '')) NOT BETWEEN 1 AND 200
           OR coalesce(item->>'assetType', '') NOT IN
             ('sprite', 'animation', 'background', 'ui', 'icon', 'tileset')
           OR length(coalesce(item->>'description', '')) NOT BETWEEN 1 AND 2000
           OR (item ? 'generationPrompt'
             AND length(coalesce(item->>'generationPrompt', '')) NOT BETWEEN 1 AND 4000)
           OR (item ? 'frameCount' AND item->'frameCount' <> 'null'::jsonb
             AND (jsonb_typeof(item->'frameCount') <> 'number'
               OR coalesce(item->>'frameCount', '') !~ '^[0-9]+$'
               OR (item->>'frameCount')::integer NOT BETWEEN 1 AND 4096))
           OR (item ? 'dimensions' AND item->'dimensions' <> 'null'::jsonb
             AND (jsonb_typeof(item->'dimensions') <> 'string'
               OR coalesce(item->>'dimensions', '') !~ '^[0-9]{1,5}x[0-9]{1,5}$'))
      ) THEN RAISE EXCEPTION 'asset manifest items are invalid'; END IF;
      IF (
        SELECT count(DISTINCT item->>'assetKey')
          FROM jsonb_array_elements(p_receipt #> '{assetManifest,items}') item
      ) <> jsonb_array_length(p_receipt #> '{assetManifest,items}')
      THEN RAISE EXCEPTION 'asset manifest keys must be unique'; END IF;

      -- One manifest per project. Every new Agent plan starts its image branch;
      -- generated/uploaded assets still survive the re-plan below, and the user
      -- can pause new claims from the asset panel after planning completes.
      INSERT INTO deviludo.asset_manifests(
        workspace_id, project_id, workflow_id, auto_generate_enabled
      )
      VALUES (
        job.workspace_id, job.project_id, job.workflow_id,
        EXISTS (SELECT 1 FROM deviludo.instance_image_generation_settings WHERE singleton = true)
      )
      ON CONFLICT (workspace_id, project_id) DO UPDATE
        SET workflow_id = excluded.workflow_id,
            auto_generate_enabled = excluded.auto_generate_enabled,
            updated_at = clock_timestamp()
      RETURNING id, auto_generate_enabled INTO asset_manifest_id, asset_auto_generate;

      -- Assets the user already supplied keep their object; only the planning
      -- fields are refreshed. Re-planned keys that no longer appear are dropped
      -- unless an upload is already attached to them.
      INSERT INTO deviludo.asset_items(
        workspace_id, manifest_id, asset_key, asset_type, description,
        generation_prompt, frame_count, dimensions
      )
      SELECT
        job.workspace_id, asset_manifest_id, item->>'assetKey', item->>'assetType',
        item->>'description', item->>'generationPrompt',
        (item->>'frameCount')::integer, item->>'dimensions'
      FROM jsonb_array_elements(p_receipt #> '{assetManifest,items}') item
      ON CONFLICT (workspace_id, manifest_id, asset_key) DO UPDATE
        SET asset_type = excluded.asset_type,
            description = excluded.description,
            generation_prompt = excluded.generation_prompt,
            frame_count = excluded.frame_count,
            dimensions = excluded.dimensions,
            -- A re-plan is a new prompt, so the previous attempts no longer apply:
            -- an item that had exhausted its budget becomes generatable again. The
            -- lease has to be cleared with the status or the CHECK tying the two
            -- together fails.
            generation_attempt = CASE
              WHEN deviludo.asset_items.status IN ('generated', 'uploaded') THEN deviludo.asset_items.generation_attempt
              ELSE 0 END,
            generation_lease_expires_at = NULL,
            status = CASE
              WHEN deviludo.asset_items.status IN ('generated', 'uploaded') THEN deviludo.asset_items.status
              ELSE 'planned' END,
            error_message = CASE
              WHEN deviludo.asset_items.status IN ('generated', 'uploaded') THEN deviludo.asset_items.error_message
              ELSE NULL END,
            updated_at = clock_timestamp();

      DELETE FROM deviludo.asset_items
       WHERE workspace_id = job.workspace_id
         AND manifest_id = asset_manifest_id
         AND status NOT IN ('generated', 'uploaded')
         AND asset_key NOT IN (
           SELECT item->>'assetKey'
             FROM jsonb_array_elements(p_receipt #> '{assetManifest,items}') item
         );
    END IF;
  ELSIF job.kind = 'PROJECT_DOCUMENT_MAINTENANCE' THEN
    SELECT * INTO project
      FROM deviludo.projects
     WHERE workspace_id = job.workspace_id AND id = job.project_id
     FOR UPDATE;
    SELECT content INTO document
      FROM deviludo.project_documents
     WHERE workspace_id = job.workspace_id AND project_id = job.project_id
       AND revision = (job.payload->>'baseRevision')::bigint
     FOR UPDATE;
    IF document IS NULL
      OR project.last_activity_at <> (job.payload->>'activityAt')::timestamptz
    THEN RAISE EXCEPTION 'project document maintenance result is stale'; END IF;
    IF jsonb_typeof(p_receipt->'projectDocument') <> 'object'
      OR jsonb_typeof(p_receipt #> '{projectDocument,content}') <> 'object'
      OR jsonb_typeof(p_receipt #> '{projectDocument,content,introduction}') <> 'string'
      OR jsonb_typeof(p_receipt #> '{projectDocument,content,gameplay}') <> 'string'
      OR jsonb_typeof(p_receipt #> '{projectDocument,content,categories}') <> 'array'
      OR jsonb_array_length(p_receipt #> '{projectDocument,content,categories}') NOT BETWEEN 1 AND 32
      OR jsonb_typeof(p_receipt #> '{projectDocument,content,features}') <> 'array'
      OR jsonb_array_length(p_receipt #> '{projectDocument,content,features}') NOT BETWEEN 1 AND 32
      OR length(coalesce(p_receipt #>> '{projectDocument,markdown}', '')) NOT BETWEEN 1 AND 100000
    THEN RAISE EXCEPTION 'validated project document output is required'; END IF;
    IF (
      SELECT count(*) FROM jsonb_array_elements(p_executor_receipt->'outputObjects') item
       WHERE item->>'kind' = 'PROJECT_DOCUMENT'
    ) <> 1 THEN RAISE EXCEPTION 'one project document artifact is required'; END IF;
  END IF;

  INSERT INTO deviludo.executor_receipts(
    workspace_id, project_id, workflow_id, job_id, executor_id,
    isolation_generation, fencing_token, receipt, signature
  ) VALUES (
    job.workspace_id, job.project_id, job.workflow_id, job.id,
    p_executor_receipt->>'executorId', job.isolation_generation,
    job.fencing_token, p_executor_receipt, p_executor_receipt->>'signature'
  );

  FOR output IN SELECT value FROM jsonb_array_elements(p_executor_receipt->'outputObjects')
  LOOP
    INSERT INTO deviludo.artifacts(
      workspace_id, project_id, workflow_id, producing_job_id, kind,
      target_platform, bucket, object_key, sha256, size_bytes, metadata
    ) VALUES (
      job.workspace_id, job.project_id, job.workflow_id, job.id,
      (output->>'kind')::deviludo.artifact_kind,
      nullif(output->>'targetPlatform', '')::deviludo.server_os,
      output->>'bucket', output->>'key', output->>'sha256',
      (output->>'sizeBytes')::bigint, coalesce(output->'metadata', '{}'::jsonb)
    );
  END LOOP;

  IF e2e_content_failure THEN
    failure_summary := left(p_receipt #>> '{execution,summary}', 1800);
    UPDATE deviludo.jobs
       SET state = 'FAILED', receipt = p_receipt,
           last_error = 'E2E_PRODUCT: ' || failure_summary,
           before_reimage_proof = p_before_reimage_proof,
           cleanup_proof = p_cleanup_proof,
           after_reimage_proof = p_after_reimage_proof,
           lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
           heartbeat_at = NULL, updated_at = clock_timestamp()
     WHERE workspace_id = job.workspace_id AND id = job.id;
    UPDATE deviludo.jobs
       SET state = 'CANCELLED',
           lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
           heartbeat_at = NULL, fencing_token = fencing_token + 1,
           last_error = 'superseded by automatic E2E content repair',
           updated_at = clock_timestamp()
     WHERE workspace_id = job.workspace_id AND workflow_id = job.workflow_id
       AND kind = 'E2E_TEST' AND id <> job.id
       AND state IN ('QUEUED', 'RETRY', 'RUNNING');
    INSERT INTO deviludo.workflow_events(
      workspace_id, workflow_id, event_kind, event_data, idempotency_key
    ) VALUES (
      job.workspace_id, job.workflow_id, 'E2E_CONTENT_FAILED',
      jsonb_build_object(
        'jobId', job.id,
        'operatingSystem', job.target_operating_system,
        'summary', failure_summary
      ),
      'e2e-content-failed:' || job.id::text
    );
    SELECT count(*)::integer INTO repair_count
      FROM deviludo.jobs previous_repair
     WHERE previous_repair.workspace_id = job.workspace_id
       AND previous_repair.workflow_id = job.workflow_id
       AND previous_repair.kind = 'AGENT_GENERATION'
       AND previous_repair.payload ? 'repairFromE2eJobId';
    SELECT * INTO agent_settings
      FROM deviludo.instance_agent_settings
     WHERE singleton = true;
    IF repair_count < 3 AND agent_settings.singleton IS NOT NULL THEN
      UPDATE deviludo.workflow_instances
         SET state = 'AGENT_RUNNING', version = version + 1, updated_at = clock_timestamp()
       WHERE workspace_id = workflow.workspace_id AND id = workflow.id;
      PERFORM deviludo.enqueue_job(
        workflow.workspace_id, workflow.id, workflow.project_id, 'AGENT_GENERATION', NULL,
        workflow.id::text || ':agent:e2e-repair:' || job.id::text,
        jsonb_build_object(
          'repairFromE2eJobId', job.id,
          'repairAttempt', repair_count + 1,
          'failedPlatform', job.target_operating_system,
          'agentConfiguration', jsonb_build_object(
            'runtime', agent_settings.agent_runtime::text,
            'baseUrl', agent_settings.base_url,
            'models', CASE WHEN agent_settings.primary_model IS NULL THEN NULL ELSE jsonb_build_object(
              'primary', agent_settings.primary_model,
              'opus', agent_settings.opus_model,
              'sonnet', agent_settings.sonnet_model,
              'haiku', agent_settings.haiku_model,
              'subagent', agent_settings.subagent_model
            ) END,
            'credentialRef', agent_settings.credential_secret_ref,
            'revision', agent_settings.revision
          )
        )
      );
    ELSE
      UPDATE deviludo.workflow_instances
         SET state = 'FAILED', version = version + 1, updated_at = clock_timestamp()
       WHERE workspace_id = workflow.workspace_id AND id = workflow.id;
    END IF;
    RETURN true;
  END IF;

  IF job.kind = 'PROJECT_DOCUMENT_MAINTENANCE' THEN
    next_document_revision := (job.payload->>'baseRevision')::bigint + 1;
    UPDATE deviludo.project_documents
       SET revision = next_document_revision,
           content = p_receipt #> '{projectDocument,content}',
           markdown = p_receipt #>> '{projectDocument,markdown}',
           maintained_by = 'AGENT',
           updated_by_actor_account_id = NULL,
           last_agent_maintained_at = clock_timestamp(),
           updated_at = clock_timestamp()
     WHERE workspace_id = job.workspace_id AND project_id = job.project_id;
    INSERT INTO deviludo.project_document_revisions(
      workspace_id, project_id, revision, content, markdown, source, maintenance_job_id
    ) VALUES (
      job.workspace_id, job.project_id, next_document_revision,
      p_receipt #> '{projectDocument,content}', p_receipt #>> '{projectDocument,markdown}',
      'AGENT_IDLE_MAINTENANCE', job.id
    );
  END IF;

  UPDATE deviludo.jobs
     SET state = 'SUCCEEDED', receipt = p_receipt,
         last_error = NULL,
         before_reimage_proof = p_before_reimage_proof,
         cleanup_proof = p_cleanup_proof,
         after_reimage_proof = p_after_reimage_proof,
         lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
         heartbeat_at = NULL, updated_at = clock_timestamp()
   WHERE workspace_id = job.workspace_id AND id = job.id;
  UPDATE deviludo.operation_receipts
     SET state = 'RECEIPTED', receipt = p_receipt, updated_at = clock_timestamp()
   WHERE workspace_id = job.workspace_id AND job_id = job.id
     AND state IN ('REGISTERED', 'IN_PROGRESS');
  INSERT INTO deviludo.workflow_events(
    workspace_id, workflow_id, event_kind, event_data, idempotency_key
  ) VALUES (
    job.workspace_id, job.workflow_id, 'JOB_SUCCEEDED',
    jsonb_build_object('jobId', job.id, 'jobKind', job.kind, 'operatingSystem', job.target_operating_system),
    'job-succeeded:' || job.id::text
  );

  IF job.kind = 'PROJECT_DOCUMENT_MAINTENANCE' THEN
    NULL;
  ELSIF workflow.state = 'AGENT_RUNNING' AND job.kind = 'AGENT_GENERATION' THEN
    IF asset_auto_generate THEN
      UPDATE deviludo.workflow_instances SET state = 'ASSET_GENERATING', version = version + 1,
        updated_at = clock_timestamp() WHERE workspace_id = workflow.workspace_id AND id = workflow.id;
    ELSE
      UPDATE deviludo.workflow_instances SET state = 'ARTIFACT_BUILDING', version = version + 1,
        updated_at = clock_timestamp() WHERE workspace_id = workflow.workspace_id AND id = workflow.id;
      -- The predecessor job id is part of every forward idempotency key. A stage
      -- rerun leaves the superseded job row (and its unique key) behind; reusing
      -- the first delivery's fixed key would return that CANCELLED row and move
      -- the workflow into a running state with no runnable downstream job.
      PERFORM deviludo.enqueue_job(job.workspace_id, job.workflow_id, job.project_id, 'ARTIFACT_BUILD', NULL,
        job.workflow_id::text || ':artifact:after:' || job.id::text,
        jsonb_build_object('targetPlatforms', workflow.target_platforms));
    END IF;
  ELSIF workflow.state = 'ARTIFACT_BUILDING' AND job.kind = 'ARTIFACT_BUILD' THEN
    UPDATE deviludo.workflow_instances SET state = 'E2E_TESTING', version = version + 1,
      updated_at = clock_timestamp() WHERE workspace_id = workflow.workspace_id AND id = workflow.id;
    FOREACH platform IN ARRAY workflow.target_platforms
    LOOP
      PERFORM deviludo.enqueue_job(job.workspace_id, job.workflow_id, job.project_id, 'E2E_TEST', platform,
        job.workflow_id::text || ':e2e:' || platform::text || ':after:' || job.id::text);
    END LOOP;
  ELSIF workflow.state = 'E2E_TESTING' AND job.kind = 'E2E_TEST'
    AND NOT EXISTS (
      SELECT 1 FROM unnest(workflow.target_platforms) AS required_platform(operating_system)
       WHERE NOT EXISTS (
         SELECT 1 FROM deviludo.jobs successful_test
          WHERE successful_test.workspace_id = job.workspace_id
            AND successful_test.workflow_id = job.workflow_id
            AND successful_test.kind = 'E2E_TEST'
            AND successful_test.target_operating_system = required_platform.operating_system
            AND successful_test.state = 'SUCCEEDED'
       )
    )
  THEN
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
  END IF;
  SELECT * INTO workflow FROM deviludo.workflow_instances
   WHERE workspace_id = job.workspace_id AND id = job.workflow_id;
  IF workflow.state = 'SUCCEEDED' AND workflow.development_actor_account_id IS NOT NULL THEN
    INSERT INTO deviludo.project_source_ready_outbox(
      workspace_id, project_id, workflow_id, source_revision, content_digest,
      development_actor_account_id
    )
    SELECT source.workspace_id, source.project_id, job.workflow_id, source.revision,
           source.content_digest, workflow.development_actor_account_id
      FROM deviludo.project_source_revisions source
     WHERE source.workspace_id = job.workspace_id AND source.project_id = job.project_id
     ORDER BY source.revision DESC LIMIT 1
    ON CONFLICT (workspace_id, project_id, workflow_id, source_revision) DO NOTHING;
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
  terminal boolean;
BEGIN
  SELECT * INTO job FROM deviludo.jobs
   WHERE id = p_job_id AND state = 'RUNNING'
     AND lease_token = p_lease_token AND fencing_token = p_fencing_token;
  IF job.id IS NULL THEN RETURN false; END IF;
  SELECT * INTO workflow FROM deviludo.workflow_instances
   WHERE workspace_id = job.workspace_id AND id = job.workflow_id
   FOR UPDATE;
  SELECT * INTO job FROM deviludo.jobs
   WHERE id = p_job_id AND state = 'RUNNING'
     AND lease_token = p_lease_token AND fencing_token = p_fencing_token
   FOR UPDATE;
  IF job.id IS NULL THEN RETURN false; END IF;
  terminal := job.attempt >= job.max_attempts;
  UPDATE deviludo.jobs
     SET state = CASE WHEN terminal THEN 'FAILED'::deviludo.job_state ELSE 'RETRY'::deviludo.job_state END,
         available_at = clock_timestamp() + make_interval(secs => least(3600, (2 ^ greatest(attempt, 1))::integer)),
         lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL, heartbeat_at = NULL,
         last_error = left(p_reason, 2000), updated_at = clock_timestamp()
   WHERE workspace_id = job.workspace_id AND id = job.id;
  INSERT INTO deviludo.workflow_events(workspace_id, workflow_id, event_kind, event_data, idempotency_key)
  VALUES (
    job.workspace_id, job.workflow_id,
    CASE WHEN terminal THEN 'JOB_FAILED' ELSE 'JOB_RETRY_SCHEDULED' END,
    jsonb_build_object('jobId', job.id, 'attempt', job.attempt, 'reason', left(p_reason, 2000)),
    'job-failure:' || job.id::text || ':' || job.attempt::text
  );
  IF terminal AND job.kind <> 'PROJECT_DOCUMENT_MAINTENANCE' THEN
    UPDATE deviludo.workflow_instances SET state = 'FAILED', version = version + 1,
      updated_at = clock_timestamp()
     WHERE workspace_id = job.workspace_id AND id = job.workflow_id
       AND state NOT IN ('SUCCEEDED', 'FAILED', 'CANCELLED');
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
       SET state = CASE WHEN attempt >= max_attempts
                        THEN 'FAILED'::deviludo.job_state
                        ELSE 'RETRY'::deviludo.job_state END,
           available_at = clock_timestamp() + make_interval(secs => least(3600, (2 ^ greatest(attempt, 1))::integer)),
           lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL, heartbeat_at = NULL,
           last_error = 'lease expired', updated_at = clock_timestamp()
     WHERE state = 'RUNNING' AND lease_expires_at < clock_timestamp()
     RETURNING workspace_id, workflow_id, id, attempt, state
  ), events AS (
    INSERT INTO deviludo.workflow_events(
      workspace_id, workflow_id, event_kind, event_data, idempotency_key
    )
    SELECT workspace_id, workflow_id,
      CASE WHEN state = 'FAILED' THEN 'JOB_FAILED' ELSE 'JOB_RETRY_SCHEDULED' END,
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

CREATE OR REPLACE FUNCTION deviludo.pull_source_ready_events(p_limit integer DEFAULT 100)
RETURNS TABLE (
  event_id uuid,
  workspace_id uuid,
  project_id uuid,
  workflow_id uuid,
  source_revision bigint,
  content_digest text,
  development_actor_account_id uuid,
  created_at timestamptz
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = pg_catalog, deviludo
SET row_security = off
AS $$
  SELECT event.event_id, event.workspace_id, event.project_id, event.workflow_id,
         event.source_revision, event.content_digest,
         event.development_actor_account_id, event.created_at
    FROM deviludo.project_source_ready_outbox event
   WHERE event.acknowledged_at IS NULL
   ORDER BY event.created_at, event.event_id
   LIMIT greatest(1, least(p_limit, 500))
$$;
ALTER FUNCTION deviludo.pull_source_ready_events(integer) OWNER TO deviludo_claim_executor;

CREATE OR REPLACE FUNCTION deviludo.acknowledge_source_ready_events(p_event_ids uuid[])
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
  UPDATE deviludo.project_source_ready_outbox
     SET acknowledged_at = coalesce(acknowledged_at, clock_timestamp())
   WHERE event_id = ANY(p_event_ids);
  GET DIAGNOSTICS acknowledged = ROW_COUNT;
  RETURN acknowledged;
END
$$;
ALTER FUNCTION deviludo.acknowledge_source_ready_events(uuid[]) OWNER TO deviludo_claim_executor;

CREATE OR REPLACE FUNCTION deviludo.reconcile_p0_capacity()
RETURNS void
LANGUAGE sql
SECURITY INVOKER
SET search_path = pg_catalog, deviludo
AS $$
  INSERT INTO deviludo.pool_capacity_intents(pool_kind, desired_nodes, reason, operation_key)
  SELECT pool.kind, pool.desired_nodes, 'P0_RECONCILIATION',
         'p0:' || pool.kind::text || ':' || pool.desired_nodes::text || ':' || extract(epoch FROM date_trunc('hour', clock_timestamp()))::text
    FROM deviludo.server_pools pool
   WHERE NOT EXISTS (
     SELECT 1 FROM deviludo.pool_capacity_intents intent
      WHERE intent.pool_kind = pool.kind
        AND intent.desired_nodes = pool.desired_nodes
        AND intent.created_at > clock_timestamp() - interval '1 hour'
   )
  ON CONFLICT (operation_key) DO NOTHING
$$;

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
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA deviludo TO deviludo_api, deviludo_scheduler, deviludo_sandbox;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  deviludo.workspaces, deviludo.projects, deviludo.project_source_revisions,
  deviludo.project_source_ready_outbox, deviludo.project_documents,
  deviludo.project_document_revisions, deviludo.project_conversations,
  deviludo.conversation_messages, deviludo.agent_installations,
  deviludo.workflow_instances, deviludo.workflow_events, deviludo.jobs,
  deviludo.external_signals, deviludo.job_progress_events, deviludo.job_guidance_messages,
  deviludo.operation_receipts,
  deviludo.artifacts, deviludo.artifact_inputs, deviludo.executor_receipts,
  deviludo.asset_manifests, deviludo.asset_items
  TO deviludo_api;
GRANT SELECT, INSERT, UPDATE ON deviludo.instance_agent_settings TO deviludo_api;
GRANT SELECT, INSERT, UPDATE ON deviludo.instance_image_generation_settings TO deviludo_api;
GRANT SELECT, INSERT, DELETE ON deviludo.project_creation_receipts TO deviludo_api;
GRANT SELECT, INSERT, UPDATE ON
  deviludo.projects, deviludo.project_source_revisions, deviludo.project_source_ready_outbox,
  deviludo.project_documents, deviludo.project_document_revisions,
  deviludo.workflow_instances, deviludo.workflow_events, deviludo.jobs,
  deviludo.external_signals, deviludo.job_progress_events, deviludo.job_guidance_messages,
  deviludo.operation_receipts,
  deviludo.artifacts, deviludo.artifact_inputs, deviludo.executor_receipts
  TO deviludo_scheduler;
-- The asset generator resolves the configured provider and credential ref through
-- an ordinary pooled read before calling out, so the scheduler reads this row
-- directly rather than through a definer function.
GRANT SELECT ON deviludo.instance_image_generation_settings TO deviludo_scheduler;
GRANT SELECT, INSERT, UPDATE ON
  deviludo.projects, deviludo.project_source_revisions, deviludo.project_source_ready_outbox,
  deviludo.project_documents, deviludo.project_document_revisions,
  deviludo.workflow_instances, deviludo.jobs, deviludo.workflow_events, deviludo.operation_receipts,
  deviludo.job_progress_events, deviludo.job_guidance_messages,
  deviludo.artifacts, deviludo.artifact_inputs, deviludo.executor_receipts,
  deviludo.asset_manifests, deviludo.asset_items
  TO deviludo_sandbox;
-- complete_job runs with the caller's privileges and Agent generation is
-- completed by the sandbox role. Re-planning a manifest drops the asset keys the
-- Agent no longer asks for, so that role needs DELETE on the items themselves —
-- and only those; the manifest row is never removed here.
GRANT DELETE ON deviludo.asset_items TO deviludo_sandbox;

GRANT EXECUTE ON FUNCTION deviludo.current_workspace_id() TO
  deviludo_api, deviludo_scheduler, deviludo_sandbox;
GRANT SELECT ON deviludo.project_creation_receipts TO deviludo_claim_executor;
GRANT EXECUTE ON FUNCTION deviludo.required_capabilities(deviludo.job_kind) TO
  deviludo_api, deviludo_scheduler, deviludo_sandbox, deviludo_claim_executor;
GRANT EXECUTE ON FUNCTION deviludo.delivery_stages(deviludo.workflow_profile) TO
  deviludo_api, deviludo_scheduler, deviludo_sandbox;
GRANT EXECUTE ON FUNCTION deviludo.stage_running_state(deviludo.job_kind) TO
  deviludo_api, deviludo_scheduler, deviludo_sandbox;
GRANT EXECUTE ON FUNCTION deviludo.enqueue_job(
  uuid, uuid, uuid, deviludo.job_kind, deviludo.server_os, text, jsonb
) TO deviludo_api, deviludo_scheduler, deviludo_sandbox, deviludo_claim_executor;
GRANT EXECUTE ON FUNCTION deviludo.claim_job(text, deviludo.server_pool_kind, integer)
  TO deviludo_api, deviludo_sandbox;
GRANT EXECUTE ON FUNCTION deviludo.accept_workflow_signal(uuid, text, text, jsonb)
  TO deviludo_api;
GRANT EXECUTE ON FUNCTION deviludo.complete_job(uuid, uuid, bigint, bigint, jsonb, jsonb, text, text, text)
  TO deviludo_api, deviludo_sandbox;
GRANT EXECUTE ON FUNCTION deviludo.fail_job(uuid, uuid, bigint, text)
  TO deviludo_api, deviludo_sandbox;
GRANT EXECUTE ON FUNCTION deviludo.recover_expired_jobs(), deviludo.reconcile_p0_capacity()
  TO deviludo_scheduler;
-- Asset generation is driven by the scheduler role: it is periodic background work
-- like the other scheduler tasks, not something an executor leases.
GRANT EXECUTE ON FUNCTION deviludo.claim_asset_generation(integer, integer) TO deviludo_scheduler;
GRANT EXECUTE ON FUNCTION deviludo.complete_asset_generation(uuid, uuid, text, text, text, bigint)
  TO deviludo_scheduler;
GRANT EXECUTE ON FUNCTION deviludo.fail_asset_generation(uuid, uuid, text) TO deviludo_scheduler;
GRANT EXECUTE ON FUNCTION deviludo.advance_asset_workflows(integer) TO deviludo_scheduler;
GRANT EXECUTE ON FUNCTION deviludo.pull_source_ready_events(integer),
  deviludo.acknowledge_source_ready_events(uuid[]) TO deviludo_api;
GRANT EXECUTE ON FUNCTION deviludo.schedule_idle_project_document_maintenance(integer, integer)
  TO deviludo_scheduler;
GRANT EXECUTE ON FUNCTION deviludo.claim_project_import_analysis(integer) TO deviludo_api;
GRANT EXECUTE ON FUNCTION deviludo.cleanup_expired_executor_state() TO deviludo_scheduler;

GRANT SELECT, UPDATE ON deviludo.jobs TO deviludo_claim_executor;
GRANT INSERT ON deviludo.jobs, deviludo.artifact_inputs TO deviludo_claim_executor;
GRANT SELECT, UPDATE ON deviludo.projects TO deviludo_claim_executor;
GRANT UPDATE ON deviludo.workflow_instances TO deviludo_claim_executor;
GRANT SELECT ON deviludo.project_documents,
  deviludo.project_source_revisions, deviludo.project_source_ready_outbox,
  deviludo.workflow_instances, deviludo.instance_agent_settings,
  deviludo.runtime_images, deviludo.artifacts, deviludo.artifact_inputs
  TO deviludo_claim_executor;
GRANT UPDATE ON deviludo.project_source_ready_outbox TO deviludo_claim_executor;
-- The asset generation lease and its settlement run as this role, which is the
-- owner of those SECURITY DEFINER functions.
GRANT SELECT, UPDATE ON deviludo.asset_items TO deviludo_claim_executor;
GRANT SELECT ON deviludo.asset_manifests, deviludo.instance_image_generation_settings
  TO deviludo_claim_executor;
GRANT SELECT, INSERT, UPDATE ON deviludo.workspace_claim_fairness TO deviludo_claim_executor;
GRANT SELECT ON deviludo.workspaces TO deviludo_claim_executor;
GRANT SELECT, INSERT ON deviludo.workflow_events TO deviludo_claim_executor;
GRANT SELECT, DELETE ON deviludo.e2e_enrollment_tokens TO deviludo_claim_executor;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA deviludo TO deviludo_claim_executor;

COMMIT;
