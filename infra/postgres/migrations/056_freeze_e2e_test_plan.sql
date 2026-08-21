BEGIN;

-- A Test Agent plan is a workflow/platform contract, not a per-attempt guess.
-- Freeze the first validated manifest so product repair, rebuild, and E2E rerun
-- all exercise the same semantic controls and progress keys.
CREATE TABLE deviludo.e2e_test_plans (
  workspace_id uuid NOT NULL,
  workflow_id uuid NOT NULL,
  project_id uuid NOT NULL,
  target_platform deviludo.server_os NOT NULL,
  test_manifest jsonb NOT NULL CHECK (
    jsonb_typeof(test_manifest) = 'object'
    AND test_manifest->>'schema' = 'deviludo.test-manifest'
  ),
  test_manifest_digest text NOT NULL CHECK (test_manifest_digest ~ '^sha256:[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, workflow_id, target_platform),
  FOREIGN KEY (workspace_id, workflow_id)
    REFERENCES deviludo.workflow_instances(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, project_id)
    REFERENCES deviludo.projects(workspace_id, id) ON DELETE CASCADE
);

ALTER TABLE deviludo.e2e_test_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE deviludo.e2e_test_plans FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON deviludo.e2e_test_plans
  USING (workspace_id = deviludo.current_workspace_id())
  WITH CHECK (workspace_id = deviludo.current_workspace_id());

GRANT SELECT, INSERT ON deviludo.e2e_test_plans TO deviludo_api;

COMMIT;
