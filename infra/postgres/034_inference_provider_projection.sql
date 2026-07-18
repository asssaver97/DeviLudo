BEGIN;

-- Provider IDs are immutable administrator revision identities, not rows in
-- immutable_revisions. A platform Provider may be projected independently for
-- many tenants, so neither identity may be globally unique on its own.
ALTER TABLE deviludo.inference_provider_revisions
  DROP CONSTRAINT inference_provider_revisions_pkey,
  DROP CONSTRAINT inference_provider_revisions_source_revision_id_key,
  DROP CONSTRAINT inference_provider_revisions_source_revision_id_fkey;
ALTER TABLE deviludo.inference_provider_revisions
  ALTER COLUMN source_revision_id TYPE text USING source_revision_id::text,
  ADD CONSTRAINT inference_provider_revision_source_shape
    CHECK (source_revision_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'),
  ADD CONSTRAINT inference_provider_revisions_pkey
    PRIMARY KEY (tenant_id, provider_revision_id),
  ADD CONSTRAINT inference_provider_revision_source_unique
    UNIQUE (tenant_id, source_revision_id);

-- A run authorization must bind the same tenant and project as AgentRun. The
-- former run_id-only FK allowed a syntactically valid cross-tenant reference.
ALTER TABLE deviludo.inference_run_authorizations
  DROP CONSTRAINT inference_run_authorizations_run_id_fkey,
  ADD CONSTRAINT inference_run_authorization_agent_run_fk
    FOREIGN KEY (tenant_id, project_id, run_id)
    REFERENCES deviludo.agent_runs(tenant_id, project_id, id),
  ADD CONSTRAINT inference_run_authorization_lifetime_shape
    CHECK (expires_at > created_at) NOT VALID;

ALTER TABLE deviludo.inference_provider_revisions
  ADD CONSTRAINT inference_provider_authentication_shape CHECK (
    (agent = 'codex-cli' AND authentication = 'bearer')
    OR (agent = 'claude-code'
      AND authentication IN ('x-api-key', 'authorization-bearer'))
  ) NOT VALID;

ALTER TABLE deviludo.agent_runs
  ADD CONSTRAINT agent_run_inference_configuration_shape CHECK (
    source_baseline_receipt_id IS NULL
    OR configuration_lock ?& ARRAY[
      'providerBaseUrl', 'providerApprovedPorts',
      'providerAuthentication', 'providerPricing', 'providerGovernance',
      'inferenceAuthorizationExpiresAt'
    ]
  ) NOT VALID;

COMMIT;
