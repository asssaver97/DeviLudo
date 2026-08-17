-- A linked local working tree becomes a visible project immediately. Core API
-- replicas claim its initial analysis through a durable lease stored in the
-- workflow state instead of holding the browser request open.
CREATE OR REPLACE FUNCTION deviludo.claim_project_import_analysis(p_lease_seconds integer)
RETURNS TABLE (
  "workspaceId" uuid,
  "projectId" uuid,
  "workflowId" uuid,
  "actorId" uuid,
  "leaseToken" uuid,
  "sourceKind" text,
  "repositoryUrl" text,
  "localDirectoryBindingId" uuid,
  "gitBranch" text,
  "displayName" text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, deviludo
SET row_security = off
AS $$
DECLARE
  candidate record;
  next_token uuid;
  next_expiry timestamptz;
  next_attempt integer;
BEGIN
  IF p_lease_seconds NOT BETWEEN 60 AND 3600 THEN
    RAISE EXCEPTION 'invalid project import analysis lease';
  END IF;
  SELECT workflow.workspace_id, workflow.id AS workflow_id, workflow.project_id,
         workflow.state_data, project.created_by_actor_id
    INTO candidate
    FROM deviludo.workflow_instances workflow
    JOIN deviludo.projects project
      ON project.workspace_id = workflow.workspace_id AND project.id = workflow.project_id
   WHERE workflow.state_data #>> '{importAnalysis,status}' = 'PENDING'
      OR (
        workflow.state_data #>> '{importAnalysis,status}' = 'ANALYZING'
        AND (workflow.state_data #>> '{importAnalysis,leaseExpiresAt}')::timestamptz <= clock_timestamp()
      )
   ORDER BY workflow.created_at, workflow.id
   FOR UPDATE OF workflow SKIP LOCKED
   LIMIT 1;
  IF NOT FOUND THEN RETURN; END IF;

  next_token := gen_random_uuid();
  next_expiry := clock_timestamp() + make_interval(secs => p_lease_seconds);
  next_attempt := coalesce((candidate.state_data #>> '{importAnalysis,attempts}')::integer, 0) + 1;
  UPDATE deviludo.workflow_instances
     SET state_data = jsonb_set(
       candidate.state_data,
       '{importAnalysis}',
       coalesce(candidate.state_data->'importAnalysis', '{}'::jsonb) || jsonb_build_object(
         'status', 'ANALYZING',
         'attempts', next_attempt,
         'error', NULL,
         'startedAt', clock_timestamp(),
         'leaseToken', next_token,
         'leaseExpiresAt', next_expiry
       )
     ),
     version = version + 1,
     updated_at = clock_timestamp()
   WHERE workspace_id = candidate.workspace_id AND id = candidate.workflow_id;

  RETURN QUERY SELECT
    candidate.workspace_id,
    candidate.project_id,
    candidate.workflow_id,
    candidate.created_by_actor_id,
    next_token,
    candidate.state_data #>> '{source,kind}',
    candidate.state_data #>> '{source,repositoryUrl}',
    (candidate.state_data #>> '{source,localDirectoryBindingId}')::uuid,
    candidate.state_data #>> '{source,gitBranch}',
    candidate.state_data #>> '{source,displayName}';
END
$$;

ALTER FUNCTION deviludo.claim_project_import_analysis(integer)
  OWNER TO deviludo_claim_executor;
GRANT EXECUTE ON FUNCTION deviludo.claim_project_import_analysis(integer) TO deviludo_api;
