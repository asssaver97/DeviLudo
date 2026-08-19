BEGIN;

ALTER TABLE deviludo.instance_agent_settings
  ADD COLUMN image_model text,
  DROP CONSTRAINT IF EXISTS instance_agent_settings_model_overrides;

UPDATE deviludo.instance_agent_settings
   SET image_model = model_overrides->>'image',
       model_overrides = jsonb_build_object(
         'design', model_overrides->'design',
         'development', model_overrides->'development',
         'test', model_overrides->'test'
       );

ALTER TABLE deviludo.instance_agent_settings
  ADD CONSTRAINT instance_agent_settings_model_overrides CHECK (
    jsonb_typeof(model_overrides) = 'object'
    AND model_overrides ?& ARRAY['design', 'development', 'test']
    AND model_overrides - ARRAY['design', 'development', 'test']::text[] = '{}'::jsonb
    AND (model_overrides->'design' = 'null'::jsonb OR (model_overrides->>'design') ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$')
    AND (model_overrides->'development' = 'null'::jsonb OR (model_overrides->>'development') ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$')
    AND (model_overrides->'test' = 'null'::jsonb OR (model_overrides->>'test') ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$')
  ),
  ADD CONSTRAINT instance_agent_settings_image_model CHECK (
    image_model IS NULL OR image_model ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'
  );

COMMIT;
