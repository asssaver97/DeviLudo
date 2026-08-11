BEGIN;

-- Agent jobs call complete_job as deviludo_sandbox. That SECURITY INVOKER
-- function reads the singleton to decide whether planned images gate Builder.
GRANT SELECT ON deviludo.instance_image_generation_settings TO deviludo_sandbox;

COMMIT;
