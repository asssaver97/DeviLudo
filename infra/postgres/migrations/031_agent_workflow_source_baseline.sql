-- Give every existing-project Agent task the immutable source from the start of
-- its workflow iteration. This is a recovery reference, not a second writable
-- worktree: the current source remains authoritative.
CREATE OR REPLACE FUNCTION deviludo.snapshot_agent_baseline_source()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, deviludo
AS $$
DECLARE
  baseline deviludo.project_source_revisions%ROWTYPE;
BEGIN
  IF NEW.kind <> 'AGENT_GENERATION' THEN RETURN NEW; END IF;
  SELECT source.* INTO baseline
    FROM deviludo.project_source_revisions source
   WHERE source.workspace_id = NEW.workspace_id
     AND source.project_id = NEW.project_id
     AND source.revision = coalesce(
       (SELECT nullif(workflow.state_data #>> '{iteration,baseSourceRevision}', '')::bigint
          FROM deviludo.workflow_instances workflow
         WHERE workflow.workspace_id = NEW.workspace_id AND workflow.id = NEW.workflow_id),
       (SELECT min(initial.revision)
          FROM deviludo.project_source_revisions initial
         WHERE initial.workspace_id = NEW.workspace_id AND initial.project_id = NEW.project_id)
     )
   LIMIT 1;
  IF baseline.revision IS NOT NULL THEN
    NEW.payload := NEW.payload || jsonb_build_object(
      'baselineSourceRevision', baseline.revision,
      'baselineSourceRelativePath', baseline.relative_path,
      'baselineSourceDigest', baseline.content_digest
    );
  END IF;
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION deviludo.snapshot_agent_baseline_source() FROM PUBLIC;

DROP TRIGGER IF EXISTS jobs_snapshot_agent_baseline_source ON deviludo.jobs;
CREATE TRIGGER jobs_snapshot_agent_baseline_source
BEFORE INSERT ON deviludo.jobs
FOR EACH ROW EXECUTE FUNCTION deviludo.snapshot_agent_baseline_source();
