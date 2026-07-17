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

CREATE TABLE deviludo.github_installations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES deviludo.tenants(id),
  installation_id bigint NOT NULL CHECK (installation_id > 0),
  account_node_id text NOT NULL,
  account_login text NOT NULL,
  repository_selection text NOT NULL CHECK (repository_selection IN ('all', 'selected')),
  permissions jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('PENDING_VERIFICATION', 'ACTIVE', 'SUSPENDED', 'REVOKED')),
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, installation_id)
);

-- Raw OAuth state, PKCE verifiers, authorization codes and user access tokens
-- are never persisted here. State/session values are SHA-256 digests; the
-- verifier is a short-lived Vault reference consumed exactly once.
CREATE TABLE deviludo.github_installation_authorizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  state_digest text NOT NULL UNIQUE CHECK (state_digest ~ '^[a-f0-9]{64}$'),
  tenant_id uuid NOT NULL REFERENCES deviludo.tenants(id),
  user_subject text NOT NULL,
  session_binding_digest text NOT NULL CHECK (session_binding_digest ~ '^[a-f0-9]{64}$'),
  stage text NOT NULL CHECK (stage IN ('INSTALL', 'OAUTH')),
  installation_id bigint CHECK (installation_id > 0),
  pkce_verifier_secret_ref text,
  return_path text NOT NULL,
  status text NOT NULL CHECK (status IN ('PENDING', 'CLAIMED', 'COMPLETED', 'FAILED', 'EXPIRED')),
  claim_token uuid,
  claim_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  completed_at timestamptz,
  failure_code text,
  CHECK ((stage = 'INSTALL' AND installation_id IS NULL AND pkce_verifier_secret_ref IS NULL)
    OR (stage = 'OAUTH' AND installation_id IS NOT NULL AND pkce_verifier_secret_ref IS NOT NULL)),
  CHECK (return_path = '/settings/connections'
    OR return_path ~ '^/projects/[A-Za-z0-9][A-Za-z0-9._-]{0,99}/settings/connections$')
);

CREATE TABLE deviludo.github_repository_bindings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES deviludo.tenants(id),
  project_id uuid NOT NULL UNIQUE REFERENCES deviludo.projects(id),
  github_installation_id uuid NOT NULL REFERENCES deviludo.github_installations(id),
  repository_id bigint NOT NULL CHECK (repository_id > 0),
  repository_node_id text NOT NULL,
  owner_name text NOT NULL,
  repository_name text NOT NULL,
  default_branch text NOT NULL,
  status text NOT NULL CHECK (status IN ('ACTIVE', 'REVOKED', 'MISSING_PERMISSION')),
  bound_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, repository_node_id)
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
  commit_sha text NOT NULL CHECK (commit_sha ~ '^[a-f0-9]{40}$'),
  source_digest text NOT NULL CHECK (source_digest ~ '^[a-f0-9]{64}$'),
  binding jsonb NOT NULL,
  target_matrix text[] NOT NULL,
  state text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, attempt_number)
);

-- Runners are platform infrastructure identities rather than tenant-owned
-- records. Every write still lands in a tenant-bound lease/event row below.
CREATE TABLE deviludo.runner_registrations (
  id text PRIMARY KEY,
  spiffe_id text NOT NULL UNIQUE CHECK (spiffe_id LIKE 'spiffe://%'),
  certificate_fingerprint text NOT NULL UNIQUE CHECK (certificate_fingerprint ~ '^[a-f0-9]{64}$'),
  certificate_serial text NOT NULL,
  certificate_not_after timestamptz NOT NULL,
  platform text NOT NULL CHECK (platform IN ('windows', 'linux', 'macos')),
  architecture text NOT NULL CHECK (architecture IN ('x86_64', 'arm64')),
  capability_digest text NOT NULL CHECK (capability_digest ~ '^[a-f0-9]{64}$'),
  capabilities jsonb NOT NULL,
  state text NOT NULL CHECK (state IN ('ONLINE', 'DRAINING', 'OFFLINE', 'QUARANTINED')),
  registered_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL
);

