BEGIN;

-- Runtime security events are actors in the audit trail but are never valid
-- request principals. Keep Admin RBAC roles unchanged while permitting an
-- append-only System actor in materialized audit records.
ALTER TABLE deviludo.admin_audit_records
  DROP CONSTRAINT admin_audit_records_actor_role_check;
ALTER TABLE deviludo.admin_audit_records
  ADD CONSTRAINT admin_audit_records_actor_role_check CHECK (actor_role IN (
    'PlatformAgentAdmin', 'SecurityAdmin', 'TenantAdmin', 'ProjectOwner', 'Auditor', 'System'
  ));

CREATE OR REPLACE FUNCTION deviludo.audit_agent_run_provider_failover()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, deviludo
AS $$
BEGIN
  INSERT INTO deviludo.admin_audit_records (
    id, action, resource, actor_role, actor_id, tenant_id, project_id,
    request_id, occurred_at, metadata
  ) VALUES (
    'audit-' || (md5(NEW.tenant_id::text || ':' || NEW.run_id::text || ':provider-failover')::uuid)::text,
    'AGENT_RUN_PROVIDER_FAILOVER_ACTIVATED',
    'agent-run:' || NEW.run_id::text,
    'System',
    'agent-execution-broker',
    NEW.tenant_id::text,
    NEW.project_id::text,
    'provider-failover:' || NEW.run_id::text,
    NEW.activated_at,
    jsonb_build_object(
      'reason', NEW.reason,
      'fromProfileRevisionId', NEW.from_profile_revision_id,
      'fromProviderRevisionId', NEW.from_provider_revision_id,
      'toProfileRevisionId', NEW.to_profile_revision_id,
      'toProviderRevisionId', NEW.to_provider_revision_id,
      'toCredentialVersionId', NEW.to_credential_version_id,
      'toModels', to_jsonb(NEW.to_models),
      'toBudget', NEW.to_budget,
      'authorizationExpiresAt', NEW.authorization_expires_at
    )
  ) ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION deviludo.audit_agent_run_provider_failover() FROM PUBLIC;

CREATE TRIGGER agent_run_provider_failover_admin_audit
AFTER INSERT ON deviludo.agent_run_provider_failovers
FOR EACH ROW EXECUTE FUNCTION deviludo.audit_agent_run_provider_failover();

-- Backfill failovers committed after migration 046 but before this projection.
INSERT INTO deviludo.admin_audit_records (
  id, action, resource, actor_role, actor_id, tenant_id, project_id,
  request_id, occurred_at, metadata
)
SELECT
  'audit-' || (md5(event.tenant_id::text || ':' || event.run_id::text || ':provider-failover')::uuid)::text,
  'AGENT_RUN_PROVIDER_FAILOVER_ACTIVATED',
  'agent-run:' || event.run_id::text,
  'System',
  'agent-execution-broker',
  event.tenant_id::text,
  event.project_id::text,
  'provider-failover:' || event.run_id::text,
  event.activated_at,
  jsonb_build_object(
    'reason', event.reason,
    'fromProfileRevisionId', event.from_profile_revision_id,
    'fromProviderRevisionId', event.from_provider_revision_id,
    'toProfileRevisionId', event.to_profile_revision_id,
    'toProviderRevisionId', event.to_provider_revision_id,
    'toCredentialVersionId', event.to_credential_version_id,
    'toModels', to_jsonb(event.to_models),
    'toBudget', event.to_budget,
    'authorizationExpiresAt', event.authorization_expires_at
  )
FROM deviludo.agent_run_provider_failovers event
ON CONFLICT (id) DO NOTHING;

COMMIT;
