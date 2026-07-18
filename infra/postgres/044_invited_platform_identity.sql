BEGIN;

-- GitHub is the account identity provider, but the account and membership are
-- tenant-owned.  Keeping tenant_id on every row makes the same RLS boundary
-- apply before and after an invitation has been consumed.
CREATE TABLE deviludo.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES deviludo.tenants(id),
  github_user_id bigint NOT NULL CHECK (github_user_id > 0),
  github_node_id text NOT NULL,
  github_login text NOT NULL CHECK (github_login ~ '^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$'),
  display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 160),
  avatar_url text NOT NULL CHECK (avatar_url ~ '^https://'),
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'SUSPENDED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, github_user_id),
  UNIQUE (tenant_id, github_node_id)
);

CREATE TABLE deviludo.tenant_memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES deviludo.tenants(id),
  user_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('TenantAdmin', 'ProjectOwner', 'Auditor')),
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'SUSPENDED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, id, user_id),
  UNIQUE (tenant_id, user_id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES deviludo.users(tenant_id, id)
);

-- Raw invitation values are returned once and never persisted.  The token is
-- <tenant UUID>.<256-bit random value>, allowing the Broker to establish RLS
-- before looking up its SHA-256 digest.
CREATE TABLE deviludo.tenant_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES deviludo.tenants(id),
  token_digest text NOT NULL CHECK (token_digest ~ '^[a-f0-9]{64}$'),
  role text NOT NULL CHECK (role IN ('TenantAdmin', 'ProjectOwner', 'Auditor')),
  state text NOT NULL DEFAULT 'ACTIVE' CHECK (state IN ('ACTIVE', 'CLAIMED', 'CONSUMED', 'REVOKED')),
  login_intent_id uuid,
  claim_expires_at timestamptz,
  expires_at timestamptz NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  consumed_by_user_id uuid,
  consumed_at timestamptz,
  revoked_at timestamptz,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, token_digest),
  FOREIGN KEY (tenant_id, consumed_by_user_id) REFERENCES deviludo.users(tenant_id, id),
  CHECK ((state = 'ACTIVE' AND login_intent_id IS NULL AND claim_expires_at IS NULL
      AND consumed_by_user_id IS NULL AND consumed_at IS NULL AND revoked_at IS NULL)
    OR (state = 'CLAIMED' AND login_intent_id IS NOT NULL AND claim_expires_at IS NOT NULL
      AND consumed_by_user_id IS NULL AND consumed_at IS NULL AND revoked_at IS NULL)
    OR (state = 'CONSUMED' AND login_intent_id IS NOT NULL AND claim_expires_at IS NULL
      AND consumed_by_user_id IS NOT NULL AND consumed_at IS NOT NULL AND revoked_at IS NULL)
    OR (state = 'REVOKED' AND consumed_by_user_id IS NULL AND consumed_at IS NULL
      AND revoked_at IS NOT NULL))
);

-- Raw OAuth state and PKCE verifiers are not persisted.  State is digested;
-- the verifier is held by the one-time secret Broker and consumed at callback.
CREATE TABLE deviludo.identity_login_intents (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES deviludo.tenants(id),
  invitation_id uuid NOT NULL,
  state_digest text NOT NULL CHECK (state_digest ~ '^[a-f0-9]{64}$'),
  browser_binding_digest text NOT NULL CHECK (browser_binding_digest ~ '^[a-f0-9]{64}$'),
  pkce_verifier_secret_ref text NOT NULL CHECK (pkce_verifier_secret_ref LIKE 'vault://%'),
  status text NOT NULL CHECK (status IN ('PENDING', 'CLAIMED', 'COMPLETED', 'FAILED')),
  claim_token uuid,
  claim_expires_at timestamptz,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  completed_at timestamptz,
  failure_code text,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, state_digest),
  FOREIGN KEY (tenant_id, invitation_id) REFERENCES deviludo.tenant_invitations(tenant_id, id),
  CHECK ((status = 'PENDING' AND claim_token IS NULL AND claim_expires_at IS NULL
      AND completed_at IS NULL AND failure_code IS NULL)
    OR (status = 'CLAIMED' AND claim_token IS NOT NULL AND claim_expires_at IS NOT NULL
      AND completed_at IS NULL AND failure_code IS NULL)
    OR (status = 'COMPLETED' AND claim_token IS NULL AND claim_expires_at IS NULL
      AND completed_at IS NOT NULL AND failure_code IS NULL)
    OR (status = 'FAILED' AND claim_token IS NULL AND claim_expires_at IS NULL
      AND completed_at IS NOT NULL AND failure_code IS NOT NULL))
);

ALTER TABLE deviludo.tenant_invitations
  ADD CONSTRAINT tenant_invitation_login_intent_fk
  FOREIGN KEY (tenant_id, login_intent_id) REFERENCES deviludo.identity_login_intents(tenant_id, id)
  DEFERRABLE INITIALLY DEFERRED;

