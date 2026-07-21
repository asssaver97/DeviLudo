BEGIN;

-- Credential-isolated signing hosts persist only content addresses and public
-- receipts. Native signing keys remain in their platform keystore or HSM.
CREATE TABLE deviludo.steam_depot_finalization_operations (
  tenant_id uuid NOT NULL REFERENCES deviludo.tenants(id),
  operation_key text NOT NULL CHECK (
    operation_key ~ '^steam-depot-finalize:[a-f0-9-]{36}:(windows|linux|macos)$'
  ),
  request_digest char(64) NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  project_id uuid NOT NULL,
  release_id uuid NOT NULL,
  main_commit_sha char(40) NOT NULL CHECK (main_commit_sha ~ '^[a-f0-9]{40}$'),
  evidence_bundle_digest char(64) NOT NULL CHECK (evidence_bundle_digest ~ '^[a-f0-9]{64}$'),
  platform text NOT NULL CHECK (platform IN ('windows', 'linux', 'macos')),
  source_object_key text NOT NULL CHECK (
    length(source_object_key) BETWEEN 2 AND 1024
      AND source_object_key !~ '(^/|/$|\.\.)'
  ),
  source_artifact_digest char(64) NOT NULL CHECK (source_artifact_digest ~ '^[a-f0-9]{64}$'),
  request_payload jsonb NOT NULL CHECK (pg_column_size(request_payload) <= 65536),
  state text NOT NULL CHECK (state IN ('PENDING', 'RUNNING', 'COMPLETED')),
  claim_token uuid,
  claim_expires_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 1000000),
  receipt jsonb CHECK (receipt IS NULL OR pg_column_size(receipt) <= 262144),
  receipt_digest char(64) CHECK (receipt_digest IS NULL OR receipt_digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  completed_at timestamptz,
  PRIMARY KEY (tenant_id, operation_key),
  UNIQUE (tenant_id, project_id, release_id, platform),
  FOREIGN KEY (tenant_id, project_id)
    REFERENCES deviludo.projects(tenant_id, id),
  FOREIGN KEY (tenant_id, project_id, release_id)
    REFERENCES deviludo.steam_releases(tenant_id, project_id, id),
  CHECK (
    (state = 'PENDING' AND claim_token IS NULL AND claim_expires_at IS NULL
      AND receipt IS NULL AND receipt_digest IS NULL AND completed_at IS NULL)
    OR (state = 'RUNNING' AND claim_token IS NOT NULL AND claim_expires_at IS NOT NULL
      AND receipt IS NULL AND receipt_digest IS NULL AND completed_at IS NULL)
    OR (state = 'COMPLETED' AND claim_token IS NULL AND claim_expires_at IS NULL
      AND receipt IS NOT NULL AND receipt_digest IS NOT NULL AND completed_at IS NOT NULL)
  )
);

CREATE OR REPLACE FUNCTION deviludo.protect_steam_depot_finalization_operation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.tenant_id, NEW.operation_key, NEW.request_digest, NEW.project_id,
         NEW.release_id, NEW.main_commit_sha, NEW.evidence_bundle_digest,
         NEW.platform, NEW.source_object_key, NEW.source_artifact_digest,
         NEW.request_payload, NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.tenant_id, OLD.operation_key, OLD.request_digest, OLD.project_id,
         OLD.release_id, OLD.main_commit_sha, OLD.evidence_bundle_digest,
         OLD.platform, OLD.source_object_key, OLD.source_artifact_digest,
         OLD.request_payload, OLD.created_at) THEN
    RAISE EXCEPTION 'Steam depot finalization binding is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.state = 'COMPLETED' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'completed Steam depot finalization is immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW.attempt_count < OLD.attempt_count OR NEW.attempt_count > OLD.attempt_count + 1 THEN
    RAISE EXCEPTION 'Steam depot finalization attempt sequence is invalid' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER steam_depot_finalization_operation_guard
BEFORE UPDATE ON deviludo.steam_depot_finalization_operations
FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*)
EXECUTE FUNCTION deviludo.protect_steam_depot_finalization_operation();

CREATE TRIGGER steam_depot_finalization_operation_no_delete
BEFORE DELETE ON deviludo.steam_depot_finalization_operations
FOR EACH ROW EXECUTE FUNCTION deviludo.reject_mutation();

ALTER TABLE deviludo.steam_depot_finalization_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE deviludo.steam_depot_finalization_operations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON deviludo.steam_depot_finalization_operations
  USING (tenant_id = deviludo.current_tenant_id())
  WITH CHECK (tenant_id = deviludo.current_tenant_id());

CREATE INDEX steam_depot_finalization_pending_idx
  ON deviludo.steam_depot_finalization_operations (tenant_id, state, claim_expires_at, created_at);

COMMIT;
