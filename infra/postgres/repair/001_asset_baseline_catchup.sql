-- One-shot repair for a local database whose schema predates
-- infra/postgres/001_core.sql. It exists because migrate-postgres.mjs applied the
-- baseline only when absent and then verified a compatibility string that had not
-- changed, so every edit to that file after the volume was created was skipped.
-- The result was a database missing the asset tables entirely and running an
-- accept_workflow_signal with no STAGE_RERUN_REQUESTED branch: reruns were
-- accepted and routed nowhere.
--
-- This brings the schema up to the committed baseline WITHOUT dropping the
-- existing projects, which is why it is written by hand rather than by re-running
-- the baseline. It is idempotent and safe to run against an already-current
-- database. New environments get the baseline directly and never need this.
--
-- The function bodies are NOT duplicated here: they are replayed from
-- 001_core.sql by scripts/repair-local-baseline.mjs, so this file cannot drift
-- from them.

BEGIN;

-- The pre-asset baseline had no timeout_seconds column at all; the current one
-- defaults it per kind in enqueue_job. Adding it with the same default the
-- baseline declares keeps rows written by either version valid.
ALTER TABLE deviludo.jobs
  ADD COLUMN IF NOT EXISTS timeout_seconds integer NOT NULL DEFAULT 1800;

ALTER TABLE deviludo.schema_metadata
  ADD COLUMN IF NOT EXISTS source_digest text
    CHECK (source_digest IS NULL OR source_digest ~ '^sha256:[0-9a-f]{64}$');

CREATE TABLE IF NOT EXISTS deviludo.instance_image_generation_settings (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  provider text NOT NULL
    CHECK (provider IN ('dalle-3', 'stable-diffusion-xl', 'midjourney', 'replicate')),
  api_endpoint text CHECK (
    api_endpoint IS NULL
    OR (length(api_endpoint) BETWEEN 8 AND 2048 AND api_endpoint ~ '^https?://')
  ),
  model text CHECK (model IS NULL OR model ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'),
  credential_secret_ref text NOT NULL CHECK (
    length(credential_secret_ref) BETWEEN 32 AND 1000
    AND credential_secret_ref LIKE 'vault://instance/image-generation/api-key/versions/%'
  ),
  api_key_mask text NOT NULL CHECK (api_key_mask ~ '^.{3}\*{8}.{4}$'),
  api_key_fingerprint text NOT NULL CHECK (api_key_fingerprint ~ '^sha256:[0-9a-f]{12}$'),
  credential_version uuid NOT NULL,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_by text NOT NULL CHECK (length(updated_by) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS deviludo.asset_manifests (
  workspace_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  workflow_id uuid,
  auto_generate_enabled boolean NOT NULL DEFAULT false,
  planned_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, project_id),
  FOREIGN KEY (workspace_id) REFERENCES deviludo.workspaces(id),
  FOREIGN KEY (workspace_id, project_id) REFERENCES deviludo.projects(workspace_id, id),
  FOREIGN KEY (workspace_id, workflow_id) REFERENCES deviludo.workflow_instances(workspace_id, id)
);

CREATE TABLE IF NOT EXISTS deviludo.asset_items (
  workspace_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  manifest_id uuid NOT NULL,
  asset_key text NOT NULL CHECK (length(asset_key) BETWEEN 1 AND 200),
  asset_type text NOT NULL
    CHECK (asset_type IN ('sprite', 'animation', 'background', 'ui', 'icon', 'tileset')),
  description text NOT NULL CHECK (length(description) BETWEEN 1 AND 2000),
  generation_prompt text CHECK (generation_prompt IS NULL OR length(generation_prompt) BETWEEN 1 AND 4000),
  frame_count integer CHECK (frame_count IS NULL OR frame_count BETWEEN 1 AND 4096),
  dimensions text CHECK (dimensions IS NULL OR dimensions ~ '^[0-9]{1,5}x[0-9]{1,5}$'),
  status text NOT NULL DEFAULT 'planned'
    CHECK (status IN ('planned', 'generating', 'generated', 'uploaded', 'failed')),
  bucket text,
  object_key text,
  sha256 text CHECK (sha256 IS NULL OR sha256 ~ '^sha256:[0-9a-f]{64}$'),
  size_bytes bigint CHECK (size_bytes IS NULL OR size_bytes > 0),
  error_message text CHECK (error_message IS NULL OR length(error_message) BETWEEN 1 AND 2000),
  generation_attempt integer NOT NULL DEFAULT 0
    CHECK (generation_attempt BETWEEN 0 AND 3),
  generation_lease_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, manifest_id, asset_key),
  FOREIGN KEY (workspace_id) REFERENCES deviludo.workspaces(id),
  FOREIGN KEY (workspace_id, manifest_id) REFERENCES deviludo.asset_manifests(workspace_id, id)
    ON DELETE CASCADE,
  CONSTRAINT asset_items_lease_requires_generating CHECK (
    (generation_lease_expires_at IS NOT NULL) = (status = 'generating')
  ),
  CHECK (
    (status IN ('generated', 'uploaded'))
      = (object_key IS NOT NULL AND bucket IS NOT NULL AND sha256 IS NOT NULL AND size_bytes IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS asset_items_manifest_status
  ON deviludo.asset_items (workspace_id, manifest_id, status);

-- Row-level security and its policy, applied only where absent so a re-run does
-- not fail on the existing policy. These two tables carry workspace data, so
-- missing isolation here would be a cross-tenant read.
DO $rls$
DECLARE
  target text;
BEGIN
  FOREACH target IN ARRAY ARRAY['asset_manifests', 'asset_items']
  LOOP
    EXECUTE format('ALTER TABLE deviludo.%I ENABLE ROW LEVEL SECURITY', target);
    EXECUTE format('ALTER TABLE deviludo.%I FORCE ROW LEVEL SECURITY', target);
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
       WHERE schemaname = 'deviludo' AND tablename = target AND policyname = 'workspace_isolation'
    ) THEN
      EXECUTE format(
        'CREATE POLICY workspace_isolation ON deviludo.%I USING (workspace_id = deviludo.current_workspace_id()) WITH CHECK (workspace_id = deviludo.current_workspace_id())',
        target
      );
    END IF;
  END LOOP;
END
$rls$;

-- Grants mirroring the baseline's. GRANT is idempotent, so these are unconditional.
GRANT SELECT, INSERT, UPDATE ON deviludo.instance_image_generation_settings TO deviludo_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON deviludo.asset_manifests, deviludo.asset_items TO deviludo_api;
GRANT SELECT ON deviludo.instance_image_generation_settings TO deviludo_scheduler;
GRANT SELECT, INSERT, UPDATE ON deviludo.asset_manifests, deviludo.asset_items TO deviludo_sandbox;
GRANT DELETE ON deviludo.asset_items TO deviludo_sandbox;
GRANT SELECT, UPDATE ON deviludo.asset_items TO deviludo_claim_executor;
GRANT SELECT ON deviludo.asset_manifests, deviludo.instance_image_generation_settings
  TO deviludo_claim_executor;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA deviludo TO deviludo_claim_executor;

COMMIT;
