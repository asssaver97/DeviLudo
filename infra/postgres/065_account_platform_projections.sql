BEGIN;

CREATE TABLE deviludo.tenant_entitlement_projections (
  tenant_id uuid PRIMARY KEY REFERENCES deviludo.tenants(id),
  plan_code text NOT NULL CHECK (plan_code IN ('FREE','PLUS','BUSINESS','ENTERPRISE')),
  subscription_status text NOT NULL CHECK (subscription_status IN ('FREE','ACTIVE','TRIALING','PAST_DUE','CANCELED')),
  revision bigint NOT NULL CHECK (revision > 0),
  active_projects_limit integer CHECK (active_projects_limit IS NULL OR active_projects_limit > 0),
  daily_agent_starts_limit integer CHECK (daily_agent_starts_limit IS NULL OR daily_agent_starts_limit > 0),
  target_platforms jsonb NOT NULL CHECK (jsonb_typeof(target_platforms) = 'array'),
  steam_beta boolean NOT NULL,
  no_training_providers_only boolean NOT NULL,
  available_credits_cents bigint NOT NULL CHECK (available_credits_cents >= 0),
  period_ends_at timestamptz,
  source_event_sequence bigint NOT NULL CHECK (source_event_sequence > 0),
  projected_at timestamptz NOT NULL,
  UNIQUE (tenant_id, revision),
  UNIQUE (tenant_id, source_event_sequence)
);

CREATE TABLE deviludo.account_workspace_event_inbox (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES deviludo.tenants(id),
  source_event_id uuid NOT NULL,
  source_sequence bigint NOT NULL CHECK (source_sequence > 0),
  event_type text NOT NULL CHECK (event_type IN ('workspace.created','workspace.updated','workspace.suspended','entitlement.revised')),
  payload_digest text NOT NULL CHECK (payload_digest ~ '^[a-f0-9]{64}$'),
  signature text NOT NULL,
  received_at timestamptz NOT NULL,
  applied_at timestamptz,
  UNIQUE (tenant_id, source_event_id),
  UNIQUE (tenant_id, source_sequence)
);

CREATE TABLE deviludo.account_usage_reservation_bindings (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES deviludo.tenants(id),
  project_id uuid NOT NULL REFERENCES deviludo.projects(id),
  run_id text NOT NULL,
  meter text NOT NULL CHECK (meter IN ('MODEL','AGENT_MICROVM','E2E_LINUX','E2E_WINDOWS','E2E_MACOS','STORAGE')),
  account_reservation_id uuid NOT NULL,
  reserved_cents integer NOT NULL CHECK (reserved_cents > 0),
  settled_cents integer NOT NULL DEFAULT 0 CHECK (settled_cents >= 0 AND settled_cents <= reserved_cents),
  state text NOT NULL CHECK (state IN ('RESERVED','SETTLED','CANCELED')),
  entitlement_revision bigint NOT NULL CHECK (entitlement_revision > 0),
  created_at timestamptz NOT NULL,
  settled_at timestamptz,
  UNIQUE (tenant_id, run_id, meter),
  UNIQUE (tenant_id, account_reservation_id)
);

DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY['tenant_entitlement_projections','account_workspace_event_inbox','account_usage_reservation_bindings'] LOOP
    EXECUTE format('ALTER TABLE deviludo.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE deviludo.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY %I ON deviludo.%I USING (tenant_id = deviludo.current_tenant_id()) WITH CHECK (tenant_id = deviludo.current_tenant_id())', table_name || '_tenant_isolation', table_name);
  END LOOP;
END $$;

COMMIT;

