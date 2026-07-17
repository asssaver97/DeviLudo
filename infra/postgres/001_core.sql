BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS deviludo;

CREATE OR REPLACE FUNCTION deviludo.current_tenant_id()
RETURNS uuid LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid
$$;

CREATE TABLE deviludo.tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  name text NOT NULL,
  status text NOT NULL CHECK (status IN ('ACTIVE', 'SUSPENDED')) DEFAULT 'ACTIVE',
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE deviludo.projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES deviludo.tenants(id),
  slug text NOT NULL,
  name text NOT NULL,
  github_installation_id text,
  github_repository_node_id text,
  default_branch text NOT NULL DEFAULT 'main',
  steam_app_id text,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, slug)
);

CREATE TABLE deviludo.immutable_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES deviludo.tenants(id),
  project_id uuid REFERENCES deviludo.projects(id),
  aggregate_type text NOT NULL CHECK (aggregate_type IN (
    'GAME_SPEC', 'AGENT_VERSION', 'WORKER_IMAGE', 'INSTALLATION',
    'PROVIDER', 'CREDENTIAL_BINDING', 'AGENT_PROFILE', 'TEST_PLAN'
  )),
  aggregate_id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  state text NOT NULL,
  payload jsonb NOT NULL,
  payload_digest text NOT NULL CHECK (payload_digest ~ '^[a-f0-9]{64}$'),
  previous_revision_id uuid REFERENCES deviludo.immutable_revisions(id),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, aggregate_type, aggregate_id, revision),
  UNIQUE (tenant_id, aggregate_type, payload_digest)
);

-- Deliberately contains no credential plaintext. `secret_ref` names a Vault
-- version; fingerprint is a one-way HMAC used only to identify duplicates.
CREATE TABLE deviludo.credential_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES deviludo.tenants(id),
  project_id uuid REFERENCES deviludo.projects(id),
  binding_id uuid NOT NULL,
  secret_ref text NOT NULL,
  fingerprint text NOT NULL,
  masked_value text NOT NULL,
  status text NOT NULL CHECK (status IN ('ACTIVE', 'ROTATING', 'REVOKED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  rotated_at timestamptz,
  revoked_at timestamptz,
  last_used_at timestamptz,
  UNIQUE (tenant_id, binding_id, fingerprint)
);

CREATE TABLE deviludo.agent_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES deviludo.tenants(id),
  project_id uuid NOT NULL REFERENCES deviludo.projects(id),
  iteration_id uuid NOT NULL,
  idempotency_key text NOT NULL,
  state text NOT NULL,
  profile_revision_id uuid NOT NULL REFERENCES deviludo.immutable_revisions(id),
  installation_id uuid NOT NULL REFERENCES deviludo.immutable_revisions(id),
  image_digest text NOT NULL,
  adapter_version text NOT NULL,
  exact_agent_version text NOT NULL,
  provider_revision_id uuid NOT NULL REFERENCES deviludo.immutable_revisions(id),
  model text NOT NULL,
  credential_version_id uuid NOT NULL REFERENCES deviludo.immutable_revisions(id),
  configuration_lock jsonb NOT NULL,
  resolution_digest text NOT NULL CHECK (resolution_digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, idempotency_key)
);

CREATE TABLE deviludo.e2e_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES deviludo.tenants(id),
  project_id uuid NOT NULL REFERENCES deviludo.projects(id),
  run_id uuid NOT NULL REFERENCES deviludo.agent_runs(id),
  attempt_number integer NOT NULL CHECK (attempt_number > 0),
  runner_id text,
  fencing_token bigint NOT NULL CHECK (fencing_token > 0),
  last_seq_no bigint NOT NULL DEFAULT 0,
  commit_sha text NOT NULL CHECK (commit_sha ~ '^[a-f0-9]{40}$'),
  source_digest text NOT NULL CHECK (source_digest ~ '^[a-f0-9]{64}$'),
  binding jsonb NOT NULL,
  target_matrix text[] NOT NULL,
  lease_expires_at timestamptz,
  state text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, attempt_number),
  UNIQUE (id, fencing_token)
);

CREATE TABLE deviludo.runner_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES deviludo.tenants(id),
  attempt_id uuid NOT NULL REFERENCES deviludo.e2e_attempts(id),
  fencing_token bigint NOT NULL,
  seq_no bigint NOT NULL CHECK (seq_no > 0),
  commit_sha text NOT NULL,
  source_digest text NOT NULL,
  platform text NOT NULL CHECK (platform IN ('windows', 'linux', 'macos')),
  event_type text NOT NULL,
  status text NOT NULL,
  artifact_digest text,
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (attempt_id, fencing_token, seq_no),
  FOREIGN KEY (attempt_id, fencing_token) REFERENCES deviludo.e2e_attempts(id, fencing_token)
);

