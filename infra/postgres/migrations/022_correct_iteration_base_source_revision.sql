BEGIN;

-- revision::text keeps the output alias "revision". An unqualified
-- ORDER BY revision then sorts that alias lexically (9 before 14), so an
-- iteration created after revision 9 could record the wrong base. Repair every
-- child from the newest source that existed when it was created.
WITH corrected AS (
  SELECT child.workspace_id,
         child.id AS workflow_id,
         (
           SELECT max(source.revision)
             FROM deviludo.project_source_revisions source
            WHERE source.workspace_id = child.workspace_id
              AND source.project_id = child.project_id
              AND source.created_at <= child.created_at
         ) AS base_source_revision
    FROM deviludo.workflow_instances child
   WHERE child.parent_workflow_id IS NOT NULL
), updated AS (
  UPDATE deviludo.workflow_instances child
     SET state_data = jsonb_set(
       child.state_data,
       '{iteration,baseSourceRevision}',
       coalesce(to_jsonb(corrected.base_source_revision), 'null'::jsonb),
       true
     )
    FROM corrected
   WHERE child.workspace_id = corrected.workspace_id
     AND child.id = corrected.workflow_id
     AND child.state_data #> '{iteration,baseSourceRevision}'
       IS DISTINCT FROM coalesce(to_jsonb(corrected.base_source_revision), 'null'::jsonb)
  RETURNING child.workspace_id, child.id, corrected.base_source_revision
)
UPDATE deviludo.workflow_events event
   SET event_data = jsonb_set(
     event.event_data,
     '{baseSourceRevision}',
     coalesce(to_jsonb(updated.base_source_revision), 'null'::jsonb),
     true
   )
  FROM updated
 WHERE event.workspace_id = updated.workspace_id
   AND event.workflow_id = updated.id
   AND event.event_kind = 'ITERATION_STARTED';

COMMIT;
