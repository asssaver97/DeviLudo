BEGIN;

ALTER TABLE deviludo.instance_agent_settings
  ADD COLUMN IF NOT EXISTS role_models jsonb;

UPDATE deviludo.instance_agent_settings
   SET role_models = jsonb_build_object(
     'design', coalesce(sonnet_model, primary_model, 'codex-mini-latest'),
     'development', coalesce(primary_model, 'codex-mini-latest'),
     'test', coalesce(haiku_model, primary_model, 'codex-mini-latest')
   )
 WHERE role_models IS NULL;

ALTER TABLE deviludo.instance_agent_settings
  ALTER COLUMN role_models SET NOT NULL;

ALTER TABLE deviludo.instance_agent_settings
  DROP CONSTRAINT IF EXISTS instance_agent_settings_role_models_check;
ALTER TABLE deviludo.instance_agent_settings
  ADD CONSTRAINT instance_agent_settings_role_models_check CHECK (
    jsonb_typeof(role_models) = 'object'
    AND role_models ?& ARRAY['design', 'development', 'test']
    AND (role_models->>'design') ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'
    AND (role_models->>'development') ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'
    AND (role_models->>'test') ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'
  );

-- Existing databases already contain the queue functions. Route every future
-- development job through the model assigned to the Development Agent while
-- retaining primary_model as a backward-compatible fallback.
DO $patch_development_model$
DECLARE
  routine record;
  definition text;
  original text := $needle$'primary', agent_settings.primary_model,$needle$;
  replacement text := $replacement$'primary', coalesce(agent_settings.role_models->>'development', agent_settings.primary_model),$replacement$;
BEGIN
  FOR routine IN
    SELECT procedure.oid
      FROM pg_proc procedure
     WHERE procedure.pronamespace = 'deviludo'::regnamespace
       AND procedure.prokind = 'f'
       AND position(original IN pg_get_functiondef(procedure.oid)) > 0
  LOOP
    definition := pg_get_functiondef(routine.oid);
    EXECUTE replace(definition, original, replacement);
  END LOOP;
END
$patch_development_model$;

COMMIT;
