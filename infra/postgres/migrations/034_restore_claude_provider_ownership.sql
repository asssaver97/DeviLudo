BEGIN;

-- Migration 032 followed the selected runtime of the old singleton. During the
-- short-lived Codex custom-Provider rollout that singleton could contain a
-- Claude gateway, so move the only retained Provider credential back to Claude.
INSERT INTO deviludo.instance_agent_provider_profiles(
  agent_runtime, base_url, primary_model, opus_model, sonnet_model, haiku_model,
  subagent_model, role_models, credential_secret_ref, api_key_mask,
  api_key_fingerprint, credential_version, revision, test_policy_ready,
  test_policy_checked_revision, updated_by, created_at, updated_at
)
SELECT 'CLAUDE_CODE'::deviludo.agent_runtime, base_url, primary_model,
       primary_model, primary_model, primary_model, primary_model, role_models,
       credential_secret_ref, api_key_mask, api_key_fingerprint,
       credential_version, revision, false, NULL, updated_by, created_at,
       clock_timestamp()
  FROM deviludo.instance_agent_provider_profiles codex
 WHERE codex.agent_runtime = 'CODEX_CLI'
   AND NOT EXISTS (
     SELECT 1
       FROM deviludo.instance_agent_provider_profiles claude
      WHERE claude.agent_runtime = 'CLAUDE_CODE'
   );

UPDATE deviludo.instance_agent_settings active
   SET agent_runtime = 'CLAUDE_CODE',
       base_url = profile.base_url,
       primary_model = profile.primary_model,
       opus_model = profile.opus_model,
       sonnet_model = profile.sonnet_model,
       haiku_model = profile.haiku_model,
       subagent_model = profile.subagent_model,
       role_models = profile.role_models,
       credential_secret_ref = profile.credential_secret_ref,
       api_key_mask = profile.api_key_mask,
       api_key_fingerprint = profile.api_key_fingerprint,
       credential_version = profile.credential_version,
       test_policy_ready = false,
       test_policy_checked_revision = NULL,
       revision = active.revision + 1,
       updated_by = profile.updated_by,
       updated_at = clock_timestamp()
  FROM deviludo.instance_agent_provider_profiles profile
 WHERE active.singleton = true
   AND active.agent_runtime = 'CODEX_CLI'
   AND profile.agent_runtime = 'CLAUDE_CODE';

DELETE FROM deviludo.instance_agent_provider_profiles
 WHERE agent_runtime = 'CODEX_CLI';

DO $$
DECLARE constraint_row record;
BEGIN
  FOR constraint_row IN
    SELECT conrelid::regclass AS relation_name, conname
      FROM pg_constraint
     WHERE conrelid IN (
       'deviludo.instance_agent_settings'::regclass,
       'deviludo.instance_agent_provider_profiles'::regclass
     )
       AND contype = 'c'
       AND pg_get_constraintdef(oid) LIKE '%agent_runtime = ''CODEX_CLI''%'
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', constraint_row.relation_name, constraint_row.conname);
  END LOOP;
END
$$;

ALTER TABLE deviludo.instance_agent_settings
  ADD CONSTRAINT instance_agent_settings_claude_provider_only CHECK (
    agent_runtime = 'CLAUDE_CODE'
    AND primary_model IS NOT NULL
    AND opus_model IS NOT NULL
    AND sonnet_model IS NOT NULL
    AND haiku_model IS NOT NULL
    AND subagent_model IS NOT NULL
  );

ALTER TABLE deviludo.instance_agent_provider_profiles
  ADD CONSTRAINT instance_agent_provider_profiles_claude_only CHECK (
    agent_runtime = 'CLAUDE_CODE'
    AND opus_model IS NOT NULL
    AND sonnet_model IS NOT NULL
    AND haiku_model IS NOT NULL
    AND subagent_model IS NOT NULL
  );

COMMIT;
