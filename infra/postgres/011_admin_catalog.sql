BEGIN;

-- The catalog is a single versioned aggregate because platform, tenant and
-- project inheritance must be resolved against one coherent revision. Writers
-- serialize through SELECT FOR UPDATE and advance exactly one revision.
CREATE TABLE deviludo.admin_catalog_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (pg_column_size(payload) <= 16777216)
);

INSERT INTO deviludo.admin_catalog_state (singleton, revision, payload)
VALUES (true, 0, '{
  "versions": [],
  "installations": [],
  "providers": [],
  "profiles": [],
  "credentials": [],
  "defaults": []
}'::jsonb);

CREATE OR REPLACE FUNCTION deviludo.protect_admin_catalog_revision()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.singleton IS DISTINCT FROM OLD.singleton THEN
    RAISE EXCEPTION 'administrator catalog identity is immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW.revision <> OLD.revision + 1 THEN
    RAISE EXCEPTION 'administrator catalog revision must advance exactly once' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER admin_catalog_revision_guard
BEFORE UPDATE ON deviludo.admin_catalog_state
FOR EACH ROW EXECUTE FUNCTION deviludo.protect_admin_catalog_revision();

CREATE TRIGGER admin_catalog_no_delete
BEFORE DELETE ON deviludo.admin_catalog_state
FOR EACH ROW EXECUTE FUNCTION deviludo.reject_mutation();

CREATE TABLE deviludo.admin_audit_records (
  id text PRIMARY KEY CHECK (id ~ '^audit-[0-9a-f-]{36}$'),
  action text NOT NULL CHECK (action ~ '^[A-Z][A-Z0-9_]{2,99}$'),
  resource text NOT NULL CHECK (length(resource) BETWEEN 1 AND 512),
  actor_role text NOT NULL CHECK (actor_role IN (
    'PlatformAgentAdmin', 'SecurityAdmin', 'TenantAdmin', 'ProjectOwner', 'Auditor'
  )),
  actor_id text NOT NULL CHECK (length(actor_id) BETWEEN 1 AND 160),
  tenant_id text,
  project_id text,
  request_id text NOT NULL CHECK (length(request_id) BETWEEN 1 AND 200),
  occurred_at timestamptz NOT NULL,
  metadata jsonb NOT NULL CHECK (jsonb_typeof(metadata) = 'object'),
  CHECK (project_id IS NULL OR tenant_id IS NOT NULL),
  CHECK (pg_column_size(metadata) <= 1048576)
);

CREATE TRIGGER admin_audit_append_only
BEFORE UPDATE OR DELETE ON deviludo.admin_audit_records
FOR EACH ROW EXECUTE FUNCTION deviludo.reject_mutation();

CREATE INDEX admin_audit_time_idx
  ON deviludo.admin_audit_records (occurred_at DESC, id DESC);

COMMIT;