-- The browser receives the raw session value in an HttpOnly cookie.  Only its
-- digest and the independent browser-binding digest are durable.
CREATE TABLE deviludo.platform_sessions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES deviludo.tenants(id),
  user_id uuid NOT NULL,
  membership_id uuid NOT NULL,
  token_digest text NOT NULL CHECK (token_digest ~ '^[a-f0-9]{64}$'),
  browser_binding_digest text NOT NULL CHECK (browser_binding_digest ~ '^[a-f0-9]{64}$'),
  state text NOT NULL DEFAULT 'ACTIVE' CHECK (state IN ('ACTIVE', 'REVOKED')),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  revoked_at timestamptz,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, token_digest),
  FOREIGN KEY (tenant_id, user_id) REFERENCES deviludo.users(tenant_id, id),
  FOREIGN KEY (tenant_id, membership_id, user_id) REFERENCES deviludo.tenant_memberships(tenant_id, id, user_id),
  CHECK ((state = 'ACTIVE' AND revoked_at IS NULL)
    OR (state = 'REVOKED' AND revoked_at IS NOT NULL))
);

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'users', 'tenant_memberships', 'tenant_invitations',
    'identity_login_intents', 'platform_sessions'
  ] LOOP
    EXECUTE format('ALTER TABLE deviludo.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE deviludo.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY %I ON deviludo.%I USING (tenant_id = deviludo.current_tenant_id()) WITH CHECK (tenant_id = deviludo.current_tenant_id())',
      table_name || '_tenant_isolation', table_name
    );
  END LOOP;
END $$;

CREATE INDEX tenant_invitation_expiry_idx
  ON deviludo.tenant_invitations (tenant_id, expires_at)
  WHERE state IN ('ACTIVE', 'CLAIMED');
CREATE INDEX identity_login_expiry_idx
  ON deviludo.identity_login_intents (tenant_id, expires_at)
  WHERE status IN ('PENDING', 'CLAIMED');
CREATE INDEX platform_session_active_idx
  ON deviludo.platform_sessions (tenant_id, user_id, expires_at)
  WHERE state = 'ACTIVE';

CREATE OR REPLACE FUNCTION deviludo.protect_identity_keys()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tenant_id <> OLD.tenant_id OR NEW.id <> OLD.id THEN
    RAISE EXCEPTION 'identity ownership keys are immutable';
  END IF;
  IF TG_TABLE_NAME = 'users'
      AND to_jsonb(NEW) - ARRAY['github_login', 'display_name', 'avatar_url', 'status', 'updated_at']
        <> to_jsonb(OLD) - ARRAY['github_login', 'display_name', 'avatar_url', 'status', 'updated_at'] THEN
    RAISE EXCEPTION 'user identity keys are immutable';
  ELSIF TG_TABLE_NAME = 'tenant_memberships'
      AND to_jsonb(NEW) - ARRAY['status', 'updated_at']
        <> to_jsonb(OLD) - ARRAY['status', 'updated_at'] THEN
    RAISE EXCEPTION 'membership identity and role are immutable';
  ELSIF TG_TABLE_NAME = 'tenant_invitations'
      AND to_jsonb(NEW) - ARRAY['state', 'login_intent_id', 'claim_expires_at', 'consumed_by_user_id', 'consumed_at', 'revoked_at']
        <> to_jsonb(OLD) - ARRAY['state', 'login_intent_id', 'claim_expires_at', 'consumed_by_user_id', 'consumed_at', 'revoked_at'] THEN
    RAISE EXCEPTION 'invitation authority is immutable';
  ELSIF TG_TABLE_NAME = 'identity_login_intents'
      AND to_jsonb(NEW) - ARRAY['status', 'claim_token', 'claim_expires_at', 'completed_at', 'failure_code']
        <> to_jsonb(OLD) - ARRAY['status', 'claim_token', 'claim_expires_at', 'completed_at', 'failure_code'] THEN
    RAISE EXCEPTION 'login intent binding is immutable';
  ELSIF TG_TABLE_NAME = 'platform_sessions'
      AND to_jsonb(NEW) - ARRAY['state', 'last_seen_at', 'revoked_at']
        <> to_jsonb(OLD) - ARRAY['state', 'last_seen_at', 'revoked_at'] THEN
    RAISE EXCEPTION 'platform session binding is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER user_identity_key_guard
BEFORE UPDATE ON deviludo.users
FOR EACH ROW EXECUTE FUNCTION deviludo.protect_identity_keys();
CREATE TRIGGER membership_identity_key_guard
BEFORE UPDATE ON deviludo.tenant_memberships
FOR EACH ROW EXECUTE FUNCTION deviludo.protect_identity_keys();
CREATE TRIGGER invitation_identity_key_guard
BEFORE UPDATE ON deviludo.tenant_invitations
FOR EACH ROW EXECUTE FUNCTION deviludo.protect_identity_keys();
CREATE TRIGGER login_intent_identity_key_guard
BEFORE UPDATE ON deviludo.identity_login_intents
FOR EACH ROW EXECUTE FUNCTION deviludo.protect_identity_keys();
CREATE TRIGGER platform_session_identity_key_guard
BEFORE UPDATE ON deviludo.platform_sessions
FOR EACH ROW EXECUTE FUNCTION deviludo.protect_identity_keys();

COMMIT;
