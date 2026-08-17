BEGIN;

ALTER TABLE deviludo.instance_agent_settings
  ADD COLUMN image_model text CHECK (
    image_model IS NULL OR image_model ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'
  );

ALTER TABLE deviludo.instance_agent_settings
  DROP CONSTRAINT IF EXISTS instance_agent_settings_runtime_models;
ALTER TABLE deviludo.instance_agent_settings
  DROP CONSTRAINT IF EXISTS instance_agent_settings_claude_provider_only;
ALTER TABLE deviludo.instance_agent_settings
  ADD CONSTRAINT instance_agent_settings_runtime_models CHECK (
    (agent_runtime = 'CLAUDE_CODE' AND primary_model IS NOT NULL AND opus_model IS NOT NULL
      AND sonnet_model IS NOT NULL AND haiku_model IS NOT NULL AND subagent_model IS NOT NULL)
    OR
    (agent_runtime = 'CODEX_CLI' AND primary_model IS NOT NULL AND opus_model IS NULL
      AND sonnet_model IS NULL AND haiku_model IS NULL AND subagent_model IS NULL
      AND image_model IS NULL)
  );

-- Asset gates now follow the selected Agent connection. Rebuild every stored
-- function containing the former singleton predicate before dropping that table.
DO $$
DECLARE
  routine record;
  definition text;
BEGIN
  FOR routine IN
    SELECT procedure.oid, pg_get_functiondef(procedure.oid) AS source
      FROM pg_proc procedure
      JOIN pg_namespace namespace ON namespace.oid = procedure.pronamespace
     WHERE namespace.nspname = 'deviludo'
       AND pg_get_functiondef(procedure.oid) LIKE '%instance_image_generation_settings%'
  LOOP
    definition := regexp_replace(
      routine.source,
      'EXISTS\s*\(\s*SELECT 1 FROM deviludo\.instance_image_generation_settings WHERE singleton = true\s*\)',
      'EXISTS (SELECT 1 FROM deviludo.instance_agent_settings WHERE singleton = true AND agent_runtime = ''CLAUDE_CODE'' AND image_model IS NOT NULL)',
      'g'
    );
    IF definition LIKE '%instance_image_generation_settings%' THEN
      RAISE EXCEPTION 'Unable to rewrite image generation dependency in function %', routine.oid::regprocedure;
    END IF;
    EXECUTE definition;
  END LOOP;
END
$$;

DROP TABLE deviludo.instance_image_generation_settings;

GRANT SELECT ON deviludo.instance_agent_settings TO deviludo_scheduler, deviludo_sandbox, deviludo_claim_executor;

COMMIT;