CREATE TABLE deviludo.e2e_platform_leases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES deviludo.tenants(id),
  project_id uuid NOT NULL REFERENCES deviludo.projects(id),
  attempt_id uuid NOT NULL REFERENCES deviludo.e2e_attempts(id),
  platform text NOT NULL CHECK (platform IN ('windows', 'linux', 'macos')),
  runner_id text NOT NULL REFERENCES deviludo.runner_registrations(id),
  fencing_token bigint NOT NULL CHECK (fencing_token > 0),
  lease_expires_at timestamptz NOT NULL,
  last_seq_no bigint NOT NULL DEFAULT 0,
  cursor jsonb NOT NULL,
  job_digest text NOT NULL CHECK (job_digest ~ '^[a-f0-9]{64}$'),
  job_signature text NOT NULL,
  evidence_manifest_digest text CHECK (evidence_manifest_digest ~ '^[a-f0-9]{64}$'),
  state text NOT NULL CHECK (state IN ('LEASED', 'RUNNING', 'PASSED', 'FAILED', 'EXPIRED', 'INVALIDATED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (attempt_id, platform, fencing_token)
);

CREATE TABLE deviludo.platform_runner_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES deviludo.tenants(id),
  attempt_id uuid NOT NULL REFERENCES deviludo.e2e_attempts(id),
  platform_lease_id uuid NOT NULL REFERENCES deviludo.e2e_platform_leases(id),
  runner_id text NOT NULL REFERENCES deviludo.runner_registrations(id),
  platform text NOT NULL CHECK (platform IN ('windows', 'linux', 'macos')),
  fencing_token bigint NOT NULL,
  seq_no bigint NOT NULL CHECK (seq_no > 0),
  commit_sha text NOT NULL,
  source_digest text NOT NULL,
  event_type text NOT NULL,
  status text NOT NULL,
  artifact_digest text,
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (platform_lease_id, seq_no)
);

CREATE TABLE deviludo.scm_operation_claims (
  operation_key text PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES deviludo.tenants(id),
  project_id uuid NOT NULL REFERENCES deviludo.projects(id),
  operation text NOT NULL CHECK (operation IN ('PUBLISH_CANDIDATE', 'MERGE_ACCEPTED_CANDIDATE')),
  request_digest text NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  claim_token uuid NOT NULL,
  claim_expires_at timestamptz NOT NULL,
  response jsonb,
  authorized_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE TABLE deviludo.github_candidate_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES deviludo.tenants(id),
  project_id uuid NOT NULL REFERENCES deviludo.projects(id),
  run_id uuid NOT NULL REFERENCES deviludo.agent_runs(id),
  attempt_id text NOT NULL UNIQUE,
  spec_revision_id uuid NOT NULL REFERENCES deviludo.immutable_revisions(id),
  repository_binding_id uuid NOT NULL REFERENCES deviludo.github_repository_bindings(id),
  artifact_digest text NOT NULL CHECK (artifact_digest ~ '^[a-f0-9]{64}$'),
  base_commit_sha text NOT NULL CHECK (base_commit_sha ~ '^[a-f0-9]{40}$'),
  candidate_branch text NOT NULL,
  candidate_commit_sha text NOT NULL CHECK (candidate_commit_sha ~ '^[a-f0-9]{40}$'),
  source_digest text NOT NULL CHECK (source_digest ~ '^[a-f0-9]{64}$'),
  pull_request_number bigint NOT NULL CHECK (pull_request_number > 0),
  pull_request_node_id text NOT NULL,
  pull_request_url text NOT NULL,
  receipt jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (repository_binding_id, pull_request_number)
);