CREATE TABLE deviludo.evidence_bundles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES deviludo.tenants(id),
  project_id uuid NOT NULL REFERENCES deviludo.projects(id),
  attempt_id uuid NOT NULL REFERENCES deviludo.e2e_attempts(id),
  commit_sha text NOT NULL,
  source_digest text NOT NULL,
  binding jsonb NOT NULL,
  manifest jsonb NOT NULL,
  bundle_digest text NOT NULL UNIQUE,
  object_key text NOT NULL,
  status text NOT NULL CHECK (status IN ('PASSED', 'FAILED')),
  invalidated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE deviludo.steam_releases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES deviludo.tenants(id),
  project_id uuid NOT NULL REFERENCES deviludo.projects(id),
  main_commit_sha text NOT NULL CHECK (main_commit_sha ~ '^[a-f0-9]{40}$'),
  evidence_bundle_id uuid NOT NULL REFERENCES deviludo.evidence_bundles(id),
  steam_app_id text NOT NULL,
  steam_session_secret_ref text NOT NULL,
  mfa_approval_id uuid NOT NULL,
  state text NOT NULL,
  external_gate text NOT NULL DEFAULT 'NONE',
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE deviludo.audit_events (
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  id uuid NOT NULL UNIQUE,
  tenant_id uuid REFERENCES deviludo.tenants(id),
  project_id uuid REFERENCES deviludo.projects(id),
  actor jsonb NOT NULL,
  action text NOT NULL,
  resource_type text NOT NULL,
  resource_id text NOT NULL,
  request_id text NOT NULL,
  idempotency_key text,
  before_digest text,
  after_digest text,
  metadata jsonb NOT NULL,
  previous_event_hash text,
  event_hash text NOT NULL UNIQUE,
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION deviludo.reject_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '55000';
END $$;

CREATE TRIGGER immutable_revisions_append_only
BEFORE UPDATE OR DELETE ON deviludo.immutable_revisions
FOR EACH ROW EXECUTE FUNCTION deviludo.reject_mutation();

CREATE TRIGGER audit_events_append_only
BEFORE UPDATE OR DELETE ON deviludo.audit_events
FOR EACH ROW EXECUTE FUNCTION deviludo.reject_mutation();

CREATE OR REPLACE FUNCTION deviludo.protect_run_configuration()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.profile_revision_id, NEW.installation_id, NEW.image_digest,
         NEW.adapter_version, NEW.exact_agent_version, NEW.provider_revision_id,
         NEW.model, NEW.credential_version_id, NEW.configuration_lock,
         NEW.resolution_digest)
     IS DISTINCT FROM
     ROW(OLD.profile_revision_id, OLD.installation_id, OLD.image_digest,
         OLD.adapter_version, OLD.exact_agent_version, OLD.provider_revision_id,
         OLD.model, OLD.credential_version_id, OLD.configuration_lock,
         OLD.resolution_digest) THEN
    RAISE EXCEPTION 'agent run configuration lock is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER agent_run_configuration_lock
BEFORE UPDATE ON deviludo.agent_runs
FOR EACH ROW EXECUTE FUNCTION deviludo.protect_run_configuration();

-- Tenant isolation. The API opens every transaction with
-- SET LOCAL app.tenant_id = '<authorized tenant uuid>'. The owner role is never
-- used by the application so FORCE RLS cannot be bypassed accidentally.
ALTER TABLE deviludo.tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE deviludo.tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_self ON deviludo.tenants
  USING (id = deviludo.current_tenant_id())
  WITH CHECK (id = deviludo.current_tenant_id());

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'projects', 'immutable_revisions', 'agent_runs', 'e2e_attempts',
    'credential_versions', 'runner_events', 'evidence_bundles',
    'steam_releases', 'audit_events'
  ] LOOP
    EXECUTE format('ALTER TABLE deviludo.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE deviludo.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON deviludo.%I USING (tenant_id = deviludo.current_tenant_id()) WITH CHECK (tenant_id = deviludo.current_tenant_id())',
      table_name
    );
  END LOOP;
END $$;

CREATE INDEX agent_runs_project_state_idx ON deviludo.agent_runs (tenant_id, project_id, state);
CREATE INDEX e2e_lease_idx ON deviludo.e2e_attempts (state, lease_expires_at);
CREATE INDEX evidence_commit_idx ON deviludo.evidence_bundles (tenant_id, project_id, commit_sha);
CREATE INDEX audit_tenant_time_idx ON deviludo.audit_events (tenant_id, occurred_at DESC);

COMMIT;
