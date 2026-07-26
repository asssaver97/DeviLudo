BEGIN;

-- Append-only proof that a dedicated issuer produced one expiring bootstrap
-- drive for the currently fenced Agent execution attempt. No image bytes,
-- private keys, certificates, token values or SecretRefs are persisted here.
CREATE TABLE deviludo.agent_microvm_credential_issuances (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES deviludo.tenants(id),
  project_id uuid NOT NULL REFERENCES deviludo.projects(id),
  run_id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  request_digest char(64) NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  native_request_digest char(64) NOT NULL CHECK (native_request_digest ~ '^[a-f0-9]{64}$'),
  image_digest char(64) NOT NULL CHECK (image_digest ~ '^[a-f0-9]{64}$'),
  image_size_bytes bigint NOT NULL CHECK (image_size_bytes BETWEEN 131072 AND 67108864),
  attestation_key_id text NOT NULL
    CHECK (attestation_key_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,159}$'),
  requester_spiffe_id text NOT NULL CHECK (requester_spiffe_id LIKE 'spiffe://%'),
  expires_at timestamptz NOT NULL,
  issued_at timestamptz NOT NULL,
  FOREIGN KEY (tenant_id, project_id, run_id)
    REFERENCES deviludo.agent_runs(tenant_id, project_id, id),
  CHECK (expires_at > issued_at + interval '60 seconds')
);

CREATE TRIGGER agent_microvm_credential_issuance_append_only
BEFORE UPDATE OR DELETE ON deviludo.agent_microvm_credential_issuances
FOR EACH ROW EXECUTE FUNCTION deviludo.reject_mutation();

ALTER TABLE deviludo.agent_microvm_credential_issuances ENABLE ROW LEVEL SECURITY;
ALTER TABLE deviludo.agent_microvm_credential_issuances FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON deviludo.agent_microvm_credential_issuances
  USING (tenant_id = deviludo.current_tenant_id())
  WITH CHECK (tenant_id = deviludo.current_tenant_id());

CREATE INDEX agent_microvm_credential_issuance_run_idx
  ON deviludo.agent_microvm_credential_issuances
    (tenant_id, project_id, run_id, attempt_id, issued_at DESC);

COMMIT;
