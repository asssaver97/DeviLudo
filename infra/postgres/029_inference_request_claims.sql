BEGIN;

-- A run may have only one unresolved upstream inference request. If a process
-- dies after dispatch, the claim becomes INDETERMINATE instead of being
-- silently retried, because the upstream may already have billed the request.
CREATE TABLE deviludo.inference_request_claims (
  request_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES deviludo.tenants(id),
  project_id uuid NOT NULL REFERENCES deviludo.projects(id),
  run_id uuid NOT NULL,
  provider_revision_id text NOT NULL,
  credential_version_id text NOT NULL CHECK (credential_version_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'),
  model text NOT NULL,
  claim_token uuid NOT NULL UNIQUE,
  state text NOT NULL CHECK (state IN ('ACTIVE', 'COMPLETED', 'RELEASED', 'INDETERMINATE')),
  claim_expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  FOREIGN KEY (tenant_id, run_id)
    REFERENCES deviludo.inference_run_authorizations(tenant_id, run_id),
  FOREIGN KEY (tenant_id, provider_revision_id)
    REFERENCES deviludo.inference_provider_revisions(tenant_id, provider_revision_id),
  CHECK ((state = 'COMPLETED' AND completed_at IS NOT NULL)
    OR (state <> 'COMPLETED' AND completed_at IS NULL))
);

CREATE UNIQUE INDEX inference_one_active_request_per_run
  ON deviludo.inference_request_claims (tenant_id, run_id)
  WHERE state = 'ACTIVE';
CREATE UNIQUE INDEX inference_one_indeterminate_request_per_run
  ON deviludo.inference_request_claims (tenant_id, run_id)
  WHERE state = 'INDETERMINATE';
CREATE INDEX inference_request_claim_run_idx
  ON deviludo.inference_request_claims (tenant_id, run_id, state, claim_expires_at);

-- Upgrade-safe backfill for usage events written after migration 028 but before
-- this claim table existed. These requests are already terminal and auditable.
INSERT INTO deviludo.inference_request_claims
  (request_id, tenant_id, project_id, run_id, provider_revision_id,
   credential_version_id, model, claim_token, state, claim_expires_at,
   created_at, completed_at)
SELECT request_id, tenant_id, project_id, run_id, provider_revision_id,
       credential_version_id, model, gen_random_uuid(), 'COMPLETED',
       recorded_at, recorded_at, recorded_at
  FROM deviludo.inference_usage_events
ON CONFLICT (request_id) DO NOTHING;

ALTER TABLE deviludo.inference_request_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE deviludo.inference_request_claims FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON deviludo.inference_request_claims
  USING (tenant_id = deviludo.current_tenant_id())
  WITH CHECK (tenant_id = deviludo.current_tenant_id());

-- Bind each usage event to the exact completed request claim. The deferred
-- direction permits completion to append usage and flip the claim atomically.
ALTER TABLE deviludo.inference_usage_events
  ADD CONSTRAINT inference_usage_request_claim_fk
  FOREIGN KEY (request_id) REFERENCES deviludo.inference_request_claims(request_id)
  DEFERRABLE INITIALLY DEFERRED;

COMMIT;
