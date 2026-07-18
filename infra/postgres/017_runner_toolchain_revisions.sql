BEGIN;

-- E2E toolchains are project-scoped immutable supply-chain revisions. The
-- approved specification binds one exact revision and digest; Artifact
-- Preparer never accepts these executable inputs from the workflow request.
CREATE TABLE deviludo.runner_toolchain_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES deviludo.tenants(id),
  project_id uuid NOT NULL REFERENCES deviludo.projects(id),
  revision integer NOT NULL CHECK (revision > 0),
  payload jsonb NOT NULL,
  payload_digest char(64) NOT NULL CHECK (payload_digest ~ '^[a-f0-9]{64}$'),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, project_id, revision),
  UNIQUE (tenant_id, project_id, id, payload_digest),
  CHECK (jsonb_typeof(payload) = 'object' AND pg_column_size(payload) <= 262144)
);

ALTER TABLE deviludo.runner_toolchain_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE deviludo.runner_toolchain_revisions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON deviludo.runner_toolchain_revisions
  USING (tenant_id = deviludo.current_tenant_id())
  WITH CHECK (tenant_id = deviludo.current_tenant_id());

CREATE TRIGGER runner_toolchain_revisions_append_only
BEFORE UPDATE OR DELETE ON deviludo.runner_toolchain_revisions
FOR EACH ROW EXECUTE FUNCTION deviludo.reject_mutation();

ALTER TABLE deviludo.approved_test_plan_bindings
  ADD COLUMN runner_toolchain_revision_id uuid NOT NULL,
  ADD COLUMN runner_toolchain_digest char(64) NOT NULL
    CHECK (runner_toolchain_digest ~ '^[a-f0-9]{64}$'),
  ADD CONSTRAINT approved_test_plan_runner_toolchain_fk
    FOREIGN KEY (tenant_id, project_id, runner_toolchain_revision_id, runner_toolchain_digest)
    REFERENCES deviludo.runner_toolchain_revisions (tenant_id, project_id, id, payload_digest);

CREATE INDEX approved_test_plan_binding_toolchain_idx
  ON deviludo.approved_test_plan_bindings
  (tenant_id, project_id, runner_toolchain_revision_id);

COMMIT;
