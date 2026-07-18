BEGIN;

-- Composite authority keys make every new reference tenant/project bound at
-- the database layer, not merely by application convention.
ALTER TABLE deviludo.immutable_revisions
  ADD CONSTRAINT immutable_revisions_tenant_project_id_unique
    UNIQUE (tenant_id, project_id, id);
ALTER TABLE deviludo.github_repository_bindings
  ADD CONSTRAINT github_repository_bindings_tenant_project_id_unique
    UNIQUE (tenant_id, project_id, id);

-- The administrator catalog uses exact, vendor-facing revision IDs. AgentRun
-- must preserve those IDs verbatim instead of pretending they are rows in the
-- unrelated immutable_revisions table.
ALTER TABLE deviludo.agent_runs
  DROP CONSTRAINT agent_runs_profile_revision_id_fkey,
  DROP CONSTRAINT agent_runs_installation_id_fkey,
  DROP CONSTRAINT agent_runs_provider_revision_id_fkey,
  DROP CONSTRAINT agent_runs_credential_version_id_fkey;
ALTER TABLE deviludo.agent_runs
  ALTER COLUMN profile_revision_id TYPE text USING profile_revision_id::text,
  ALTER COLUMN installation_id TYPE text USING installation_id::text,
  ALTER COLUMN provider_revision_id TYPE text USING provider_revision_id::text,
  ALTER COLUMN credential_version_id TYPE text USING credential_version_id::text,
  ADD COLUMN spec_revision_id uuid,
  ADD COLUMN test_plan_revision_id uuid,
  ADD COLUMN spec_approval_receipt_id char(64)
    CHECK (spec_approval_receipt_id IS NULL OR spec_approval_receipt_id ~ '^[a-f0-9]{64}$'),
  ADD COLUMN source_baseline_receipt_id uuid,
  ADD CONSTRAINT agent_run_profile_revision_shape
    CHECK (profile_revision_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'),
  ADD CONSTRAINT agent_run_installation_shape
    CHECK (installation_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'),
  ADD CONSTRAINT agent_run_provider_revision_shape
    CHECK (provider_revision_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'),
  ADD CONSTRAINT agent_run_credential_version_shape
    CHECK (credential_version_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'),
  ADD CONSTRAINT agent_run_state_shape
    CHECK (state IN (
      'QUEUED', 'PREPARING', 'RUNNING', 'WAITING_PROVIDER',
      'CANCELLING', 'SUCCEEDED', 'FAILED', 'CANCELLED'
    )),
  ADD CONSTRAINT agent_run_configuration_shape CHECK (
    (spec_revision_id IS NULL AND test_plan_revision_id IS NULL
      AND spec_approval_receipt_id IS NULL AND source_baseline_receipt_id IS NULL)
    OR (spec_revision_id IS NOT NULL AND test_plan_revision_id IS NOT NULL
      AND spec_approval_receipt_id IS NOT NULL AND source_baseline_receipt_id IS NOT NULL
    AND jsonb_typeof(configuration_lock) = 'object'
    AND configuration_lock ?& ARRAY[
      'profileRevisionId', 'installationId', 'imageDigest',
      'exactAgentVersion', 'adapterVersion', 'providerRevisionId',
      'providerProtocol', 'modelRoles', 'credentialVersionId', 'budget',
      'specRevisionId', 'specDigest', 'testPlanRevisionId', 'testPlanDigest',
      'specApprovalReceiptId', 'runnerToolchainRevisionId',
      'runnerToolchainDigest', 'sourceBaselineReceiptId', 'commitSha',
      'sourceDigest', 'targetMatrix', 'adminCatalogRevision',
      'resolvedAt', 'resolutionDigest'
    ]
    )
  ) NOT VALID,
  ADD CONSTRAINT agent_run_spec_revision_fk
    FOREIGN KEY (tenant_id, project_id, spec_revision_id)
    REFERENCES deviludo.immutable_revisions(tenant_id, project_id, id),
  ADD CONSTRAINT agent_run_test_plan_revision_fk
    FOREIGN KEY (tenant_id, project_id, test_plan_revision_id)
    REFERENCES deviludo.immutable_revisions(tenant_id, project_id, id);

CREATE TABLE deviludo.github_source_baseline_operations (
  tenant_id uuid NOT NULL REFERENCES deviludo.tenants(id),
  project_id uuid NOT NULL REFERENCES deviludo.projects(id),
  operation_key char(64) NOT NULL CHECK (operation_key ~ '^[a-f0-9]{64}$'),
  request_digest char(64) NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  workflow_id text NOT NULL CHECK (length(workflow_id) BETWEEN 3 AND 200),
  spec_revision_id uuid NOT NULL,
  test_plan_revision_id uuid NOT NULL,
  spec_approval_receipt_id char(64) NOT NULL
    CHECK (spec_approval_receipt_id ~ '^[a-f0-9]{64}$'),
  state text NOT NULL CHECK (state IN ('PENDING', 'CLAIMED', 'COMPLETED')),
  claim_token uuid,
  claim_expires_at timestamptz,
  response jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  PRIMARY KEY (tenant_id, operation_key),
  FOREIGN KEY (tenant_id, project_id, spec_revision_id)
    REFERENCES deviludo.immutable_revisions(tenant_id, project_id, id),
  FOREIGN KEY (tenant_id, project_id, test_plan_revision_id)
    REFERENCES deviludo.immutable_revisions(tenant_id, project_id, id),
  CHECK ((state = 'PENDING' AND claim_token IS NULL
      AND claim_expires_at IS NULL AND response IS NULL AND completed_at IS NULL)
    OR (state = 'CLAIMED' AND claim_token IS NOT NULL
      AND claim_expires_at IS NOT NULL AND response IS NULL AND completed_at IS NULL)
    OR (state = 'COMPLETED' AND claim_token IS NULL
      AND claim_expires_at IS NULL AND jsonb_typeof(response) = 'object'
      AND completed_at IS NOT NULL))
);

CREATE TABLE deviludo.github_source_baseline_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES deviludo.tenants(id),
  project_id uuid NOT NULL REFERENCES deviludo.projects(id),
  operation_key char(64) NOT NULL,
  repository_binding_id uuid NOT NULL,
  workflow_id text NOT NULL CHECK (length(workflow_id) BETWEEN 3 AND 200),
  spec_revision_id uuid NOT NULL,
  test_plan_revision_id uuid NOT NULL,
  spec_approval_receipt_id char(64) NOT NULL
    CHECK (spec_approval_receipt_id ~ '^[a-f0-9]{64}$'),
  default_branch text NOT NULL CHECK (length(default_branch) BETWEEN 1 AND 255),
  commit_sha char(40) NOT NULL CHECK (commit_sha ~ '^[a-f0-9]{40}$'),
  source_digest char(64) NOT NULL CHECK (source_digest ~ '^[a-f0-9]{64}$'),
  request_digest char(64) NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  observed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, operation_key)
    REFERENCES deviludo.github_source_baseline_operations(tenant_id, operation_key),
  FOREIGN KEY (tenant_id, project_id, repository_binding_id)
    REFERENCES deviludo.github_repository_bindings(tenant_id, project_id, id),
  FOREIGN KEY (tenant_id, project_id, spec_revision_id)
    REFERENCES deviludo.immutable_revisions(tenant_id, project_id, id),
  FOREIGN KEY (tenant_id, project_id, test_plan_revision_id)
    REFERENCES deviludo.immutable_revisions(tenant_id, project_id, id),
  UNIQUE (tenant_id, project_id, spec_revision_id),
  UNIQUE (tenant_id, project_id, id)
);

ALTER TABLE deviludo.agent_runs
  ADD CONSTRAINT agent_run_source_baseline_fk
    FOREIGN KEY (tenant_id, project_id, source_baseline_receipt_id)
    REFERENCES deviludo.github_source_baseline_receipts(tenant_id, project_id, id);

CREATE TABLE deviludo.agent_configuration_resolutions (
  tenant_id uuid NOT NULL REFERENCES deviludo.tenants(id),
  project_id uuid NOT NULL REFERENCES deviludo.projects(id),
  workflow_id text NOT NULL CHECK (length(workflow_id) BETWEEN 3 AND 200),
  action_id uuid NOT NULL,
  spec_revision_id uuid NOT NULL,
  test_plan_revision_id uuid NOT NULL,
  spec_approval_receipt_id char(64) NOT NULL
    CHECK (spec_approval_receipt_id ~ '^[a-f0-9]{64}$'),
  state text NOT NULL DEFAULT 'PENDING'
    CHECK (state IN ('PENDING', 'CLAIMED', 'LOCKED', 'COMPLETED')),
  claim_token uuid,
  claim_expires_at timestamptz,
  source_baseline_receipt_id uuid,
  run_id uuid,
  resolution_digest char(64)
    CHECK (resolution_digest IS NULL OR resolution_digest ~ '^[a-f0-9]{64}$'),
  completion_outbox_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  completed_at timestamptz,
  PRIMARY KEY (tenant_id, action_id),
  FOREIGN KEY (tenant_id, project_id, workflow_id, action_id)
    REFERENCES deviludo.workflow_control_actions(tenant_id, project_id, workflow_id, id),
  FOREIGN KEY (tenant_id, project_id, spec_revision_id)
    REFERENCES deviludo.immutable_revisions(tenant_id, project_id, id),
  FOREIGN KEY (tenant_id, project_id, test_plan_revision_id)
    REFERENCES deviludo.immutable_revisions(tenant_id, project_id, id),
  FOREIGN KEY (tenant_id, project_id, source_baseline_receipt_id)
    REFERENCES deviludo.github_source_baseline_receipts(tenant_id, project_id, id),
  FOREIGN KEY (tenant_id, project_id, run_id)
    REFERENCES deviludo.agent_runs(tenant_id, project_id, id),
  FOREIGN KEY (tenant_id, project_id, workflow_id, completion_outbox_id)
    REFERENCES deviludo.workflow_signal_outbox(tenant_id, project_id, workflow_id, id),
  CHECK ((state = 'PENDING' AND claim_token IS NULL AND claim_expires_at IS NULL
      AND source_baseline_receipt_id IS NULL AND run_id IS NULL
      AND resolution_digest IS NULL AND completion_outbox_id IS NULL
      AND locked_at IS NULL AND completed_at IS NULL)
    OR (state = 'CLAIMED' AND claim_token IS NOT NULL AND claim_expires_at IS NOT NULL
      AND run_id IS NULL AND resolution_digest IS NULL
      AND completion_outbox_id IS NULL AND locked_at IS NULL AND completed_at IS NULL)
    OR (state = 'LOCKED' AND claim_token IS NULL AND claim_expires_at IS NULL
      AND source_baseline_receipt_id IS NOT NULL AND run_id IS NOT NULL
      AND resolution_digest IS NOT NULL AND completion_outbox_id IS NULL
      AND locked_at IS NOT NULL AND completed_at IS NULL)
    OR (state = 'COMPLETED' AND claim_token IS NULL AND claim_expires_at IS NULL
      AND source_baseline_receipt_id IS NOT NULL AND run_id IS NOT NULL
      AND resolution_digest IS NOT NULL AND completion_outbox_id IS NOT NULL
      AND locked_at IS NOT NULL AND completed_at IS NOT NULL))
);

CREATE OR REPLACE FUNCTION deviludo.protect_source_baseline_operation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.tenant_id, NEW.project_id, NEW.operation_key, NEW.request_digest,
         NEW.workflow_id, NEW.spec_revision_id, NEW.test_plan_revision_id,
         NEW.spec_approval_receipt_id, NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.tenant_id, OLD.project_id, OLD.operation_key, OLD.request_digest,
         OLD.workflow_id, OLD.spec_revision_id, OLD.test_plan_revision_id,
         OLD.spec_approval_receipt_id, OLD.created_at)
     OR OLD.state = 'COMPLETED'
     OR (OLD.state = 'PENDING' AND NEW.state <> 'CLAIMED')
     OR (OLD.state = 'CLAIMED' AND NEW.state = 'CLAIMED'
       AND OLD.claim_expires_at > now())
     OR (OLD.state = 'CLAIMED' AND NEW.state NOT IN ('PENDING', 'CLAIMED', 'COMPLETED')) THEN
    RAISE EXCEPTION 'source baseline operation binding is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION deviludo.protect_agent_configuration_resolution()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.tenant_id, NEW.project_id, NEW.workflow_id, NEW.action_id,
         NEW.spec_revision_id, NEW.test_plan_revision_id,
         NEW.spec_approval_receipt_id, NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.tenant_id, OLD.project_id, OLD.workflow_id, OLD.action_id,
         OLD.spec_revision_id, OLD.test_plan_revision_id,
         OLD.spec_approval_receipt_id, OLD.created_at)
     OR OLD.state IN ('COMPLETED')
     OR (OLD.state = 'PENDING' AND NEW.state <> 'CLAIMED')
     OR (OLD.state = 'CLAIMED' AND NEW.state = 'CLAIMED'
       AND OLD.claim_expires_at > now())
     OR (OLD.state = 'CLAIMED' AND NEW.state NOT IN ('PENDING', 'CLAIMED', 'LOCKED'))
     OR (OLD.state = 'LOCKED' AND NEW.state <> 'COMPLETED') THEN
    RAISE EXCEPTION 'Agent configuration resolution binding is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER source_baseline_operation_guard
