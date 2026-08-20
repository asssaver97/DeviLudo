ALTER TABLE deviludo.server_nodes
  ADD COLUMN IF NOT EXISTS preparation_state text,
  ADD COLUMN IF NOT EXISTS preparation_stage text,
  ADD COLUMN IF NOT EXISTS preparation_progress smallint,
  ADD COLUMN IF NOT EXISTS preparation_message text,
  ADD COLUMN IF NOT EXISTS preparation_updated_at timestamptz;

ALTER TABLE deviludo.server_nodes
  DROP CONSTRAINT IF EXISTS server_nodes_preparation_state_check,
  DROP CONSTRAINT IF EXISTS server_nodes_preparation_stage_check,
  DROP CONSTRAINT IF EXISTS server_nodes_preparation_progress_check,
  DROP CONSTRAINT IF EXISTS server_nodes_preparation_message_check,
  ADD CONSTRAINT server_nodes_preparation_state_check
    CHECK (preparation_state IS NULL OR preparation_state IN ('PREPARING', 'READY', 'FAILED')),
  ADD CONSTRAINT server_nodes_preparation_stage_check
    CHECK (preparation_stage IS NULL OR preparation_stage ~ '^[A-Z][A-Z0-9_]{1,39}$'),
  ADD CONSTRAINT server_nodes_preparation_progress_check
    CHECK (preparation_progress IS NULL OR preparation_progress BETWEEN 0 AND 100),
  ADD CONSTRAINT server_nodes_preparation_message_check
    CHECK (preparation_message IS NULL OR char_length(preparation_message) BETWEEN 1 AND 240);
