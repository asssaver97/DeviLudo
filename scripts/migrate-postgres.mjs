import { readFile } from "node:fs/promises";
import pg from "pg";

const { Client } = pg;
const connectionFile = process.env.DEVILUDO_MIGRATION_DATABASE_URL_FILE;
if (connectionFile && process.env.DEVILUDO_MIGRATION_DATABASE_URL) throw new Error("Set only one migration credential source");
const connectionString = connectionFile
  ? (await readFile(connectionFile, "utf8")).trim()
  : process.env.DEVILUDO_MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL ?? "";
if (!connectionString) throw new Error("DEVILUDO_MIGRATION_DATABASE_URL is required");
const url = new URL(connectionString);
if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.username || url.pathname.length < 2) {
  throw new Error("Migration database URL is invalid");
}
if (process.env.NODE_ENV === "production" && !connectionFile) {
  throw new Error("Production migration credentials must be supplied by the deployment secret injector");
}

const source = await readFile(new URL("../infra/postgres/001_core.sql", import.meta.url), "utf8");
const requiredCapabilitiesDefinition = source.match(
  /CREATE OR REPLACE FUNCTION deviludo\.required_capabilities\([\s\S]*?(?=CREATE OR REPLACE FUNCTION deviludo\.enqueue_job\()/,
)?.[0];
if (!requiredCapabilitiesDefinition) throw new Error("The 001 baseline is missing required_capabilities");
const enqueueJobDefinition = source.match(
  /CREATE OR REPLACE FUNCTION deviludo\.enqueue_job\([\s\S]*?(?=CREATE OR REPLACE FUNCTION deviludo\.schedule_idle_project_document_maintenance\()/,
)?.[0];
if (!enqueueJobDefinition) throw new Error("The 001 baseline is missing enqueue_job");
const scheduleDocumentMaintenanceDefinition = source.match(
  /CREATE OR REPLACE FUNCTION deviludo\.schedule_idle_project_document_maintenance\([\s\S]*?(?=CREATE OR REPLACE FUNCTION deviludo\.claim_job\()/,
)?.[0];
if (!scheduleDocumentMaintenanceDefinition) throw new Error("The 001 baseline is missing project document maintenance scheduling");
const claimJobDefinition = source.match(
  /CREATE OR REPLACE FUNCTION deviludo\.claim_job\([\s\S]*?(?=CREATE OR REPLACE FUNCTION deviludo\.accept_workflow_signal\()/,
)?.[0];
if (!claimJobDefinition) throw new Error("The 001 baseline is missing claim_job");
const acceptWorkflowSignalDefinition = source.match(
  /CREATE OR REPLACE FUNCTION deviludo\.accept_workflow_signal\([\s\S]*?(?=CREATE OR REPLACE FUNCTION deviludo\.complete_job\()/,
)?.[0];
if (!acceptWorkflowSignalDefinition) throw new Error("The 001 baseline is missing accept_workflow_signal");
const completeJobDefinition = source.match(
  /CREATE OR REPLACE FUNCTION deviludo\.complete_job\([\s\S]*?(?=CREATE OR REPLACE FUNCTION deviludo\.fail_job\()/,
)?.[0];
if (!completeJobDefinition) throw new Error("The 001 baseline is missing complete_job");
const failJobDefinition = source.match(
  /CREATE OR REPLACE FUNCTION deviludo\.fail_job\([\s\S]*?(?=CREATE OR REPLACE FUNCTION deviludo\.recover_expired_jobs\()/,
)?.[0];
if (!failJobDefinition) throw new Error("The 001 baseline is missing fail_job");
const client = new Client({ connectionString, application_name: "deviludo-fresh-baseline" });
await client.connect();
try {
  const existing = await client.query("SELECT to_regclass('deviludo.schema_metadata') IS NOT NULL AS present");
  if (existing.rows[0]?.present) {
    const metadata = await client.query("SELECT baseline, compatibility FROM deviludo.schema_metadata WHERE singleton = true");
    if (metadata.rows[0]?.baseline === "001" && metadata.rows[0]?.compatibility === "deviludo-core-v4") {
      await client.query("ALTER TYPE deviludo.job_kind ADD VALUE IF NOT EXISTS 'PROJECT_DOCUMENT_MAINTENANCE'");
      await client.query("ALTER TYPE deviludo.artifact_kind ADD VALUE IF NOT EXISTS 'PROJECT_DOCUMENT'");
      await client.query(`
        ALTER TABLE deviludo.projects
          ADD COLUMN IF NOT EXISTS last_activity_at timestamptz NOT NULL DEFAULT clock_timestamp();
        DO $jobs_constraint$
        DECLARE placement_constraint text;
        BEGIN
          SELECT job_constraint.conname INTO placement_constraint
            FROM pg_constraint job_constraint
           WHERE job_constraint.conrelid = 'deviludo.jobs'::regclass
             AND job_constraint.contype = 'c'
             AND pg_get_constraintdef(job_constraint.oid) LIKE '%pool_kind%'
             AND pg_get_constraintdef(job_constraint.oid) LIKE '%target_operating_system%'
             AND pg_get_constraintdef(job_constraint.oid) LIKE '%exclusive%'
           LIMIT 1;
          IF placement_constraint IS NOT NULL THEN
            EXECUTE format('ALTER TABLE deviludo.jobs DROP CONSTRAINT %I', placement_constraint);
          END IF;
          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint
             WHERE conrelid = 'deviludo.jobs'::regclass AND conname = 'jobs_fixed_placement'
          ) THEN
            ALTER TABLE deviludo.jobs ADD CONSTRAINT jobs_fixed_placement CHECK (
              (
                kind IN ('AGENT_GENERATION', 'PROJECT_DOCUMENT_MAINTENANCE', 'ARTIFACT_BUILD', 'STEAM_PUBLISH')
                AND pool_kind = 'CORE' AND target_operating_system IS NULL AND exclusive = false
              ) OR (
                kind IN ('E2E_TEST', 'ARTIFACT_SIGN', 'STEAM_CLEAN_INSTALL') AND exclusive = true
                AND (
                  (pool_kind = 'E2E_LINUX' AND target_operating_system = 'linux')
                  OR (pool_kind = 'E2E_WINDOWS' AND target_operating_system = 'windows')
                  OR (pool_kind = 'E2E_MACOS' AND target_operating_system = 'macos')
                )
              )
            );
          END IF;
        END
        $jobs_constraint$;
        CREATE TABLE IF NOT EXISTS deviludo.project_documents (
          workspace_id uuid NOT NULL,
          project_id uuid NOT NULL,
          revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
          content jsonb NOT NULL CHECK (
            jsonb_typeof(content) = 'object'
            AND jsonb_typeof(content->'introduction') = 'string'
            AND jsonb_typeof(content->'gameplay') = 'string'
            AND jsonb_typeof(content->'categories') = 'array'
            AND jsonb_array_length(content->'categories') BETWEEN 1 AND 32
            AND jsonb_typeof(content->'features') = 'array'
            AND jsonb_array_length(content->'features') BETWEEN 1 AND 32
          ),
          markdown text NOT NULL CHECK (length(markdown) BETWEEN 1 AND 100000),
          maintained_by text NOT NULL CHECK (maintained_by IN ('SYSTEM', 'USER', 'AGENT')),
          updated_by_user_id uuid REFERENCES deviludo.users(id),
          last_agent_maintained_at timestamptz,
          updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
          PRIMARY KEY (workspace_id, project_id),
          FOREIGN KEY (workspace_id, project_id)
            REFERENCES deviludo.projects(workspace_id, id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS deviludo.project_document_revisions (
          workspace_id uuid NOT NULL,
          project_id uuid NOT NULL,
          revision bigint NOT NULL CHECK (revision > 0),
          content jsonb NOT NULL CHECK (jsonb_typeof(content) = 'object'),
          markdown text NOT NULL CHECK (length(markdown) BETWEEN 1 AND 100000),
          source text NOT NULL CHECK (source IN ('PROJECT_CREATED', 'PROJECT_IMPORTED', 'USER_EDIT', 'AGENT_CONVERSATION', 'AGENT_IDLE_MAINTENANCE')),
          author_user_id uuid REFERENCES deviludo.users(id),
          maintenance_job_id uuid,
          created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
          PRIMARY KEY (workspace_id, project_id, revision),
          FOREIGN KEY (workspace_id, project_id)
            REFERENCES deviludo.project_documents(workspace_id, project_id) ON DELETE CASCADE,
          FOREIGN KEY (workspace_id, maintenance_job_id)
            REFERENCES deviludo.jobs(workspace_id, id)
        );
        ALTER TABLE deviludo.project_document_revisions
          DROP CONSTRAINT IF EXISTS project_document_revisions_source_check;
        ALTER TABLE deviludo.project_document_revisions
          ADD CONSTRAINT project_document_revisions_source_check
          CHECK (source IN ('PROJECT_CREATED', 'PROJECT_IMPORTED', 'USER_EDIT', 'AGENT_CONVERSATION', 'AGENT_IDLE_MAINTENANCE'));
        ALTER TABLE deviludo.project_documents NO FORCE ROW LEVEL SECURITY;
        ALTER TABLE deviludo.project_document_revisions NO FORCE ROW LEVEL SECURITY;
        INSERT INTO deviludo.project_documents(
          workspace_id, project_id, content, markdown, maintained_by
        )
        SELECT project.workspace_id, project.id,
               jsonb_build_object(
                 'introduction', coalesce(workflow.state_data->>'concept', project.name),
                 'gameplay', '待 Agent 根据项目实现补充玩法说明。',
                 'categories', jsonb_build_array('待 Agent 分类'),
                 'features', jsonb_build_array('完成核心游戏循环')
               ),
               '# ' || project.name || E'\n\n## 游戏介绍\n\n'
                 || coalesce(workflow.state_data->>'concept', project.name)
                 || E'\n\n## 玩法\n\n待 Agent 根据项目实现补充玩法说明。'
                 || E'\n\n## 游戏分类\n\n- 待 Agent 分类'
                 || E'\n\n## 主要特性\n\n- 完成核心游戏循环\n',
               'SYSTEM'
          FROM deviludo.projects project
          LEFT JOIN LATERAL (
            SELECT state_data FROM deviludo.workflow_instances instance
             WHERE instance.workspace_id = project.workspace_id AND instance.project_id = project.id
             ORDER BY instance.created_at DESC LIMIT 1
          ) workflow ON true
        ON CONFLICT (workspace_id, project_id) DO NOTHING;
        INSERT INTO deviludo.project_document_revisions(
          workspace_id, project_id, revision, content, markdown, source
        )
        SELECT workspace_id, project_id, revision, content, markdown, 'PROJECT_CREATED'
          FROM deviludo.project_documents
        ON CONFLICT (workspace_id, project_id, revision) DO NOTHING;
        ALTER TABLE deviludo.project_documents ENABLE ROW LEVEL SECURITY;
        ALTER TABLE deviludo.project_documents FORCE ROW LEVEL SECURITY;
        ALTER TABLE deviludo.project_document_revisions ENABLE ROW LEVEL SECURITY;
        ALTER TABLE deviludo.project_document_revisions FORCE ROW LEVEL SECURITY;
        DROP POLICY IF EXISTS workspace_isolation ON deviludo.project_documents;
        CREATE POLICY workspace_isolation ON deviludo.project_documents
          USING (workspace_id = deviludo.current_workspace_id())
          WITH CHECK (workspace_id = deviludo.current_workspace_id());
        DROP POLICY IF EXISTS workspace_isolation ON deviludo.project_document_revisions;
        CREATE POLICY workspace_isolation ON deviludo.project_document_revisions
          USING (workspace_id = deviludo.current_workspace_id())
          WITH CHECK (workspace_id = deviludo.current_workspace_id());
        GRANT SELECT, INSERT, UPDATE, DELETE ON
          deviludo.project_documents, deviludo.project_document_revisions TO deviludo_api;
        GRANT SELECT, INSERT, UPDATE ON
          deviludo.projects, deviludo.project_documents, deviludo.project_document_revisions TO deviludo_scheduler;
        GRANT SELECT, INSERT, UPDATE ON
          deviludo.projects, deviludo.project_documents, deviludo.project_document_revisions TO deviludo_sandbox;
        CREATE TABLE IF NOT EXISTS deviludo.job_progress_events (
          workspace_id uuid NOT NULL,
          sequence bigint GENERATED ALWAYS AS IDENTITY,
          project_id uuid NOT NULL,
          workflow_id uuid NOT NULL,
          job_id uuid NOT NULL,
          event_kind text NOT NULL CHECK (event_kind IN ('PHASE', 'AGENT_OUTPUT', 'GUIDANCE_ACCEPTED', 'COMPLETED', 'FAILED')),
          content text NOT NULL CHECK (length(content) BETWEEN 1 AND 4000),
          created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
          PRIMARY KEY (workspace_id, sequence),
          FOREIGN KEY (workspace_id, project_id) REFERENCES deviludo.projects(workspace_id, id),
          FOREIGN KEY (workspace_id, workflow_id) REFERENCES deviludo.workflow_instances(workspace_id, id),
          FOREIGN KEY (workspace_id, job_id) REFERENCES deviludo.jobs(workspace_id, id)
        );
        CREATE INDEX IF NOT EXISTS job_progress_events_project_sequence
          ON deviludo.job_progress_events(workspace_id, project_id, sequence);
        CREATE TABLE IF NOT EXISTS deviludo.job_guidance_messages (
          workspace_id uuid NOT NULL,
          id uuid NOT NULL DEFAULT gen_random_uuid(),
          project_id uuid NOT NULL,
          workflow_id uuid NOT NULL,
          job_id uuid NOT NULL,
          conversation_id uuid NOT NULL,
          content text NOT NULL CHECK (length(content) BETWEEN 2 AND 4000),
          state text NOT NULL DEFAULT 'PENDING' CHECK (state IN ('PENDING', 'DELIVERED', 'REJECTED')),
          created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
          delivered_at timestamptz,
          PRIMARY KEY (workspace_id, id),
          FOREIGN KEY (workspace_id, project_id) REFERENCES deviludo.projects(workspace_id, id),
          FOREIGN KEY (workspace_id, workflow_id) REFERENCES deviludo.workflow_instances(workspace_id, id),
          FOREIGN KEY (workspace_id, job_id) REFERENCES deviludo.jobs(workspace_id, id),
          FOREIGN KEY (workspace_id, conversation_id) REFERENCES deviludo.project_conversations(workspace_id, id)
        );
        CREATE INDEX IF NOT EXISTS job_guidance_messages_pending
          ON deviludo.job_guidance_messages(workspace_id, job_id, created_at) WHERE state = 'PENDING';
        ALTER TABLE deviludo.job_progress_events ENABLE ROW LEVEL SECURITY;
        ALTER TABLE deviludo.job_progress_events FORCE ROW LEVEL SECURITY;
        ALTER TABLE deviludo.job_guidance_messages ENABLE ROW LEVEL SECURITY;
        ALTER TABLE deviludo.job_guidance_messages FORCE ROW LEVEL SECURITY;
        DROP POLICY IF EXISTS workspace_isolation ON deviludo.job_progress_events;
        CREATE POLICY workspace_isolation ON deviludo.job_progress_events
          USING (workspace_id = deviludo.current_workspace_id())
          WITH CHECK (workspace_id = deviludo.current_workspace_id());
        DROP POLICY IF EXISTS workspace_isolation ON deviludo.job_guidance_messages;
        CREATE POLICY workspace_isolation ON deviludo.job_guidance_messages
          USING (workspace_id = deviludo.current_workspace_id())
          WITH CHECK (workspace_id = deviludo.current_workspace_id());
        REVOKE ALL ON deviludo.job_progress_events, deviludo.job_guidance_messages FROM PUBLIC;
        GRANT SELECT, INSERT, UPDATE, DELETE ON deviludo.job_progress_events, deviludo.job_guidance_messages TO deviludo_api;
        GRANT SELECT, INSERT, UPDATE ON deviludo.job_progress_events, deviludo.job_guidance_messages TO deviludo_scheduler, deviludo_sandbox;
        GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA deviludo TO deviludo_api, deviludo_scheduler, deviludo_sandbox;
      `);
      await client.query(requiredCapabilitiesDefinition);
      await client.query(enqueueJobDefinition);
      await client.query(scheduleDocumentMaintenanceDefinition);
      await client.query(claimJobDefinition);
      await client.query(acceptWorkflowSignalDefinition);
      await client.query(completeJobDefinition);
      await client.query(failJobDefinition);
      await client.query(`
        UPDATE deviludo.jobs
           SET last_error = NULL
         WHERE state IN ('RUNNING', 'SUCCEEDED')
           AND last_error IS NOT NULL
      `);
      await client.query(`
        REVOKE ALL ON deviludo.project_documents, deviludo.project_document_revisions FROM PUBLIC;
        REVOKE ALL ON FUNCTION deviludo.schedule_idle_project_document_maintenance(integer, integer) FROM PUBLIC;
        ALTER FUNCTION deviludo.claim_job(text, deviludo.server_pool_kind, integer) OWNER TO deviludo_claim_executor;
        ALTER FUNCTION deviludo.reconcile_p0_capacity() SECURITY INVOKER;
        ALTER FUNCTION deviludo.schedule_idle_project_document_maintenance(integer, integer) OWNER TO deviludo_claim_executor;
        GRANT EXECUTE ON FUNCTION deviludo.current_user_id() TO deviludo_claim_executor;
        GRANT EXECUTE ON FUNCTION deviludo.required_capabilities(deviludo.job_kind),
          deviludo.enqueue_job(uuid, uuid, uuid, deviludo.job_kind, deviludo.server_os, text, jsonb)
          TO deviludo_claim_executor;
        GRANT EXECUTE ON FUNCTION deviludo.schedule_idle_project_document_maintenance(integer, integer)
          TO deviludo_scheduler;
        GRANT INSERT ON deviludo.jobs, deviludo.artifact_inputs TO deviludo_claim_executor;
        GRANT SELECT, DELETE ON deviludo.project_creation_receipts TO deviludo_api;
        GRANT SELECT, UPDATE ON deviludo.projects TO deviludo_claim_executor;
        GRANT SELECT ON deviludo.project_documents,
          deviludo.workflow_instances, deviludo.instance_agent_settings,
          deviludo.runtime_images, deviludo.artifacts, deviludo.artifact_inputs
          TO deviludo_claim_executor;
      `);
      console.log(JSON.stringify({ applied: "001_core.sql", mode: "already-current", privileges: "reconciled" }));
    } else {
      throw new Error("The fresh 001 baseline refuses an incompatible database; provision a new empty PostgreSQL database");
    }
  } else {
    const namespace = await client.query("SELECT to_regnamespace('deviludo') IS NOT NULL AS present");
    if (namespace.rows[0]?.present) {
      throw new Error("The existing database predates the Deviludo 001 baseline; run npm run local:reset or provision a new empty database");
    }
    const userObjects = await client.query(`
      SELECT count(*)::integer AS count
        FROM pg_class relation
        JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
       WHERE namespace.nspname NOT IN ('pg_catalog', 'information_schema')
         AND namespace.nspname NOT LIKE 'pg_toast%'
         AND relation.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
    `);
    if (Number(userObjects.rows[0]?.count ?? 0) !== 0) {
      throw new Error("The fresh 001 baseline requires an empty PostgreSQL database");
    }
    await client.query(source);
    console.log(JSON.stringify({ applied: "001_core.sql", mode: "fresh-baseline" }));
  }
} finally {
  await client.end();
}
