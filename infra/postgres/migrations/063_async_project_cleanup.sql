BEGIN;

CREATE TABLE deviludo.project_cleanup_requests (
  workspace_id uuid NOT NULL REFERENCES deviludo.workspaces(id) ON DELETE CASCADE,
  project_id uuid NOT NULL,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 10),
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  lease_token uuid,
  lease_expires_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, project_id),
  CHECK ((lease_token IS NULL) = (lease_expires_at IS NULL))
);

ALTER TABLE deviludo.project_cleanup_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE deviludo.project_cleanup_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON deviludo.project_cleanup_requests
  USING (workspace_id = deviludo.current_workspace_id())
  WITH CHECK (workspace_id = deviludo.current_workspace_id());

CREATE OR REPLACE FUNCTION deviludo.claim_project_cleanup(p_lease_seconds integer)
RETURNS TABLE ("workspaceId" uuid, "projectId" uuid, "leaseToken" uuid, attempt integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, deviludo
SET row_security = off
AS $$
BEGIN
  IF p_lease_seconds NOT BETWEEN 30 AND 600 THEN RAISE EXCEPTION 'invalid project cleanup lease'; END IF;
  RETURN QUERY
  WITH candidate AS (
    SELECT request.workspace_id, request.project_id
      FROM deviludo.project_cleanup_requests request
     WHERE request.attempts < 10 AND request.available_at <= clock_timestamp()
       AND (request.lease_token IS NULL OR request.lease_expires_at <= clock_timestamp())
     ORDER BY request.available_at, request.created_at
     FOR UPDATE SKIP LOCKED LIMIT 1
  )
  UPDATE deviludo.project_cleanup_requests request
     SET attempts = request.attempts + 1, lease_token = gen_random_uuid(),
         lease_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds), last_error = NULL
    FROM candidate
   WHERE request.workspace_id = candidate.workspace_id AND request.project_id = candidate.project_id
  RETURNING request.workspace_id, request.project_id, request.lease_token, request.attempts;
END
$$;
ALTER FUNCTION deviludo.claim_project_cleanup(integer) OWNER TO deviludo_claim_executor;

CREATE OR REPLACE FUNCTION deviludo.complete_project_cleanup(
  p_workspace_id uuid, p_project_id uuid, p_lease_token uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, deviludo
SET row_security = off
AS $$
DECLARE removed integer;
BEGIN
  DELETE FROM deviludo.project_cleanup_requests
   WHERE workspace_id = p_workspace_id AND project_id = p_project_id
     AND lease_token = p_lease_token AND lease_expires_at > clock_timestamp();
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed = 1;
END
$$;
ALTER FUNCTION deviludo.complete_project_cleanup(uuid, uuid, uuid) OWNER TO deviludo_claim_executor;

CREATE OR REPLACE FUNCTION deviludo.fail_project_cleanup(
  p_workspace_id uuid, p_project_id uuid, p_lease_token uuid, p_error text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, deviludo
SET row_security = off
AS $$
DECLARE updated integer;
BEGIN
  UPDATE deviludo.project_cleanup_requests
     SET lease_token = NULL, lease_expires_at = NULL,
         available_at = clock_timestamp() + make_interval(secs => least(3600, 15 * power(2, attempts)::integer)),
         last_error = left(p_error, 2000)
   WHERE workspace_id = p_workspace_id AND project_id = p_project_id AND lease_token = p_lease_token;
  GET DIAGNOSTICS updated = ROW_COUNT;
  RETURN updated = 1;
END
$$;
ALTER FUNCTION deviludo.fail_project_cleanup(uuid, uuid, uuid, text) OWNER TO deviludo_claim_executor;

GRANT INSERT ON deviludo.project_cleanup_requests TO deviludo_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON deviludo.project_cleanup_requests TO deviludo_claim_executor;
GRANT EXECUTE ON FUNCTION deviludo.claim_project_cleanup(integer),
  deviludo.complete_project_cleanup(uuid, uuid, uuid),
  deviludo.fail_project_cleanup(uuid, uuid, uuid, text)
  TO deviludo_scheduler;

UPDATE deviludo.schema_metadata
   SET current_version = '063_async_project_cleanup', applied_at = clock_timestamp()
 WHERE singleton = true;

COMMIT;
