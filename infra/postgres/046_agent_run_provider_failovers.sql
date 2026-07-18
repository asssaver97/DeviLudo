BEGIN;

-- One irreversible runtime selection may move an AgentRun from its primary
-- Provider to the exact same-Agent fallback frozen in configuration_lock.
-- The original run authorization remains immutable and auditable.
CREATE TABLE deviludo.agent_run_provider_failovers (
  tenant_id uuid NOT NULL REFERENCES deviludo.tenants(id),
  project_id uuid NOT NULL REFERENCES deviludo.projects(id),
  run_id uuid NOT NULL,
  from_profile_revision_id text NOT NULL,
  from_provider_revision_id text NOT NULL,
  to_profile_revision_id text NOT NULL,
  to_provider_revision_id text NOT NULL,
  to_credential_version_id text NOT NULL,
  to_models text[] NOT NULL CHECK (cardinality(to_models) BETWEEN 1 AND 16),
  to_budget jsonb NOT NULL CHECK (jsonb_typeof(to_budget) = 'object' AND to_budget ? 'maxCostUsd'),
  authorization_nonce uuid NOT NULL,
  authorization_expires_at timestamptz NOT NULL,
  reason text NOT NULL CHECK (reason = 'PRIMARY_PROVIDER_UNAVAILABLE'),
  activated_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, run_id),
  FOREIGN KEY (tenant_id, project_id, run_id)
    REFERENCES deviludo.agent_runs(tenant_id, project_id, id),
  FOREIGN KEY (tenant_id, from_provider_revision_id)
    REFERENCES deviludo.inference_provider_revisions(tenant_id, provider_revision_id),
  FOREIGN KEY (tenant_id, to_provider_revision_id)
    REFERENCES deviludo.inference_provider_revisions(tenant_id, provider_revision_id)
);

CREATE OR REPLACE FUNCTION deviludo.validate_agent_run_provider_failover()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  locked jsonb;
  fallback jsonb;
  authorization_profile_revision_id text;
  authorization_provider_revision_id text;
  authorization_state text;
  authorization_expires_at timestamptz;
  primary_provider_state text;
  fallback_provider_state text;
  run_state text;
BEGIN
  SELECT run.configuration_lock, run.state,
         auth.profile_revision_id, auth.provider_revision_id,
         auth.state, auth.expires_at,
         primary_provider.state, fallback_provider.state
    INTO locked, run_state,
         authorization_profile_revision_id, authorization_provider_revision_id,
         authorization_state, authorization_expires_at,
         primary_provider_state, fallback_provider_state
    FROM deviludo.agent_runs run
    JOIN deviludo.inference_run_authorizations auth
      ON auth.tenant_id = run.tenant_id AND auth.project_id = run.project_id
     AND auth.run_id = run.id
    JOIN deviludo.inference_provider_revisions primary_provider
      ON primary_provider.tenant_id = auth.tenant_id
     AND primary_provider.provider_revision_id = auth.provider_revision_id
    JOIN deviludo.inference_provider_revisions fallback_provider
      ON fallback_provider.tenant_id = auth.tenant_id
     AND fallback_provider.provider_revision_id = NEW.to_provider_revision_id
   WHERE run.tenant_id = NEW.tenant_id AND run.project_id = NEW.project_id
     AND run.id = NEW.run_id
   FOR SHARE OF run, auth, primary_provider, fallback_provider;

  fallback := locked->'fallback';
  IF locked IS NULL OR fallback IS NULL OR jsonb_typeof(fallback) <> 'object'
     OR locked->>'profileSource' <> ('project:' || NEW.project_id::text)
     OR locked->>'agent' <> fallback->>'agent'
     OR locked->>'profileRevisionId' <> NEW.from_profile_revision_id
     OR locked->>'providerRevisionId' <> NEW.from_provider_revision_id
     OR fallback->>'profileRevisionId' <> NEW.to_profile_revision_id
     OR fallback->>'providerRevisionId' <> NEW.to_provider_revision_id
     OR fallback->>'credentialVersionId' <> NEW.to_credential_version_id
     OR fallback->'modelRoles' IS NULL
     OR NOT (fallback->'modelRoles' ?& ARRAY[
       'primaryModel', 'planningModel', 'smallFastModel', 'subagentModel'
     ])
     OR NOT (NEW.to_models @> ARRAY[
       fallback->'modelRoles'->>'primaryModel', fallback->'modelRoles'->>'planningModel',
       fallback->'modelRoles'->>'smallFastModel', fallback->'modelRoles'->>'subagentModel'
     ])
     OR NOT (NEW.to_models <@ ARRAY[
       fallback->'modelRoles'->>'primaryModel', fallback->'modelRoles'->>'planningModel',
       fallback->'modelRoles'->>'smallFastModel', fallback->'modelRoles'->>'subagentModel'
     ])
     OR NEW.to_budget <> jsonb_build_object('maxCostUsd', (fallback->'budget'->>'maxUsd')::numeric)
     OR NEW.authorization_expires_at <> (fallback->>'inferenceAuthorizationExpiresAt')::timestamptz
     OR authorization_profile_revision_id <> NEW.from_profile_revision_id
     OR authorization_provider_revision_id <> NEW.from_provider_revision_id
     OR authorization_state <> 'ACTIVE'
     OR authorization_expires_at <= NEW.activated_at + interval '30 seconds'
     OR primary_provider_state = 'ACTIVE'
     OR fallback_provider_state <> 'ACTIVE'
     OR NEW.authorization_expires_at <= NEW.activated_at + interval '30 seconds'
     OR run_state NOT IN ('QUEUED', 'WAITING_PROVIDER')
     OR EXISTS (
       SELECT 1 FROM deviludo.inference_request_claims claim
        WHERE claim.tenant_id = NEW.tenant_id AND claim.run_id = NEW.run_id
          AND claim.state IN ('ACTIVE', 'INDETERMINATE')
     ) THEN
    RAISE EXCEPTION 'Agent run Provider failover is not authorized' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER agent_run_provider_failover_validate
BEFORE INSERT ON deviludo.agent_run_provider_failovers
FOR EACH ROW EXECUTE FUNCTION deviludo.validate_agent_run_provider_failover();
CREATE TRIGGER agent_run_provider_failover_append_only
BEFORE UPDATE OR DELETE ON deviludo.agent_run_provider_failovers
FOR EACH ROW EXECUTE FUNCTION deviludo.reject_mutation();

ALTER TABLE deviludo.agent_run_provider_failovers ENABLE ROW LEVEL SECURITY;
ALTER TABLE deviludo.agent_run_provider_failovers FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON deviludo.agent_run_provider_failovers
  USING (tenant_id = deviludo.current_tenant_id())
  WITH CHECK (tenant_id = deviludo.current_tenant_id());

CREATE INDEX agent_run_provider_failover_project_idx
  ON deviludo.agent_run_provider_failovers (tenant_id, project_id, activated_at);

COMMIT;
