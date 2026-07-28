BEGIN;

-- Capacity is platform infrastructure, never tenant-controlled. Intents are
-- immutable requests; only their bounded lifecycle and sanitized cloud receipt
-- may advance. The actuator must use operation_key as its cloud idempotency key.
CREATE TABLE deviludo.fleet_capacity_intents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fleet text NOT NULL CHECK (fleet IN ('AGENT','LINUX','WINDOWS','MACOS')),
  desired_hosts smallint NOT NULL CHECK (desired_hosts BETWEEN 0 AND 32),
  reason text NOT NULL CHECK (reason IN (
    'MINIMUM_CAPACITY','QUEUE_BACKLOG','QUEUE_SLO','ACTIVE_WORK','IDLE_DRAIN','RECONCILIATION'
  )),
  operation_key text NOT NULL UNIQUE CHECK (operation_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,159}$'),
  state text NOT NULL CHECK (state IN (
    'REQUESTED','HOST_ALLOCATING','INSTANCE_BOOTING','REGISTERED','DRAINING',
    'RELEASE_ELIGIBLE','RELEASED','FAILED','MANUAL_INTERVENTION_REQUIRED'
  )) DEFAULT 'REQUESTED',
  requested_at timestamptz NOT NULL,
  minimum_release_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  cloud_receipt jsonb,
  failure_code text,
  retry_not_before timestamptz,
  updated_at timestamptz NOT NULL,
  CHECK ((fleet='MACOS' AND desired_hosts > 0 AND minimum_release_at >= requested_at + interval '24 hours')
    OR (fleet<>'MACOS' AND minimum_release_at IS NULL)
    OR (fleet='MACOS' AND desired_hosts=0)),
  CHECK (cloud_receipt IS NULL OR (
    jsonb_typeof(cloud_receipt)='object'
    AND NOT cloud_receipt ?| ARRAY['apiKey','password','secret','accessToken','sessionToken','privateKey']
  )),
  CHECK ((state IN ('FAILED','MANUAL_INTERVENTION_REQUIRED')) = (failure_code IS NOT NULL))
);

CREATE SEQUENCE deviludo.runner_host_fencing_token_seq AS bigint START WITH 1;

CREATE TABLE deviludo.runner_host_leases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  intent_id uuid NOT NULL REFERENCES deviludo.fleet_capacity_intents(id),
  fleet text NOT NULL CHECK (fleet IN ('AGENT','LINUX','WINDOWS','MACOS')),
  cloud_provider text NOT NULL CHECK (cloud_provider IN ('ALIBABA','AWS')),
  cloud_resource_ref text NOT NULL CHECK (cloud_resource_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{2,255}$'),
  runner_id text REFERENCES deviludo.runner_registrations(id),
  state text NOT NULL CHECK (state IN (
    'ALLOCATING','BOOTING','REGISTERED','DRAINING','RELEASE_ELIGIBLE','RELEASED','FAILED'
  )),
  fencing_token bigint NOT NULL DEFAULT nextval('deviludo.runner_host_fencing_token_seq') CHECK (fencing_token > 0),
  lease_version integer NOT NULL DEFAULT 1 CHECK (lease_version > 0),
  allocated_at timestamptz NOT NULL,
  registered_at timestamptz,
  draining_at timestamptz,
  minimum_release_at timestamptz,
  released_at timestamptz,
  failure_code text,
  UNIQUE (intent_id),
  UNIQUE (cloud_provider, cloud_resource_ref),
  CHECK ((fleet='MACOS' AND minimum_release_at >= allocated_at + interval '24 hours')
    OR (fleet<>'MACOS' AND minimum_release_at IS NULL)),
  CHECK (released_at IS NULL OR (state='RELEASED' AND released_at >= COALESCE(minimum_release_at, allocated_at))),
  CHECK ((state='FAILED') = (failure_code IS NOT NULL))
);

