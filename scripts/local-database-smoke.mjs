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
      "workspaces", "projects", "project_source_revisions", "project_source_ready_outbox",
      "project_conversations", "conversation_messages", "agent_installations",
      "workflow_instances", "workflow_events", "jobs", "external_signals",
      "job_progress_events", "job_guidance_messages", "operation_receipts",
      "workspace_claim_fairness", "artifacts", "artifact_inputs", "executor_receipts",
      "project_creation_receipts",
    ];
    const forcedNames = new Set(forced.rows.map(row => row.relname));
    if (requiredRls.some(table => !forcedNames.has(table))) throw new Error("A workspace table is missing forced RLS");

    const accountTables = await owner.query(`
      SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'deviludo'
         AND table_name = ANY(ARRAY['users','sessions','workspace_memberships','workspace_invitations',
           'github_oauth_flows','project_repository_connections','project_github_permissions'])
    `);
    if (accountTables.rowCount) throw new Error("Core still contains account or GitHub authority tables");

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
    const expectedDefiners = [
      "acknowledge_source_ready_events", "claim_job", "cleanup_expired_executor_state",
      "pull_source_ready_events", "recover_expired_jobs", "schedule_idle_project_document_maintenance",
    ];
    if (JSON.stringify(definers.rows.map(row => row.proname)) !== JSON.stringify(expectedDefiners)
      || definers.rows.some(row => row.owner !== "deviludo_claim_executor")) {
      throw new Error("A SECURITY DEFINER function has an unexpected owner or scope");
    }
    await assertFunctionPrivilege(owner, "deviludo_api", "deviludo.pull_source_ready_events(integer)", true);
    await assertFunctionPrivilege(owner, "deviludo_scheduler", "deviludo.pull_source_ready_events(integer)", false);
    await assertFunctionPrivilege(owner, "deviludo_scheduler", "deviludo.cleanup_expired_executor_state()", true);
    await assertFunctionPrivilege(owner, "deviludo_api", "deviludo.cleanup_expired_executor_state()", false);
    await scheduler.query("SELECT deviludo.reconcile_p0_capacity()");

    await owner.query(
      "INSERT INTO deviludo.workspaces(id, name) VALUES ($1::uuid, 'source-smoke-a'), ($2::uuid, 'source-smoke-b')",
      workspaceIds,
    );
    await expectRlsRejection(() => api.query(
      "INSERT INTO deviludo.projects(workspace_id, id, created_by_actor_account_id, name) VALUES ($1::uuid, $2::uuid, $3::uuid, 'missing-context')",
      [workspaceIds[0], randomUUID(), actorId],
    ));

    for (let index = 0; index < 2; index += 1) {
      await withWorkspace(api, workspaceIds[index], client => client.query(
        `INSERT INTO deviludo.projects(workspace_id, id, created_by_actor_account_id, name)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4)`,
        [workspaceIds[index], projectIds[index], actorId, `source-smoke-${index}`],
      ));
      await owner.query(
        `INSERT INTO deviludo.workflow_instances(
           workspace_id, id, project_id, profile, target_platforms, state, development_actor_account_id
         ) VALUES ($1::uuid, $2::uuid, $3::uuid, 'VALIDATE', ARRAY['macos']::deviludo.server_os[],
           'AGENT_RUNNING', $4::uuid)`,
        [workspaceIds[index], workflowIds[index], projectIds[index], actorId],
      );
    }

    const digest = `sha256:${"a".repeat(64)}`;
    const relativePath = `workspaces/${workspaceIds[0]}/projects/${projectIds[0]}/revisions/r000000000001-${digest.slice(7, 23)}`;
    await withWorkspace(api, workspaceIds[0], async client => {
      await client.query(
        `INSERT INTO deviludo.project_source_revisions(
           workspace_id, project_id, revision, relative_path, content_digest, file_count, total_bytes,
           workflow_id, actor_account_id
         ) VALUES ($1::uuid, $2::uuid, 1, $3, $4, 1, 128, $5::uuid, $6::uuid)`,
        [workspaceIds[0], projectIds[0], relativePath, digest, workflowIds[0], actorId],
      );
      await client.query(
        `INSERT INTO deviludo.project_source_ready_outbox(
           workspace_id, project_id, workflow_id, source_revision, content_digest, development_actor_account_id
         ) VALUES ($1::uuid, $2::uuid, $3::uuid, 1, $4, $5::uuid)`,
        [workspaceIds[0], projectIds[0], workflowIds[0], digest, actorId],
      );
    });
    const events = await api.query("SELECT * FROM deviludo.pull_source_ready_events(10)");
    if (events.rows.length !== 1 || events.rows[0].content_digest !== digest) throw new Error("Source outbox replay is invalid");
    const acknowledged = await api.query(
      "SELECT deviludo.acknowledge_source_ready_events($1::uuid[])::integer AS count",
      [[events.rows[0].event_id]],
    );
    if (acknowledged.rows[0]?.count !== 1) throw new Error("Source outbox acknowledgement is invalid");

    const runtime = await owner.query("SELECT image_reference FROM deviludo.runtime_images WHERE runtime_key = 'AGENT_CLAUDE'");
    if (!runtime.rows[0]?.image_reference) throw new Error("Local Agent runtime digest is missing");
    for (let index = 0; index < 2; index += 1) {
      await owner.query(
        `INSERT INTO deviludo.jobs(
           workspace_id, id, workflow_id, project_id, kind, pool_kind,
           required_capabilities, exclusive, runtime_image, output_contract, idempotency_key,
           payload
         ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'AGENT_GENERATION', 'CORE',
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

    console.log(JSON.stringify({
      database: "verified",
      forcedRlsTables: forcedNames.size,
      securityDefiners: definers.rows.length,
      coreAccountTables: 0,
      sourceOutboxReplay: true,
      concurrentClaims: claims.length,
      repeatedClaimRejected: true,
      expiredLeaseRecovered: true,
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
    "workflow_events", "jobs", "workspace_claim_fairness", "conversation_messages",
    "project_conversations", "agent_installations", "project_source_ready_outbox",
    "project_source_revisions", "project_document_revisions", "project_documents",
    "workflow_instances", "project_creation_receipts", "projects",
  ]) {
    await owner.query(`DELETE FROM deviludo.${table} WHERE workspace_id = ANY($1::uuid[])`, [workspaceIds]);
  }
  await owner.query("DELETE FROM deviludo.workspaces WHERE id = ANY($1::uuid[])", [workspaceIds]);
}
