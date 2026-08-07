-- Asset manifest and items for parallel asset generation workflow
-- Schema version: 002

-- Asset manifest: 项目的素材清单
CREATE TABLE asset_manifests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id TEXT NOT NULL,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  schema_version TEXT NOT NULL DEFAULT 'deviludo.asset-manifest.v1',
  status TEXT NOT NULL CHECK (status IN ('planning', 'ready', 'partial', 'complete')),
  auto_generate_enabled BOOLEAN NOT NULL DEFAULT false,
  planned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  UNIQUE(project_id)
);

CREATE INDEX idx_asset_manifests_project ON asset_manifests(project_id);
CREATE INDEX idx_asset_manifests_workspace ON asset_manifests(workspace_id);

-- Asset items: 每个素材项
CREATE TABLE asset_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  manifest_id UUID NOT NULL REFERENCES asset_manifests(id) ON DELETE CASCADE,
  asset_key TEXT NOT NULL, -- 如 "sprites/player_idle", "animations/enemy_walk"
  asset_type TEXT NOT NULL CHECK (asset_type IN ('sprite', 'animation', 'background', 'ui', 'icon', 'tileset')),
  description TEXT NOT NULL, -- 用户可见的精准描述
  generation_prompt TEXT, -- 用于图片生成的 prompt（更技术性）
  frame_count INT CHECK (frame_count IS NULL OR frame_count > 0), -- 动画帧数
  dimensions TEXT, -- 推荐尺寸 "64x64" 或 "128x128"
  status TEXT NOT NULL CHECK (status IN ('planned', 'generating', 'generated', 'uploaded', 'failed')),
  object_key TEXT, -- S3 对象键（生成或上传后填充）
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(manifest_id, asset_key)
);

CREATE INDEX idx_asset_items_manifest ON asset_items(manifest_id);
CREATE INDEX idx_asset_items_status ON asset_items(status);

-- Asset generation jobs
CREATE TABLE asset_generation_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_item_id UUID NOT NULL REFERENCES asset_items(id) ON DELETE CASCADE,
  provider TEXT NOT NULL, -- 'dalle', 'stable-diffusion', 'replicate', etc.
  prompt TEXT NOT NULL,
  parameters JSONB,
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  result_object_key TEXT,
  error_message TEXT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_asset_generation_jobs_item ON asset_generation_jobs(asset_item_id);
CREATE INDEX idx_asset_generation_jobs_status ON asset_generation_jobs(status);

-- Row-level security
ALTER TABLE asset_manifests ENABLE ROW LEVEL SECURITY;
ALTER TABLE asset_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE asset_generation_jobs ENABLE ROW LEVEL SECURITY;

CREATE POLICY asset_manifests_workspace_isolation ON asset_manifests
  USING (workspace_id = current_setting('deviludo.workspace_id', true));

CREATE POLICY asset_items_workspace_isolation ON asset_items
  USING (EXISTS (
    SELECT 1 FROM asset_manifests m
    WHERE m.id = asset_items.manifest_id
    AND m.workspace_id = current_setting('deviludo.workspace_id', true)
  ));

CREATE POLICY asset_generation_jobs_workspace_isolation ON asset_generation_jobs
  USING (EXISTS (
    SELECT 1 FROM asset_items ai
    JOIN asset_manifests m ON m.id = ai.manifest_id
    WHERE ai.id = asset_generation_jobs.asset_item_id
    AND m.workspace_id = current_setting('deviludo.workspace_id', true)
  ));