BEFORE UPDATE ON deviludo.github_source_baseline_operations
FOR EACH ROW EXECUTE FUNCTION deviludo.protect_source_baseline_operation();
CREATE TRIGGER source_baseline_operation_no_delete
BEFORE DELETE ON deviludo.github_source_baseline_operations
FOR EACH ROW EXECUTE FUNCTION deviludo.reject_mutation();
CREATE TRIGGER source_baseline_receipt_append_only
BEFORE UPDATE OR DELETE ON deviludo.github_source_baseline_receipts
FOR EACH ROW EXECUTE FUNCTION deviludo.reject_mutation();
CREATE TRIGGER agent_configuration_resolution_guard
BEFORE UPDATE ON deviludo.agent_configuration_resolutions
FOR EACH ROW EXECUTE FUNCTION deviludo.protect_agent_configuration_resolution();
CREATE TRIGGER agent_configuration_resolution_no_delete
BEFORE DELETE ON deviludo.agent_configuration_resolutions
FOR EACH ROW EXECUTE FUNCTION deviludo.reject_mutation();

-- Extend the existing AgentRun lock to the newly normalized authorities.
CREATE OR REPLACE FUNCTION deviludo.protect_run_configuration()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.profile_revision_id, NEW.installation_id, NEW.image_digest,
         NEW.adapter_version, NEW.exact_agent_version, NEW.provider_revision_id,
         NEW.model, NEW.credential_version_id, NEW.configuration_lock,
         NEW.resolution_digest, NEW.spec_revision_id, NEW.test_plan_revision_id,
         NEW.spec_approval_receipt_id, NEW.source_baseline_receipt_id)
     IS DISTINCT FROM
     ROW(OLD.profile_revision_id, OLD.installation_id, OLD.image_digest,
         OLD.adapter_version, OLD.exact_agent_version, OLD.provider_revision_id,
         OLD.model, OLD.credential_version_id, OLD.configuration_lock,
         OLD.resolution_digest, OLD.spec_revision_id, OLD.test_plan_revision_id,
         OLD.spec_approval_receipt_id, OLD.source_baseline_receipt_id) THEN
    RAISE EXCEPTION 'agent run configuration lock is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'github_source_baseline_operations',
    'github_source_baseline_receipts',
    'agent_configuration_resolutions'
  ] LOOP
    EXECUTE format('ALTER TABLE deviludo.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE deviludo.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON deviludo.%I USING (tenant_id = deviludo.current_tenant_id()) WITH CHECK (tenant_id = deviludo.current_tenant_id())',
      table_name
    );
  END LOOP;
END $$;

CREATE INDEX source_baseline_operation_claim_idx
  ON deviludo.github_source_baseline_operations
  (tenant_id, state, claim_expires_at, created_at);
CREATE INDEX source_baseline_project_spec_idx
  ON deviludo.github_source_baseline_receipts
  (tenant_id, project_id, spec_revision_id);
CREATE INDEX agent_configuration_resolution_claim_idx
  ON deviludo.agent_configuration_resolutions
  (tenant_id, state, claim_expires_at, created_at);

COMMIT;
