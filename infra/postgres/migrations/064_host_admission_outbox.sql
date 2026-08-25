BEGIN;

-- Migration 063 introduced these definer functions after older databases had
-- already executed the baseline-wide PUBLIC revoke. Close that upgrade-path
-- privilege gap without mutating the immutable prior migration.
REVOKE ALL ON FUNCTION deviludo.claim_project_cleanup(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION deviludo.complete_project_cleanup(uuid, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION deviludo.fail_project_cleanup(uuid, uuid, uuid, text) FROM PUBLIC;

CREATE TABLE deviludo.host_admission_events (
  workspace_id uuid NOT NULL REFERENCES deviludo.workspaces(id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL,
  reservation_id text NOT NULL CHECK (length(reservation_id) BETWEEN 1 AND 2000),
  action text NOT NULL CHECK (action IN ('SETTLE', 'CANCEL')),
  actual_units integer CHECK (
    (action = 'SETTLE' AND actual_units > 0)
    OR (action = 'CANCEL' AND actual_units IS NULL)
  ),
  state text NOT NULL DEFAULT 'PENDING' CHECK (state IN ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 20),
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  lease_token uuid,
  lease_expires_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, reservation_id),
  FOREIGN KEY (workspace_id, job_id) REFERENCES deviludo.jobs(workspace_id, id) ON DELETE CASCADE,
  CHECK ((lease_token IS NULL) = (lease_expires_at IS NULL))
);
ALTER TABLE deviludo.host_admission_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE deviludo.host_admission_events FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON deviludo.host_admission_events
  USING (workspace_id = deviludo.current_workspace_id())
  WITH CHECK (workspace_id = deviludo.current_workspace_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON deviludo.host_admission_events TO deviludo_claim_executor;

CREATE OR REPLACE FUNCTION deviludo.reconcile_host_admission_events()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, deviludo
SET row_security = off
AS $$
DECLARE inserted integer;
BEGIN
  INSERT INTO deviludo.host_admission_events(
    workspace_id, job_id, reservation_id, action, actual_units
  )
  SELECT job.workspace_id,
         job.id,
         job.payload->>'hostAdmissionReservationId',
         CASE WHEN job.state = 'SUCCEEDED' THEN 'SETTLE' ELSE 'CANCEL' END,
         CASE WHEN job.state = 'SUCCEEDED' THEN
           least(
             (job.payload->>'hostAdmissionReservedUnits')::integer,
             greatest(1, ceil(extract(epoch FROM (
               job.updated_at - (job.payload->>'hostAdmissionStartedAt')::timestamptz
             )))
           ))::integer
         ELSE NULL END
    FROM deviludo.jobs job
   WHERE job.state IN ('SUCCEEDED', 'FAILED', 'CANCELLED')
     AND length(coalesce(job.payload->>'hostAdmissionReservationId', '')) BETWEEN 1 AND 2000
     AND pg_input_is_valid(job.payload->>'hostAdmissionStartedAt', 'timestamptz')
     AND pg_input_is_valid(job.payload->>'hostAdmissionReservedUnits', 'integer')
     AND (job.payload->>'hostAdmissionReservedUnits')::integer BETWEEN 1 AND 86400
     AND job.updated_at >= (job.payload->>'hostAdmissionStartedAt')::timestamptz
  ON CONFLICT (workspace_id, reservation_id) DO NOTHING;
  GET DIAGNOSTICS inserted = ROW_COUNT;
  RETURN inserted;
END
$$;
ALTER FUNCTION deviludo.reconcile_host_admission_events() OWNER TO deviludo_claim_executor;
REVOKE ALL ON FUNCTION deviludo.reconcile_host_admission_events() FROM PUBLIC;

CREATE OR REPLACE FUNCTION deviludo.claim_host_admission_event(p_lease_seconds integer)
RETURNS TABLE (
  "workspaceId" uuid,
  "eventId" uuid,
  "reservationId" text,
  action text,
  "actualUnits" integer,
  "leaseToken" uuid,
  attempt integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, deviludo
SET row_security = off
AS $$
BEGIN
  IF p_lease_seconds NOT BETWEEN 30 AND 600 THEN
    RAISE EXCEPTION 'invalid host admission lease';
  END IF;
  RETURN QUERY
  WITH candidate AS (
    SELECT event.workspace_id, event.id
      FROM deviludo.host_admission_events event
     WHERE event.attempts < 20
       AND event.available_at <= clock_timestamp()
       AND (
         (event.state IN ('PENDING', 'FAILED')
           AND (event.lease_token IS NULL OR event.lease_expires_at <= clock_timestamp()))
         OR (event.state = 'RUNNING' AND event.lease_expires_at <= clock_timestamp())
       )
     ORDER BY event.available_at, event.created_at
     FOR UPDATE SKIP LOCKED
     LIMIT 1
  )
  UPDATE deviludo.host_admission_events event
     SET state = 'RUNNING',
         attempts = event.attempts + 1,
         lease_token = gen_random_uuid(),
         lease_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds),
         last_error = NULL
    FROM candidate
   WHERE event.workspace_id = candidate.workspace_id AND event.id = candidate.id
  RETURNING event.workspace_id, event.id, event.reservation_id, event.action,
            event.actual_units, event.lease_token, event.attempts;
END
$$;
ALTER FUNCTION deviludo.claim_host_admission_event(integer) OWNER TO deviludo_claim_executor;
REVOKE ALL ON FUNCTION deviludo.claim_host_admission_event(integer) FROM PUBLIC;

CREATE OR REPLACE FUNCTION deviludo.complete_host_admission_event(
  p_workspace_id uuid, p_event_id uuid, p_lease_token uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, deviludo
SET row_security = off
AS $$
DECLARE updated integer;
BEGIN
  UPDATE deviludo.host_admission_events
     SET state = 'SUCCEEDED', lease_token = NULL, lease_expires_at = NULL,
         completed_at = clock_timestamp(), last_error = NULL
   WHERE workspace_id = p_workspace_id AND id = p_event_id
     AND state = 'RUNNING' AND lease_token = p_lease_token
     AND lease_expires_at > clock_timestamp();
  GET DIAGNOSTICS updated = ROW_COUNT;
  RETURN updated = 1;
END
$$;
ALTER FUNCTION deviludo.complete_host_admission_event(uuid, uuid, uuid) OWNER TO deviludo_claim_executor;
REVOKE ALL ON FUNCTION deviludo.complete_host_admission_event(uuid, uuid, uuid) FROM PUBLIC;

CREATE OR REPLACE FUNCTION deviludo.fail_host_admission_event(
  p_workspace_id uuid, p_event_id uuid, p_lease_token uuid, p_error text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, deviludo
SET row_security = off
AS $$
DECLARE updated integer;
BEGIN
  UPDATE deviludo.host_admission_events
     SET state = 'FAILED', lease_token = NULL, lease_expires_at = NULL,
         available_at = clock_timestamp() + make_interval(
           secs => least(3600, 15 * power(2, attempts)::integer)
         ),
         last_error = left(p_error, 2000)
   WHERE workspace_id = p_workspace_id AND id = p_event_id
     AND state = 'RUNNING' AND lease_token = p_lease_token;
  GET DIAGNOSTICS updated = ROW_COUNT;
  RETURN updated = 1;
END
$$;
ALTER FUNCTION deviludo.fail_host_admission_event(uuid, uuid, uuid, text) OWNER TO deviludo_claim_executor;
REVOKE ALL ON FUNCTION deviludo.fail_host_admission_event(uuid, uuid, uuid, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION deviludo.reconcile_host_admission_events(),
  deviludo.claim_host_admission_event(integer),
  deviludo.complete_host_admission_event(uuid, uuid, uuid),
  deviludo.fail_host_admission_event(uuid, uuid, uuid, text)
  TO deviludo_scheduler;

UPDATE deviludo.schema_metadata
   SET current_version = '064_host_admission_outbox', applied_at = clock_timestamp()
 WHERE singleton = true;
COMMIT;
