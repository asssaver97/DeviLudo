-- Preserve every delivery as an immutable iteration. Existing workflow rows
-- are ordered deterministically and linked into the same linear history that
-- newly-created iterations use.
ALTER TABLE deviludo.workflow_instances
  ADD COLUMN iteration_number integer,
  ADD COLUMN parent_workflow_id uuid;

WITH ordered AS (
  SELECT workspace_id, id, project_id,
         row_number() OVER (
           PARTITION BY workspace_id, project_id
           ORDER BY created_at, id
         )::integer AS iteration_number,
         lag(id) OVER (
           PARTITION BY workspace_id, project_id
           ORDER BY created_at, id
         ) AS parent_workflow_id
    FROM deviludo.workflow_instances
)
UPDATE deviludo.workflow_instances workflow
   SET iteration_number = ordered.iteration_number,
       parent_workflow_id = ordered.parent_workflow_id
  FROM ordered
 WHERE workflow.workspace_id = ordered.workspace_id
   AND workflow.id = ordered.id;

ALTER TABLE deviludo.workflow_instances
  ALTER COLUMN iteration_number SET NOT NULL,
  ALTER COLUMN iteration_number SET DEFAULT 1,
  ADD CONSTRAINT workflow_iteration_positive CHECK (iteration_number > 0),
  ADD CONSTRAINT workflow_iteration_unique UNIQUE (workspace_id, project_id, iteration_number),
  ADD CONSTRAINT workflow_iteration_parent_unique UNIQUE (workspace_id, parent_workflow_id),
  ADD CONSTRAINT workflow_iteration_parent_fk
    FOREIGN KEY (workspace_id, parent_workflow_id)
    REFERENCES deviludo.workflow_instances(workspace_id, id);
