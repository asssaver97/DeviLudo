BEGIN;

-- Agent configuration resolution already verifies the administrator catalog,
-- but PostgreSQL is the final authority for a Run lock. Existing rows may
-- predate the version-to-Adapter receipt and must remain resumable; every row
-- inserted after this migration is forced into the strict contract even when
-- a caller explicitly supplies false. The sole compatibility path is a new
-- repair Run whose immutable runtime identity matches a migration-marked
-- historical predecessor in the same tenant and project.
ALTER TABLE deviludo.agent_runs
  ADD COLUMN agent_version_attestation_required boolean;

UPDATE deviludo.agent_runs
   SET agent_version_attestation_required = false
 WHERE agent_version_attestation_required IS NULL;

ALTER TABLE deviludo.agent_runs
  ALTER COLUMN agent_version_attestation_required SET DEFAULT true,
  ALTER COLUMN agent_version_attestation_required SET NOT NULL;

CREATE OR REPLACE FUNCTION deviludo.agent_profile_version_attestation_is_valid(profile jsonb)
RETURNS boolean
LANGUAGE plpgsql IMMUTABLE
AS $$
DECLARE
  attestation jsonb;
  compatibility jsonb;
  attestation_keys text[];
  compatibility_keys text[];
  adapter_version text;
  validated_adapter_version text;
  maximum_exclusive text;
