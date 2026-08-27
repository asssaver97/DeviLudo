import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import pg from "pg";

const execute = promisify(execFile);
const root = new URL("..", import.meta.url);
const connectionString = process.env.DEVILUDO_DATABASE_SMOKE_URL
  ?? process.env.DEVILUDO_MIGRATION_DATABASE_URL
  ?? "";

if (!connectionString) {
  const result = await execute("docker", [
    "compose", "-f", "infra/docker-compose.yml", "--profile", "init", "run", "--rm", "-T",
    "migrate", "node", "scripts/local-database-smoke.mjs",
  ], { cwd: root, maxBuffer: 4 * 1024 * 1024, timeout: 5 * 60_000 });
  process.stdout.write(result.stdout);
} else {
  await runDatabaseSmoke(connectionString);
}

async function runDatabaseSmoke(url) {
  const owner = new pg.Pool({ connectionString: url, max: 4 });
  const api = rolePool(url, "deviludo_api");
  const sandbox = rolePool(url, "deviludo_sandbox");
  const scheduler = rolePool(url, "deviludo_scheduler");
  const workspaceIds = [randomUUID(), randomUUID()];
  const projectIds = [randomUUID(), randomUUID()];
  const workflowIds = [randomUUID(), randomUUID()];
  const jobIds = [randomUUID(), randomUUID()];
  const actorId = randomUUID();
  try {
    const forced = await owner.query(`
      SELECT c.relname
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'deviludo' AND c.relrowsecurity AND c.relforcerowsecurity
    `);
    const requiredRls = [
      "workspaces", "projects", "project_source_revisions",
      "project_conversations", "conversation_messages", "agent_installations",
      "workflow_instances", "workflow_events", "jobs", "external_signals",
      "job_progress_events", "implementation_change_requests", "workflow_e2e_goal_revisions",
      "operation_receipts",
      "workspace_claim_fairness", "artifacts", "artifact_inputs", "pending_object_uploads", "object_cleanup_queue",
      "project_cleanup_requests", "host_admission_events",
      "e2e_policy_locks", "e2e_policy_decisions", "e2e_regression_traces", "executor_receipts",
      "project_creation_receipts",
    ];
    const forcedNames = new Set(forced.rows.map(row => row.relname));
    if (requiredRls.some(table => !forcedNames.has(table))) throw new Error("A workspace table is missing forced RLS");

    const identityTables = await owner.query(`
      SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'deviludo'
         AND table_name = ANY(ARRAY['users','sessions','workspace_memberships','workspace_invitations',
           'github_oauth_flows','project_repository_connections','project_github_permissions'])
    `);
    if (identityTables.rowCount) throw new Error("Core still contains hosted identity or GitHub authority tables");

    const roles = await owner.query(`
      SELECT rolname, rolbypassrls, rolcanlogin FROM pg_roles
       WHERE rolname IN ('deviludo_api','deviludo_scheduler','deviludo_sandbox','deviludo_claim_executor')
    `);
    if (roles.rows.length !== 4 || roles.rows.some(row => row.rolcanlogin)) throw new Error("A service role can log in directly");
    const claimRole = roles.rows.find(row => row.rolname === "deviludo_claim_executor");
    if (!claimRole?.rolbypassrls || roles.rows.some(row => row.rolname !== "deviludo_claim_executor" && row.rolbypassrls)) {
      throw new Error("The RLS bypass privilege is not isolated to the claim executor");
    }

    const publicPrivileges = await owner.query(`
      SELECT 1 FROM information_schema.table_privileges
       WHERE table_schema = 'deviludo' AND grantee = 'PUBLIC'
      UNION ALL
      SELECT 1 FROM information_schema.routine_privileges
       WHERE specific_schema = 'deviludo' AND grantee = 'PUBLIC'
    `);
    if (publicPrivileges.rowCount) throw new Error("PUBLIC retained Core data-plane privileges");

    const definers = await owner.query(`
      SELECT function.proname, owner.rolname AS owner
        FROM pg_proc function
        JOIN pg_namespace namespace ON namespace.oid = function.pronamespace
        JOIN pg_roles owner ON owner.oid = function.proowner
       WHERE namespace.nspname = 'deviludo' AND function.prosecdef
       ORDER BY function.proname
    `);
    const artifactOwnerResult = await owner.query(`
      SELECT owner.rolname AS owner
        FROM pg_class relation
        JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
        JOIN pg_roles owner ON owner.oid = relation.relowner
       WHERE namespace.nspname = 'deviludo' AND relation.relname = 'artifacts'
    `);
    const artifactOwner = artifactOwnerResult.rows[0]?.owner;
    const expectedDefiners = [
      "acknowledge_host_source_events", "advance_asset_workflows", "claim_agent_container_lifecycle", "claim_asset_generation", "claim_host_admission_event", "claim_job",
      "claim_local_git_commit", "claim_object_cleanup", "claim_paused_agent_container_for_pressure", "claim_project_cleanup", "claim_project_import_analysis", "cleanup_expired_executor_state",
      "complete_agent_container_lifecycle", "complete_asset_generation", "complete_host_admission_event", "complete_local_git_commit", "complete_object_cleanup", "complete_project_cleanup",
      "enqueue_expired_artifacts", "enqueue_host_source_event",
      "fail_agent_container_lifecycle", "fail_asset_generation", "fail_host_admission_event", "fail_local_git_commit", "fail_object_cleanup", "fail_project_cleanup",
      "publish_development_agent_message", "pull_host_source_events", "reconcile_expired_uploads", "reconcile_host_admission_events", "recover_expired_jobs",
      "retain_latest_e2e_report",
    ];
    if (JSON.stringify(definers.rows.map(row => row.proname)) !== JSON.stringify(expectedDefiners)
      || !artifactOwner
      || definers.rows.some(row => row.owner !== (row.proname === "retain_latest_e2e_report"
        ? artifactOwner
        : row.proname === "publish_development_agent_message"
          ? "deviludo_conversation_writer"
          : "deviludo_claim_executor"))) {
      throw new Error("A SECURITY DEFINER function has an unexpected owner or scope");
    }
    await assertFunctionPrivilege(owner, "deviludo_scheduler", "deviludo.cleanup_expired_executor_state()", true);
    await assertFunctionPrivilege(owner, "deviludo_api", "deviludo.cleanup_expired_executor_state()", false);
    await assertFunctionPrivilege(owner, "deviludo_scheduler", "deviludo.advance_asset_workflows(integer)", true);
    await assertFunctionPrivilege(owner, "deviludo_api", "deviludo.advance_asset_workflows(integer)", false);
    await assertFunctionPrivilege(owner, "deviludo_api", "deviludo.request_asset_rerun(uuid,uuid,text,jsonb)", true);
    await assertFunctionPrivilege(owner, "deviludo_scheduler", "deviludo.request_asset_rerun(uuid,uuid,text,jsonb)", false);
    const sandboxAgentSettings = await sandbox.query(
      "SELECT count(*)::integer AS count FROM deviludo.instance_agent_settings",
    );
    if (!Number.isInteger(sandboxAgentSettings.rows[0]?.count)) {
      throw new Error("Sandbox cannot read the selected Agent connection required by complete_job");
    }
    await assertFunctionPrivilege(owner, "deviludo_scheduler", "deviludo.claim_local_git_commit(integer)", true);
    await assertFunctionPrivilege(owner, "deviludo_api", "deviludo.claim_local_git_commit(integer)", false);
    await assertFunctionPrivilege(owner, "deviludo_scheduler", "deviludo.claim_object_cleanup(integer)", true);
    await assertFunctionPrivilege(owner, "deviludo_api", "deviludo.claim_object_cleanup(integer)", false);
    await assertFunctionPrivilege(owner, "deviludo_scheduler", "deviludo.enqueue_expired_artifacts(integer,integer)", true);
    await assertFunctionPrivilege(owner, "deviludo_api", "deviludo.enqueue_expired_artifacts(integer,integer)", false);
    await assertFunctionPrivilege(owner, "deviludo_scheduler", "deviludo.reconcile_expired_uploads(integer)", true);
    await assertFunctionPrivilege(owner, "deviludo_api", "deviludo.reconcile_expired_uploads(integer)", false);
    await assertFunctionPrivilege(owner, "deviludo_scheduler", "deviludo.reconcile_host_admission_events()", true);
    await assertFunctionPrivilege(owner, "deviludo_api", "deviludo.reconcile_host_admission_events()", false);
    await assertFunctionPrivilege(owner, "deviludo_scheduler", "deviludo.claim_host_admission_event(integer)", true);
    await assertFunctionPrivilege(owner, "deviludo_api", "deviludo.claim_host_admission_event(integer)", false);
    await scheduler.query("SELECT deviludo.reconcile_p0_capacity()");

    await owner.query(
      "INSERT INTO deviludo.workspaces(id, name) VALUES ($1::uuid, 'source-smoke-a'), ($2::uuid, 'source-smoke-b')",
      workspaceIds,
    );
    const cleanupKey = `workspaces/${workspaceIds[0]}/retired-e2e.zip`;
    await owner.query(`INSERT INTO deviludo.object_cleanup_queue(workspace_id, bucket, object_key, reason)
      VALUES ($1::uuid, 'deviludo-artifacts', $2, 'database smoke')`, [workspaceIds[0], cleanupKey]);
    const cleanupClaim = await scheduler.query(`SELECT "workspaceId"::text, bucket, "objectKey", "leaseToken"::text
      FROM deviludo.claim_object_cleanup(60)`);
    if (cleanupClaim.rows[0]?.workspaceId !== workspaceIds[0] || cleanupClaim.rows[0]?.objectKey !== cleanupKey) {
      throw new Error("Object cleanup request was not leased durably");
    }
    const cleanupSettled = await scheduler.query(`SELECT deviludo.complete_object_cleanup(
      $1::uuid, $2::text, $3::text, $4::uuid) AS completed`, [workspaceIds[0], "deviludo-artifacts", cleanupKey, cleanupClaim.rows[0].leaseToken]);
    if (cleanupSettled.rows[0]?.completed !== true) throw new Error("Object cleanup lease was not settled");
    await expectRlsRejection(() => api.query(
      "INSERT INTO deviludo.projects(workspace_id, id, created_by_actor_id, name) VALUES ($1::uuid, $2::uuid, $3::uuid, 'missing-context')",
      [workspaceIds[0], randomUUID(), actorId],
    ));

    for (let index = 0; index < 2; index += 1) {
      await withWorkspace(api, workspaceIds[index], client => client.query(
        `INSERT INTO deviludo.projects(workspace_id, id, created_by_actor_id, name)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4)`,
        [workspaceIds[index], projectIds[index], actorId, `source-smoke-${index}`],
      ));
      await owner.query(
        `INSERT INTO deviludo.workflow_instances(
           workspace_id, id, project_id, profile, target_platforms, state, development_actor_id
         ) VALUES ($1::uuid, $2::uuid, $3::uuid, 'VALIDATE', ARRAY['macos']::deviludo.server_os[],
           'DEVELOPING', $4::uuid)`,
        [workspaceIds[index], workflowIds[index], projectIds[index], actorId],
      );
    }

    // Each immutable iteration/platform exposes one current evidence ZIP. A new
    // report retires the old database row immediately and durably queues its
    // object for deletion, while another platform remains independent.
    const firstReportId = randomUUID();
    const secondReportId = randomUUID();
    const linuxReportId = randomUUID();
    const firstReportKey = `workspaces/${workspaceIds[0]}/projects/${projectIds[0]}/jobs/e2e-old/report.zip`;
    const secondReportKey = `workspaces/${workspaceIds[0]}/projects/${projectIds[0]}/jobs/e2e-new/report.zip`;
    await withWorkspace(sandbox, workspaceIds[0], client => client.query(`
      INSERT INTO deviludo.artifacts(
        workspace_id, id, project_id, workflow_id, kind, target_platform,
        bucket, object_key, sha256, size_bytes
      ) VALUES
        ($1::uuid, $4::uuid, $2::uuid, $3::uuid, 'E2E_REPORT', 'macos',
         'deviludo-artifacts', $7, 'sha256:${"d".repeat(64)}', 100),
        ($1::uuid, $5::uuid, $2::uuid, $3::uuid, 'E2E_REPORT', 'macos',
         'deviludo-artifacts', $8, 'sha256:${"e".repeat(64)}', 200),
        ($1::uuid, $6::uuid, $2::uuid, $3::uuid, 'E2E_REPORT', 'linux',
         'deviludo-artifacts',
         'workspaces/' || $1::text || '/projects/' || $2::text || '/jobs/e2e-linux/report.zip',
         'sha256:${"f".repeat(64)}', 300)
    `, [workspaceIds[0], projectIds[0], workflowIds[0], firstReportId,
      secondReportId, linuxReportId, firstReportKey, secondReportKey]));
    const retainedReports = await owner.query(`
      SELECT id::text, target_platform::text
        FROM deviludo.artifacts
       WHERE workspace_id = $1::uuid AND workflow_id = $2::uuid AND kind = 'E2E_REPORT'
       ORDER BY target_platform
    `, [workspaceIds[0], workflowIds[0]]);
    if (retainedReports.rows.length !== 2
      || retainedReports.rows.some(row => row.id === firstReportId)
      || !retainedReports.rows.some(row => row.id === secondReportId)
      || !retainedReports.rows.some(row => row.id === linuxReportId)) {
      throw new Error(`E2E report retention did not keep one report per platform: ${JSON.stringify(retainedReports.rows)}`);
    }
    const queuedReportCleanup = await owner.query(`
      SELECT 1 FROM deviludo.object_cleanup_queue
       WHERE workspace_id = $1::uuid AND bucket = 'deviludo-artifacts' AND object_key = $2
    `, [workspaceIds[0], firstReportKey]);
    if (queuedReportCleanup.rowCount !== 1) throw new Error("Superseded E2E evidence was not queued for object deletion");

    const digest = `sha256:${"a".repeat(64)}`;
    const relativePath = `workspaces/${workspaceIds[0]}/projects/${projectIds[0]}/revisions/r000000000001-${digest.slice(7, 23)}`;
    await withWorkspace(api, workspaceIds[0], async client => {
      await client.query(
        `INSERT INTO deviludo.project_source_revisions(
           workspace_id, project_id, revision, relative_path, content_digest, file_count, total_bytes,
           workflow_id, actor_id
         ) VALUES ($1::uuid, $2::uuid, 1, $3, $4, 1, 128, $5::uuid, $6::uuid)`,
        [workspaceIds[0], projectIds[0], relativePath, digest, workflowIds[0], actorId],
      );
    });

    const gitRequestId = randomUUID();
    const bindingId = randomUUID();
    await owner.query(`
      UPDATE deviludo.workflow_instances
         SET state_data = jsonb_build_object('gitCommit', jsonb_build_object(
           'requestId', $3::uuid, 'state', 'PENDING', 'bindingId', $4::uuid,
           'expectedSourceDigest', $5::text, 'iterationNumber', 1,
           'attempts', 0, 'availableAt', clock_timestamp()
         ))
       WHERE workspace_id = $1::uuid AND id = $2::uuid
    `, [workspaceIds[1], workflowIds[1], gitRequestId, bindingId, digest]);
    const gitClaim = await scheduler.query(`
      SELECT "workflowId"::text, "requestId"::text, "leaseToken"::text, "bindingId"::text
        FROM deviludo.claim_local_git_commit(60)
    `);
    if (gitClaim.rows[0]?.workflowId !== workflowIds[1]
      || gitClaim.rows[0]?.requestId !== gitRequestId
      || gitClaim.rows[0]?.bindingId !== bindingId) {
      throw new Error("Local Git commit request was not leased durably");
    }
    const gitSettled = await scheduler.query(`
      SELECT deviludo.complete_local_git_commit(
        $1::uuid, $2::uuid, $3::uuid, 'NOT_GIT', NULL, NULL
      ) AS completed
    `, [workflowIds[1], gitRequestId, gitClaim.rows[0].leaseToken]);
    if (gitSettled.rows[0]?.completed !== true) throw new Error("Local Git commit lease was not settled");
    const gitState = await owner.query(`
      SELECT state_data #>> '{gitCommit,state}' AS state
        FROM deviludo.workflow_instances WHERE workspace_id = $1::uuid AND id = $2::uuid
    `, [workspaceIds[1], workflowIds[1]]);
    if (gitState.rows[0]?.state !== "SKIPPED") throw new Error("Local Git commit result was not persisted");

    const runtime = await owner.query("SELECT image_reference FROM deviludo.runtime_images WHERE runtime_key = 'AGENT_CLAUDE'");
    if (!runtime.rows[0]?.image_reference) throw new Error("Local Agent runtime digest is missing");
    for (let index = 0; index < 2; index += 1) {
      await owner.query(
        `INSERT INTO deviludo.jobs(
           workspace_id, id, workflow_id, project_id, kind, pool_kind,
           required_capabilities, exclusive, runtime_image, output_contract, idempotency_key,
           payload
         ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'AGENT_TURN', 'CORE',
           ARRAY['MICROVM','NETWORK_POLICY'], false, $5,
           '{"kinds":["SPECIFICATION"],"maxBytes":134217728}'::jsonb, $6,
           jsonb_build_object('publishSourceRevision', 1))`,
        [workspaceIds[index], jobIds[index], workflowIds[index], projectIds[index], runtime.rows[0].image_reference, `source-smoke:${jobIds[index]}`],
      );
    }
    const executorIds = [`source-smoke:${randomUUID()}`, `source-smoke:${randomUUID()}`];
    const claims = await Promise.all(executorIds.map(executorId => claim(sandbox, executorId)));
    if (claims.some(claimed => !claimed) || new Set(claims.map(claimed => claimed.workspaceId)).size !== 2) {
      throw new Error(`Concurrent claims were not distributed across workspaces: ${JSON.stringify(claims)}`);
    }
    if (await claim(sandbox, executorIds[0])) throw new Error("An executor obtained a duplicate active lease");

    const first = await owner.query(
      "SELECT id::text FROM deviludo.jobs WHERE lease_owner = $1",
      [executorIds[0]],
    );
    await owner.query("UPDATE deviludo.jobs SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE id = $1::uuid", [first.rows[0].id]);
    const recovered = await scheduler.query("SELECT deviludo.recover_expired_jobs()::integer AS count");
    if (Number(recovered.rows[0]?.count ?? 0) < 1) throw new Error("The expired lease was not recovered");

    // Generated art is a durable build gate: a planned item holds the workflow,
    // and the same scheduler sweep advances it exactly once after upload.
    await owner.query(`UPDATE deviludo.jobs
       SET state = 'SUCCEEDED',
           payload = jsonb_set(
             jsonb_set(
               jsonb_set(payload, '{hostAdmissionReservationId}', to_jsonb($3::text), true),
               '{hostAdmissionReservedUnits}', to_jsonb(1800), true
             ),
             '{hostAdmissionStartedAt}', to_jsonb((clock_timestamp() - interval '2 seconds')::text), true
           ),
           receipt = jsonb_build_object(
             'assetManifest', jsonb_build_object(
               'items', jsonb_build_array(
                 jsonb_build_object('assetKey', 'ui/smoke')
               )
             )
           ),
           lease_owner = NULL, lease_token = NULL,
           lease_expires_at = NULL, heartbeat_at = NULL
     WHERE workspace_id = $1::uuid AND id = $2::uuid`, [workspaceIds[0], jobIds[0], `database-smoke:${jobIds[0]}`]);
    const admissionReconciled = await scheduler.query(
      "SELECT deviludo.reconcile_host_admission_events()::integer AS inserted",
    );
    const admissionReplayed = await scheduler.query(
      "SELECT deviludo.reconcile_host_admission_events()::integer AS inserted",
    );
    if (admissionReconciled.rows[0]?.inserted !== 1 || admissionReplayed.rows[0]?.inserted !== 0) {
      throw new Error("Host admission reconciliation is not durable and idempotent");
    }
    const admissionClaim = await scheduler.query(`
      SELECT "workspaceId"::text, "eventId"::text, "reservationId", action,
             "actualUnits", "leaseToken"::text, attempt
        FROM deviludo.claim_host_admission_event(60)
    `);
    if (admissionClaim.rows[0]?.workspaceId !== workspaceIds[0]
      || admissionClaim.rows[0]?.reservationId !== `database-smoke:${jobIds[0]}`
      || admissionClaim.rows[0]?.action !== "SETTLE"
      || admissionClaim.rows[0]?.actualUnits < 1) {
      throw new Error("Host admission settlement event was not leased correctly");
    }
    const admissionCompleted = await scheduler.query(
      "SELECT deviludo.complete_host_admission_event($1::uuid, $2::uuid, $3::uuid) AS completed",
      [workspaceIds[0], admissionClaim.rows[0].eventId, admissionClaim.rows[0].leaseToken],
    );
    if (admissionCompleted.rows[0]?.completed !== true) {
      throw new Error("Host admission settlement event was not completed");
    }
    await owner.query(`UPDATE deviludo.workflow_instances SET state = 'DEVELOPING'
       WHERE workspace_id = $1::uuid AND id = $2::uuid`, [workspaceIds[0], workflowIds[0]]);
    await owner.query(`
      INSERT INTO deviludo.artifacts(
        workspace_id, project_id, workflow_id, producing_job_id, kind,
        bucket, object_key, sha256, size_bytes
      ) VALUES (
        $1::uuid, $2::uuid, $3::uuid, $4::uuid, 'SPECIFICATION',
        'deviludo-artifacts',
        'workspaces/' || $1::text || '/projects/' || $2::text || '/jobs/' || $4::text || '/agent.json',
        'sha256:${"c".repeat(64)}', 128
      )
    `, [workspaceIds[0], projectIds[0], workflowIds[0], jobIds[0]]);
    await owner.query(`
      WITH manifest AS (
        INSERT INTO deviludo.asset_manifests(workspace_id, project_id, workflow_id, auto_generate_enabled)
        VALUES ($1::uuid, $2::uuid, $3::uuid, true)
        RETURNING id
      )
      INSERT INTO deviludo.asset_items(workspace_id, manifest_id, asset_key, asset_type, description)
      SELECT $1::uuid, id, 'ui/smoke', 'icon', 'database smoke asset' FROM manifest
    `, [workspaceIds[0], projectIds[0], workflowIds[0]]);
    // The insertion trigger derives the initial value from the instance model.
    // Exercise the project-level user switch explicitly so this gate contract
    // does not depend on whether CI configured an image-capable Agent runtime.
    await owner.query(`
      UPDATE deviludo.asset_manifests
         SET auto_generate_enabled = true
       WHERE workspace_id = $1::uuid AND workflow_id = $2::uuid
    `, [workspaceIds[0], workflowIds[0]]);
    await scheduler.query("SELECT deviludo.advance_asset_workflows()::integer AS count");
    const held = await owner.query(`
      SELECT workflow.state::text,
             count(job.id) FILTER (
               WHERE job.kind = 'BUILD' AND job.state = 'QUEUED'
             )::integer AS queued_builds
        FROM deviludo.workflow_instances workflow
        LEFT JOIN deviludo.jobs job
          ON job.workspace_id = workflow.workspace_id AND job.workflow_id = workflow.id
       WHERE workflow.workspace_id = $1::uuid AND workflow.id = $2::uuid
       GROUP BY workflow.state
    `, [workspaceIds[0], workflowIds[0]]);
    if (held.rows[0]?.state !== "DEVELOPING" || held.rows[0]?.queued_builds !== 0) {
      throw new Error("A planned image did not hold the artifact build gate");
    }
    await owner.query(`
      UPDATE deviludo.asset_items
         SET status = 'uploaded', bucket = 'deviludo-artifacts',
             object_key = 'workspaces/' || workspace_id::text || '/projects/${projectIds[0]}/assets/ui-smoke.png',
             sha256 = 'sha256:${"b".repeat(64)}', size_bytes = 64
       WHERE workspace_id = $1::uuid AND asset_key = 'ui/smoke'
    `, [workspaceIds[0]]);
    const advanced = await scheduler.query("SELECT deviludo.advance_asset_workflows()::integer AS count");
    if (Number(advanced.rows[0]?.count) !== 1) throw new Error("Uploaded art did not release the artifact build gate");
    const gated = await owner.query(`
      SELECT workflow.state::text,
             count(job.id) FILTER (WHERE job.kind = 'BUILD' AND job.state = 'QUEUED')::integer AS builds
        FROM deviludo.workflow_instances workflow
        LEFT JOIN deviludo.jobs job ON job.workspace_id = workflow.workspace_id AND job.workflow_id = workflow.id
       WHERE workflow.workspace_id = $1::uuid AND workflow.id = $2::uuid
       GROUP BY workflow.state
    `, [workspaceIds[0], workflowIds[0]]);
    if (gated.rows[0]?.state !== "BUILDING" || gated.rows[0]?.builds !== 1) {
      throw new Error("Asset-ready workflow did not enqueue one artifact build");
    }
    const buildAssets = await owner.query(`
      SELECT payload->'assetInputs' AS inputs
        FROM deviludo.jobs
       WHERE workspace_id = $1::uuid AND workflow_id = $2::uuid
         AND kind = 'BUILD' AND state = 'QUEUED'
    `, [workspaceIds[0], workflowIds[0]]);
    const frozenAsset = buildAssets.rows[0]?.inputs?.[0];
    if (buildAssets.rows[0]?.inputs?.length !== 1
      || frozenAsset?.assetKey !== "ui/smoke"
      || frozenAsset?.sha256 !== `sha256:${"b".repeat(64)}`) {
      throw new Error("Artifact build did not freeze the supplied image object");
    }

    // A later art retry reopens the same workflow, supersedes the build made
    // from the older image, and gives the readiness sweep a fresh idempotency
    // scope. This is the user-visible continuation from Art to Build and E2E.
    await owner.query(`
      UPDATE deviludo.asset_items
         SET status = 'failed', bucket = NULL, object_key = NULL, sha256 = NULL,
             size_bytes = NULL, generation_attempt = 3,
             error_message = 'database smoke retry'
       WHERE workspace_id = $1::uuid AND asset_key = 'ui/smoke'
    `, [workspaceIds[0]]);
    await owner.query(`UPDATE deviludo.workflow_instances SET state = 'SUCCEEDED'
      WHERE workspace_id = $1::uuid AND id = $2::uuid`, [workspaceIds[0], workflowIds[0]]);
    const assetRerunKey = `asset-rerun-smoke:${workflowIds[0]}`;
    const { rerun, duplicateRerun } = await requestAssetRerunWithTemporaryImageConfiguration(owner, {
      workspaceId: workspaceIds[0],
      workflowId: workflowIds[0],
      projectId: projectIds[0],
      idempotencyKey: assetRerunKey,
      actorId,
    });
    if (rerun.rows[0]?.accepted !== true || rerun.rows[0]?.queued !== 1 || rerun.rows[0]?.remaining !== 1) {
      throw new Error(`Asset rerun was not accepted atomically: ${JSON.stringify(rerun.rows[0])}`);
    }
    if (duplicateRerun.rows[0]?.accepted !== false || duplicateRerun.rows[0]?.queued !== 0) {
      throw new Error("Duplicate asset rerun was not idempotent");
    }
    const reopened = await owner.query(`
      SELECT workflow.state::text,
             count(job.id) FILTER (WHERE job.kind = 'BUILD' AND job.state = 'CANCELLED')::integer AS cancelled_builds,
             max(item.generation_attempt)::integer AS generation_attempt
        FROM deviludo.workflow_instances workflow
        JOIN deviludo.asset_manifests manifest
          ON manifest.workspace_id = workflow.workspace_id AND manifest.workflow_id = workflow.id
        JOIN deviludo.asset_items item
          ON item.workspace_id = manifest.workspace_id AND item.manifest_id = manifest.id
        LEFT JOIN deviludo.jobs job
          ON job.workspace_id = workflow.workspace_id AND job.workflow_id = workflow.id
       WHERE workflow.workspace_id = $1::uuid AND workflow.id = $2::uuid
       GROUP BY workflow.state
    `, [workspaceIds[0], workflowIds[0]]);
    if (reopened.rows[0]?.state !== "DEVELOPING"
      || reopened.rows[0]?.cancelled_builds !== 1
      || reopened.rows[0]?.generation_attempt !== 0) {
      throw new Error("Asset rerun did not reopen the gate and supersede the old build");
    }
    await owner.query(`
      UPDATE deviludo.asset_items
         SET status = 'uploaded', bucket = 'deviludo-artifacts',
             object_key = 'workspaces/' || workspace_id::text || '/projects/${projectIds[0]}/assets/ui-smoke-rerun.png',
             sha256 = 'sha256:${"a".repeat(64)}', size_bytes = 96,
             error_message = NULL
       WHERE workspace_id = $1::uuid AND asset_key = 'ui/smoke'
    `, [workspaceIds[0]]);
    const readvanced = await scheduler.query("SELECT deviludo.advance_asset_workflows()::integer AS count");
    // This smoke runs against the persistent local database, which may contain
    // other ready workflows from an interrupted earlier run. The scoped query
    // below proves that this workflow advanced exactly once; the global sweep
    // only needs to have made progress.
    if (Number(readvanced.rows[0]?.count) < 1) throw new Error("Regenerated art did not resume the build chain");
    const rebuilt = await owner.query(`
      SELECT count(*) FILTER (WHERE state = 'QUEUED')::integer AS queued,
             bool_or(idempotency_key LIKE '%:artifact:assets:%') AS scoped_to_assets
        FROM deviludo.jobs
       WHERE workspace_id = $1::uuid AND workflow_id = $2::uuid AND kind = 'BUILD'
    `, [workspaceIds[0], workflowIds[0]]);
    if (rebuilt.rows[0]?.queued !== 1 || rebuilt.rows[0]?.scoped_to_assets !== true) {
      throw new Error("Asset rerun did not enqueue one fresh asset-scoped build");
    }
    const steamReleaseId = randomUUID();
    const steamCredentialVersion = randomUUID();
    await owner.query(`
      UPDATE deviludo.jobs
         SET state = 'SUCCEEDED', updated_at = clock_timestamp()
       WHERE workspace_id = $1::uuid AND workflow_id = $2::uuid
         AND kind = 'BUILD' AND state = 'QUEUED'
    `, [workspaceIds[0], workflowIds[0]]);
    await owner.query(`
      UPDATE deviludo.workflow_instances
         SET profile = 'RELEASE', target_platforms = ARRAY['linux','windows','macos']::deviludo.server_os[],
             state = 'RELEASE_APPROVAL_PENDING'
       WHERE workspace_id = $1::uuid AND id = $2::uuid
    `, [workspaceIds[0], workflowIds[0]]);
    const releasePendingRerun = await withWorkspace(api, workspaceIds[0], client => client.query(`
      SELECT deviludo.request_stage_rerun(
        $1::uuid, $2,
        jsonb_build_object('stage', 'BUILD', 'requestedByActorId', $3::text)
      ) AS accepted
    `, [workflowIds[0], `release-pending-build-rerun:${workflowIds[0]}`, actorId]));
    if (releasePendingRerun.rows[0]?.accepted !== true) {
      throw new Error("Build rerun was rejected while the workflow awaited a release decision");
    }
    const releasePendingRebuild = await owner.query(`
      SELECT workflow.state::text,
             count(job.id) FILTER (
               WHERE job.kind = 'BUILD' AND job.state = 'QUEUED'
             )::integer AS queued_builds
        FROM deviludo.workflow_instances workflow
        LEFT JOIN deviludo.jobs job
          ON job.workspace_id = workflow.workspace_id AND job.workflow_id = workflow.id
       WHERE workflow.workspace_id = $1::uuid AND workflow.id = $2::uuid
       GROUP BY workflow.state
    `, [workspaceIds[0], workflowIds[0]]);
    if (releasePendingRebuild.rows[0]?.state !== "BUILDING"
      || releasePendingRebuild.rows[0]?.queued_builds !== 1) {
      throw new Error("Build rerun did not reopen the release-pending workflow");
    }
    await owner.query(`
      UPDATE deviludo.jobs
         SET state = 'SUCCEEDED', updated_at = clock_timestamp()
       WHERE workspace_id = $1::uuid AND workflow_id = $2::uuid
         AND kind = 'BUILD' AND state = 'QUEUED'
    `, [workspaceIds[0], workflowIds[0]]);
    await owner.query(`
      UPDATE deviludo.workflow_instances
         SET state = 'RELEASE_APPROVAL_PENDING'
       WHERE workspace_id = $1::uuid AND id = $2::uuid
    `, [workspaceIds[0], workflowIds[0]]);
    await owner.query(`
      INSERT INTO deviludo.artifacts(
        workspace_id, project_id, workflow_id, kind, target_platform,
        bucket, object_key, sha256, size_bytes, producing_job_id
      )
      SELECT $1::uuid, $2::uuid, $3::uuid, 'BUILD', platform,
             'deviludo-artifacts',
             'workspaces/' || $1::text || '/projects/' || $2::text || '/jobs/release-smoke/build-' || platform::text || '.tar.gz',
             'sha256:' || repeat(CASE platform
               WHEN 'linux' THEN 'd' WHEN 'windows' THEN 'e' ELSE 'f' END, 64),
             256,
             (SELECT id FROM deviludo.jobs
               WHERE workspace_id = $1::uuid AND workflow_id = $3::uuid
                 AND kind = 'BUILD' AND state = 'SUCCEEDED'
               ORDER BY updated_at DESC LIMIT 1)
        FROM unnest(ARRAY['linux','windows','macos']::deviludo.server_os[]) platform
    `, [workspaceIds[0], projectIds[0], workflowIds[0]]);
    await owner.query(`
      INSERT INTO deviludo.workspace_steam_settings(
        workspace_id, builder_username, credential_secret_ref, credential_mask,
        credential_fingerprint, credential_version, updated_by_actor_id
      ) VALUES ($1::uuid, 'deviludo_builder',
        'vault://workspaces/' || $1::text || '/steam/build-token/versions/' || $3::text,
        'tok********smoke', 'sha256:123456789abc', $3::uuid, $2::uuid)
    `, [workspaceIds[0], actorId, steamCredentialVersion]);
    await owner.query(`
      INSERT INTO deviludo.project_steam_settings(
        workspace_id, project_id, app_id, depot_linux, depot_windows, depot_macos,
        test_branch, updated_by_actor_id
      ) VALUES ($1::uuid, $3::uuid, 1000, 1001, 1002, 1003, 'deviludo-test', $2::uuid)
    `, [workspaceIds[0], actorId, projectIds[0]]);
    await owner.query(`
      INSERT INTO deviludo.steam_releases(
        workspace_id, id, project_id, workflow_id, version, release_number, channel,
        target_branch, app_id, depot_linux, depot_windows, depot_macos,
        project_settings_revision, builder_username, credential_secret_ref,
        credential_revision, build_digests, requested_by_actor_id
      ) VALUES ($1::uuid, $4::uuid, $3::uuid, $5::uuid, '1.0.0', 1, 'TEST',
        'deviludo-test', 1000, 1001, 1002, 1003, 1, 'deviludo_builder',
        'vault://workspaces/' || $1::text || '/steam/build-token/versions/' || $6::text,
        1, jsonb_build_object('linux', 'sha256:${"d".repeat(64)}',
          'windows', 'sha256:${"e".repeat(64)}', 'macos', 'sha256:${"f".repeat(64)}'), $2::uuid)
    `, [workspaceIds[0], actorId, projectIds[0], steamReleaseId, workflowIds[0], steamCredentialVersion]);
    const releaseAccepted = await withWorkspace(api, workspaceIds[0], client => client.query(
      "SELECT deviludo.start_steam_release($1::uuid, $2::uuid, $3, jsonb_build_object('requestedByActorId', $4::text)) AS accepted",
      [workflowIds[0], steamReleaseId, `release-smoke:${workflowIds[0]}`, actorId],
    ));
    if (releaseAccepted.rows[0]?.accepted !== true) throw new Error("Release approval signal was not accepted");
    const approvedRelease = await owner.query(`
      SELECT workflow.state::text,
             count(job.id) FILTER (WHERE job.kind = 'STEAM_PUBLISH' AND job.state = 'QUEUED')::integer AS publishes
        FROM deviludo.workflow_instances workflow
        LEFT JOIN deviludo.jobs job ON job.workspace_id = workflow.workspace_id AND job.workflow_id = workflow.id
       WHERE workflow.workspace_id = $1::uuid AND workflow.id = $2::uuid
       GROUP BY workflow.state
    `, [workspaceIds[0], workflowIds[0]]);
    if (approvedRelease.rows[0]?.state !== "STEAM_PUBLISHING" || approvedRelease.rows[0]?.publishes !== 1) {
      throw new Error("Human release approval did not enqueue exactly one Steam publish");
    }

    const failedUploadKey = `workspaces/${workspaceIds[0]}/projects/${projectIds[0]}/jobs/${jobIds[0]}/failed-upload.json`;
    await owner.query(
      "UPDATE deviludo.jobs SET state = 'FAILED', updated_at = clock_timestamp() WHERE workspace_id = $1::uuid AND id = $2::uuid",
      [workspaceIds[0], jobIds[0]],
    );
    await withWorkspace(sandbox, workspaceIds[0], client => client.query(
      `INSERT INTO deviludo.pending_object_uploads(
         workspace_id, job_id, bucket, object_key, kind, sha256, size_bytes, cleanup_after
       ) VALUES(
         $1::uuid, $2::uuid, 'deviludo-artifacts', $3, 'PROJECT_DOCUMENT', $4,
         128, clock_timestamp() - interval '1 minute'
       )`,
      [workspaceIds[0], jobIds[0], failedUploadKey, `sha256:${"8".repeat(64)}`],
    ));
    const failedUploads = await scheduler.query(
      "SELECT deviludo.reconcile_expired_uploads(25) AS enqueued",
    );
    if (Number(failedUploads.rows[0]?.enqueued) !== 1) {
      throw new Error("Failed authorized upload was not reconciled");
    }
    const pendingAfterReconcile = await owner.query(
      "SELECT 1 FROM deviludo.pending_object_uploads WHERE workspace_id = $1::uuid AND object_key = $2",
      [workspaceIds[0], failedUploadKey],
    );
    const queuedFailedUpload = await owner.query(
      "SELECT 1 FROM deviludo.object_cleanup_queue WHERE workspace_id = $1::uuid AND object_key = $2",
      [workspaceIds[0], failedUploadKey],
    );
    if (pendingAfterReconcile.rowCount || queuedFailedUpload.rowCount !== 1) {
      throw new Error("Failed upload cleanup was not durably queued");
    }

    const expiredArtifactId=randomUUID();
    const expiredArtifactKey=`workspaces/${workspaceIds[0]}/projects/${projectIds[0]}/jobs/${jobIds[0]}/retention-smoke-build.zip`;
    await withWorkspace(sandbox,workspaceIds[0],client=>client.query(`INSERT INTO deviludo.pending_object_uploads(
      workspace_id,job_id,bucket,object_key,kind,sha256,size_bytes,cleanup_after
    ) VALUES($1::uuid,$2::uuid,'deviludo-artifacts',$3,'BUILD',$4,512,clock_timestamp()+interval '1 day')`,
    [workspaceIds[0],jobIds[0],expiredArtifactKey,`sha256:${"9".repeat(64)}`]));
    await withWorkspace(sandbox,workspaceIds[0],client=>client.query(`INSERT INTO deviludo.artifacts(
      workspace_id,id,project_id,workflow_id,kind,bucket,object_key,sha256,size_bytes,created_at
    ) VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,'BUILD','deviludo-artifacts',$5,$6,512,clock_timestamp()-interval '40 days')`,
    [workspaceIds[0],expiredArtifactId,projectIds[0],workflowIds[0],expiredArtifactKey,`sha256:${"9".repeat(64)}`]));
    const completedUploadPending=await owner.query("SELECT 1 FROM deviludo.pending_object_uploads WHERE workspace_id=$1::uuid AND object_key=$2",[workspaceIds[0],expiredArtifactKey]);
    if(completedUploadPending.rowCount)throw new Error("Completed artifact retained its pending upload record");
    const retention=await scheduler.query("SELECT deviludo.enqueue_expired_artifacts(30,25) AS enqueued");
    if(Number(retention.rows[0]?.enqueued)<1)throw new Error("Expired downloadable artifact was not queued for deletion");
    const deleting=await owner.query("SELECT state FROM deviludo.artifacts WHERE workspace_id=$1::uuid AND id=$2::uuid",[workspaceIds[0],expiredArtifactId]);
    if(deleting.rows[0]?.state!=="DELETING")throw new Error("Expired artifact state was not persisted");
    let expiredObjectCompleted=false;
    for(let attempt=0;attempt<10&&!expiredObjectCompleted;attempt+=1){const claim=await scheduler.query(`SELECT "workspaceId"::text,bucket,"objectKey","leaseToken"::text FROM deviludo.claim_object_cleanup(60)`);const row=claim.rows[0];if(!row)break;const completed=await scheduler.query("SELECT deviludo.complete_object_cleanup($1::uuid,$2::text,$3::text,$4::uuid) completed",[row.workspaceId,row.bucket,row.objectKey,row.leaseToken]);if(completed.rows[0]?.completed!==true)throw new Error("Retention object cleanup lease did not settle");expiredObjectCompleted=row.objectKey===expiredArtifactKey;}
    const deleted=await owner.query("SELECT state FROM deviludo.artifacts WHERE workspace_id=$1::uuid AND id=$2::uuid",[workspaceIds[0],expiredArtifactId]);
    if(!expiredObjectCompleted||deleted.rows[0]?.state!=="DELETED")throw new Error("Deleted artifact lifecycle state was not persisted");

    console.log(JSON.stringify({
      database: "verified",
      forcedRlsTables: forcedNames.size,
      securityDefiners: definers.rows.length,
      coreAccountTables: 0,
      sourceOutboxReplay: true,
      concurrentClaims: claims.length,
      repeatedClaimRejected: true,
      expiredLeaseRecovered: true,
      hostAdmissionOutbox: true,
      failedUploadLifecycle: true,
      artifactRetentionLifecycle: true,
      assetReadinessGate: true,
      assetRerunContinuation: true,
      releasePendingStageRerun: true,
      humanReleaseApproval: true,
      localGitCommitLease: true,
    }));
  } finally {
    await cleanup(owner, workspaceIds).catch(() => undefined);
    await Promise.all([owner.end(), api.end(), sandbox.end(), scheduler.end()]);
  }
}