CREATE OR REPLACE FUNCTION deviludo.protect_fleet_capacity_intent()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.id,NEW.fleet,NEW.desired_hosts,NEW.reason,NEW.operation_key,NEW.requested_at,NEW.minimum_release_at)
     IS DISTINCT FROM
     ROW(OLD.id,OLD.fleet,OLD.desired_hosts,OLD.reason,OLD.operation_key,OLD.requested_at,OLD.minimum_release_at) THEN
    RAISE EXCEPTION 'fleet capacity intent binding is immutable' USING ERRCODE='55000';
  END IF;
  IF NEW.version <> OLD.version + 1 OR NEW.updated_at <= OLD.updated_at THEN
    RAISE EXCEPTION 'fleet capacity intent update requires the next version' USING ERRCODE='55000';
  END IF;
  IF OLD.state IN ('RELEASED','FAILED','MANUAL_INTERVENTION_REQUIRED') THEN
    RAISE EXCEPTION 'terminal fleet capacity intent is immutable' USING ERRCODE='55000';
  END IF;
  IF NOT (
    (OLD.state='REQUESTED' AND NEW.state IN ('HOST_ALLOCATING','DRAINING','FAILED')) OR
    (OLD.state='HOST_ALLOCATING' AND NEW.state IN ('INSTANCE_BOOTING','FAILED','MANUAL_INTERVENTION_REQUIRED')) OR
    (OLD.state='INSTANCE_BOOTING' AND NEW.state IN ('REGISTERED','FAILED','MANUAL_INTERVENTION_REQUIRED')) OR
    (OLD.state='REGISTERED' AND NEW.state IN ('DRAINING','FAILED')) OR
    (OLD.state='DRAINING' AND NEW.state IN ('RELEASE_ELIGIBLE','FAILED','MANUAL_INTERVENTION_REQUIRED')) OR
    (OLD.state='RELEASE_ELIGIBLE' AND NEW.state IN ('RELEASED','FAILED'))
  ) THEN
    RAISE EXCEPTION 'invalid fleet capacity intent transition' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER fleet_capacity_intent_guard
BEFORE UPDATE ON deviludo.fleet_capacity_intents
FOR EACH ROW EXECUTE FUNCTION deviludo.protect_fleet_capacity_intent();

CREATE OR REPLACE FUNCTION deviludo.protect_runner_host_lease()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.id,NEW.intent_id,NEW.fleet,NEW.cloud_provider,NEW.cloud_resource_ref,
         NEW.fencing_token,NEW.allocated_at,NEW.minimum_release_at)
     IS DISTINCT FROM
     ROW(OLD.id,OLD.intent_id,OLD.fleet,OLD.cloud_provider,OLD.cloud_resource_ref,
         OLD.fencing_token,OLD.allocated_at,OLD.minimum_release_at) THEN
    RAISE EXCEPTION 'runner host lease binding is immutable' USING ERRCODE='55000';
  END IF;
  IF NEW.lease_version <> OLD.lease_version + 1 THEN
    RAISE EXCEPTION 'runner host lease update requires the next version' USING ERRCODE='55000';
  END IF;
  IF OLD.state IN ('RELEASED','FAILED') THEN
    RAISE EXCEPTION 'terminal runner host lease is immutable' USING ERRCODE='55000';
  END IF;
  IF NOT (
    (OLD.state='ALLOCATING' AND NEW.state IN ('BOOTING','FAILED')) OR
    (OLD.state='BOOTING' AND NEW.state IN ('REGISTERED','FAILED')) OR
    (OLD.state='REGISTERED' AND NEW.state IN ('DRAINING','FAILED')) OR
    (OLD.state='DRAINING' AND NEW.state IN ('RELEASE_ELIGIBLE','FAILED')) OR
    (OLD.state='RELEASE_ELIGIBLE' AND NEW.state IN ('RELEASED','FAILED'))
  ) THEN
    RAISE EXCEPTION 'invalid runner host lease transition' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER runner_host_lease_guard
BEFORE UPDATE ON deviludo.runner_host_leases
FOR EACH ROW EXECUTE FUNCTION deviludo.protect_runner_host_lease();

CREATE INDEX fleet_capacity_intents_pending_idx
  ON deviludo.fleet_capacity_intents(state,retry_not_before,requested_at)
  WHERE state NOT IN ('RELEASED','FAILED','MANUAL_INTERVENTION_REQUIRED');
CREATE INDEX runner_host_leases_active_idx
  ON deviludo.runner_host_leases(fleet,state,minimum_release_at)
  WHERE state NOT IN ('RELEASED','FAILED');

REVOKE ALL ON deviludo.fleet_capacity_intents FROM PUBLIC;
REVOKE ALL ON deviludo.runner_host_leases FROM PUBLIC;
REVOKE ALL ON SEQUENCE deviludo.runner_host_fencing_token_seq FROM PUBLIC;

COMMIT;
