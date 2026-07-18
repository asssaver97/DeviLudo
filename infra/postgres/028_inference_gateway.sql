BEGIN;

-- Immutable serving projection. It deliberately contains only a Vault version
-- identity; upstream credential bytes never enter PostgreSQL.
CREATE TABLE deviludo.inference_provider_revisions (
  provider_revision_id text PRIMARY KEY CHECK (provider_revision_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'),
  tenant_id uuid NOT NULL REFERENCES deviludo.tenants(id),
  project_id uuid REFERENCES deviludo.projects(id),
  source_revision_id uuid NOT NULL UNIQUE REFERENCES deviludo.immutable_revisions(id),
  agent text NOT NULL CHECK (agent IN ('claude-code', 'codex-cli')),
  protocol text NOT NULL CHECK (protocol IN ('anthropic-messages', 'openai-responses')),
  base_url text NOT NULL,
  approved_ports integer[] NOT NULL CHECK (cardinality(approved_ports) BETWEEN 1 AND 16),
  authentication text NOT NULL CHECK (authentication IN ('bearer', 'x-api-key', 'authorization-bearer')),
  models jsonb NOT NULL,
  credential_version_id text NOT NULL CHECK (credential_version_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'),
  input_usd_per_million_tokens numeric(20,8) NOT NULL CHECK (input_usd_per_million_tokens >= 0),
  output_usd_per_million_tokens numeric(20,8) NOT NULL CHECK (output_usd_per_million_tokens >= 0),
  state text NOT NULL CHECK (state IN ('ACTIVE', 'DEGRADED', 'DISABLED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, provider_revision_id),
  CHECK ((agent = 'codex-cli' AND protocol = 'openai-responses')
    OR (agent = 'claude-code' AND protocol = 'anthropic-messages')),
  CHECK (jsonb_typeof(models) = 'object'
    AND models ?& ARRAY['primaryModel', 'planningModel', 'smallFastModel', 'subagentModel'])
);

-- One exact token binding per Agent run. Updates may revoke/complete a run but
-- cannot change the profile, Provider, key version, models, budget or nonce.
CREATE TABLE deviludo.inference_run_authorizations (
  run_id uuid PRIMARY KEY REFERENCES deviludo.agent_runs(id),
  tenant_id uuid NOT NULL REFERENCES deviludo.tenants(id),
  project_id uuid NOT NULL REFERENCES deviludo.projects(id),
  profile_revision_id text NOT NULL CHECK (profile_revision_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'),
  provider_revision_id text NOT NULL,
  credential_version_id text NOT NULL CHECK (credential_version_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'),
  models text[] NOT NULL CHECK (cardinality(models) BETWEEN 1 AND 16),
  budget jsonb NOT NULL,
  nonce text NOT NULL CHECK (nonce ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'),
  state text NOT NULL CHECK (state IN ('ACTIVE', 'REVOKED', 'COMPLETED')),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, run_id),
  FOREIGN KEY (tenant_id, provider_revision_id)
    REFERENCES deviludo.inference_provider_revisions(tenant_id, provider_revision_id),
  CHECK (jsonb_typeof(budget) = 'object' AND budget ? 'maxCostUsd')
);

-- Append-only and idempotent by gateway-generated request_id. Aggregates are
-- calculated under tenant RLS and remain bound to the exact run/key/model.
CREATE TABLE deviludo.inference_usage_events (
  request_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES deviludo.tenants(id),
  project_id uuid NOT NULL REFERENCES deviludo.projects(id),
  run_id uuid NOT NULL,
  provider_revision_id text NOT NULL,
  credential_version_id text NOT NULL CHECK (credential_version_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'),
  model text NOT NULL,
  input_tokens bigint NOT NULL CHECK (input_tokens >= 0),
  output_tokens bigint NOT NULL CHECK (output_tokens >= 0),
  cost_usd numeric(20,10) NOT NULL CHECK (cost_usd >= 0),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, run_id)
    REFERENCES deviludo.inference_run_authorizations(tenant_id, run_id),
  FOREIGN KEY (tenant_id, provider_revision_id)
    REFERENCES deviludo.inference_provider_revisions(tenant_id, provider_revision_id)
);

CREATE OR REPLACE FUNCTION deviludo.protect_inference_provider_revision()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.provider_revision_id, NEW.tenant_id, NEW.project_id, NEW.source_revision_id,
         NEW.agent, NEW.protocol, NEW.base_url, NEW.approved_ports, NEW.authentication,
         NEW.models, NEW.credential_version_id, NEW.input_usd_per_million_tokens,
         NEW.output_usd_per_million_tokens, NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.provider_revision_id, OLD.tenant_id, OLD.project_id, OLD.source_revision_id,
         OLD.agent, OLD.protocol, OLD.base_url, OLD.approved_ports, OLD.authentication,
         OLD.models, OLD.credential_version_id, OLD.input_usd_per_million_tokens,
         OLD.output_usd_per_million_tokens, OLD.created_at) THEN
    RAISE EXCEPTION 'inference Provider revision binding is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER inference_provider_revision_immutable
BEFORE UPDATE ON deviludo.inference_provider_revisions
FOR EACH ROW EXECUTE FUNCTION deviludo.protect_inference_provider_revision();

CREATE OR REPLACE FUNCTION deviludo.protect_inference_run_authorization()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.run_id, NEW.tenant_id, NEW.project_id, NEW.profile_revision_id,
         NEW.provider_revision_id, NEW.credential_version_id, NEW.models,
         NEW.budget, NEW.nonce, NEW.expires_at, NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.run_id, OLD.tenant_id, OLD.project_id, OLD.profile_revision_id,
         OLD.provider_revision_id, OLD.credential_version_id, OLD.models,
         OLD.budget, OLD.nonce, OLD.expires_at, OLD.created_at) THEN
    RAISE EXCEPTION 'inference run authorization binding is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER inference_run_authorization_immutable
BEFORE UPDATE ON deviludo.inference_run_authorizations
FOR EACH ROW EXECUTE FUNCTION deviludo.protect_inference_run_authorization();

CREATE OR REPLACE FUNCTION deviludo.reject_inference_usage_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'inference usage events are append-only' USING ERRCODE = '55000';
END $$;

CREATE TRIGGER inference_usage_no_update
BEFORE UPDATE OR DELETE ON deviludo.inference_usage_events
FOR EACH ROW EXECUTE FUNCTION deviludo.reject_inference_usage_mutation();

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'inference_provider_revisions', 'inference_run_authorizations', 'inference_usage_events'
  ] LOOP
    EXECUTE format('ALTER TABLE deviludo.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE deviludo.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON deviludo.%I USING (tenant_id = deviludo.current_tenant_id()) WITH CHECK (tenant_id = deviludo.current_tenant_id())',
      table_name
    );
  END LOOP;
END $$;

CREATE INDEX inference_provider_tenant_state_idx
  ON deviludo.inference_provider_revisions (tenant_id, state);
CREATE INDEX inference_run_tenant_state_idx
  ON deviludo.inference_run_authorizations (tenant_id, state, expires_at);
CREATE INDEX inference_usage_run_idx
  ON deviludo.inference_usage_events (tenant_id, run_id, recorded_at);

COMMIT;
