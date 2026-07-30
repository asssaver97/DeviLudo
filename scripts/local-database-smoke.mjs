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
  const userId = randomUUID();
  try {
    const forced = await owner.query(`
      SELECT c.relname
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'deviludo' AND c.relrowsecurity AND c.relforcerowsecurity
    `);
    const requiredRls = [
      "workspaces", "workspace_memberships", "workspace_invitations", "projects",
      "project_conversations", "conversation_messages", "agent_installations",
      "workflow_instances", "workflow_events", "jobs", "external_signals",
      "job_progress_events", "job_guidance_messages", "operation_receipts",
      "workspace_claim_fairness", "artifacts", "artifact_inputs",
      "executor_receipts", "project_creation_receipts",
    ];
    const forcedNames = new Set(forced.rows.map(row => row.relname));
    if (requiredRls.some(table => !forcedNames.has(table))) throw new Error("A workspace table is missing forced RLS");
    const roles = await owner.query(`
      SELECT rolname, rolbypassrls, rolcanlogin FROM pg_roles
       WHERE rolname IN ('deviludo_api','deviludo_scheduler','deviludo_sandbox','deviludo_claim_executor')
    `);
    if (roles.rows.length !== 4 || roles.rows.some(row => row.rolcanlogin)) throw new Error("A service role can log in directly");
    const claimRole = roles.rows.find(row => row.rolname === "deviludo_claim_executor");
    if (!claimRole?.rolbypassrls || roles.rows.some(row => row.rolname !== "deviludo_claim_executor" && row.rolbypassrls)) {
      throw new Error("The RLS bypass privilege is not isolated to the claim executor");
    }
    const publicTables = await owner.query(`
      SELECT table_name, privilege_type FROM information_schema.table_privileges
       WHERE table_schema = 'deviludo' AND grantee = 'PUBLIC'
    `);
    const publicRoutines = await owner.query(`
      SELECT routine_name, privilege_type FROM information_schema.routine_privileges
       WHERE specific_schema = 'deviludo' AND grantee = 'PUBLIC'
    `);
    if (publicTables.rowCount || publicRoutines.rowCount) throw new Error("PUBLIC retained Deviludo data-plane privileges");
    const definers = await owner.query(`
      SELECT function.proname, owner.rolname AS owner
        FROM pg_proc function
        JOIN pg_namespace namespace ON namespace.oid = function.pronamespace
        JOIN pg_roles owner ON owner.oid = function.proowner
       WHERE namespace.nspname = 'deviludo' AND function.prosecdef
       ORDER BY function.proname
    `);
    const expectedDefiners = [
      "accept_workspace_invitation", "claim_job", "cleanup_expired_auth_state",
      "list_workspaces", "read_project_creation_receipt", "recover_expired_jobs",
      "schedule_idle_project_document_maintenance",
    ];
    if (JSON.stringify(definers.rows.map(row => row.proname)) !== JSON.stringify(expectedDefiners)
      || definers.rows.some(row => row.owner !== "deviludo_claim_executor")) {
      throw new Error("A SECURITY DEFINER function has an unexpected owner or scope");
    }
    const capacityFunction = await owner.query(`
      SELECT function.prosecdef
        FROM pg_proc function JOIN pg_namespace namespace ON namespace.oid = function.pronamespace
       WHERE namespace.nspname = 'deviludo' AND function.proname = 'reconcile_p0_capacity'
    `);
    if (capacityFunction.rows[0]?.prosecdef !== false) throw new Error("Capacity reconciliation is still privileged");
    await assertFunctionPrivilege(owner, "deviludo_claim_executor", "deviludo.current_user_id()", true);
    await assertFunctionPrivilege(owner, "deviludo_api", "deviludo.cleanup_expired_auth_state()", false);
    await assertFunctionPrivilege(owner, "deviludo_scheduler", "deviludo.claim_job(text,deviludo.server_pool_kind,integer)", false);
    await assertFunctionPrivilege(owner, "deviludo_scheduler", "deviludo.schedule_idle_project_document_maintenance(integer,integer)", true);
    await assertFunctionPrivilege(owner, "deviludo_api", "deviludo.schedule_idle_project_document_maintenance(integer,integer)", false);
    await assertFunctionPrivilege(owner, "deviludo_sandbox", "deviludo.list_workspaces()", false);
    await scheduler.query("SELECT deviludo.reconcile_p0_capacity()");
    await expectPermissionRejection(() => api.query("SELECT deviludo.cleanup_expired_auth_state()"));
    await expectPermissionRejection(() => scheduler.query("SELECT * FROM deviludo.claim_job('forbidden', 'CORE', 60)"));
    await expectPermissionRejection(() => sandbox.query("SELECT * FROM deviludo.list_workspaces()"));

    await owner.query(
      "INSERT INTO deviludo.workspaces(id, name) VALUES ($1::uuid, 'database-smoke-a'), ($2::uuid, 'database-smoke-b')",
      workspaceIds,
    );
    await owner.query(
      `INSERT INTO deviludo.users(id, username, password_hash) VALUES ($1::uuid, $2, '$argon2id$database-smoke')`,
      [userId, `database-smoke-${userId}`],
    );
    await owner.query(
      "INSERT INTO deviludo.workspace_memberships(workspace_id, user_id, role) VALUES ($1::uuid, $2::uuid, 'OWNER')",
      [workspaceIds[0], userId],
    );
    const visibleWorkspaces = await withUser(api, userId, client => client.query("SELECT id::text FROM deviludo.list_workspaces()"));
    if (visibleWorkspaces.rows.length !== 1 || visibleWorkspaces.rows[0]?.id !== workspaceIds[0]) {
      throw new Error("Workspace projection did not honor user membership");
    }
    await expectRlsRejection(() => api.query(
      "INSERT INTO deviludo.projects(workspace_id, id, name) VALUES ($1::uuid, $2::uuid, 'missing-context')",
      [workspaceIds[0], randomUUID()],
    ));
    const rlsClient = await api.connect();
    try {
      await rlsClient.query("BEGIN");
      await rlsClient.query("SELECT set_config('app.workspace_id', $1, true)", [workspaceIds[0]]);
      await rlsClient.query(
        "INSERT INTO deviludo.projects(workspace_id, id, name) VALUES ($1::uuid, $2::uuid, 'same-context')",
        [workspaceIds[0], randomUUID()],
      );
      await expectRlsRejection(() => rlsClient.query(
        "INSERT INTO deviludo.projects(workspace_id, id, name) VALUES ($1::uuid, $2::uuid, 'cross-context')",
        [workspaceIds[1], randomUUID()],
      ));
      await rlsClient.query("ROLLBACK");
    } finally {
      rlsClient.release();
    }

    const runtime = await owner.query("SELECT image_reference FROM deviludo.runtime_images WHERE runtime_key = 'AGENT_CLAUDE'");
    if (!runtime.rows[0]?.image_reference) throw new Error("Local Agent runtime digest is missing");
    for (let index = 0; index < 2; index += 1) {
      await owner.query(
        `INSERT INTO deviludo.projects(workspace_id, id, name) VALUES ($1::uuid, $2::uuid, $3)`,
        [workspaceIds[index], projectIds[index], `database-smoke-${index}`],
      );
      await owner.query(
        `INSERT INTO deviludo.workflow_instances(workspace_id, id, project_id, profile, target_platforms, state)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'VALIDATE', ARRAY['macos']::deviludo.server_os[], 'AGENT_RUNNING')`,
        [workspaceIds[index], workflowIds[index], projectIds[index]],
      );
      await owner.query(
        `INSERT INTO deviludo.jobs(
           workspace_id, id, workflow_id, project_id, kind, pool_kind,
           required_capabilities, exclusive, runtime_image, output_contract, idempotency_key
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, $4::uuid, 'AGENT_GENERATION', 'CORE',
           ARRAY['MICROVM','NETWORK_POLICY'], false, $5,
           '{"kinds":["SOURCE","SPECIFICATION"],"maxBytes":134217728}'::jsonb, $6
         )`,
        [workspaceIds[index], jobIds[index], workflowIds[index], projectIds[index], runtime.rows[0].image_reference, `database-smoke:${jobIds[index]}`],
      );
    }
    const receiptKey = `database-smoke:${randomUUID()}`;
    await owner.query(
      `INSERT INTO deviludo.project_creation_receipts(idempotency_key, operation_kind, workspace_id, project_id)
       VALUES ($1, 'PROJECT', $2::uuid, $3::uuid)`,
      [receiptKey, workspaceIds[0], projectIds[0]],
    );
    const receipt = await withUser(api, userId, client => client.query(
      "SELECT workspace_id::text, project_id::text FROM deviludo.read_project_creation_receipt($1)",
      [receiptKey],
    ));
    if (receipt.rows[0]?.workspace_id !== workspaceIds[0] || receipt.rows[0]?.project_id !== projectIds[0]) {
      throw new Error("Project creation receipt projection could not execute under the restricted owner");
    }

    const executorIds = [`database-smoke:${randomUUID()}`, `database-smoke:${randomUUID()}`];
    const claims = await Promise.all(executorIds.map(executorId => claim(sandbox, executorId)));
    if (claims.some(claimed => !claimed) || new Set(claims.map(claimed => claimed.workspaceId)).size !== 2) {
      throw new Error("Concurrent claims were not distributed across the two workspaces");
    }
    if (await claim(sandbox, executorIds[0])) throw new Error("An executor obtained a duplicate active lease");

    const first = await owner.query(
      "SELECT workspace_id::text, id::text, lease_token::text, fencing_token::text FROM deviludo.jobs WHERE lease_owner = $1",
      [executorIds[0]],
    );
    const firstJob = first.rows[0];
    const wrongFenceAccepted = await withWorkspace(sandbox, firstJob.workspace_id, client => client.query(
      "SELECT deviludo.fail_job($1::uuid, $2::uuid, $3::bigint, 'wrong fence') AS accepted",
      [firstJob.id, randomUUID(), firstJob.fencing_token],
    ));
    if (wrongFenceAccepted.rows[0]?.accepted !== false) throw new Error("A completion with the wrong lease token was accepted");
    await owner.query("UPDATE deviludo.jobs SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE id = $1::uuid", [firstJob.id]);
    const recovered = await scheduler.query("SELECT deviludo.recover_expired_jobs()::integer AS count");
    if (Number(recovered.rows[0]?.count ?? 0) < 1) throw new Error("The expired lease was not recovered");

    const second = await owner.query(
      "SELECT workspace_id::text, workflow_id::text FROM deviludo.jobs WHERE lease_owner = $1",
      [executorIds[1]],
    );
    const cancelled = await withWorkspace(api, second.rows[0].workspace_id, client => client.query(
      "SELECT deviludo.accept_workflow_signal($1::uuid, 'CANCEL_REQUESTED', $2, '{}'::jsonb) AS accepted",
      [second.rows[0].workflow_id, `database-smoke-cancel:${randomUUID()}`],
    ));
    if (cancelled.rows[0]?.accepted !== true) throw new Error("Cancellation signal was rejected");
    const states = await owner.query(
      "SELECT state::text, count(*)::integer AS count FROM deviludo.jobs WHERE workspace_id = ANY($1::uuid[]) GROUP BY state ORDER BY state",
      [workspaceIds],
    );
    if (!states.rows.some(row => row.state === "RETRY") || !states.rows.some(row => row.state === "CANCELLED")) {
      throw new Error("Lease recovery and cancellation did not fence the jobs correctly");
    }
    await verifyAutomaticE2eProductRepair(owner);
    console.log(JSON.stringify({
      database: "verified",
      forcedRlsTables: forcedNames.size,
      securityDefiners: definers.rows.length,
      publicPrivileges: 0,
      concurrentClaims: claims.length,
      repeatedClaimRejected: true,
      expiredLeaseRecovered: true,
      cancellationFenced: true,
      e2eProductAutoRepair: true,
    }));
  } finally {
    await cleanup(owner, workspaceIds).catch(() => undefined);
    await owner.query("DELETE FROM deviludo.users WHERE id = $1::uuid", [userId]).catch(() => undefined);
    await Promise.all([owner.end(), api.end(), sandbox.end(), scheduler.end()]);
  }
}

