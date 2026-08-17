BEGIN;

DO $$
DECLARE legacy_constraint record;
BEGIN
  FOR legacy_constraint IN
    SELECT conname
      FROM pg_constraint
     WHERE conrelid = 'deviludo.instance_agent_settings'::regclass
       AND contype = 'c'
       AND pg_get_constraintdef(oid) LIKE '%primary_model IS NULL%subagent_model IS NOT NULL%'
  LOOP
    EXECUTE format('ALTER TABLE deviludo.instance_agent_settings DROP CONSTRAINT %I', legacy_constraint.conname);
  END LOOP;
END
$$;

UPDATE deviludo.instance_agent_settings
   SET primary_model = coalesce(primary_model, role_models->>'development'),
       opus_model = CASE WHEN agent_runtime = 'CLAUDE_CODE' THEN coalesce(opus_model, role_models->>'development') END,
       sonnet_model = CASE WHEN agent_runtime = 'CLAUDE_CODE' THEN coalesce(sonnet_model, role_models->>'design') END,
       haiku_model = CASE WHEN agent_runtime = 'CLAUDE_CODE' THEN coalesce(haiku_model, role_models->>'test') END,
       subagent_model = CASE WHEN agent_runtime = 'CLAUDE_CODE' THEN coalesce(subagent_model, role_models->>'development') END
 WHERE singleton = true;

ALTER TABLE deviludo.instance_agent_settings
  ADD CONSTRAINT instance_agent_settings_runtime_models CHECK (
    (agent_runtime = 'CLAUDE_CODE' AND primary_model IS NOT NULL AND opus_model IS NOT NULL
      AND sonnet_model IS NOT NULL AND haiku_model IS NOT NULL AND subagent_model IS NOT NULL)
    OR
    (agent_runtime = 'CODEX_CLI' AND primary_model IS NOT NULL AND opus_model IS NULL
      AND sonnet_model IS NULL AND haiku_model IS NULL AND subagent_model IS NULL)
  );

CREATE TABLE deviludo.instance_agent_provider_profiles (
  agent_runtime deviludo.agent_runtime PRIMARY KEY,
  base_url text NOT NULL CHECK (length(base_url) BETWEEN 8 AND 2048 AND base_url ~ '^https?://'),
  primary_model text NOT NULL CHECK (primary_model ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'),
  opus_model text CHECK (opus_model IS NULL OR opus_model ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'),
  sonnet_model text CHECK (sonnet_model IS NULL OR sonnet_model ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'),
  haiku_model text CHECK (haiku_model IS NULL OR haiku_model ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'),
  subagent_model text CHECK (subagent_model IS NULL OR subagent_model ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'),
  role_models jsonb NOT NULL CHECK (
    jsonb_typeof(role_models) = 'object'
    AND role_models ?& ARRAY['design', 'development', 'test']
    AND (role_models->>'design') ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'
    AND (role_models->>'development') ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'
    AND (role_models->>'test') ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'
  ),
  credential_secret_ref text NOT NULL CHECK (
    length(credential_secret_ref) BETWEEN 32 AND 1000
    AND credential_secret_ref LIKE 'vault://instance/agent-runtime/api-key/versions/%'
  ),
  api_key_mask text NOT NULL CHECK (api_key_mask ~ '^.{3}\*{8}.{4}$'),
  api_key_fingerprint text NOT NULL CHECK (api_key_fingerprint ~ '^sha256:[0-9a-f]{12}$'),
  credential_version uuid NOT NULL,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  test_policy_ready boolean NOT NULL DEFAULT false,
  test_policy_checked_revision bigint CHECK (test_policy_checked_revision IS NULL OR test_policy_checked_revision > 0),
  updated_by text NOT NULL CHECK (length(updated_by) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (
    (agent_runtime = 'CLAUDE_CODE' AND opus_model IS NOT NULL AND sonnet_model IS NOT NULL
      AND haiku_model IS NOT NULL AND subagent_model IS NOT NULL)
    OR
    (agent_runtime = 'CODEX_CLI' AND opus_model IS NULL AND sonnet_model IS NULL
      AND haiku_model IS NULL AND subagent_model IS NULL)
  )
);

-- The legacy singleton is the only configuration whose ownership is known.
-- Migrate it to its selected runtime only; creating a second profile that
-- points at the same credential would defeat provider isolation.
INSERT INTO deviludo.instance_agent_provider_profiles(
  agent_runtime, base_url, primary_model, opus_model, sonnet_model, haiku_model,
  subagent_model, role_models, credential_secret_ref, api_key_mask,
  api_key_fingerprint, credential_version, revision, test_policy_ready,
  test_policy_checked_revision, updated_by, created_at, updated_at
)
SELECT agent_runtime, base_url,
       coalesce(primary_model, role_models->>'development'),
       CASE WHEN agent_runtime = 'CLAUDE_CODE' THEN coalesce(opus_model, role_models->>'development') END,
       CASE WHEN agent_runtime = 'CLAUDE_CODE' THEN coalesce(sonnet_model, role_models->>'design') END,
       CASE WHEN agent_runtime = 'CLAUDE_CODE' THEN coalesce(haiku_model, role_models->>'test') END,
       CASE WHEN agent_runtime = 'CLAUDE_CODE' THEN coalesce(subagent_model, role_models->>'development') END,
       role_models, credential_secret_ref, api_key_mask, api_key_fingerprint,
       credential_version, revision, test_policy_ready,
       test_policy_checked_revision, updated_by, created_at, updated_at
  FROM deviludo.instance_agent_settings
 WHERE singleton = true
ON CONFLICT (agent_runtime) DO NOTHING;

GRANT SELECT, INSERT, UPDATE ON deviludo.instance_agent_provider_profiles TO deviludo_api;

COMMIT;