CREATE TABLE deviludo.github_merge_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES deviludo.tenants(id),
  project_id uuid NOT NULL REFERENCES deviludo.projects(id),
  candidate_receipt_id uuid NOT NULL UNIQUE REFERENCES deviludo.github_candidate_receipts(id),
  acceptance_nonce text NOT NULL,
  evidence_bundle_digest text NOT NULL CHECK (evidence_bundle_digest ~ '^[a-f0-9]{64}$'),
  candidate_commit_sha text NOT NULL CHECK (candidate_commit_sha ~ '^[a-f0-9]{40}$'),
  merge_commit_sha text NOT NULL CHECK (merge_commit_sha ~ '^[a-f0-9]{40}$'),
  default_branch_head_sha text NOT NULL CHECK (default_branch_head_sha ~ '^[a-f0-9]{40}$'),
  requires_fresh_main_snapshot boolean NOT NULL,
  receipt jsonb NOT NULL,
  merged_at timestamptz NOT NULL,
  UNIQUE (tenant_id, acceptance_nonce)
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

CREATE TABLE deviludo.steam_build_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES deviludo.tenants(id),
  account_id text NOT NULL,
  account_name text NOT NULL,
  config_vdf_secret_ref text NOT NULL,
  credential_version_id uuid NOT NULL REFERENCES deviludo.credential_versions(id),
  allowed_app_ids text[] NOT NULL,
  permissions text[] NOT NULL,
  state text NOT NULL CHECK (state IN ('ACTIVE', 'REVOKED', 'EXPIRED')),
  verified_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, account_id, credential_version_id),
  CHECK (permissions @> ARRAY['EditAppMetadata', 'PublishAppChanges']::text[])
);

CREATE TABLE deviludo.steam_publish_claims (
  key text PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES deviludo.tenants(id),
  project_id uuid NOT NULL REFERENCES deviludo.projects(id),
  release_id uuid NOT NULL REFERENCES deviludo.steam_releases(id),
  request_digest text NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  claim_token uuid NOT NULL,
  claim_expires_at timestamptz NOT NULL,
  response jsonb,
  authorized_at timestamptz NOT NULL,
  completed_at timestamptz
);

CREATE TABLE deviludo.steam_build_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES deviludo.tenants(id),
  project_id uuid NOT NULL REFERENCES deviludo.projects(id),
  release_id uuid NOT NULL UNIQUE REFERENCES deviludo.steam_releases(id),
  steam_app_id text NOT NULL CHECK (steam_app_id ~ '^[0-9]+$'),
  build_id text NOT NULL CHECK (build_id ~ '^[0-9]+$'),
  main_commit_sha text NOT NULL CHECK (main_commit_sha ~ '^[a-f0-9]{40}$'),
  source_digest text NOT NULL CHECK (source_digest ~ '^[a-f0-9]{64}$'),
  evidence_bundle_digest text NOT NULL CHECK (evidence_bundle_digest ~ '^[a-f0-9]{64}$'),
  beta_branch text NOT NULL CHECK (beta_branch ~ '^[a-z0-9][a-z0-9_-]{2,39}$' AND beta_branch NOT IN ('default', 'public')),
  depot_manifest_ids jsonb NOT NULL,
  install_attempts jsonb NOT NULL,
  steam_install_evidence_bundle_digest text CHECK (steam_install_evidence_bundle_digest ~ '^[a-f0-9]{64}$'),
  state text NOT NULL CHECK (state IN ('INSTALL_TESTING', 'EXTERNAL_APPROVAL_REQUIRED')),
  uploaded_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (steam_app_id, build_id)
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

CREATE TRIGGER github_candidate_receipts_append_only
BEFORE UPDATE OR DELETE ON deviludo.github_candidate_receipts
FOR EACH ROW EXECUTE FUNCTION deviludo.reject_mutation();

CREATE TRIGGER github_merge_receipts_append_only
BEFORE UPDATE OR DELETE ON deviludo.github_merge_receipts
FOR EACH ROW EXECUTE FUNCTION deviludo.reject_mutation();