async function verifyAutomaticE2eProductRepair(owner) {
  const client = await owner.connect();
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const workflowId = randomUUID();
  const agentJobId = randomUUID();
  const buildJobId = randomUUID();
  const e2eJobId = randomUUID();
  const leaseToken = randomUUID();
  try {
    await client.query("BEGIN");
    const runtimes = await client.query(`
      SELECT runtime_key, image_reference
        FROM deviludo.runtime_images
       WHERE runtime_key IN ('AGENT_CLAUDE', 'GODOT_BUILDER', 'E2E_MACOS')
    `);
    const runtime = Object.fromEntries(runtimes.rows.map(row => [row.runtime_key, row.image_reference]));
    if (!runtime.AGENT_CLAUDE || !runtime.GODOT_BUILDER || !runtime.E2E_MACOS) {
      throw new Error("Automatic E2E repair smoke requires the three verified local runtime images");
    }
    const credentialVersion = randomUUID();
    await client.query(`
      INSERT INTO deviludo.instance_agent_settings(
        agent_runtime, base_url, primary_model, opus_model, sonnet_model, haiku_model,
        subagent_model, credential_secret_ref, api_key_mask, api_key_fingerprint,
        credential_version, updated_by
      ) VALUES (
        'CLAUDE_CODE', 'https://fixture.invalid', 'fixture', 'fixture', 'fixture', 'fixture',
        'fixture', $1, 'sk-********test', 'sha256:aaaaaaaaaaaa', $2::uuid, 'database-smoke'
      ) ON CONFLICT (singleton) DO NOTHING
    `, [`vault://instance/agent-runtime/api-key/versions/${credentialVersion}`, credentialVersion]);
    await client.query("INSERT INTO deviludo.workspaces(id, name) VALUES ($1::uuid, 'e2e-auto-repair-smoke')", [workspaceId]);
    await client.query("INSERT INTO deviludo.projects(workspace_id, id, name) VALUES ($1::uuid, $2::uuid, 'e2e-auto-repair-smoke')", [workspaceId, projectId]);
    await client.query(`
      INSERT INTO deviludo.workflow_instances(workspace_id, id, project_id, profile, target_platforms, state)
      VALUES ($1::uuid, $2::uuid, $3::uuid, 'VALIDATE', ARRAY['macos']::deviludo.server_os[], 'E2E_TESTING')
    `, [workspaceId, workflowId, projectId]);
    await client.query(`
      INSERT INTO deviludo.jobs(
        workspace_id, id, workflow_id, project_id, kind, pool_kind, target_operating_system, required_capabilities,
        exclusive, runtime_image, output_contract, state, idempotency_key
      ) VALUES
        ($1::uuid, $4::uuid, $2::uuid, $3::uuid, 'AGENT_GENERATION', 'CORE', NULL, ARRAY['MICROVM','NETWORK_POLICY'],
         false, $7, '{"kinds":["SOURCE","SPECIFICATION"],"maxBytes":1073741824}'::jsonb, 'SUCCEEDED', 'e2e-repair-smoke:agent'),
        ($1::uuid, $5::uuid, $2::uuid, $3::uuid, 'ARTIFACT_BUILD', 'CORE', NULL, ARRAY['RESTRICTED_CONTAINER','BUILD_TOOLCHAIN'],
         false, $8, '{"kinds":["BUILD"],"maxBytes":1073741824}'::jsonb, 'SUCCEEDED', 'e2e-repair-smoke:build'),
        ($1::uuid, $6::uuid, $2::uuid, $3::uuid, 'E2E_TEST', 'E2E_MACOS', 'macos', ARRAY['GAME_RUNTIME','TRUSTED_REIMAGE'],
         true, $9, '{"kinds":["E2E_REPORT"],"maxBytes":1048576}'::jsonb, 'QUEUED', 'e2e-repair-smoke:e2e')
    `, [workspaceId, workflowId, projectId, agentJobId, buildJobId, e2eJobId, runtime.AGENT_CLAUDE, runtime.GODOT_BUILDER, runtime.E2E_MACOS]);
    await client.query(`
      UPDATE deviludo.jobs
         SET state = 'RUNNING', lease_owner = 'database-smoke:e2e',
             lease_token = $2::uuid, lease_expires_at = clock_timestamp() + interval '5 minutes',
             fencing_token = 1, attempt = 1
       WHERE workspace_id = $1::uuid AND id = $3::uuid
    `, [workspaceId, leaseToken, e2eJobId]);
    const objectPrefix = `workspaces/${workspaceId}/projects/${projectId}`;
    await client.query(`
      INSERT INTO deviludo.artifacts(
        workspace_id, project_id, workflow_id, producing_job_id, kind, target_platform,
        bucket, object_key, sha256, size_bytes
      ) VALUES
        ($1::uuid, $2::uuid, $3::uuid, NULL, 'SPECIFICATION', NULL,
         'deviludo-artifacts', $6, 'sha256:${"1".repeat(64)}', 128),
        ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'SOURCE', NULL,
         'deviludo-artifacts', $7, 'sha256:${"2".repeat(64)}', 1024),
        ($1::uuid, $2::uuid, $3::uuid, $5::uuid, 'BUILD', 'macos',
         'deviludo-artifacts', $8, 'sha256:${"3".repeat(64)}', 2048)
    `, [workspaceId, projectId, workflowId, agentJobId, buildJobId,
      `${objectPrefix}/specification.json`, `${objectPrefix}/jobs/${agentJobId}/source.tar.gz`, `${objectPrefix}/jobs/${buildJobId}/godot-build-macos.tar.gz`]);
    const e2eReportKey = `${objectPrefix}/jobs/${e2eJobId}/e2e-report-macos.json`;
    const receipt = {
      schemaVersion: "deviludo.e2e-receipt.v1",
      execution: {
        schemaVersion: "deviludo.godot-guest-report.v1",
        action: "test",
        outcome: "FAILED",
        failureDomain: "PRODUCT",
        summary: "The game crashed while entering its first playable level",
        guest: { exitCode: 1, stderr: "Invalid access in player controller" },
      },
    };
    const executorReceipt = {
      schemaVersion: "deviludo.executor-receipt.v2",
      executorId: "database-smoke-e2e-node",
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      exitCode: 0,
      simulated: false,
      outputObjects: [{
        kind: "E2E_REPORT", targetPlatform: "macos", bucket: "deviludo-artifacts",
        key: e2eReportKey, sha256: `sha256:${"4".repeat(64)}`, sizeBytes: 512,
      }],
      signature: "s".repeat(64),
    };
    const completed = await client.query(`
      SELECT deviludo.complete_job(
        $1::uuid, $2::uuid, 1, 1, $3::jsonb, $4::jsonb,
        'trusted-before-reimage-proof', 'trusted-workspace-cleanup-proof', 'trusted-after-reimage-proof'
      ) AS accepted
    `, [e2eJobId, leaseToken, JSON.stringify(receipt), JSON.stringify(executorReceipt)]);
    if (completed.rows[0]?.accepted !== true) throw new Error("E2E product failure completion was rejected");
    const result = await client.query(`
      SELECT workflow.state::text AS workflow_state,
             failed.state::text AS failed_state,
             failed.last_error,
             repair.state::text AS repair_state,
             repair.payload,
             array_agg(artifact.kind::text ORDER BY artifact.kind::text) AS input_kinds
        FROM deviludo.workflow_instances workflow
        JOIN deviludo.jobs failed ON failed.workspace_id = workflow.workspace_id AND failed.id = $2::uuid
        JOIN deviludo.jobs repair ON repair.workspace_id = workflow.workspace_id
          AND repair.workflow_id = workflow.id AND repair.kind = 'AGENT_GENERATION'
          AND repair.payload ? 'repairFromE2eJobId'
        JOIN deviludo.artifact_inputs input ON input.workspace_id = repair.workspace_id AND input.job_id = repair.id
        JOIN deviludo.artifacts artifact ON artifact.workspace_id = input.workspace_id AND artifact.id = input.artifact_id
       WHERE workflow.workspace_id = $1::uuid AND workflow.id = $3::uuid
       GROUP BY workflow.state, failed.state, failed.last_error, repair.state, repair.payload
    `, [workspaceId, e2eJobId, workflowId]);
    const row = result.rows[0];
    if (row?.workflow_state !== "AGENT_RUNNING" || row.failed_state !== "FAILED"
      || !String(row.last_error).startsWith("E2E_PRODUCT:") || row.repair_state !== "QUEUED"
      || row.payload?.repairFromE2eJobId !== e2eJobId
      || JSON.stringify(row.input_kinds) !== JSON.stringify(["E2E_REPORT", "SOURCE", "SPECIFICATION"])) {
      throw new Error("E2E product failure did not enqueue an isolated Agent repair with all immutable inputs");
    }
    await client.query("ROLLBACK");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
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

async function withUser(pool, userId, callback) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.user_id', $1, true)", [userId]);
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

async function expectRlsRejection(operation) {
  try {
    await operation();
  } catch (error) {
    if (error?.code === "42501") return;
    throw error;
  }
  throw new Error("RLS accepted a forbidden write");
}

async function expectPermissionRejection(operation) {
  try {
    await operation();
  } catch (error) {
    if (error?.code === "42501") return;
    throw error;
  }
  throw new Error("A service role executed a forbidden function");
}

async function cleanup(owner, workspaceIds) {
  for (const table of [
    "executor_receipts", "artifact_inputs", "artifacts", "operation_receipts", "external_signals",
    "workflow_events", "jobs", "workspace_claim_fairness", "conversation_messages",
    "project_conversations", "agent_installations", "workflow_instances", "project_creation_receipts",
    "projects", "workspace_invitations", "workspace_memberships",
  ]) {
    await owner.query(`DELETE FROM deviludo.${table} WHERE workspace_id = ANY($1::uuid[])`, [workspaceIds]);
  }
  await owner.query("DELETE FROM deviludo.workspaces WHERE id = ANY($1::uuid[])", [workspaceIds]);
}
