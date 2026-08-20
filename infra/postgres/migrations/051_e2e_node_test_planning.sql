BEGIN;

-- The platform E2E node now freezes the test contract immediately before it
-- boots the target platform. Source revisions contain game source only; they no
-- longer carry a plan produced by the Development Agent.
DO $migration$
DECLARE
  target regprocedure :=
    'deviludo.enqueue_job(uuid,uuid,uuid,deviludo.job_kind,deviludo.server_os,text,jsonb)'::regprocedure;
  definition text;
  previous text;
BEGIN
  SELECT pg_get_functiondef(target) INTO definition;
  previous := definition;
  definition := regexp_replace(
    definition,
    E',\\s*''testManifestDigest'',\\s*v_source\\.test_manifest_digest,\\s*''e2eContractDigest'',\\s*v_source\\.e2e_contract_digest',
    '',
    'g'
  );
  definition := replace(definition,
    'WHEN p_kind = ''E2E_TEST'' THEN v_source.e2e_timeout_seconds',
    'WHEN p_kind = ''E2E_TEST'' THEN 5400');
  definition := replace(definition,
    ' AND trace.source_digest = v_source.content_digest',
    '');
  definition := replace(definition,
    ' AND trace.test_manifest_digest = v_source.test_manifest_digest',
    '');
  definition := replace(definition,
    ' AND trace.contract_digest = v_source.e2e_contract_digest',
    '');
  IF definition = previous
    OR position('v_source.test_manifest_digest' IN definition) > 0
    OR position('v_source.e2e_timeout_seconds' IN definition) > 0
    OR position('v_source.e2e_contract_digest' IN definition) > 0
  THEN
    RAISE EXCEPTION 'enqueue_job no longer matches the source-owned E2E contract';
  END IF;
  EXECUTE definition;
END
$migration$;

DO $migration$
DECLARE
  target regprocedure :=
    'deviludo.complete_job(uuid,uuid,bigint,bigint,jsonb,jsonb,text,text,text)'::regprocedure;
  definition text;
  previous text;
BEGIN
  SELECT pg_get_functiondef(target) INTO definition;
  previous := definition;
  definition := replace(definition,
    E'      OR coalesce(p_receipt #>> ''{testManifest,schema}'', '''') <> ''deviludo.test-manifest''\n',
    '');
  definition := replace(definition,
    E'      OR coalesce(p_receipt->>''testManifestDigest'', '''') !~ ''^sha256:[0-9a-f]{64}$''\n',
    '');
  definition := replace(definition,
    E'      OR (p_receipt #>> ''{e2eExecutionPlan,plannedTimeoutSeconds}'')::integer NOT BETWEEN 1800 AND 5400\n',
    '');
  definition := replace(definition,
    E'      OR coalesce(p_receipt #>> ''{e2eExecutionPlan,contractDigest}'', '''') !~ ''^sha256:[0-9a-f]{64}$''\n',
    '');
  definition := replace(definition,
    E'      file_count, total_bytes, test_manifest_schema, test_manifest_digest,\n      e2e_timeout_seconds, e2e_contract_digest,\n      workflow_id',
    E'      file_count, total_bytes, workflow_id');
  definition := replace(definition,
    E'      p_receipt #>> ''{testManifest,schema}'',\n      p_receipt->>''testManifestDigest'',\n      (p_receipt #>> ''{e2eExecutionPlan,plannedTimeoutSeconds}'')::integer,\n      p_receipt #>> ''{e2eExecutionPlan,contractDigest}'',\n',
    '');
  definition := replace(definition,
    'coalesce(job.payload->>''testManifestDigest'', '''')',
    'coalesce(p_receipt #>> ''{execution,evidence,testManifestDigest}'', '''')');
  definition := replace(definition,
    'coalesce(job.payload->>''e2eContractDigest'', '''')',
    'coalesce(p_receipt #>> ''{execution,evidence,regressionContractDigest}'', '''')');
  definition := replace(definition,
    'artifact.metadata #>> ''{e2eRegression,regressionContractDigest}'' = job.payload->>''e2eContractDigest''',
    'artifact.metadata #>> ''{e2eRegression,regressionContractDigest}'' = p_receipt #>> ''{execution,evidence,regressionContractDigest}''');
  definition := replace(definition,
    'job.payload->>''sourceDigest'', job.payload->>''testManifestDigest'', job.payload->>''e2eContractDigest'',',
    E'job.payload->>''sourceDigest'',\n           p_receipt #>> ''{execution,evidence,testManifestDigest}'',\n           p_receipt #>> ''{execution,evidence,regressionContractDigest}'',');
  IF definition = previous
    OR position('{testManifest,schema}' IN definition) > 0
    OR position('{e2eExecutionPlan,plannedTimeoutSeconds}' IN definition) > 0
    OR position('job.payload->>''testManifestDigest''' IN definition) > 0
    OR position('job.payload->>''e2eContractDigest''' IN definition) > 0
  THEN
    RAISE EXCEPTION 'complete_job no longer matches the Agent-owned E2E contract';
  END IF;
  EXECUTE definition;
END
$migration$;

ALTER TABLE deviludo.project_source_revisions
  DROP COLUMN test_manifest_schema,
  DROP COLUMN test_manifest_digest,
  DROP COLUMN e2e_timeout_seconds,
  DROP COLUMN e2e_contract_digest;

COMMIT;