CREATE OR REPLACE FUNCTION deviludo.protect_steam_build_receipt()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.tenant_id, NEW.project_id, NEW.release_id, NEW.steam_app_id,
         NEW.build_id, NEW.main_commit_sha, NEW.source_digest,
         NEW.evidence_bundle_digest, NEW.beta_branch, NEW.depot_manifest_ids,
         NEW.install_attempts, NEW.uploaded_at, NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.tenant_id, OLD.project_id, OLD.release_id, OLD.steam_app_id,
         OLD.build_id, OLD.main_commit_sha, OLD.source_digest,
         OLD.evidence_bundle_digest, OLD.beta_branch, OLD.depot_manifest_ids,
         OLD.install_attempts, OLD.uploaded_at, OLD.created_at)
     OR OLD.state <> 'INSTALL_TESTING'
     OR NEW.state <> 'EXTERNAL_APPROVAL_REQUIRED'
     OR OLD.steam_install_evidence_bundle_digest IS NOT NULL
     OR NEW.steam_install_evidence_bundle_digest IS NULL THEN
    RAISE EXCEPTION 'steam build receipt binding is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER steam_build_receipt_binding_immutable
BEFORE UPDATE ON deviludo.steam_build_receipts
FOR EACH ROW EXECUTE FUNCTION deviludo.protect_steam_build_receipt();

CREATE TRIGGER steam_build_receipt_no_delete
BEFORE DELETE ON deviludo.steam_build_receipts
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
    'projects', 'github_installations', 'github_installation_authorizations', 'github_repository_bindings',
    'immutable_revisions', 'agent_runs', 'e2e_attempts',
    'credential_versions', 'e2e_platform_leases', 'platform_runner_events', 'evidence_bundles',
    'scm_operation_claims', 'github_candidate_receipts', 'github_merge_receipts',
    'steam_releases', 'steam_build_sessions', 'steam_publish_claims', 'steam_build_receipts', 'audit_events'
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
CREATE INDEX e2e_attempt_state_idx ON deviludo.e2e_attempts (state, created_at);
CREATE INDEX e2e_platform_lease_idx ON deviludo.e2e_platform_leases (state, lease_expires_at);
CREATE INDEX e2e_platform_runner_idx ON deviludo.e2e_platform_leases (runner_id, state, lease_expires_at);
CREATE INDEX github_installation_status_idx ON deviludo.github_installations (tenant_id, status);
CREATE INDEX github_authorization_principal_status_idx ON deviludo.github_installation_authorizations (tenant_id, user_subject, status);
CREATE INDEX github_authorization_expiry_idx ON deviludo.github_installation_authorizations (expires_at, status);
CREATE INDEX github_repository_installation_idx ON deviludo.github_repository_bindings (github_installation_id, status);
CREATE INDEX scm_operation_claim_idx ON deviludo.scm_operation_claims (tenant_id, project_id, claim_expires_at);
CREATE INDEX github_candidate_project_commit_idx ON deviludo.github_candidate_receipts (project_id, candidate_commit_sha);
CREATE INDEX github_merge_project_commit_idx ON deviludo.github_merge_receipts (project_id, merge_commit_sha);
CREATE INDEX evidence_commit_idx ON deviludo.evidence_bundles (tenant_id, project_id, commit_sha);
CREATE INDEX steam_build_session_state_idx ON deviludo.steam_build_sessions (tenant_id, state, expires_at);
CREATE INDEX steam_publish_active_claim_idx ON deviludo.steam_publish_claims (tenant_id, project_id, claim_expires_at);
CREATE INDEX steam_build_receipt_project_state_idx ON deviludo.steam_build_receipts (project_id, state);
CREATE INDEX audit_tenant_time_idx ON deviludo.audit_events (tenant_id, occurred_at DESC);

COMMIT;
