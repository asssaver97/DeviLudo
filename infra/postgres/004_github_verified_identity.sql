BEGIN;

ALTER TABLE deviludo.github_installations
  ADD COLUMN verified_by_github_user_id bigint,
  ADD COLUMN verified_by_github_user_node_id text,
  ADD COLUMN verified_by_github_user_login text;

ALTER TABLE deviludo.github_installations
  ADD CONSTRAINT github_installation_verified_identity_complete CHECK (
    (status = 'PENDING_VERIFICATION' AND verified_by_github_user_id IS NULL
      AND verified_by_github_user_node_id IS NULL
      AND verified_by_github_user_login IS NULL)
    OR
    (status <> 'PENDING_VERIFICATION' AND verified_by_github_user_id > 0
      AND verified_by_github_user_node_id IS NOT NULL
      AND verified_by_github_user_login IS NOT NULL)
  ) NOT VALID;

CREATE INDEX github_installation_verifier_idx
  ON deviludo.github_installations (tenant_id, verified_by_github_user_id, status);

COMMIT;
