-- Development remote E2E nodes keep a node-bound credential after their
-- one-time enrollment record is expired and removed.

ALTER TABLE deviludo.server_nodes
  ADD COLUMN IF NOT EXISTS development_auth_token_hash text
  CHECK (
    development_auth_token_hash IS NULL
    OR development_auth_token_hash ~ '^sha256:[0-9a-f]{64}$'
  );
