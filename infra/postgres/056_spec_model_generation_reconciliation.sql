BEGIN;

-- Every upstream dispatch of the same idempotent model operation has a stable
-- generation. A retry is possible only after a pre-dispatch release or an
-- explicit SecurityAdmin reconciliation of the previous generation.
ALTER TABLE deviludo.spec_model_generation_operations
  ADD COLUMN dispatch_generation integer NOT NULL DEFAULT 1
    CHECK (dispatch_generation BETWEEN 1 AND 1000000);

CREATE TABLE deviludo.spec_model_generation_reconciliations (
  tenant_id uuid NOT NULL REFERENCES deviludo.tenants(id),
  reconciliation_operation_key text NOT NULL
    CHECK (reconciliation_operation_key ~ '^[a-f0-9]{64}$'),
  generation_operation_key text NOT NULL
    CHECK (generation_operation_key ~ '^[a-f0-9]{64}$'),
  dispatch_generation integer NOT NULL
    CHECK (dispatch_generation BETWEEN 1 AND 1000000),
  payload_digest text NOT NULL CHECK (payload_digest ~ '^[a-f0-9]{64}$'),
  action text NOT NULL CHECK (action IN ('CONFIRM_NO_USAGE', 'RECORD_USAGE')),
  evidence_digest text NOT NULL CHECK (evidence_digest ~ '^[a-f0-9]{64}$'),
  reconciled_by text NOT NULL
    CHECK (reconciled_by ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,159}$'),
  usage jsonb NOT NULL CHECK (
    jsonb_typeof(usage) = 'object'
    AND usage ?& ARRAY['inputTokens', 'outputTokens']
    AND (usage - 'inputTokens' - 'outputTokens') = '{}'::jsonb
    AND jsonb_typeof(usage->'inputTokens') = 'number'
    AND jsonb_typeof(usage->'outputTokens') = 'number'
    AND (usage->>'inputTokens')::bigint >= 0
    AND (usage->>'outputTokens')::bigint >= 0
    AND ((action = 'CONFIRM_NO_USAGE'
          AND (usage->>'inputTokens')::bigint = 0
          AND (usage->>'outputTokens')::bigint = 0)
      OR (action = 'RECORD_USAGE'
          AND (usage->>'outputTokens')::bigint > 0))
  ),
  reconciled_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, reconciliation_operation_key),
  UNIQUE (tenant_id, generation_operation_key, dispatch_generation),
  FOREIGN KEY (tenant_id, generation_operation_key)
    REFERENCES deviludo.spec_model_generation_operations(tenant_id, operation_key)
);

CREATE TRIGGER spec_model_generation_reconciliation_no_update
BEFORE UPDATE ON deviludo.spec_model_generation_reconciliations
FOR EACH ROW EXECUTE FUNCTION deviludo.reject_mutation();
CREATE TRIGGER spec_model_generation_reconciliation_no_delete
BEFORE DELETE ON deviludo.spec_model_generation_reconciliations
FOR EACH ROW EXECUTE FUNCTION deviludo.reject_mutation();

ALTER TABLE deviludo.spec_model_generation_reconciliations ENABLE ROW LEVEL SECURITY;
ALTER TABLE deviludo.spec_model_generation_reconciliations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON deviludo.spec_model_generation_reconciliations
  USING (tenant_id = deviludo.current_tenant_id())
  WITH CHECK (tenant_id = deviludo.current_tenant_id());

-- Replace migration 055's guard so INDETERMINATE remains fail-closed unless a
-- matching append-only reconciliation receipt already exists in this exact
-- transaction. Completed generations remain immutable forever.
CREATE OR REPLACE FUNCTION deviludo.protect_spec_model_generation_operation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.tenant_id, NEW.project_id, NEW.conversation_id,
         NEW.operation_key, NEW.request_digest, NEW.profile_revision_id,
         NEW.provider_revision_id, NEW.credential_version_id, NEW.agent,
         NEW.protocol, NEW.base_url, NEW.approved_ports, NEW.authentication,
         NEW.model, NEW.policy_digest, NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.tenant_id, OLD.project_id, OLD.conversation_id,
         OLD.operation_key, OLD.request_digest, OLD.profile_revision_id,
         OLD.provider_revision_id, OLD.credential_version_id, OLD.agent,
         OLD.protocol, OLD.base_url, OLD.approved_ports, OLD.authentication,
         OLD.model, OLD.policy_digest, OLD.created_at) THEN
    RAISE EXCEPTION 'spec model generation binding is immutable' USING ERRCODE = '55000';
  END IF;

  IF OLD.state = 'COMPLETED' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'completed spec model generation is immutable' USING ERRCODE = '55000';
  END IF;

  IF OLD.state = 'CLAIMED' THEN
    IF NEW.state NOT IN ('CLAIMED', 'COMPLETED', 'RELEASED', 'INDETERMINATE')
       OR NEW.dispatch_generation <> OLD.dispatch_generation THEN
      RAISE EXCEPTION 'claimed spec model generation transition is invalid' USING ERRCODE = '55000';
    END IF;
  ELSIF OLD.state = 'RELEASED' THEN
    IF NEW.state = 'RELEASED' AND NEW.dispatch_generation <> OLD.dispatch_generation THEN
      RAISE EXCEPTION 'released spec model generation changed generation' USING ERRCODE = '55000';
    ELSIF NEW.state = 'CLAIMED' AND NEW.dispatch_generation <> OLD.dispatch_generation + 1 THEN
      RAISE EXCEPTION 'retried spec model generation is not monotonic' USING ERRCODE = '55000';
    ELSIF NEW.state NOT IN ('RELEASED', 'CLAIMED') THEN
      RAISE EXCEPTION 'released spec model generation transition is invalid' USING ERRCODE = '55000';
    END IF;
  ELSIF OLD.state = 'INDETERMINATE' THEN
    IF NEW.state = 'INDETERMINATE' THEN
      IF NEW IS DISTINCT FROM OLD THEN
        RAISE EXCEPTION 'indeterminate spec model generation is immutable' USING ERRCODE = '55000';
      END IF;
    ELSIF NEW.state = 'RELEASED' THEN
      IF NEW.dispatch_generation <> OLD.dispatch_generation OR NOT EXISTS (
        SELECT 1
          FROM deviludo.spec_model_generation_reconciliations receipt
         WHERE receipt.tenant_id = OLD.tenant_id
           AND receipt.generation_operation_key = OLD.operation_key
           AND receipt.dispatch_generation = OLD.dispatch_generation
      ) THEN
        RAISE EXCEPTION 'spec model reconciliation receipt is required' USING ERRCODE = '55000';
      END IF;
    ELSE
      RAISE EXCEPTION 'indeterminate spec model generation transition is invalid' USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE INDEX spec_model_generation_reconciliation_timeline_idx
  ON deviludo.spec_model_generation_reconciliations
    (tenant_id, generation_operation_key, dispatch_generation DESC);

COMMIT;