BEGIN
  IF jsonb_typeof(profile) IS DISTINCT FROM 'object' THEN
    RETURN false;
  END IF;
  attestation := profile->'agentVersionAttestation';
  compatibility := attestation->'adapterCompatibility';
  IF jsonb_typeof(attestation) IS DISTINCT FROM 'object'
     OR jsonb_typeof(compatibility) IS DISTINCT FROM 'object' THEN
    RETURN false;
  END IF;

  SELECT array_agg(key ORDER BY key) INTO attestation_keys
    FROM jsonb_object_keys(attestation) AS keys(key);
  IF attestation_keys IS DISTINCT FROM ARRAY[
    'adapterCompatibility', 'catalogReceiptDigest',
    'supplyChainEvidenceDigest', 'validatedAdapterVersion',
    'validationReceiptDigest', 'validationReceiptId'
  ]::text[] THEN
    RETURN false;
  END IF;
  SELECT array_agg(key ORDER BY key) INTO compatibility_keys
    FROM jsonb_object_keys(compatibility) AS keys(key);
  IF compatibility_keys IS DISTINCT FROM ARRAY['maxExclusive', 'min']::text[] THEN
    RETURN false;
  END IF;

  adapter_version := profile->>'adapterVersion';
  validated_adapter_version := attestation->>'validatedAdapterVersion';
  maximum_exclusive := compatibility->>'maxExclusive';
  IF adapter_version IS NULL OR validated_adapter_version IS NULL
     OR length(validated_adapter_version) > 32 OR length(maximum_exclusive) > 32
     OR adapter_version IS DISTINCT FROM validated_adapter_version
     OR compatibility->>'min' IS DISTINCT FROM validated_adapter_version
     OR validated_adapter_version !~ '^[0-9]+\.[0-9]+\.[0-9]+$'
     OR maximum_exclusive !~ '^[0-9]+\.[0-9]+\.[0-9]+$'
     OR split_part(maximum_exclusive, '.', 1) IS DISTINCT FROM split_part(validated_adapter_version, '.', 1)
     OR split_part(maximum_exclusive, '.', 2) IS DISTINCT FROM split_part(validated_adapter_version, '.', 2)
     OR split_part(maximum_exclusive, '.', 3)::numeric
          IS DISTINCT FROM split_part(validated_adapter_version, '.', 3)::numeric + 1
     OR NOT COALESCE(attestation->>'validationReceiptId'
          ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$', false)
     OR NOT COALESCE(attestation->>'catalogReceiptDigest' ~ '^[a-f0-9]{64}$', false)
     OR NOT COALESCE(attestation->>'validationReceiptDigest' ~ '^[a-f0-9]{64}$', false)
     OR NOT COALESCE(attestation->>'supplyChainEvidenceDigest' ~ '^[a-f0-9]{64}$', false) THEN
    RETURN false;
  END IF;
  RETURN true;
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
  RETURN false;
END;
$$;

CREATE OR REPLACE FUNCTION deviludo.agent_profile_runtime_binding(profile jsonb)
RETURNS jsonb
LANGUAGE sql IMMUTABLE
AS $$
  SELECT CASE WHEN jsonb_typeof(profile) = 'object' THEN jsonb_build_object(
    'profileRevisionId', profile->'profileRevisionId',
    'installationId', profile->'installationId',
    'workerPool', profile->'workerPool',
    'imageDigest', profile->'imageDigest',
    'agentVersionId', profile->'agentVersionId',
    'exactAgentVersion', profile->'exactAgentVersion',
    'agentVersionSourceDigest', profile->'agentVersionSourceDigest',
    'agentVersionAttestation', profile->'agentVersionAttestation',
    'adapterVersion', profile->'adapterVersion',
    'workerImageId', profile->'workerImageId',
    'buildReceiptId', profile->'buildReceiptId',
    'buildReceiptDigest', profile->'buildReceiptDigest',
    'agent', profile->'agent',
    'providerRevisionId', profile->'providerRevisionId',
    'providerProtocol', profile->'providerProtocol',
    'providerBaseUrl', profile->'providerBaseUrl',
    'providerApprovedPorts', profile->'providerApprovedPorts',
    'providerAuthentication', profile->'providerAuthentication',
    'providerPricing', profile->'providerPricing',
    'providerGovernance', profile->'providerGovernance',
    'modelRoles', profile->'modelRoles',
    'credentialVersionId', profile->'credentialVersionId',
    'budget', profile->'budget'
  ) ELSE NULL END
$$;

CREATE OR REPLACE FUNCTION deviludo.force_new_agent_run_version_attestation()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  predecessor_lock jsonb;
  predecessor_attestation_required boolean;
  predecessor_id_text text;
BEGIN
  NEW.agent_version_attestation_required := true;
  IF deviludo.agent_profile_version_attestation_is_valid(NEW.configuration_lock)
     AND (
       NEW.configuration_lock->'fallback' IS NULL
       OR NEW.configuration_lock->'fallback' = 'null'::jsonb
       OR deviludo.agent_profile_version_attestation_is_valid(NEW.configuration_lock->'fallback')
     ) THEN
    RETURN NEW;
  END IF;

  predecessor_id_text := NEW.configuration_lock->'repairContext'->>'fromRunConfigurationId';
  IF jsonb_typeof(NEW.configuration_lock->'repairContext') = 'object'
     AND predecessor_id_text ~* '^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$' THEN
    SELECT predecessor.configuration_lock,
           predecessor.agent_version_attestation_required
      INTO predecessor_lock, predecessor_attestation_required
      FROM deviludo.agent_runs predecessor
     WHERE predecessor.tenant_id = NEW.tenant_id
       AND predecessor.project_id = NEW.project_id
       AND predecessor.id = predecessor_id_text::uuid
     FOR SHARE;

    IF FOUND AND predecessor_attestation_required = false
       AND NEW.profile_revision_id IS NOT DISTINCT FROM predecessor_lock->>'profileRevisionId'
       AND NEW.installation_id IS NOT DISTINCT FROM predecessor_lock->>'installationId'
       AND NEW.image_digest IS NOT DISTINCT FROM predecessor_lock->>'imageDigest'
       AND NEW.adapter_version IS NOT DISTINCT FROM predecessor_lock->>'adapterVersion'
       AND NEW.exact_agent_version IS NOT DISTINCT FROM predecessor_lock->>'exactAgentVersion'
       AND NEW.provider_revision_id IS NOT DISTINCT FROM predecessor_lock->>'providerRevisionId'
       AND NEW.model IS NOT DISTINCT FROM predecessor_lock->'modelRoles'->>'primaryModel'
       AND NEW.credential_version_id IS NOT DISTINCT FROM predecessor_lock->>'credentialVersionId'
       AND NEW.configuration_lock->>'profileSource' IS NOT DISTINCT FROM predecessor_lock->>'profileSource'
       AND NEW.configuration_lock->'adminCatalogRevision' IS NOT DISTINCT FROM predecessor_lock->'adminCatalogRevision'
       AND deviludo.agent_profile_runtime_binding(NEW.configuration_lock)
           IS NOT DISTINCT FROM deviludo.agent_profile_runtime_binding(predecessor_lock)
       AND deviludo.agent_profile_runtime_binding(NEW.configuration_lock->'fallback')
           IS NOT DISTINCT FROM deviludo.agent_profile_runtime_binding(predecessor_lock->'fallback') THEN
      NEW.agent_version_attestation_required := false;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER agent_run_force_version_attestation
BEFORE INSERT ON deviludo.agent_runs
FOR EACH ROW EXECUTE FUNCTION deviludo.force_new_agent_run_version_attestation();

ALTER TABLE deviludo.agent_runs
  ADD CONSTRAINT agent_run_version_attestation_shape CHECK (
    jsonb_typeof(configuration_lock) = 'object'
    AND (
      (
        (configuration_lock->'agentVersionAttestation' IS NULL
          OR configuration_lock->'agentVersionAttestation' = 'null'::jsonb)
        AND NOT agent_version_attestation_required
      )
      OR deviludo.agent_profile_version_attestation_is_valid(configuration_lock)
    )
    AND (
      configuration_lock->'fallback' IS NULL
      OR configuration_lock->'fallback' = 'null'::jsonb
      OR (
        jsonb_typeof(configuration_lock->'fallback') = 'object'
        AND (
          (
            (configuration_lock->'fallback'->'agentVersionAttestation' IS NULL
              OR configuration_lock->'fallback'->'agentVersionAttestation' = 'null'::jsonb)
            AND NOT agent_version_attestation_required
          )
          OR deviludo.agent_profile_version_attestation_is_valid(configuration_lock->'fallback')
        )
      )
    )
  ) NOT VALID;

ALTER TABLE deviludo.agent_runs
  VALIDATE CONSTRAINT agent_run_version_attestation_shape;

-- The historical/new marker is part of the immutable authorization. It cannot
-- be flipped after insert to upgrade or downgrade the proof requirement.
CREATE OR REPLACE FUNCTION deviludo.protect_run_configuration()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.profile_revision_id, NEW.installation_id, NEW.image_digest,
         NEW.adapter_version, NEW.exact_agent_version, NEW.provider_revision_id,
         NEW.model, NEW.credential_version_id, NEW.configuration_lock,
         NEW.resolution_digest, NEW.spec_revision_id, NEW.test_plan_revision_id,
         NEW.spec_approval_receipt_id, NEW.source_baseline_receipt_id,
         NEW.agent_version_attestation_required)
     IS DISTINCT FROM
     ROW(OLD.profile_revision_id, OLD.installation_id, OLD.image_digest,
         OLD.adapter_version, OLD.exact_agent_version, OLD.provider_revision_id,
         OLD.model, OLD.credential_version_id, OLD.configuration_lock,
         OLD.resolution_digest, OLD.spec_revision_id, OLD.test_plan_revision_id,
         OLD.spec_approval_receipt_id, OLD.source_baseline_receipt_id,
         OLD.agent_version_attestation_required) THEN
    RAISE EXCEPTION 'agent run configuration lock is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

COMMIT;
