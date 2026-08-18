BEGIN;

ALTER TABLE deviludo.instance_agent_settings
  ADD COLUMN model_overrides jsonb;

UPDATE deviludo.instance_agent_settings
   SET model_overrides = jsonb_build_object(
     'design', CASE
       WHEN role_models->>'design' IS DISTINCT FROM primary_model THEN to_jsonb(role_models->>'design')
       ELSE 'null'::jsonb
     END,
     'development', CASE
       WHEN role_models->>'development' IS DISTINCT FROM primary_model THEN to_jsonb(role_models->>'development')
       ELSE 'null'::jsonb
     END,
     'test', CASE
       WHEN role_models->>'test' IS DISTINCT FROM primary_model THEN to_jsonb(role_models->>'test')
       ELSE 'null'::jsonb
     END,
     'image', CASE
       WHEN image_model IS NOT NULL AND image_model IS DISTINCT FROM primary_model THEN to_jsonb(image_model)
       ELSE 'null'::jsonb
     END
   );

ALTER TABLE deviludo.instance_agent_settings
  ALTER COLUMN model_overrides SET NOT NULL;

ALTER TABLE deviludo.instance_agent_settings
  DROP CONSTRAINT IF EXISTS instance_agent_settings_runtime_models;

-- Stored workflow functions freeze the effective Development model into new
-- jobs. Rewrite those snapshots before removing the obsolete five-route model
-- columns. This keeps in-flight installations migratable without retaining a
-- second runtime contract in application code.
DO $$
DECLARE
  routine record;
  definition text;
BEGIN
  FOR routine IN
    SELECT procedure.oid
      FROM pg_proc procedure
      JOIN pg_namespace namespace ON namespace.oid = procedure.pronamespace
     WHERE namespace.nspname = 'deviludo'
       AND procedure.prokind = 'f'
  LOOP
    definition := pg_get_functiondef(routine.oid);
    CONTINUE WHEN definition NOT LIKE '%agent_settings.opus_model%'
      AND definition NOT LIKE '%image_model IS NOT NULL%';
    definition := regexp_replace(
      definition,
      '''model'', CASE WHEN agent_settings\.agent_runtime = ''CODEX_CLI'' THEN agent_settings\.primary_model END,[[:space:]]*'
        || '''models'', CASE WHEN agent_settings\.agent_runtime <> ''CLAUDE_CODE'' OR agent_settings\.primary_model IS NULL THEN NULL ELSE jsonb_build_object\([[:space:]]*'
        || '''primary'', coalesce\(agent_settings\.role_models->>''development'', agent_settings\.primary_model\),[[:space:]]*'
        || '''opus'', agent_settings\.opus_model,[[:space:]]*'
        || '''sonnet'', agent_settings\.sonnet_model,[[:space:]]*'
        || '''haiku'', agent_settings\.haiku_model,[[:space:]]*'
        || '''subagent'', agent_settings\.subagent_model[[:space:]]*'
        || '\)[[:space:]]*END,[[:space:]]*''credentialRef''',
      '''model'', coalesce(agent_settings.model_overrides->>''development'', agent_settings.primary_model), ''credentialRef''',
      'g'
    );
    definition := replace(definition, ' AND image_model IS NOT NULL', '');
    IF definition LIKE '%agent_settings.opus_model%'
      OR definition LIKE '%agent_settings.sonnet_model%'
      OR definition LIKE '%agent_settings.haiku_model%'
      OR definition LIKE '%agent_settings.subagent_model%'
      OR definition LIKE '%agent_settings.role_models%'
      OR definition LIKE '%image_model IS NOT NULL%' THEN
      RAISE EXCEPTION 'Unable to rewrite legacy Agent model dependency in function %', routine.oid::regprocedure;
    END IF;
    EXECUTE definition;
  END LOOP;
END
$$;

ALTER TABLE deviludo.instance_agent_settings
  DROP COLUMN opus_model,
  DROP COLUMN sonnet_model,
  DROP COLUMN haiku_model,
  DROP COLUMN subagent_model,
  DROP COLUMN role_models,
  DROP COLUMN image_model;

ALTER TABLE deviludo.instance_agent_settings
  ALTER COLUMN primary_model SET NOT NULL,
  ADD CONSTRAINT instance_agent_settings_model_overrides CHECK (
    jsonb_typeof(model_overrides) = 'object'
    AND model_overrides ?& ARRAY['design', 'development', 'test', 'image']
    AND (model_overrides->'design' = 'null'::jsonb OR (model_overrides->>'design') ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$')
    AND (model_overrides->'development' = 'null'::jsonb OR (model_overrides->>'development') ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$')
    AND (model_overrides->'test' = 'null'::jsonb OR (model_overrides->>'test') ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$')
    AND (model_overrides->'image' = 'null'::jsonb OR (model_overrides->>'image') ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$')
  );

GRANT SELECT ON deviludo.instance_agent_settings
  TO deviludo_scheduler, deviludo_sandbox, deviludo_claim_executor;

COMMIT;
