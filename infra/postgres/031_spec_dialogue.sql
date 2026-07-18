BEGIN;

CREATE TABLE deviludo.spec_conversations (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES deviludo.tenants(id),
  project_id uuid NOT NULL REFERENCES deviludo.projects(id),
  spec_aggregate_id uuid NOT NULL DEFAULT gen_random_uuid(),
  test_plan_aggregate_id uuid NOT NULL DEFAULT gen_random_uuid(),
  current_spec_revision_id uuid REFERENCES deviludo.immutable_revisions(id),
  current_test_plan_revision_id uuid REFERENCES deviludo.immutable_revisions(id),
  current_metadata jsonb,
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  state text NOT NULL DEFAULT 'DRAFT' CHECK (state IN ('DRAFT', 'APPROVED', 'SUPERSEDED')),
  created_by text NOT NULL CHECK (created_by ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,159}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, project_id, id),
  CHECK ((version = 0 AND current_spec_revision_id IS NULL
      AND current_test_plan_revision_id IS NULL AND current_metadata IS NULL)
    OR (version > 0 AND current_spec_revision_id IS NOT NULL
      AND current_test_plan_revision_id IS NOT NULL
      AND jsonb_typeof(current_metadata) = 'object'))
);

CREATE UNIQUE INDEX spec_one_draft_conversation_per_project
  ON deviludo.spec_conversations (tenant_id, project_id)
  WHERE state = 'DRAFT';

CREATE TABLE deviludo.spec_dialogue_operations (
  operation_key text PRIMARY KEY CHECK (operation_key ~ '^[a-f0-9]{64}$'),
  tenant_id uuid NOT NULL REFERENCES deviludo.tenants(id),
  project_id uuid NOT NULL REFERENCES deviludo.projects(id),
  conversation_id uuid NOT NULL REFERENCES deviludo.spec_conversations(id),
  actor_id text NOT NULL CHECK (actor_id ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,159}$'),
  expected_revision integer NOT NULL CHECK (expected_revision >= 0),
  request_digest text NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  state text NOT NULL CHECK (state IN ('CLAIMED', 'COMPLETED')),
  claim_token uuid,
  claim_expires_at timestamptz,
  response jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  FOREIGN KEY (tenant_id, project_id, conversation_id)
    REFERENCES deviludo.spec_conversations(tenant_id, project_id, id),
  CHECK ((state = 'CLAIMED' AND claim_token IS NOT NULL
      AND claim_expires_at IS NOT NULL AND response IS NULL AND completed_at IS NULL)
    OR (state = 'COMPLETED' AND claim_token IS NULL
      AND claim_expires_at IS NULL AND jsonb_typeof(response) = 'object'
      AND completed_at IS NOT NULL))
);

CREATE TABLE deviludo.spec_conversation_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES deviludo.tenants(id),
  project_id uuid NOT NULL REFERENCES deviludo.projects(id),
  conversation_id uuid NOT NULL REFERENCES deviludo.spec_conversations(id),
  operation_key text NOT NULL REFERENCES deviludo.spec_dialogue_operations(operation_key),
  sequence integer NOT NULL CHECK (sequence > 0),
  role text NOT NULL CHECK (role IN ('user', 'assistant')),
  content text NOT NULL CHECK (length(content) BETWEEN 1 AND 4000),
  content_digest text NOT NULL CHECK (content_digest ~ '^[a-f0-9]{64}$'),
  created_by text NOT NULL CHECK (created_by ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,159}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, project_id, conversation_id)
    REFERENCES deviludo.spec_conversations(tenant_id, project_id, id),
  UNIQUE (tenant_id, conversation_id, sequence),
  UNIQUE (operation_key, role)
);

CREATE OR REPLACE FUNCTION deviludo.protect_spec_conversation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.id, NEW.tenant_id, NEW.project_id, NEW.spec_aggregate_id,
         NEW.test_plan_aggregate_id, NEW.created_by, NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.id, OLD.tenant_id, OLD.project_id, OLD.spec_aggregate_id,
         OLD.test_plan_aggregate_id, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'spec conversation binding is immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW.version < OLD.version OR NEW.version > OLD.version + 1 THEN
    RAISE EXCEPTION 'spec conversation revision is invalid' USING ERRCODE = '55000';
  END IF;
  IF OLD.state <> 'DRAFT' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'terminal spec conversation is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.state = 'DRAFT' AND NEW.state NOT IN ('DRAFT', 'APPROVED', 'SUPERSEDED') THEN
    RAISE EXCEPTION 'spec conversation transition is invalid' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER spec_conversation_binding_guard
BEFORE UPDATE ON deviludo.spec_conversations
FOR EACH ROW EXECUTE FUNCTION deviludo.protect_spec_conversation();
CREATE TRIGGER spec_conversation_no_delete
BEFORE DELETE ON deviludo.spec_conversations
FOR EACH ROW EXECUTE FUNCTION deviludo.reject_mutation();
CREATE TRIGGER spec_conversation_messages_append_only
BEFORE UPDATE OR DELETE ON deviludo.spec_conversation_messages
FOR EACH ROW EXECUTE FUNCTION deviludo.reject_mutation();

CREATE OR REPLACE FUNCTION deviludo.protect_spec_dialogue_operation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.operation_key, NEW.tenant_id, NEW.project_id, NEW.conversation_id,
         NEW.actor_id, NEW.expected_revision, NEW.request_digest, NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.operation_key, OLD.tenant_id, OLD.project_id, OLD.conversation_id,
         OLD.actor_id, OLD.expected_revision, OLD.request_digest, OLD.created_at)
     OR OLD.state = 'COMPLETED'
     OR (OLD.state = 'CLAIMED' AND NEW.state NOT IN ('CLAIMED', 'COMPLETED')) THEN
    RAISE EXCEPTION 'spec dialogue operation binding is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER spec_dialogue_operation_guard
BEFORE UPDATE ON deviludo.spec_dialogue_operations
FOR EACH ROW EXECUTE FUNCTION deviludo.protect_spec_dialogue_operation();
CREATE TRIGGER spec_dialogue_operation_no_delete
BEFORE DELETE ON deviludo.spec_dialogue_operations
FOR EACH ROW EXECUTE FUNCTION deviludo.reject_mutation();

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'spec_conversations', 'spec_dialogue_operations', 'spec_conversation_messages'
  ] LOOP
    EXECUTE format('ALTER TABLE deviludo.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE deviludo.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON deviludo.%I USING (tenant_id = deviludo.current_tenant_id()) WITH CHECK (tenant_id = deviludo.current_tenant_id())',
      table_name
    );
  END LOOP;
END $$;

CREATE INDEX spec_conversation_project_state_idx
  ON deviludo.spec_conversations (tenant_id, project_id, state, updated_at DESC);
CREATE INDEX spec_dialogue_operation_claim_idx
  ON deviludo.spec_dialogue_operations (tenant_id, state, claim_expires_at);
CREATE INDEX spec_message_history_idx
  ON deviludo.spec_conversation_messages (tenant_id, conversation_id, sequence);

COMMIT;