async function assertFunctionPrivilege(owner, role, signature, expected) {
  const result = await owner.query("SELECT has_function_privilege($1, $2, 'EXECUTE') AS allowed", [role, signature]);
  if (result.rows[0]?.allowed !== expected) throw new Error(`${role} has an invalid privilege on ${signature}`);
}

function rolePool(connectionString, role) {
  return new pg.Pool({ connectionString, max: 4, options: `-c role=${role}` });
}

async function claim(pool, executorId) {
  const result = await pool.query(
    `SELECT "jobId"::text AS "jobId", "workspaceId"::text AS "workspaceId", "leaseToken"::text AS "leaseToken"
       FROM deviludo.claim_job($1, 'CORE', 60)`,
    [executorId],
  );
  return result.rows[0] ?? null;
}

async function withWorkspace(pool, workspaceId, callback) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [workspaceId]);
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function requestAssetRerunWithTemporaryImageConfiguration(owner, input) {
  const client = await owner.connect();
  let roleChanged = false;
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [input.workspaceId]);
    const current = await client.query(`
      SELECT agent_runtime::text, image_model
        FROM deviludo.instance_agent_settings
       WHERE singleton = true
       FOR UPDATE
    `);
    const inserted = current.rowCount === 0;
    const patchedClaude = current.rows[0]?.agent_runtime === "CLAUDE_CODE"
      && current.rows[0]?.image_model === null;
    if (inserted) {
      await client.query(`
        INSERT INTO deviludo.instance_agent_settings(
          singleton, agent_runtime, base_url, primary_model, model_overrides, image_model,
          credential_secret_ref, api_key_mask, api_key_fingerprint, credential_version, updated_by
        ) VALUES (
          true, 'CODEX_CLI', 'https://chatgpt.com/backend-api/codex', 'database-smoke',
          '{"intent":null,"analysis":null,"design":null,"development":null,"test":null}'::jsonb, NULL,
          'vault://instance/agent-runtime/api-key/versions/' || $1::text,
          'db-********test', 'sha256:000000000000', $1::uuid, 'database smoke'
        )
      `, [randomUUID()]);
    } else if (patchedClaude) {
      await client.query(`
        UPDATE deviludo.instance_agent_settings
           SET image_model = 'database-smoke-image'
         WHERE singleton = true
      `);
    }

    await client.query("SET LOCAL ROLE deviludo_api");
    roleChanged = true;
    const rerun = await client.query(`
      SELECT accepted, queued, remaining
        FROM deviludo.request_asset_rerun(
          $1::uuid, $2::uuid, $3,
          jsonb_build_object('requestedBy', 'database smoke', 'requestedByActorId', $4::text)
        )
    `, [input.workflowId, input.projectId, input.idempotencyKey, input.actorId]);
    const duplicateRerun = await client.query(`
      SELECT accepted, queued, remaining
        FROM deviludo.request_asset_rerun($1::uuid, $2::uuid, $3, '{}'::jsonb)
    `, [input.workflowId, input.projectId, input.idempotencyKey]);
    await client.query("RESET ROLE");
    roleChanged = false;

    if (inserted) {
      await client.query("DELETE FROM deviludo.instance_agent_settings WHERE singleton = true");
    } else if (patchedClaude) {
      await client.query(`
        UPDATE deviludo.instance_agent_settings
           SET image_model = NULL
         WHERE singleton = true AND image_model = 'database-smoke-image'
      `);
    }
    await client.query("COMMIT");
    return { rerun, duplicateRerun };
  } catch (error) {
    if (roleChanged) await client.query("RESET ROLE").catch(() => undefined);
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function expectRlsRejection(operation) {
  try {
    await operation();
  } catch (error) {
    if (error?.code === "42501") return;
    throw error;
  }
  throw new Error("RLS accepted a forbidden write");
}

async function cleanup(owner, workspaceIds) {
  for (const table of [
    "executor_receipts", "artifact_inputs", "artifacts", "operation_receipts", "external_signals",
    "steam_releases",
    "asset_items", "asset_manifests",
    "workflow_e2e_goal_revisions", "implementation_change_requests",
    "workflow_events", "job_progress_events", "jobs",
    "workspace_claim_fairness", "conversation_messages",
    "project_conversations", "agent_installations",
    "project_source_revisions", "project_document_revisions", "project_documents",
    "workflow_instances", "project_creation_receipts", "projects",
  ]) {
    await owner.query(`DELETE FROM deviludo.${table} WHERE workspace_id = ANY($1::uuid[])`, [workspaceIds]);
  }
  await owner.query("DELETE FROM deviludo.workspaces WHERE id = ANY($1::uuid[])", [workspaceIds]);
}
