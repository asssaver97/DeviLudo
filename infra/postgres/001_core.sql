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
  'DRAFT', 'AGENT_RUNNING', 'ARTIFACT_BUILDING', 'E2E_TESTING', 'SIGNING',
  'STEAM_PUBLISHING', 'CLEAN_INSTALL_VERIFYING', 'SUCCEEDED', 'FAILED', 'CANCELLED'
);
CREATE TYPE deviludo.job_kind AS ENUM (
  'AGENT_GENERATION', 'ARTIFACT_BUILD', 'STEAM_PUBLISH',
  'E2E_TEST', 'ARTIFACT_SIGN', 'STEAM_CLEAN_INSTALL'
);
CREATE TYPE deviludo.job_state AS ENUM (
  'QUEUED', 'RUNNING', 'RETRY', 'SUCCEEDED', 'FAILED', 'CANCELLED'
);
CREATE TYPE deviludo.operation_state AS ENUM (
  'REGISTERED', 'IN_PROGRESS', 'RECEIPTED', 'RECONCILIATION_REQUIRED', 'VOID'
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
    'BUSINESS_API', 'WORKFLOW_SCHEDULER', 'AGENT_GENERATION', 'ARTIFACT_BUILD', 'STEAM_PUBLISH'
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
  current_tenant_id uuid,
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

CREATE TABLE deviludo.tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE deviludo.projects (
  tenant_id uuid NOT NULL REFERENCES deviludo.tenants(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE deviludo.agent_installations (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  project_id uuid,
  agent_kind text NOT NULL CHECK (length(agent_kind) BETWEEN 1 AND 80),
  exact_version text NOT NULL CHECK (length(exact_version) BETWEEN 1 AND 120),
  image_digest text NOT NULL CHECK (image_digest ~ '^sha256:[0-9a-f]{64}$'),
  execution_pool deviludo.server_pool_kind NOT NULL DEFAULT 'CORE' CHECK (execution_pool = 'CORE'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id) REFERENCES deviludo.tenants(id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES deviludo.projects(tenant_id, id)
);

CREATE TABLE deviludo.workflow_instances (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  state deviludo.workflow_state NOT NULL DEFAULT 'DRAFT',
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
  state_data jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(state_data) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id) REFERENCES deviludo.tenants(id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES deviludo.projects(tenant_id, id)
);

CREATE TABLE deviludo.workflow_events (
  tenant_id uuid NOT NULL,
  event_id bigint GENERATED ALWAYS AS IDENTITY,
  workflow_id uuid NOT NULL,
  event_kind text NOT NULL CHECK (length(event_kind) BETWEEN 1 AND 120),
  event_data jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(event_data) = 'object'),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 300),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, event_id),
  UNIQUE (tenant_id, workflow_id, idempotency_key),
  FOREIGN KEY (tenant_id, workflow_id)
    REFERENCES deviludo.workflow_instances(tenant_id, id)
);

CREATE TABLE deviludo.jobs (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  workflow_id uuid NOT NULL,
  project_id uuid NOT NULL,
  kind deviludo.job_kind NOT NULL,
  pool_kind deviludo.server_pool_kind NOT NULL,
  target_operating_system deviludo.server_os,
  required_capabilities text[] NOT NULL CHECK (cardinality(required_capabilities) > 0),
  exclusive boolean NOT NULL,
  isolation_generation bigint NOT NULL DEFAULT 1 CHECK (isolation_generation > 0),
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
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id) REFERENCES deviludo.tenants(id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES deviludo.projects(tenant_id, id),
  FOREIGN KEY (tenant_id, workflow_id) REFERENCES deviludo.workflow_instances(tenant_id, id),
  CHECK (
    (
      kind IN ('AGENT_GENERATION', 'ARTIFACT_BUILD', 'STEAM_PUBLISH')
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

CREATE TABLE deviludo.external_signals (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  workflow_id uuid NOT NULL,
  signal_kind text NOT NULL CHECK (length(signal_kind) BETWEEN 1 AND 120),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 300),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, workflow_id, idempotency_key),
  FOREIGN KEY (tenant_id, workflow_id)
    REFERENCES deviludo.workflow_instances(tenant_id, id)
);

CREATE TABLE deviludo.operation_receipts (
  tenant_id uuid NOT NULL,
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
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id) REFERENCES deviludo.tenants(id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES deviludo.projects(tenant_id, id),
  FOREIGN KEY (tenant_id, workflow_id) REFERENCES deviludo.workflow_instances(tenant_id, id),
  FOREIGN KEY (tenant_id, job_id) REFERENCES deviludo.jobs(tenant_id, id)
);

CREATE TABLE deviludo.tenant_claim_fairness (
  tenant_id uuid PRIMARY KEY REFERENCES deviludo.tenants(id),
  last_claimed_at timestamptz NOT NULL
);

CREATE OR REPLACE FUNCTION deviludo.current_tenant_id()
RETURNS uuid
LANGUAGE sql
STABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $$
  SELECT nullif(current_setting('app.tenant_id', true), '')::uuid
$$;

ALTER TABLE deviludo.tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE deviludo.tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON deviludo.tenants
  USING (id = deviludo.current_tenant_id())
  WITH CHECK (id = deviludo.current_tenant_id());

DO $rls$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'projects', 'agent_installations', 'workflow_instances', 'workflow_events',
    'jobs', 'external_signals', 'operation_receipts', 'tenant_claim_fairness'
  ]
  LOOP
    EXECUTE format('ALTER TABLE deviludo.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE deviludo.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON deviludo.%I USING (tenant_id = deviludo.current_tenant_id()) WITH CHECK (tenant_id = deviludo.current_tenant_id())',
      table_name
    );
  END LOOP;
END
$rls$;

CREATE OR REPLACE FUNCTION deviludo.required_capabilities(p_kind deviludo.job_kind)
RETURNS text[]
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $$
  SELECT CASE p_kind
    WHEN 'AGENT_GENERATION' THEN ARRAY['MICROVM', 'NETWORK_POLICY']
    WHEN 'ARTIFACT_BUILD' THEN ARRAY['RESTRICTED_CONTAINER', 'BUILD_TOOLCHAIN']
    WHEN 'STEAM_PUBLISH' THEN ARRAY['RESTRICTED_CONTAINER', 'STEAMCMD']
    WHEN 'E2E_TEST' THEN ARRAY['GAME_RUNTIME', 'TRUSTED_REIMAGE']
    WHEN 'ARTIFACT_SIGN' THEN ARRAY['SIGNING', 'HSM', 'TRUSTED_REIMAGE']
    WHEN 'STEAM_CLEAN_INSTALL' THEN ARRAY['STEAM_CLIENT', 'TRUSTED_REIMAGE']
  END
$$;

CREATE OR REPLACE FUNCTION deviludo.enqueue_job(
  p_tenant_id uuid,
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
BEGIN
  v_pool := CASE
    WHEN p_kind IN ('AGENT_GENERATION', 'ARTIFACT_BUILD', 'STEAM_PUBLISH') THEN 'CORE'
    WHEN p_operating_system = 'linux' THEN 'E2E_LINUX'
    WHEN p_operating_system = 'windows' THEN 'E2E_WINDOWS'
    WHEN p_operating_system = 'macos' THEN 'E2E_MACOS'
  END;
  IF v_pool IS NULL THEN RAISE EXCEPTION 'invalid fixed job placement'; END IF;
  INSERT INTO deviludo.jobs (
    tenant_id, workflow_id, project_id, kind, pool_kind, target_operating_system,
    required_capabilities, exclusive, idempotency_key, payload
  )
  VALUES (
    p_tenant_id, p_workflow_id, p_project_id, p_kind, v_pool,
    CASE WHEN v_pool = 'CORE' THEN NULL ELSE p_operating_system END,
    deviludo.required_capabilities(p_kind), v_pool <> 'CORE', p_idempotency_key, p_payload
  )
  ON CONFLICT (tenant_id, idempotency_key) DO UPDATE
    SET updated_at = deviludo.jobs.updated_at
  RETURNING id INTO v_id;
  RETURN v_id;
END
$$;

CREATE OR REPLACE FUNCTION deviludo.claim_job(
  p_executor_id text,
  p_pool_kind deviludo.server_pool_kind,
  p_lease_seconds integer
)
RETURNS TABLE ("jobId" uuid, "tenantId" uuid, "leaseToken" uuid)
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
    LEFT JOIN deviludo.tenant_claim_fairness fairness
      ON fairness.tenant_id = job.tenant_id
   WHERE job.pool_kind = p_pool_kind
     AND job.state IN ('QUEUED', 'RETRY')
     AND job.available_at <= clock_timestamp()
     AND NOT EXISTS (
       SELECT 1
         FROM deviludo.jobs prior
        WHERE prior.tenant_id = job.tenant_id
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
         lease_owner = p_executor_id,
         lease_token = next_token,
         lease_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds),
         heartbeat_at = clock_timestamp(),
         fencing_token = fencing_token + 1,
         updated_at = clock_timestamp()
   WHERE tenant_id = candidate.tenant_id AND id = candidate.id;
  INSERT INTO deviludo.tenant_claim_fairness(tenant_id, last_claimed_at)
  VALUES (candidate.tenant_id, clock_timestamp())
  ON CONFLICT (tenant_id) DO UPDATE SET last_claimed_at = EXCLUDED.last_claimed_at;
  RETURN QUERY SELECT candidate.id, candidate.tenant_id, next_token;
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
  inserted_id uuid;
BEGIN
  SELECT * INTO workflow
    FROM deviludo.workflow_instances
   WHERE id = p_workflow_id
   FOR UPDATE;
  IF workflow.id IS NULL THEN RAISE EXCEPTION 'workflow not found'; END IF;
  INSERT INTO deviludo.external_signals(
    tenant_id, workflow_id, signal_kind, payload, idempotency_key
  )
  VALUES (
    workflow.tenant_id, workflow.id, p_signal_kind, p_payload, p_idempotency_key
  )
  ON CONFLICT (tenant_id, workflow_id, idempotency_key) DO NOTHING
  RETURNING id INTO inserted_id;
  IF inserted_id IS NULL THEN RETURN false; END IF;

  INSERT INTO deviludo.workflow_events(
    tenant_id, workflow_id, event_kind, event_data, idempotency_key
  )
  VALUES (
    workflow.tenant_id, workflow.id, p_signal_kind, p_payload, 'signal:' || p_idempotency_key
  );

  IF p_signal_kind = 'SPEC_APPROVED' AND workflow.state = 'DRAFT' THEN
    UPDATE deviludo.workflow_instances
       SET state = 'AGENT_RUNNING', version = version + 1, updated_at = clock_timestamp()
     WHERE tenant_id = workflow.tenant_id AND id = workflow.id;
    PERFORM deviludo.enqueue_job(
      workflow.tenant_id, workflow.id, workflow.project_id, 'AGENT_GENERATION', NULL,
      workflow.id::text || ':agent', '{}'::jsonb
    );
  ELSIF p_signal_kind = 'CANCEL_REQUESTED' THEN
    UPDATE deviludo.workflow_instances
       SET state = 'CANCELLED', version = version + 1, updated_at = clock_timestamp()
     WHERE tenant_id = workflow.tenant_id AND id = workflow.id
       AND state NOT IN ('SUCCEEDED', 'FAILED', 'CANCELLED');
    UPDATE deviludo.jobs
       SET state = 'CANCELLED',
           lease_owner = NULL,
           lease_token = NULL,
           lease_expires_at = NULL,
           heartbeat_at = NULL,
           fencing_token = fencing_token + 1,
           updated_at = clock_timestamp()
     WHERE tenant_id = workflow.tenant_id AND workflow_id = workflow.id
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
  platform deviludo.server_os;
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
   WHERE tenant_id = job.tenant_id AND id = job.workflow_id
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

  UPDATE deviludo.jobs
     SET state = 'SUCCEEDED', receipt = p_receipt,
         before_reimage_proof = p_before_reimage_proof,
         cleanup_proof = p_cleanup_proof,
         after_reimage_proof = p_after_reimage_proof,
         lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
         heartbeat_at = NULL, updated_at = clock_timestamp()
   WHERE tenant_id = job.tenant_id AND id = job.id;
  UPDATE deviludo.operation_receipts
     SET state = 'RECEIPTED', receipt = p_receipt, updated_at = clock_timestamp()
   WHERE tenant_id = job.tenant_id AND job_id = job.id
     AND state IN ('REGISTERED', 'IN_PROGRESS');
  INSERT INTO deviludo.workflow_events(
    tenant_id, workflow_id, event_kind, event_data, idempotency_key
  ) VALUES (
    job.tenant_id, job.workflow_id, 'JOB_SUCCEEDED',
    jsonb_build_object('jobId', job.id, 'jobKind', job.kind, 'operatingSystem', job.target_operating_system),
    'job-succeeded:' || job.id::text
  );

  IF workflow.state = 'AGENT_RUNNING' AND job.kind = 'AGENT_GENERATION' THEN
    UPDATE deviludo.workflow_instances SET state = 'ARTIFACT_BUILDING', version = version + 1,
      updated_at = clock_timestamp() WHERE tenant_id = workflow.tenant_id AND id = workflow.id;
    PERFORM deviludo.enqueue_job(job.tenant_id, job.workflow_id, job.project_id, 'ARTIFACT_BUILD', NULL,
      job.workflow_id::text || ':artifact');
  ELSIF workflow.state = 'ARTIFACT_BUILDING' AND job.kind = 'ARTIFACT_BUILD' THEN
    UPDATE deviludo.workflow_instances SET state = 'E2E_TESTING', version = version + 1,
      updated_at = clock_timestamp() WHERE tenant_id = workflow.tenant_id AND id = workflow.id;
    FOREACH platform IN ARRAY ARRAY['linux', 'windows', 'macos']::deviludo.server_os[]
    LOOP
      PERFORM deviludo.enqueue_job(job.tenant_id, job.workflow_id, job.project_id, 'E2E_TEST', platform,
        job.workflow_id::text || ':e2e:' || platform::text);
    END LOOP;
  ELSIF workflow.state = 'E2E_TESTING' AND job.kind = 'E2E_TEST'
    AND NOT EXISTS (
      SELECT 1 FROM deviludo.jobs
       WHERE tenant_id = job.tenant_id AND workflow_id = job.workflow_id
         AND kind = 'E2E_TEST' AND state <> 'SUCCEEDED'
    )
  THEN
    UPDATE deviludo.workflow_instances SET state = 'SIGNING', version = version + 1,
      updated_at = clock_timestamp() WHERE tenant_id = workflow.tenant_id AND id = workflow.id;
    FOREACH platform IN ARRAY ARRAY['linux', 'windows', 'macos']::deviludo.server_os[]
    LOOP
      PERFORM deviludo.enqueue_job(job.tenant_id, job.workflow_id, job.project_id, 'ARTIFACT_SIGN', platform,
        job.workflow_id::text || ':sign:' || platform::text);
    END LOOP;
  ELSIF workflow.state = 'SIGNING' AND job.kind = 'ARTIFACT_SIGN'
    AND NOT EXISTS (
      SELECT 1 FROM deviludo.jobs
       WHERE tenant_id = job.tenant_id AND workflow_id = job.workflow_id
         AND kind = 'ARTIFACT_SIGN' AND state <> 'SUCCEEDED'
    )
  THEN
    UPDATE deviludo.workflow_instances SET state = 'STEAM_PUBLISHING', version = version + 1,
      updated_at = clock_timestamp() WHERE tenant_id = workflow.tenant_id AND id = workflow.id;
    PERFORM deviludo.enqueue_job(job.tenant_id, job.workflow_id, job.project_id, 'STEAM_PUBLISH', NULL,
      job.workflow_id::text || ':publish');
  ELSIF workflow.state = 'STEAM_PUBLISHING' AND job.kind = 'STEAM_PUBLISH' THEN
    UPDATE deviludo.workflow_instances SET state = 'CLEAN_INSTALL_VERIFYING', version = version + 1,
      updated_at = clock_timestamp() WHERE tenant_id = workflow.tenant_id AND id = workflow.id;
    FOREACH platform IN ARRAY ARRAY['linux', 'windows', 'macos']::deviludo.server_os[]
    LOOP
      PERFORM deviludo.enqueue_job(job.tenant_id, job.workflow_id, job.project_id, 'STEAM_CLEAN_INSTALL', platform,
        job.workflow_id::text || ':clean-install:' || platform::text);
    END LOOP;
  ELSIF workflow.state = 'CLEAN_INSTALL_VERIFYING' AND job.kind = 'STEAM_CLEAN_INSTALL'
    AND NOT EXISTS (
      SELECT 1 FROM deviludo.jobs
       WHERE tenant_id = job.tenant_id AND workflow_id = job.workflow_id
         AND kind = 'STEAM_CLEAN_INSTALL' AND state <> 'SUCCEEDED'
    )
  THEN
    UPDATE deviludo.workflow_instances SET state = 'SUCCEEDED', version = version + 1,
      updated_at = clock_timestamp() WHERE tenant_id = workflow.tenant_id AND id = workflow.id;
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
   WHERE tenant_id = job.tenant_id AND id = job.workflow_id
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
   WHERE tenant_id = job.tenant_id AND id = job.id;
  INSERT INTO deviludo.workflow_events(tenant_id, workflow_id, event_kind, event_data, idempotency_key)
  VALUES (
    job.tenant_id, job.workflow_id,
    CASE WHEN terminal THEN 'JOB_FAILED' ELSE 'JOB_RETRY_SCHEDULED' END,
    jsonb_build_object('jobId', job.id, 'attempt', job.attempt, 'reason', left(p_reason, 2000)),
    'job-failure:' || job.id::text || ':' || job.attempt::text
  );
  IF terminal THEN
    UPDATE deviludo.workflow_instances SET state = 'FAILED', version = version + 1,
      updated_at = clock_timestamp()
     WHERE tenant_id = job.tenant_id AND id = job.workflow_id
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
     RETURNING tenant_id, workflow_id, id, attempt, state
  ), events AS (
    INSERT INTO deviludo.workflow_events(
      tenant_id, workflow_id, event_kind, event_data, idempotency_key
    )
    SELECT tenant_id, workflow_id,
      CASE WHEN state = 'FAILED' THEN 'JOB_FAILED' ELSE 'JOB_RETRY_SCHEDULED' END,
      jsonb_build_object('jobId', id, 'attempt', attempt, 'reason', 'lease expired'),
      'lease-expired:' || id::text || ':' || attempt::text
    FROM expired
    ON CONFLICT (tenant_id, workflow_id, idempotency_key) DO NOTHING
  )
  SELECT count(*) INTO recovered FROM expired;
  RETURN recovered;
END
$$;
ALTER FUNCTION deviludo.recover_expired_jobs() OWNER TO deviludo_claim_executor;

CREATE OR REPLACE FUNCTION deviludo.reconcile_p0_capacity()
RETURNS void
LANGUAGE sql
SECURITY DEFINER
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

REVOKE ALL ON ALL TABLES IN SCHEMA deviludo FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA deviludo FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA deviludo FROM PUBLIC;

GRANT SELECT ON deviludo.server_pools, deviludo.server_nodes, deviludo.pool_capacity_intents
  TO deviludo_api, deviludo_scheduler;
GRANT INSERT, UPDATE ON deviludo.server_nodes TO deviludo_api;
GRANT INSERT, SELECT ON deviludo.pool_capacity_intents TO deviludo_scheduler;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA deviludo TO deviludo_api, deviludo_scheduler;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  deviludo.tenants, deviludo.projects, deviludo.agent_installations,
  deviludo.workflow_instances, deviludo.workflow_events, deviludo.jobs,
  deviludo.external_signals, deviludo.operation_receipts
  TO deviludo_api;
GRANT SELECT, INSERT, UPDATE ON
  deviludo.workflow_instances, deviludo.workflow_events, deviludo.jobs,
  deviludo.external_signals, deviludo.operation_receipts
  TO deviludo_scheduler;
GRANT SELECT, INSERT, UPDATE ON
  deviludo.workflow_instances, deviludo.jobs, deviludo.workflow_events, deviludo.operation_receipts
  TO deviludo_sandbox;

GRANT EXECUTE ON FUNCTION deviludo.current_tenant_id() TO
  deviludo_api, deviludo_scheduler, deviludo_sandbox;
GRANT EXECUTE ON FUNCTION deviludo.required_capabilities(deviludo.job_kind) TO
  deviludo_api, deviludo_scheduler, deviludo_sandbox;
GRANT EXECUTE ON FUNCTION deviludo.enqueue_job(
  uuid, uuid, uuid, deviludo.job_kind, deviludo.server_os, text, jsonb
) TO deviludo_api, deviludo_scheduler, deviludo_sandbox;
GRANT EXECUTE ON FUNCTION deviludo.claim_job(text, deviludo.server_pool_kind, integer)
  TO deviludo_api, deviludo_sandbox;
GRANT EXECUTE ON FUNCTION deviludo.accept_workflow_signal(uuid, text, text, jsonb)
  TO deviludo_api;
GRANT EXECUTE ON FUNCTION deviludo.complete_job(uuid, uuid, bigint, bigint, jsonb, text, text, text)
  TO deviludo_api, deviludo_sandbox;
GRANT EXECUTE ON FUNCTION deviludo.fail_job(uuid, uuid, bigint, text)
  TO deviludo_api, deviludo_sandbox;
GRANT EXECUTE ON FUNCTION deviludo.recover_expired_jobs(), deviludo.reconcile_p0_capacity()
  TO deviludo_scheduler;

GRANT SELECT, UPDATE ON deviludo.jobs TO deviludo_claim_executor;
GRANT SELECT, INSERT, UPDATE ON deviludo.tenant_claim_fairness TO deviludo_claim_executor;
GRANT SELECT ON deviludo.tenants TO deviludo_claim_executor;
GRANT SELECT, INSERT ON deviludo.workflow_events TO deviludo_claim_executor;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA deviludo TO deviludo_claim_executor;

COMMIT;
