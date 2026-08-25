BEGIN;

CREATE TABLE deviludo.host_source_events (
  event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  workflow_id uuid NOT NULL,
  source_revision bigint NOT NULL,
  content_digest text NOT NULL CHECK (content_digest ~ '^sha256:[0-9a-f]{64}$'),
  actor_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  acknowledged_at timestamptz,
  UNIQUE (workspace_id, project_id, workflow_id, source_revision),
  FOREIGN KEY (workspace_id, project_id, source_revision)
    REFERENCES deviludo.project_source_revisions(workspace_id, project_id, revision)
    ON DELETE CASCADE
);
CREATE INDEX host_source_events_pending
  ON deviludo.host_source_events(created_at, event_id)
  WHERE acknowledged_at IS NULL;

ALTER TABLE deviludo.host_source_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE deviludo.host_source_events FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON deviludo.host_source_events
  USING (workspace_id = deviludo.current_workspace_id())
  WITH CHECK (workspace_id = deviludo.current_workspace_id());

CREATE OR REPLACE FUNCTION deviludo.enqueue_host_source_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, deviludo
SET row_security = off
AS $$
BEGIN
  IF NEW.state = 'SUCCEEDED' AND OLD.state IS DISTINCT FROM NEW.state THEN
    INSERT INTO deviludo.host_source_events(
      workspace_id, project_id, workflow_id, source_revision, content_digest, actor_id
    )
    SELECT NEW.workspace_id, NEW.project_id, NEW.id, source.revision,
           source.content_digest, coalesce(NEW.development_actor_id, source.actor_id)
      FROM deviludo.project_source_revisions source
     WHERE source.workspace_id = NEW.workspace_id AND source.project_id = NEW.project_id
     ORDER BY source.revision DESC
     LIMIT 1
    ON CONFLICT (workspace_id, project_id, workflow_id, source_revision) DO NOTHING;
  END IF;
  RETURN NEW;
END
$$;
ALTER FUNCTION deviludo.enqueue_host_source_event() OWNER TO deviludo_claim_executor;
CREATE TRIGGER workflow_host_source_event
AFTER UPDATE OF state ON deviludo.workflow_instances
FOR EACH ROW EXECUTE FUNCTION deviludo.enqueue_host_source_event();

CREATE OR REPLACE FUNCTION deviludo.pull_host_source_events(p_limit integer DEFAULT 100)
RETURNS TABLE (
  event_id uuid,
  workspace_id uuid,
  project_id uuid,
  workflow_id uuid,
  source_revision bigint,
  content_digest text,
  actor_id uuid,
  created_at timestamptz
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = pg_catalog, deviludo
SET row_security = off
AS $$
  SELECT event.event_id, event.workspace_id, event.project_id, event.workflow_id,
         event.source_revision, event.content_digest, event.actor_id, event.created_at
    FROM deviludo.host_source_events event
   WHERE event.acknowledged_at IS NULL
   ORDER BY event.created_at, event.event_id
   LIMIT greatest(1, least(p_limit, 500))
$$;
ALTER FUNCTION deviludo.pull_host_source_events(integer) OWNER TO deviludo_claim_executor;

CREATE OR REPLACE FUNCTION deviludo.acknowledge_host_source_events(p_event_ids uuid[])
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, deviludo
SET row_security = off
AS $$
DECLARE
  acknowledged bigint;
BEGIN
  IF cardinality(p_event_ids) NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'source event acknowledgement size is invalid';
  END IF;
  UPDATE deviludo.host_source_events
     SET acknowledged_at = coalesce(acknowledged_at, clock_timestamp())
   WHERE event_id = ANY(p_event_ids);
  GET DIAGNOSTICS acknowledged = ROW_COUNT;
  RETURN acknowledged;
END
$$;
ALTER FUNCTION deviludo.acknowledge_host_source_events(uuid[]) OWNER TO deviludo_claim_executor;

REVOKE ALL ON FUNCTION deviludo.enqueue_host_source_event(),
  deviludo.pull_host_source_events(integer),
  deviludo.acknowledge_host_source_events(uuid[])
  FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON deviludo.host_source_events TO deviludo_claim_executor;
GRANT EXECUTE ON FUNCTION deviludo.pull_host_source_events(integer),
  deviludo.acknowledge_host_source_events(uuid[])
  TO deviludo_api;

COMMIT;
