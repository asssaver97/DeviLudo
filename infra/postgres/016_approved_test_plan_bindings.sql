BEGIN;

-- Specification approval freezes the exact canonical test-plan revision used
-- by every later candidate and release gate. A digest alone is not authority:
-- the Artifact Preparer must resolve this append-only tenant/project/spec edge.
CREATE TABLE deviludo.approved_test_plan_bindings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES deviludo.tenants(id),
  project_id uuid NOT NULL REFERENCES deviludo.projects(id),
  spec_revision_id uuid NOT NULL REFERENCES deviludo.immutable_revisions(id),
  test_plan_revision_id uuid NOT NULL REFERENCES deviludo.immutable_revisions(id),
  test_plan_digest char(64) NOT NULL CHECK (test_plan_digest ~ '^[a-f0-9]{64}$'),
  target_matrix text[] NOT NULL,
  required_godot_version text NOT NULL CHECK (
    required_godot_version ~ '^4\.[0-9]+\.[0-9]+([.-][A-Za-z0-9]+)*$'
  ),
  approved_by text NOT NULL,
  approved_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, project_id, spec_revision_id),
  CHECK (
    cardinality(target_matrix) BETWEEN 1 AND 3
      AND target_matrix <@ ARRAY['windows', 'linux', 'macos']::text[]
      AND array_lower(target_matrix, 1) = 1
      AND array_position(target_matrix, NULL) IS NULL
      AND (target_matrix[2] IS NULL OR target_matrix[2] > target_matrix[1])
      AND (target_matrix[3] IS NULL OR target_matrix[3] > target_matrix[2])
  )
);

ALTER TABLE deviludo.approved_test_plan_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE deviludo.approved_test_plan_bindings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON deviludo.approved_test_plan_bindings
  USING (tenant_id = deviludo.current_tenant_id())
  WITH CHECK (tenant_id = deviludo.current_tenant_id());

CREATE TRIGGER approved_test_plan_bindings_append_only
BEFORE UPDATE OR DELETE ON deviludo.approved_test_plan_bindings
FOR EACH ROW EXECUTE FUNCTION deviludo.reject_mutation();

CREATE INDEX approved_test_plan_binding_plan_idx
  ON deviludo.approved_test_plan_bindings (tenant_id, project_id, test_plan_revision_id);

COMMIT;
