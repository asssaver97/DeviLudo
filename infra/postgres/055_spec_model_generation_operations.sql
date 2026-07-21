BEGIN;

-- The model Broker retains only a canonical request digest, not conversation
-- text. The strict result is required for replay without a second billable
-- call; Provider credentials remain exclusively in Vault.
CREATE TABLE deviludo.spec_model_generation_operations (
  tenant_id uuid NOT NULL REFERENCES deviludo.tenants(id),
  project_id uuid NOT NULL REFERENCES deviludo.projects(id),
  conversation_id uuid NOT NULL REFERENCES deviludo.spec_conversations(id),
  operation_key text NOT NULL CHECK (operation_key ~ '^[a-f0-9]{64}$'),
  request_digest text NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  profile_revision_id text NOT NULL
    CHECK (profile_revision_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'),
  provider_revision_id text NOT NULL
    CHECK (provider_revision_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'),
  credential_version_id text NOT NULL
    CHECK (credential_version_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'),
  agent text NOT NULL CHECK (agent IN ('claude-code', 'codex-cli')),
  protocol text NOT NULL CHECK (protocol IN ('anthropic-messages', 'openai-responses')),
  base_url text NOT NULL CHECK (base_url ~ '^https://[^?#@]+$'),
  approved_ports integer[] NOT NULL CHECK (
    cardinality(approved_ports) BETWEEN 1 AND 16
    AND 0 < ALL (approved_ports) AND 65536 > ALL (approved_ports)
  ),
  authentication text NOT NULL
    CHECK (authentication IN ('bearer', 'x-api-key', 'authorization-bearer')),
  model text NOT NULL CHECK (
    length(model) BETWEEN 1 AND 200
    AND model !~ '[[:space:]]'
    AND model ~ '[0-9]'
    AND model !~* '(^|[-_:/.])(latest|default|stable|preview)$'
  ),
  policy_digest text NOT NULL CHECK (policy_digest ~ '^[a-f0-9]{64}$'),
  state text NOT NULL CHECK (state IN ('CLAIMED', 'COMPLETED', 'RELEASED', 'INDETERMINATE')),
  claim_token uuid,
  claim_expires_at timestamptz,
  result jsonb,
  result_digest text CHECK (result_digest IS NULL OR result_digest ~ '^[a-f0-9]{64}$'),
  usage jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  PRIMARY KEY (tenant_id, operation_key),
  FOREIGN KEY (tenant_id, project_id, conversation_id)
    REFERENCES deviludo.spec_conversations(tenant_id, project_id, id),
  CHECK (
    (state = 'CLAIMED' AND claim_token IS NOT NULL AND claim_expires_at IS NOT NULL
      AND result IS NULL AND result_digest IS NULL AND usage IS NULL AND completed_at IS NULL)
    OR (state = 'COMPLETED' AND claim_token IS NULL AND claim_expires_at IS NULL
      AND jsonb_typeof(result) = 'object' AND result_digest IS NOT NULL
      AND jsonb_typeof(usage) = 'object' AND completed_at IS NOT NULL)
    OR (state IN ('RELEASED', 'INDETERMINATE') AND claim_token IS NULL
      AND claim_expires_at IS NULL AND result IS NULL AND result_digest IS NULL
      AND usage IS NULL AND completed_at IS NULL)
  ),
  CHECK (usage IS NULL OR (
    usage ?& ARRAY['inputTokens', 'outputTokens']
    AND (usage - 'inputTokens' - 'outputTokens') = '{}'::jsonb
    AND jsonb_typeof(usage->'inputTokens') = 'number'
    AND jsonb_typeof(usage->'outputTokens') = 'number'
    AND (usage->>'inputTokens')::bigint >= 0
    AND (usage->>'outputTokens')::bigint > 0
  ))
);

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
  IF OLD.state IN ('COMPLETED', 'INDETERMINATE') AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'terminal spec model generation is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.state = 'CLAIMED' AND NEW.state NOT IN ('CLAIMED', 'COMPLETED', 'RELEASED', 'INDETERMINATE') THEN
    RAISE EXCEPTION 'spec model generation transition is invalid' USING ERRCODE = '55000';
  END IF;
  IF OLD.state = 'RELEASED' AND NEW.state NOT IN ('RELEASED', 'CLAIMED') THEN
    RAISE EXCEPTION 'released spec model generation transition is invalid' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER spec_model_generation_guard
BEFORE UPDATE ON deviludo.spec_model_generation_operations
FOR EACH ROW EXECUTE FUNCTION deviludo.protect_spec_model_generation_operation();
CREATE TRIGGER spec_model_generation_no_delete
BEFORE DELETE ON deviludo.spec_model_generation_operations
FOR EACH ROW EXECUTE FUNCTION deviludo.reject_mutation();

ALTER TABLE deviludo.spec_model_generation_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE deviludo.spec_model_generation_operations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON deviludo.spec_model_generation_operations
  USING (tenant_id = deviludo.current_tenant_id())
  WITH CHECK (tenant_id = deviludo.current_tenant_id());

CREATE INDEX spec_model_generation_pending_idx
  ON deviludo.spec_model_generation_operations (tenant_id, state, claim_expires_at)
  WHERE state IN ('CLAIMED', 'RELEASED', 'INDETERMINATE');
CREATE INDEX spec_model_generation_conversation_idx
  ON deviludo.spec_model_generation_operations (tenant_id, conversation_id, created_at DESC);

COMMIT;
