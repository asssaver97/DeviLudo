import type { PoolClient } from "pg";
import { verify } from "node:crypto";
import {
  AGENT_RUNTIME_KINDS,
  type AgentProgressEvent,
  type AgentProgressEventKind,
  type AgentModelConfiguration,
  type AgentRuntimeKind,
  type ArtifactRecord,
  type ProjectSourceRevision,
  type WorkspaceSummary,
} from "@/lib/product/contracts";
import {
  fixedPoolRecords,
  isServerPoolKind,
  type ServerNodeRecord,
  type ServerNodeState,
  type ServerOperatingSystem,
  type ServerPoolKind,
} from "@/lib/runtime/server-pools";
import { assertJobPlacement, isJobKind } from "@/lib/runtime/job-routing";
import type { Database } from "./database";
import type {
  ClaimedJobIdentity,
  JobCompletion,
  JobProtocolV4,
  WorkflowSignalInput,
} from "./contracts";
import { executorReceiptSigningPayload } from "./contracts";
import { normalizeAgentModels } from "./agent-settings";
import {
  createInitialProjectDocument,
  parseProjectDocumentContent,
  projectDocumentMarkdown,
  type ProjectDocumentContent,
} from "@/lib/product/project-document";

export class CoreRepository {
  constructor(private readonly database: Database) {}

  async ping(): Promise<void> {
    await this.database.pool.query("SELECT 1");
  }

  async listSourceReadyEvents(limit = 100): Promise<readonly SourceReadyEvent[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error("Source event page size is invalid");
    const result = await this.database.pool.query<SourceReadyEventRow>(
      `SELECT event_id::text, workspace_id::text, project_id::text, workflow_id::text,
              source_revision::text, content_digest, development_actor_account_id::text,
              created_at::text
         FROM deviludo.pull_source_ready_events($1::integer)`,
      [limit],
    );
    return Object.freeze(result.rows.map(row => Object.freeze({
      eventId: row.event_id,
      workspaceId: row.workspace_id,
      projectId: row.project_id,
      workflowId: row.workflow_id,
      sourceRevision: Number(row.source_revision),
      digest: row.content_digest,
      developmentActorAccountId: row.development_actor_account_id,
      createdAt: row.created_at,
    })));
  }

  async acknowledgeSourceReadyEvents(eventIds: readonly string[]): Promise<number> {
    if (eventIds.length < 1 || eventIds.length > 500 || eventIds.some(id => !UUID.test(id))) {
      throw new Error("Source event acknowledgement is invalid");
    }
    const result = await this.database.pool.query<{ acknowledged: string }>(
      "SELECT deviludo.acknowledge_source_ready_events($1::uuid[])::text AS acknowledged",
      [eventIds],
    );
    return Number(result.rows[0]?.acknowledged ?? 0);
  }

  async readSourceRevision(input: Readonly<{
    workspaceId: string;
    projectId: string;
    revision: number;
  }>): Promise<Readonly<{ relativePath: string; digest: string; fileCount: number; totalBytes: number }> | null> {
    return this.database.withWorkspace(input.workspaceId, async client => {
      const result = await client.query<{
        relative_path: string;
        content_digest: string;
        file_count: string;
        total_bytes: string;
      }>(
        `SELECT relative_path, content_digest, file_count::text, total_bytes::text
           FROM deviludo.project_source_revisions
          WHERE workspace_id = $1::uuid AND project_id = $2::uuid AND revision = $3::bigint`,
        [input.workspaceId, input.projectId, input.revision],
      );
      const row = result.rows[0];
      return row ? Object.freeze({
        relativePath: row.relative_path,
        digest: row.content_digest,
        fileCount: Number(row.file_count),
        totalBytes: Number(row.total_bytes),
      }) : null;
    });
  }

  async readServerNodes(): Promise<readonly ServerNodeRecord[]> {
    const result = await this.database.pool.query<ServerNodeRow>(
      `SELECT id::text, pool_kind::text, operating_system::text, state::text, capabilities,
              isolation_generation::text, current_workspace_id::text, last_heartbeat_at::text,
              last_reimage_proof_at::text
         FROM deviludo.server_nodes
        ORDER BY pool_kind, id`,
    );
    return Object.freeze(result.rows.map(serverNodeFromRow));
  }

  async readServerPools() {
    return fixedPoolRecords(await this.readServerNodes());
  }

  async readWorkspace(workspaceId: string): Promise<WorkspaceSummary | null> {
    return this.database.withWorkspace(workspaceId, async client => {
      const result = await client.query<WorkspaceRow>(
        `SELECT id::text, name, created_at::text
           FROM deviludo.workspaces
          WHERE id = $1::uuid`,
        [workspaceId],
      );
      return result.rows[0] ? workspaceFromRow(result.rows[0]) : null;
    });
  }

  async readAgentSettings(): Promise<StoredInstanceAgentSettings | null> {
    const result = await this.database.pool.query<AgentSettingsRow>(
        `SELECT agent_runtime::text, base_url, primary_model, opus_model,
                sonnet_model, haiku_model, subagent_model, credential_secret_ref,
                api_key_mask, api_key_fingerprint, credential_version::text, revision::text,
                updated_by, updated_at::text
           FROM deviludo.instance_agent_settings
          WHERE singleton = true`,
    );
    return result.rows[0] ? agentSettingsFromRow(result.rows[0]) : null;
  }

  async saveAgentSettings(input: Readonly<{
    agentRuntime: AgentRuntimeKind;
    baseUrl: string;
    models: AgentModelConfiguration | null;
    credentialSecretRef: string;
    apiKeyMask: string;
    apiKeyFingerprint: string;
    credentialVersion: string;
    updatedBy: string;
  }>): Promise<StoredInstanceAgentSettings> {
      const result = await this.database.pool.query<AgentSettingsRow>(
        `INSERT INTO deviludo.instance_agent_settings(
           singleton, agent_runtime, base_url, primary_model, opus_model,
           sonnet_model, haiku_model, subagent_model, credential_secret_ref,
           api_key_mask, api_key_fingerprint, credential_version, updated_by
         ) VALUES (
           true, $1::deviludo.agent_runtime, $2, $3, $4, $5, $6, $7,
           $8, $9, $10, $11::uuid, $12
         )
         ON CONFLICT (singleton) DO UPDATE SET
           agent_runtime = EXCLUDED.agent_runtime,
           base_url = EXCLUDED.base_url,
           primary_model = EXCLUDED.primary_model,
           opus_model = EXCLUDED.opus_model,
           sonnet_model = EXCLUDED.sonnet_model,
           haiku_model = EXCLUDED.haiku_model,
           subagent_model = EXCLUDED.subagent_model,
           credential_secret_ref = EXCLUDED.credential_secret_ref,
           api_key_mask = EXCLUDED.api_key_mask,
           api_key_fingerprint = EXCLUDED.api_key_fingerprint,
           credential_version = EXCLUDED.credential_version,
           revision = deviludo.instance_agent_settings.revision + 1,
           updated_by = EXCLUDED.updated_by,
           updated_at = clock_timestamp()
         RETURNING agent_runtime::text, base_url, primary_model, opus_model,
                   sonnet_model, haiku_model, subagent_model, credential_secret_ref,
                   api_key_mask, api_key_fingerprint, credential_version::text, revision::text,
                   updated_by, updated_at::text`,
        [
          input.agentRuntime,
          input.baseUrl,
          input.models?.primary ?? null,
          input.models?.opus ?? null,
          input.models?.sonnet ?? null,
          input.models?.haiku ?? null,
          input.models?.subagent ?? null,
          input.credentialSecretRef,
          input.apiKeyMask,
          input.apiKeyFingerprint,
          input.credentialVersion,
          input.updatedBy,
        ],
      );
      return agentSettingsFromRow(result.rows[0]);
  }

  async listProjects(workspaceId: string): Promise<readonly ProductProjectSummary[]> {
    return this.database.withWorkspace(workspaceId, async client => {
      const result = await client.query<ProductProjectRow>(
        `SELECT p.id::text, p.name, p.created_at::text,
                workflow.id::text AS workflow_id,
                workflow.state::text AS workflow_state,
                workflow.profile::text AS profile,
                workflow.target_platforms,
                workflow.state_data,
                workflow.updated_at::text AS workflow_updated_at,
                source.revision::text AS source_revision,
                source.relative_path AS source_relative_path,
                source.content_digest AS source_digest,
                source.file_count::text AS source_file_count,
                source.total_bytes::text AS source_total_bytes,
                source.created_at::text AS source_created_at
           FROM deviludo.projects p
           LEFT JOIN LATERAL (
             SELECT id, state, profile, target_platforms, state_data, updated_at
               FROM deviludo.workflow_instances
              WHERE workspace_id = p.workspace_id AND project_id = p.id
              ORDER BY created_at DESC
              LIMIT 1
           ) workflow ON true
           LEFT JOIN LATERAL (
             SELECT revision, relative_path, content_digest, file_count, total_bytes, created_at
               FROM deviludo.project_source_revisions
              WHERE workspace_id = p.workspace_id AND project_id = p.id
              ORDER BY revision DESC LIMIT 1
           ) source ON true
          ORDER BY p.created_at DESC`,
      );
      return Object.freeze(result.rows.map(projectSummaryFromRow));
    });
  }

  async createProject(input: Readonly<{
    actorUserId: string;
    workspaceId: string;
    workspaceName: string;
    projectId: string;
    workflowId: string;
    idempotencyKey: string;
    name: string;
    concept: string;
    specification: Readonly<Record<string, unknown>>;
    profile: "VALIDATE" | "RELEASE";
    targetPlatforms: readonly ServerOperatingSystem[];
  }>): Promise<ProductProjectDetail> {
    await this.database.withWorkspace(input.workspaceId, async client => {
      await client.query(
        `INSERT INTO deviludo.workspaces(id, name) VALUES ($1::uuid, $2)
         ON CONFLICT (id) DO NOTHING`,
        [input.workspaceId, input.workspaceName],
      );
      await client.query(
        `INSERT INTO deviludo.projects(workspace_id, id, created_by_actor_account_id, name)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4)`,
        [input.workspaceId, input.projectId, input.actorUserId, input.name],
      );
      await insertInitialProjectDocument(client, input);
      await client.query(
        `INSERT INTO deviludo.workflow_instances(
           workspace_id, id, project_id, profile, target_platforms, state_data
         ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::deviludo.workflow_profile, $5::deviludo.server_os[], $6::jsonb)`,
        [
          input.workspaceId,
          input.workflowId,
          input.projectId,
          input.profile,
          input.targetPlatforms,
          JSON.stringify({ concept: input.concept, specification: input.specification }),
        ],
      );
      await client.query(
        `INSERT INTO deviludo.workflow_events(
           workspace_id, workflow_id, event_kind, event_data, idempotency_key
         ) VALUES ($1::uuid, $2::uuid, 'PROJECT_CREATED', $3::jsonb, 'project-created')`,
        [input.workspaceId, input.workflowId, JSON.stringify({ concept: input.concept })],
      );
      await client.query(
        `INSERT INTO deviludo.project_creation_receipts(
           idempotency_key, operation_kind, workspace_id, project_id
         ) VALUES ($1, 'PROJECT', $2::uuid, $3::uuid)`,
        [input.idempotencyKey, input.workspaceId, input.projectId],
      );
    });
    const created = await this.readProject(input.workspaceId, input.projectId);
    if (!created) throw new Error("Created project could not be read");
    return created;
  }

  async createImportedProject(input: Readonly<{
    actorUserId: string;
    workspaceId: string;
    workspaceName: string;
    projectId: string;
    workflowId: string;
    conversationId: string;
    idempotencyKey: string;
    name: string;
    concept: string;
    specification: Readonly<Record<string, unknown>>;
    document: ProjectDocumentContent;
    userContent: string;
    assistantContent: string;
    assistantMetadata: Readonly<Record<string, unknown>>;
    source: Readonly<{
      kind: "GIT" | "LOCAL_ARCHIVE";
      repositoryUrl: string | null;
      displayName: string;
      fileCount: number;
      totalBytes: number;
      revision: number;
      relativePath: string;
      sha256: string;
    }>;
    profile: "VALIDATE" | "RELEASE";
    targetPlatforms: readonly ServerOperatingSystem[];
  }>): Promise<Readonly<{ project: ProductProjectDetail; conversation: ProductConversation }>> {
    await this.database.withWorkspace(input.workspaceId, async client => {
      await client.query(
        `INSERT INTO deviludo.workspaces(id, name) VALUES ($1::uuid, $2)
         ON CONFLICT (id) DO NOTHING`,
        [input.workspaceId, input.workspaceName],
      );
      await client.query(
        `INSERT INTO deviludo.projects(workspace_id, id, created_by_actor_account_id, name)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4)`,
        [input.workspaceId, input.projectId, input.actorUserId, input.name],
      );
      const markdown = projectDocumentMarkdown(input.name, input.document);
      await client.query(
        `INSERT INTO deviludo.project_documents(
           workspace_id, project_id, content, markdown, maintained_by, last_agent_maintained_at
         ) VALUES ($1::uuid, $2::uuid, $3::jsonb, $4, 'AGENT', clock_timestamp())`,
        [input.workspaceId, input.projectId, JSON.stringify(input.document), markdown],
      );
      await client.query(
        `INSERT INTO deviludo.project_document_revisions(
           workspace_id, project_id, revision, content, markdown, source
         ) VALUES ($1::uuid, $2::uuid, 1, $3::jsonb, $4, 'PROJECT_IMPORTED')`,
        [input.workspaceId, input.projectId, JSON.stringify(input.document), markdown],
      );
      await client.query(
        `INSERT INTO deviludo.workflow_instances(
           workspace_id, id, project_id, profile, target_platforms, state_data
         ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::deviludo.workflow_profile, $5::deviludo.server_os[], $6::jsonb)`,
        [input.workspaceId, input.workflowId, input.projectId, input.profile, input.targetPlatforms, JSON.stringify({
          concept: input.concept,
          specification: input.specification,
          source: {
            kind: input.source.kind,
            repositoryUrl: input.source.repositoryUrl,
            displayName: input.source.displayName,
            fileCount: input.source.fileCount,
            totalBytes: input.source.totalBytes,
            sha256: input.source.sha256,
          },
        })],
      );
      await client.query(
        `INSERT INTO deviludo.workflow_events(
           workspace_id, workflow_id, event_kind, event_data, idempotency_key
         ) VALUES ($1::uuid, $2::uuid, 'PROJECT_IMPORTED', $3::jsonb, 'project-imported')`,
        [input.workspaceId, input.workflowId, JSON.stringify({
          sourceKind: input.source.kind,
          repositoryUrl: input.source.repositoryUrl,
          fileCount: input.source.fileCount,
          totalBytes: input.source.totalBytes,
          sha256: input.source.sha256,
        })],
      );
      await client.query(
        `INSERT INTO deviludo.project_source_revisions(
           workspace_id, project_id, revision, relative_path, content_digest,
           file_count, total_bytes, workflow_id, actor_account_id
         ) VALUES ($1::uuid, $2::uuid, $3::bigint, $4, $5, $6, $7, $8::uuid, $9::uuid)`,
        [input.workspaceId, input.projectId, input.source.revision, input.source.relativePath,
          input.source.sha256, input.source.fileCount, input.source.totalBytes,
          input.workflowId, input.actorUserId],
      );
      await client.query(
        `INSERT INTO deviludo.project_conversations(workspace_id, id, project_id, mode, title)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'PROJECT_FEEDBACK', $4)`,
        [input.workspaceId, input.conversationId, input.projectId, `${input.name} · 导入分析`],
      );
      await client.query(
        `INSERT INTO deviludo.conversation_messages(workspace_id, conversation_id, role, content)
         VALUES ($1::uuid, $2::uuid, 'USER', $3)`,
        [input.workspaceId, input.conversationId, input.userContent],
      );
      await client.query(
        `INSERT INTO deviludo.conversation_messages(workspace_id, conversation_id, role, content, metadata)
         VALUES ($1::uuid, $2::uuid, 'ASSISTANT', $3, $4::jsonb)`,
        [input.workspaceId, input.conversationId, input.assistantContent, JSON.stringify({
          ...input.assistantMetadata,
          source: "PROJECT_IMPORT_AGENT",
          appliedToDraft: true,
        })],
      );
      await client.query(
        `INSERT INTO deviludo.project_creation_receipts(
           idempotency_key, operation_kind, workspace_id, project_id
         ) VALUES ($1, 'PROJECT', $2::uuid, $3::uuid)`,
        [input.idempotencyKey, input.workspaceId, input.projectId],
      );
    });
    const [project, conversation] = await Promise.all([
      this.readProject(input.workspaceId, input.projectId),
      this.readConversation(input.workspaceId, input.conversationId),
    ]);
    if (!project || !conversation) throw new Error("Imported project could not be read");
    return Object.freeze({ project, conversation });
  }

  async readProjectCreationReceipt(workspaceId: string, idempotencyKey: string): Promise<CreationReceipt | null> {
    return this.database.withWorkspace(workspaceId, async client => {
      const result = await client.query<CreationReceiptRow>(
      `SELECT idempotency_key, operation_kind, workspace_id::text, project_id::text,
              conversation_id::text
         FROM deviludo.project_creation_receipts
        WHERE workspace_id = $1::uuid AND idempotency_key = $2`,
      [workspaceId, idempotencyKey],
    );
      return result.rows[0] ? creationReceiptFromRow(result.rows[0]) : null;
    });
  }

  async createProjectConversation(input: Readonly<{
    actorUserId: string;
    workspaceId: string;
    workspaceName: string;
    projectId: string;
    workflowId: string;
    conversationId: string;
    idempotencyKey: string;
    name: string;
    concept: string;
    specification: Readonly<Record<string, unknown>>;
    document: ProjectDocumentContent;
    userContent: string;
    assistantContent: string;
    assistantMetadata: Readonly<Record<string, unknown>>;
    profile: "VALIDATE" | "RELEASE";
    targetPlatforms: readonly ServerOperatingSystem[];
  }>): Promise<Readonly<{ project: ProductProjectDetail; conversation: ProductConversation }>> {
    await this.database.withWorkspace(input.workspaceId, async client => {
      await client.query(
        `INSERT INTO deviludo.workspaces(id, name) VALUES ($1::uuid, $2)
         ON CONFLICT (id) DO NOTHING`,
        [input.workspaceId, input.workspaceName],
      );
      await client.query(
        `INSERT INTO deviludo.projects(workspace_id, id, created_by_actor_account_id, name)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4)`,
        [input.workspaceId, input.projectId, input.actorUserId, input.name],
      );
      await insertInitialProjectDocument(client, input);
      await client.query(
        `INSERT INTO deviludo.workflow_instances(
           workspace_id, id, project_id, profile, target_platforms, state_data
         ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::deviludo.workflow_profile, $5::deviludo.server_os[], $6::jsonb)`,
        [
          input.workspaceId,
          input.workflowId,
          input.projectId,
          input.profile,
          input.targetPlatforms,
          JSON.stringify({ concept: input.concept, specification: input.specification }),
        ],
      );
      await client.query(
        `INSERT INTO deviludo.workflow_events(
           workspace_id, workflow_id, event_kind, event_data, idempotency_key
         ) VALUES ($1::uuid, $2::uuid, 'PROJECT_CREATED', $3::jsonb, 'project-created')`,
        [input.workspaceId, input.workflowId, JSON.stringify({ concept: input.concept, source: "HOME_CONVERSATION" })],
      );
      await client.query(
        `INSERT INTO deviludo.project_conversations(workspace_id, id, project_id, mode, title)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'NEW_GAME', $4)`,
        [input.workspaceId, input.conversationId, input.projectId, input.name],
      );
      await client.query(
        `INSERT INTO deviludo.conversation_messages(workspace_id, conversation_id, role, content)
         VALUES ($1::uuid, $2::uuid, 'USER', $3)`,
        [input.workspaceId, input.conversationId, input.userContent],
      );
      await client.query(
        `INSERT INTO deviludo.conversation_messages(workspace_id, conversation_id, role, content, metadata)
         VALUES ($1::uuid, $2::uuid, 'ASSISTANT', $3, $4::jsonb)`,
        [input.workspaceId, input.conversationId, input.assistantContent, JSON.stringify({
          ...input.assistantMetadata,
          appliedToDraft: true,
          projectDocumentUpdated: true,
        })],
      );
      await client.query(
        `INSERT INTO deviludo.project_creation_receipts(
           idempotency_key, operation_kind, workspace_id, project_id, conversation_id
         ) VALUES ($1, 'CONVERSATION', $2::uuid, $3::uuid, $4::uuid)`,
        [input.idempotencyKey, input.workspaceId, input.projectId, input.conversationId],
      );
    });
    const [project, conversation] = await Promise.all([
      this.readProject(input.workspaceId, input.projectId),
      this.readConversation(input.workspaceId, input.conversationId),
    ]);
    if (!project || !conversation) throw new Error("Created project conversation could not be read");
    return Object.freeze({ project, conversation });
  }

  async updateProjectSpecification(input: Readonly<{
    workspaceId: string;
    projectId: string;
    specification: Readonly<Record<string, unknown>>;
    note: string;
    idempotencyKey: string;
  }>): Promise<ProductProjectDetail | null> {
    await this.database.withWorkspace(input.workspaceId, async client => {
      await touchProjectActivity(client, input.workspaceId, input.projectId);
      const workflow = await client.query<{ id: string }>(
        `UPDATE deviludo.workflow_instances
            SET state_data = state_data || jsonb_build_object('specification', $2::jsonb),
                version = version + 1,
                updated_at = clock_timestamp()
          WHERE project_id = $1::uuid AND state = 'DRAFT'
          RETURNING id::text`,
        [input.projectId, JSON.stringify(input.specification)],
      );
      if (!workflow.rows[0]) throw new Error("Only draft project specifications can be edited");
      await client.query(
        `INSERT INTO deviludo.workflow_events(
           workspace_id, workflow_id, event_kind, event_data, idempotency_key
         ) VALUES ($1::uuid, $2::uuid, 'SPEC_REFINED', $3::jsonb, $4)
         ON CONFLICT (workspace_id, workflow_id, idempotency_key) DO NOTHING`,
        [input.workspaceId, workflow.rows[0].id, JSON.stringify({ note: input.note }), input.idempotencyKey],
      );
    });
    return this.readProject(input.workspaceId, input.projectId);
  }

  async readProject(workspaceId: string, projectId: string): Promise<ProductProjectDetail | null> {
    return this.database.withWorkspace(workspaceId, async client => {
      const project = await client.query<ProductProjectRow>(
        `SELECT p.id::text, p.name, p.created_at::text,
                workflow.id::text AS workflow_id,
                workflow.state::text AS workflow_state,
                workflow.profile::text AS profile,
                workflow.target_platforms,
                workflow.state_data,
                workflow.updated_at::text AS workflow_updated_at,
                source.revision::text AS source_revision,
                source.relative_path AS source_relative_path,
                source.content_digest AS source_digest,
                source.file_count::text AS source_file_count,
                source.total_bytes::text AS source_total_bytes,
                source.created_at::text AS source_created_at
           FROM deviludo.projects p
           LEFT JOIN LATERAL (
             SELECT id, state, profile, target_platforms, state_data, updated_at
               FROM deviludo.workflow_instances
              WHERE workspace_id = p.workspace_id AND project_id = p.id
              ORDER BY created_at DESC
              LIMIT 1
           ) workflow ON true
           LEFT JOIN LATERAL (
             SELECT revision, relative_path, content_digest, file_count, total_bytes, created_at
               FROM deviludo.project_source_revisions
              WHERE workspace_id = p.workspace_id AND project_id = p.id
              ORDER BY revision DESC LIMIT 1
           ) source ON true
          WHERE p.id = $1::uuid`,
        [projectId],
      );
      const row = project.rows[0];
      if (!row || !row.workflow_id) return null;
      const [jobs, events, document, documentRevisions] = await Promise.all([
        client.query<ProductJobRow>(
          `SELECT id::text, kind::text, pool_kind::text, target_operating_system::text,
                  state::text, attempt, last_error, created_at::text, updated_at::text
             FROM deviludo.jobs
            WHERE workflow_id = $1::uuid
            ORDER BY created_at, kind, target_operating_system NULLS FIRST`,
          [row.workflow_id],
        ),
        client.query<ProductEventRow>(
          `SELECT event_id::text, event_kind, event_data, created_at::text
             FROM deviludo.workflow_events
            WHERE workflow_id = $1::uuid
            ORDER BY event_id DESC
            LIMIT 40`,
          [row.workflow_id],
        ),
        client.query<ProjectDocumentRow>(
          `SELECT revision::text, content, markdown, maintained_by,
                  last_agent_maintained_at::text, updated_at::text
             FROM deviludo.project_documents
            WHERE project_id = $1::uuid`,
          [projectId],
        ),
        client.query<ProjectDocumentRevisionRow>(
          `SELECT revision.revision::text, revision.source,
                  revision.author_actor_account_id::text AS author_username, revision.created_at::text
             FROM deviludo.project_document_revisions revision
            WHERE revision.project_id = $1::uuid
            ORDER BY revision.revision DESC
            LIMIT 30`,
          [projectId],
        ),
      ]);
      const currentDocument = document.rows[0];
      if (!currentDocument) throw new Error("Project document is missing");
      return Object.freeze({
        ...projectSummaryFromRow(row),
        document: projectDocumentFromRows(currentDocument, documentRevisions.rows),
        jobs: Object.freeze(jobs.rows.map(job => Object.freeze({
          id: job.id,
          kind: job.kind,
          poolKind: job.pool_kind,
          targetOperatingSystem: job.target_operating_system,
          state: job.state,
          attempt: job.attempt,
          lastError: job.last_error,
          createdAt: job.created_at,
          updatedAt: job.updated_at,
        }))),
        events: Object.freeze(events.rows.map(event => Object.freeze({
          id: event.event_id,
          kind: event.event_kind,
          data: Object.freeze({ ...event.event_data }),
          createdAt: event.created_at,
        }))),
      });
    });
  }

  async listProjectArtifacts(workspaceId: string, projectId: string): Promise<readonly ArtifactRecord[]> {
    return this.database.withWorkspace(workspaceId, async client => {
      const result = await client.query<ArtifactRow>(
        `SELECT id::text, workspace_id::text, project_id::text, workflow_id::text,
                kind::text, target_platform::text, bucket, object_key, sha256,
                size_bytes::text, created_at::text
           FROM deviludo.artifacts
          WHERE project_id = $1::uuid
          ORDER BY created_at DESC, id DESC`,
        [projectId],
      );
      return Object.freeze(result.rows.map(artifactFromRow));
    });
  }

  async readProjectArtifact(workspaceId: string, projectId: string, artifactId: string): Promise<ArtifactRecord | null> {
    return this.database.withWorkspace(workspaceId, async client => {
      const result = await client.query<ArtifactRow>(
        `SELECT id::text, workspace_id::text, project_id::text, workflow_id::text,
                kind::text, target_platform::text, bucket, object_key, sha256,
                size_bytes::text, created_at::text
           FROM deviludo.artifacts
          WHERE project_id = $1::uuid AND id = $2::uuid`,
        [projectId, artifactId],
      );
      return result.rows[0] ? artifactFromRow(result.rows[0]) : null;
    });
  }

  async updateProjectDocument(input: Readonly<{
    actorUserId: string;
    workspaceId: string;
    projectId: string;
    expectedRevision: number;
    content: ProjectDocumentContent;
  }>): Promise<ProductProjectDetail | null> {
    await this.database.withWorkspace(input.workspaceId, async client => {
      const project = await client.query<{ name: string }>(
        "SELECT name FROM deviludo.projects WHERE id = $1::uuid FOR UPDATE",
        [input.projectId],
      );
      if (!project.rows[0]) return;
      const current = await client.query<{ revision: string }>(
        "SELECT revision::text FROM deviludo.project_documents WHERE project_id = $1::uuid FOR UPDATE",
        [input.projectId],
      );
      if (Number(current.rows[0]?.revision ?? 0) !== input.expectedRevision) {
        throw Object.assign(new Error("说明文档已被其他协作者更新，请刷新后重试"), {
          statusCode: 409,
          code: "PROJECT_DOCUMENT_REVISION_CONFLICT",
        });
      }
      const content = parseProjectDocumentContent(input.content);
      const markdown = projectDocumentMarkdown(project.rows[0].name, content);
      const revision = input.expectedRevision + 1;
      await touchProjectActivity(client, input.workspaceId, input.projectId);
      await client.query(
        `UPDATE deviludo.project_documents
            SET revision = $2::bigint, content = $3::jsonb, markdown = $4,
                maintained_by = 'USER', updated_by_actor_account_id = $5::uuid,
                updated_at = clock_timestamp()
          WHERE project_id = $1::uuid`,
        [input.projectId, revision, JSON.stringify(content), markdown, input.actorUserId],
      );
      await client.query(
        `INSERT INTO deviludo.project_document_revisions(
           workspace_id, project_id, revision, content, markdown, source, author_actor_account_id
         ) VALUES ($1::uuid, $2::uuid, $3::bigint, $4::jsonb, $5, 'USER_EDIT', $6::uuid)`,
        [input.workspaceId, input.projectId, revision, JSON.stringify(content), markdown, input.actorUserId],
      );
    });
    return this.readProject(input.workspaceId, input.projectId);
  }

  async deleteProject(
    workspaceId: string,
    projectId: string,
    beforeDelete?: () => Promise<void>,
  ): Promise<boolean> {
    return this.database.withWorkspace(workspaceId, async client => {
      const project = await client.query<{ id: string }>(
        `SELECT id::text FROM deviludo.projects
          WHERE workspace_id = $1::uuid AND id = $2::uuid
          FOR UPDATE`,
        [workspaceId, projectId],
      );
      if (!project.rows[0]) return false;

      const workflow = await client.query<{ state: string }>(
        `SELECT state::text FROM deviludo.workflow_instances
          WHERE workspace_id = $1::uuid AND project_id = $2::uuid
          ORDER BY created_at DESC LIMIT 1`,
        [workspaceId, projectId],
      );
      const state = workflow.rows[0]?.state ?? "DRAFT";
      if (!["DRAFT", "SUCCEEDED", "FAILED", "CANCELLED"].includes(state)) {
        await client.query(
          `UPDATE deviludo.workflow_instances
              SET state = 'CANCELLED', updated_at = clock_timestamp()
            WHERE workspace_id = $1::uuid AND project_id = $2::uuid
              AND state NOT IN ('SUCCEEDED', 'FAILED', 'CANCELLED')`,
          [workspaceId, projectId],
        );
        await client.query(
          `UPDATE deviludo.jobs
              SET state = 'CANCELLED', lease_owner = NULL, lease_token = NULL,
                  lease_expires_at = NULL, heartbeat_at = NULL,
                  fencing_token = fencing_token + 1, updated_at = clock_timestamp()
            WHERE workspace_id = $1::uuid AND project_id = $2::uuid
              AND state IN ('QUEUED', 'RETRY', 'RUNNING')`,
          [workspaceId, projectId],
        );
      }

      await beforeDelete?.();

      const params = [workspaceId, projectId];
      await client.query(
        `DELETE FROM deviludo.project_creation_receipts
          WHERE workspace_id = $1::uuid AND project_id = $2::uuid`,
        params,
      );
      await client.query(
        `DELETE FROM deviludo.artifact_inputs input
          WHERE input.workspace_id = $1::uuid
            AND (
              input.job_id IN (
                SELECT id FROM deviludo.jobs
                 WHERE workspace_id = $1::uuid AND project_id = $2::uuid
              )
              OR input.artifact_id IN (
                SELECT id FROM deviludo.artifacts
                 WHERE workspace_id = $1::uuid AND project_id = $2::uuid
              )
            )`,
        params,
      );
      for (const table of ["executor_receipts", "operation_receipts", "artifacts"] as const) {
        await client.query(
          `DELETE FROM deviludo.${table}
            WHERE workspace_id = $1::uuid AND project_id = $2::uuid`,
          params,
        );
      }
      await client.query(
        `DELETE FROM deviludo.external_signals signal
          WHERE signal.workspace_id = $1::uuid
            AND signal.workflow_id IN (
              SELECT id FROM deviludo.workflow_instances
               WHERE workspace_id = $1::uuid AND project_id = $2::uuid
            )`,
        params,
      );
      await client.query(
        `DELETE FROM deviludo.workflow_events event
          WHERE event.workspace_id = $1::uuid
            AND event.workflow_id IN (
              SELECT id FROM deviludo.workflow_instances
               WHERE workspace_id = $1::uuid AND project_id = $2::uuid
            )`,
        params,
      );
      for (const table of ["job_guidance_messages", "job_progress_events"] as const) {
        await client.query(
          `DELETE FROM deviludo.${table}
            WHERE workspace_id = $1::uuid AND project_id = $2::uuid`,
          params,
        );
      }
      await client.query(
        `DELETE FROM deviludo.project_document_revisions
          WHERE workspace_id = $1::uuid AND project_id = $2::uuid`,
        params,
      );
      await client.query(
        `DELETE FROM deviludo.project_documents
          WHERE workspace_id = $1::uuid AND project_id = $2::uuid`,
        params,
      );
      await client.query(
        `DELETE FROM deviludo.project_conversations
          WHERE workspace_id = $1::uuid AND project_id = $2::uuid`,
        params,
      );
      await client.query(
        `DELETE FROM deviludo.agent_installations
          WHERE workspace_id = $1::uuid AND project_id = $2::uuid`,
        params,
      );
      await client.query(
        `DELETE FROM deviludo.jobs
          WHERE workspace_id = $1::uuid AND project_id = $2::uuid`,
        params,
      );
      await client.query(
        `DELETE FROM deviludo.workflow_instances
          WHERE workspace_id = $1::uuid AND project_id = $2::uuid`,
        params,
      );
      const deleted = await client.query(
        `DELETE FROM deviludo.projects
          WHERE workspace_id = $1::uuid AND id = $2::uuid`,
        params,
      );
      return deleted.rowCount === 1;
    });
  }

  async listProjectConversations(
    workspaceId: string,
    projectId: string,
  ): Promise<readonly ProductConversationSummary[]> {
    return this.database.withWorkspace(workspaceId, async client => {
      const conversations = await client.query<ProductConversationSummaryRow>(
        `SELECT conversation.id::text, conversation.project_id::text,
                conversation.mode, conversation.title,
                conversation.created_at::text, conversation.updated_at::text,
                first_user.content AS preview,
                count(message.message_id)::text AS message_count
           FROM deviludo.project_conversations conversation
           LEFT JOIN deviludo.conversation_messages message
             ON message.workspace_id = conversation.workspace_id
            AND message.conversation_id = conversation.id
           LEFT JOIN LATERAL (
             SELECT content
               FROM deviludo.conversation_messages first_message
              WHERE first_message.workspace_id = conversation.workspace_id
                AND first_message.conversation_id = conversation.id
                AND first_message.role = 'USER'
              ORDER BY first_message.message_id
              LIMIT 1
           ) first_user ON true
          WHERE conversation.project_id = $1::uuid
          GROUP BY conversation.workspace_id, conversation.id, first_user.content
          ORDER BY conversation.updated_at DESC`,
        [projectId],
      );
      return Object.freeze(conversations.rows.map(conversation => Object.freeze({
        id: conversation.id,
        projectId: conversation.project_id,
        mode: conversation.mode,
        title: conversation.title,
        preview: conversation.preview ?? conversation.title,
        messageCount: Number(conversation.message_count),
        createdAt: conversation.created_at,
        updatedAt: conversation.updated_at,
      })));
    });
  }

  async readConversation(workspaceId: string, conversationId: string): Promise<ProductConversation | null> {
    return this.database.withWorkspace(workspaceId, async client => {
      const conversation = await client.query<ProductConversationRow>(
        `SELECT id::text, project_id::text, mode, title, created_at::text, updated_at::text
           FROM deviludo.project_conversations
          WHERE id = $1::uuid`,
        [conversationId],
      );
      return conversation.rows[0]
        ? this.readConversationMessages(client, conversation.rows[0])
        : null;
    });
  }

  async appendAgentGuidance(input: Readonly<{
    workspaceId: string;
    projectId: string;
    conversationId: string;
    content: string;
  }>): Promise<ProductConversation> {
    return this.database.withWorkspace(input.workspaceId, async client => {
      const project = await client.query<{ name: string }>(
        "SELECT name FROM deviludo.projects WHERE id = $1::uuid",
        [input.projectId],
      );
      const workflow = await client.query<{ id: string; state: string }>(
        `SELECT id::text, state::text
           FROM deviludo.workflow_instances
          WHERE project_id = $1::uuid
          ORDER BY created_at DESC
          LIMIT 1
          FOR UPDATE`,
        [input.projectId],
      );
      if (!project.rows[0] || !workflow.rows[0]) throw new Error("Project not found");
      if (workflow.rows[0].state !== "AGENT_RUNNING") {
        throw Object.assign(new Error("Agent 生成已经结束，请刷新后继续对话"), {
          statusCode: 409,
          code: "AGENT_NOT_RUNNING",
        });
      }
      const job = await client.query<{ id: string }>(
        `SELECT id::text
           FROM deviludo.jobs
          WHERE workflow_id = $1::uuid
            AND kind = 'AGENT_GENERATION'
            AND state IN ('QUEUED', 'RETRY', 'RUNNING')
          ORDER BY created_at DESC
          LIMIT 1
          FOR UPDATE`,
        [workflow.rows[0].id],
      );
      if (!job.rows[0]) throw new Error("Active Agent generation job is unavailable");

      const existing = await client.query<ProductConversationRow>(
        `SELECT id::text, project_id::text, mode, title, created_at::text, updated_at::text
           FROM deviludo.project_conversations
          WHERE id = $1::uuid
          FOR UPDATE`,
        [input.conversationId],
      );
      let conversation = existing.rows[0];
      if (conversation && conversation.project_id !== input.projectId) {
        throw new Error("A conversation cannot switch projects");
      }
      if (!conversation) {
        const created = await client.query<ProductConversationRow>(
          `INSERT INTO deviludo.project_conversations(workspace_id, id, project_id, mode, title)
           VALUES ($1::uuid, $2::uuid, $3::uuid, 'PROJECT_FEEDBACK', $4)
           RETURNING id::text, project_id::text, mode, title, created_at::text, updated_at::text`,
          [input.workspaceId, input.conversationId, input.projectId, project.rows[0].name],
        );
        conversation = created.rows[0];
      }
      await client.query(
        `INSERT INTO deviludo.conversation_messages(
           workspace_id, conversation_id, role, content, metadata
         ) VALUES ($1::uuid, $2::uuid, 'USER', $3, $4::jsonb)`,
        [input.workspaceId, input.conversationId, input.content, JSON.stringify({
          source: "PLAYER_GUIDANCE",
          jobId: job.rows[0].id,
        })],
      );
      await client.query(
        `INSERT INTO deviludo.job_guidance_messages(
           workspace_id, project_id, workflow_id, job_id, conversation_id, content
         ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6)`,
        [input.workspaceId, input.projectId, workflow.rows[0].id, job.rows[0].id, input.conversationId, input.content],
      );
      await client.query(
        `INSERT INTO deviludo.job_progress_events(
           workspace_id, project_id, workflow_id, job_id, event_kind, content
         ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'GUIDANCE_ACCEPTED', $5)`,
        [input.workspaceId, input.projectId, workflow.rows[0].id, job.rows[0].id, input.content],
      );
      const updated = await client.query<ProductConversationRow>(
        `UPDATE deviludo.project_conversations
            SET updated_at = clock_timestamp()
          WHERE id = $1::uuid
          RETURNING id::text, project_id::text, mode, title, created_at::text, updated_at::text`,
        [input.conversationId],
      );
      await touchProjectActivity(client, input.workspaceId, input.projectId);
      return this.readConversationMessages(client, updated.rows[0]);
    });
  }

  async appendJobProgress(
    job: JobProtocolV4,
    kind: AgentProgressEventKind,
    content: string,
  ): Promise<AgentProgressEvent | null> {
    const sanitized = content.replaceAll(/\u0000/g, "").slice(0, 4_000);
    const normalized = kind === "AGENT_OUTPUT" ? sanitized : sanitized.trim();
    if (normalized.length === 0) return null;
    return this.database.withWorkspace(job.workspaceId, async client => {
      const result = await client.query<AgentProgressEventRow>(
        `INSERT INTO deviludo.job_progress_events(
           workspace_id, project_id, workflow_id, job_id, event_kind, content
         )
         SELECT candidate.workspace_id, candidate.project_id, candidate.workflow_id, candidate.id, $4, $5
           FROM deviludo.jobs candidate
          WHERE candidate.id = $1::uuid
            AND candidate.lease_token = $2::uuid
            AND candidate.fencing_token = $3::bigint
         RETURNING sequence::text, job_id::text, event_kind, content, created_at::text`,
        [job.jobId, job.lease.token, job.lease.fencingToken, kind, normalized],
      );
      return result.rows[0] ? agentProgressEventFromRow(result.rows[0]) : null;
    });
  }

  async readAgentProgress(
    workspaceId: string,
    projectId: string,
    afterSequence = 0,
    limit = 200,
  ): Promise<readonly AgentProgressEvent[]> {
    return this.database.withWorkspace(workspaceId, async client => {
      const result = await client.query<AgentProgressEventRow>(
        `SELECT sequence::text, job_id::text, event_kind, content, created_at::text
           FROM deviludo.job_progress_events
          WHERE project_id = $1::uuid AND sequence > $2::bigint
          ORDER BY sequence
          LIMIT $3::integer`,
        [projectId, afterSequence, Math.min(Math.max(limit, 1), 500)],
      );
      return Object.freeze(result.rows.map(agentProgressEventFromRow));
    });
  }

  async readPendingAgentGuidance(job: JobProtocolV4): Promise<readonly Readonly<{ id: string; content: string }>[]> {
    return this.database.withWorkspace(job.workspaceId, async client => {
      const result = await client.query<{ id: string; content: string }>(
        `SELECT id::text, content
           FROM deviludo.job_guidance_messages
          WHERE job_id = $1::uuid AND state = 'PENDING'
          ORDER BY created_at
          LIMIT 20`,
        [job.jobId],
      );
      return Object.freeze(result.rows.map(row => Object.freeze(row)));
    });
  }

  async markAgentGuidanceDelivered(job: JobProtocolV4, guidanceId: string): Promise<boolean> {
    return this.database.withWorkspace(job.workspaceId, async client => {
      const result = await client.query(
        `UPDATE deviludo.job_guidance_messages
            SET state = 'DELIVERED', delivered_at = clock_timestamp()
          WHERE id = $1::uuid AND job_id = $2::uuid AND state = 'PENDING'`,
        [guidanceId, job.jobId],
      );
      return result.rowCount === 1;
    });
  }

  async appendConversationTurn(input: Readonly<{
    workspaceId: string;
    conversationId: string;
    projectId: string;
    userContent: string;
    expectedWorkflowState: string;
    assistantContent: string;
    assistantApplyToDraft: boolean;
    assistantProjectDocument: ProjectDocumentContent | null;
    assistantMetadata: Readonly<Record<string, unknown>>;
  }>): Promise<ProductConversation> {
    return this.database.withWorkspace(input.workspaceId, async client => {
      const existing = await client.query<ProductConversationRow>(
        `SELECT id::text, project_id::text, mode, title, created_at::text, updated_at::text
           FROM deviludo.project_conversations
          WHERE id = $1::uuid
          FOR UPDATE`,
        [input.conversationId],
      );
      let conversation = existing.rows[0];
      if (conversation && conversation.project_id !== input.projectId) {
        throw new Error("A conversation cannot switch projects");
      }

      let project: { name: string; workflowId: string; workflowState: string; stateData: Record<string, unknown> };
      {
        const projectResult = await client.query<{ name: string }>(
          `SELECT name FROM deviludo.projects WHERE id = $1::uuid`,
          [input.projectId],
        );
        const workflowResult = await client.query<{
          id: string;
          state: string;
          state_data: Record<string, unknown>;
        }>(
          `SELECT id::text, state::text, state_data
             FROM deviludo.workflow_instances
            WHERE project_id = $1::uuid
            ORDER BY created_at DESC
            LIMIT 1
            FOR UPDATE`,
          [input.projectId],
        );
        if (!projectResult.rows[0] || !workflowResult.rows[0]) throw new Error("Project not found");
        project = {
          name: projectResult.rows[0].name,
          workflowId: workflowResult.rows[0].id,
          workflowState: workflowResult.rows[0].state,
          stateData: workflowResult.rows[0].state_data,
        };
      }
      if (project.workflowState !== input.expectedWorkflowState) {
        throw Object.assign(new Error("项目状态已变化，请重试本次对话"), {
          statusCode: 409,
          code: "PROJECT_STATE_CHANGED",
        });
      }

      if (!conversation) {
        const created = await client.query<ProductConversationRow>(
          `INSERT INTO deviludo.project_conversations(workspace_id, id, project_id, mode, title)
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5)
           RETURNING id::text, project_id::text, mode, title, created_at::text, updated_at::text`,
          [
            input.workspaceId,
            input.conversationId,
            input.projectId,
            "PROJECT_FEEDBACK",
            project.name,
          ],
        );
        conversation = created.rows[0];
      }

      const userMessage = await client.query<{ message_id: string }>(
        `INSERT INTO deviludo.conversation_messages(workspace_id, conversation_id, role, content)
         VALUES ($1::uuid, $2::uuid, 'USER', $3)
         RETURNING message_id::text`,
        [input.workspaceId, input.conversationId, input.userContent],
      );
      await touchProjectActivity(client, input.workspaceId, input.projectId);
      const appliedToDraft = input.assistantApplyToDraft && project.workflowState === "DRAFT";
      let projectDocumentUpdated = false;

      if (appliedToDraft) {
        const specification = productSpecificationFromState(project.stateData);
        await client.query(
          `UPDATE deviludo.workflow_instances
              SET state_data = state_data || jsonb_build_object('specification', $2::jsonb),
                  version = version + 1,
                  updated_at = clock_timestamp()
            WHERE id = $1::uuid AND state = 'DRAFT'`,
          [project.workflowId, JSON.stringify(appendRevisionNote(specification, input.userContent))],
        );
        await client.query(
          `INSERT INTO deviludo.workflow_events(
             workspace_id, workflow_id, event_kind, event_data, idempotency_key
           ) VALUES ($1::uuid, $2::uuid, 'SPEC_REFINED', $3::jsonb, $4)
           ON CONFLICT (workspace_id, workflow_id, idempotency_key) DO NOTHING`,
          [
            input.workspaceId,
            project.workflowId,
            JSON.stringify({ note: input.userContent, source: "HOME_CONVERSATION" }),
            `conversation:${input.conversationId}:${userMessage.rows[0].message_id}`,
          ],
        );
      }

      if (input.assistantProjectDocument && project.workflowState === "DRAFT") {
        const content = parseProjectDocumentContent(input.assistantProjectDocument);
        const currentDocument = await client.query<{ revision: string; content: Record<string, unknown> }>(
          `SELECT revision::text, content
             FROM deviludo.project_documents
            WHERE project_id = $1::uuid
            FOR UPDATE`,
          [input.projectId],
        );
        const current = currentDocument.rows[0];
        if (!current) throw new Error("Project document not found");
        if (JSON.stringify(current.content) !== JSON.stringify(content)) {
          const revision = Number(current.revision) + 1;
          const markdown = projectDocumentMarkdown(project.name, content);
          await client.query(
            `UPDATE deviludo.project_documents
                SET revision = $2::bigint, content = $3::jsonb, markdown = $4,
                    maintained_by = 'AGENT', updated_by_actor_account_id = NULL,
                    last_agent_maintained_at = clock_timestamp(), updated_at = clock_timestamp()
              WHERE project_id = $1::uuid`,
            [input.projectId, revision, JSON.stringify(content), markdown],
          );
          await client.query(
            `INSERT INTO deviludo.project_document_revisions(
               workspace_id, project_id, revision, content, markdown, source
             ) VALUES ($1::uuid, $2::uuid, $3::bigint, $4::jsonb, $5, 'AGENT_CONVERSATION')`,
            [input.workspaceId, input.projectId, revision, JSON.stringify(content), markdown],
          );
          projectDocumentUpdated = true;
        }
      }

      await client.query(
        `INSERT INTO deviludo.conversation_messages(workspace_id, conversation_id, role, content, metadata)
         VALUES ($1::uuid, $2::uuid, 'ASSISTANT', $3, $4::jsonb)`,
        [
          input.workspaceId,
          input.conversationId,
          input.assistantContent,
          JSON.stringify({ ...input.assistantMetadata, appliedToDraft, projectDocumentUpdated }),
        ],
      );
      const updated = await client.query<ProductConversationRow>(
        `UPDATE deviludo.project_conversations
            SET updated_at = clock_timestamp()
          WHERE id = $1::uuid
          RETURNING id::text, project_id::text, mode, title, created_at::text, updated_at::text`,
        [input.conversationId],
      );
      return this.readConversationMessages(client, updated.rows[0]);
    });
  }

  private async readConversationMessages(
    client: PoolClient,
    conversation: ProductConversationRow,
  ): Promise<ProductConversation> {
    const messages = await client.query<ProductConversationMessageRow>(
      `SELECT message_id::text, role, content, metadata, created_at::text
         FROM deviludo.conversation_messages
        WHERE conversation_id = $1::uuid
        ORDER BY message_id`,
      [conversation.id],
    );
    return Object.freeze({
      id: conversation.id,
      projectId: conversation.project_id,
      mode: conversation.mode,
      title: conversation.title,
      createdAt: conversation.created_at,
      updatedAt: conversation.updated_at,
      messages: Object.freeze(messages.rows.map(message => Object.freeze({
        id: message.message_id,
        role: message.role,
        content: message.content,
        metadata: Object.freeze({ ...message.metadata }),
        createdAt: message.created_at,
      }))),
    });
  }

  async createServerNode(input: Readonly<{
    poolKind: ServerPoolKind;
    operatingSystem: ServerOperatingSystem;
    capabilities: readonly string[];
  }>): Promise<ServerNodeRecord> {
    const result = await this.database.pool.query<ServerNodeRow>(
      `INSERT INTO deviludo.server_nodes (pool_kind, operating_system, capabilities)
       VALUES ($1::deviludo.server_pool_kind, $2::deviludo.server_os, $3::text[])
       RETURNING id::text, pool_kind::text, operating_system::text, state::text, capabilities,
                 isolation_generation::text, current_workspace_id::text, last_heartbeat_at::text,
                 last_reimage_proof_at::text`,
      [input.poolKind, input.operatingSystem, input.capabilities],
    );
    return serverNodeFromRow(result.rows[0]);
  }

  async transitionServerNode(id: string, state: ServerNodeState): Promise<ServerNodeRecord | null> {
    const result = await this.database.pool.query<ServerNodeRow>(
      `UPDATE deviludo.server_nodes
          SET state = $2::deviludo.server_node_state,
              updated_at = clock_timestamp()
        WHERE id = $1::uuid
        RETURNING id::text, pool_kind::text, operating_system::text, state::text, capabilities,
                  isolation_generation::text, current_workspace_id::text, last_heartbeat_at::text,
                  last_reimage_proof_at::text`,
      [id, state],
    );
    return result.rows[0] ? serverNodeFromRow(result.rows[0]) : null;
  }

  async createE2eEnrollmentToken(input: Readonly<{
    tokenHash: string;
    poolKind: Extract<ServerPoolKind, `E2E_${string}`>;
    createdBy: string;
  }>): Promise<{ id: string; expiresAt: string }> {
    const result = await this.database.pool.query<{ id: string; expires_at: string }>(
      `INSERT INTO deviludo.e2e_enrollment_tokens(token_hash, pool_kind, expires_at, created_by_actor_account_id)
       VALUES ($1, $2::deviludo.server_pool_kind, clock_timestamp() + interval '30 minutes', $3::uuid)
       RETURNING id::text, expires_at::text`,
      [input.tokenHash, input.poolKind, input.createdBy],
    );
    return Object.freeze({ id: result.rows[0].id, expiresAt: result.rows[0].expires_at });
  }

  async reserveE2eEnrollment(input: Readonly<{
    tokenHash: string;
    poolKind: Extract<ServerPoolKind, `E2E_${string}`>;
    operatingSystem: ServerOperatingSystem;
    receiptPublicKey: string;
  }>): Promise<string> {
    const client = await this.database.pool.connect();
    try {
      await client.query("BEGIN");
      const token = await client.query<{ id: string }>(
        `SELECT id::text FROM deviludo.e2e_enrollment_tokens
          WHERE token_hash = $1 AND pool_kind = $2::deviludo.server_pool_kind
            AND used_at IS NULL AND expires_at > clock_timestamp()
          FOR UPDATE`,
        [input.tokenHash, input.poolKind],
      );
      if (!token.rows[0]) throw Object.assign(new Error("Enrollment token is invalid or expired"), { statusCode: 401 });
      const node = await client.query<{ id: string }>(
        `INSERT INTO deviludo.server_nodes(pool_kind, operating_system, state, capabilities)
         VALUES ($1::deviludo.server_pool_kind, $2::deviludo.server_os, 'PROVISIONING',
                 ARRAY['E2E_TEST','ARTIFACT_SIGN','STEAM_CLEAN_INSTALL'])
         RETURNING id::text`,
        [input.poolKind, input.operatingSystem],
      );
      await client.query(
        `UPDATE deviludo.e2e_enrollment_tokens
            SET used_at = clock_timestamp(), node_id = $2::uuid WHERE id = $1::uuid`,
        [token.rows[0].id, node.rows[0].id],
      );
      await client.query(
        `INSERT INTO deviludo.executor_identities(executor_id, identity_kind, node_id, public_key_pem)
         VALUES ($1, 'E2E', $1::uuid, $2)`,
        [node.rows[0].id, input.receiptPublicKey],
      );
      await client.query("COMMIT");
      return node.rows[0].id;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async saveE2eCertificate(input: Readonly<{
    nodeId: string;
    serialNumber: string;
    spiffeUri: string;
    notAfter: string;
  }>): Promise<void> {
    await this.database.pool.query(
      `INSERT INTO deviludo.e2e_node_certificates(node_id, serial_number, spiffe_uri, not_after)
       VALUES ($1::uuid, $2, $3, $4::timestamptz)
       ON CONFLICT (node_id) DO UPDATE SET serial_number = EXCLUDED.serial_number,
         spiffe_uri = EXCLUDED.spiffe_uri, not_after = EXCLUDED.not_after,
         renewed_at = clock_timestamp()`,
      [input.nodeId, input.serialNumber, input.spiffeUri, input.notAfter],
    );
    await this.database.pool.query(
      "UPDATE deviludo.server_nodes SET state = 'ACTIVE', updated_at = clock_timestamp() WHERE id = $1::uuid",
      [input.nodeId],
    );
  }

  async claimJob(input: Readonly<{
    workerId: string;
    poolKind: ServerPoolKind;
    leaseSeconds: number;
  }>): Promise<JobProtocolV4 | null> {
    const claimed = await this.database.pool.query<ClaimRow>(
      `SELECT "jobId"::text, "workspaceId"::text, "leaseToken"::text
         FROM deviludo.claim_job($1, $2::deviludo.server_pool_kind, $3)`,
      [input.workerId, input.poolKind, input.leaseSeconds],
    );
    if (!claimed.rows[0]) return null;
    const identity: ClaimedJobIdentity = Object.freeze({
      jobId: claimed.rows[0].jobId,
      workspaceId: claimed.rows[0].workspaceId,
      leaseToken: claimed.rows[0].leaseToken,
    });
    return this.database.withWorkspace(identity.workspaceId, async client => this.readClaimedJob(client, identity));
  }

  async loadLeasedJob(identity: ClaimedJobIdentity, expectedLeaseOwner?: string): Promise<JobProtocolV4> {
    return this.database.withWorkspace(identity.workspaceId, async client => this.readClaimedJob(client, identity, expectedLeaseOwner));
  }

  async heartbeat(job: JobProtocolV4): Promise<boolean> {
    return this.database.withWorkspace(job.workspaceId, async client => {
      const result = await client.query(
        `UPDATE deviludo.jobs
            SET heartbeat_at = clock_timestamp(),
                lease_expires_at = clock_timestamp() + interval '60 seconds',
                updated_at = clock_timestamp()
          WHERE id = $1::uuid
            AND state = 'RUNNING'
            AND lease_token = $2::uuid
            AND fencing_token = $3::bigint`,
        [job.jobId, job.lease.token, job.lease.fencingToken],
      );
      return result.rowCount === 1;
    });
  }

  async complete(job: JobProtocolV4, completion: JobCompletion): Promise<boolean> {
    const identity = await this.database.pool.query<{ public_key_pem: string; identity_kind: string; node_id: string | null }>(
      `SELECT public_key_pem, identity_kind, node_id::text
         FROM deviludo.executor_identities
        WHERE executor_id = $1 AND enabled = true`,
      [completion.executorReceipt.executorId],
    );
    const executor = identity.rows[0];
    const expectedKind = job.poolKind === "CORE" ? "CORE" : "E2E";
    if (!executor || executor.identity_kind !== expectedKind
      || (expectedKind === "E2E" && executor.node_id !== completion.executorReceipt.executorId)
      || !verify(
        null,
        executorReceiptSigningPayload(completion.executorReceipt),
        executor.public_key_pem,
        Buffer.from(completion.executorReceipt.signature, "base64url"),
      )) {
      throw new Error("Executor receipt signature or identity is invalid");
    }
    if (job.poolKind !== "CORE") {
      verifyIsolationProof(completion.beforeReimageProof, executor.public_key_pem, job, "reimage", "before");
      verifyIsolationProof(completion.cleanupProof, executor.public_key_pem, job, "cleanup", "after");
      verifyIsolationProof(completion.afterReimageProof, executor.public_key_pem, job, "reimage", "after");
    } else {
      verifyCoreExecutorProof(completion.executorReceipt.isolationProof, executor.public_key_pem, job, "isolated");
      verifyCoreExecutorProof(completion.executorReceipt.cleanupProof, executor.public_key_pem, job, "cleaned");
    }
    return this.database.withWorkspace(job.workspaceId, async client => {
      const result = await client.query<{ completed: boolean }>(
        `SELECT deviludo.complete_job(
          $1::uuid, $2::uuid, $3::bigint, $4::bigint, $5::jsonb, $6::jsonb,
          $7::text, $8::text, $9::text
        ) AS completed`,
        [
          job.jobId,
          completion.leaseToken,
          completion.fencingToken,
          completion.isolationGeneration,
          JSON.stringify(completion.receipt),
          JSON.stringify(completion.executorReceipt),
          completion.beforeReimageProof ?? null,
          completion.cleanupProof ?? null,
          completion.afterReimageProof ?? null,
        ],
      );
      return result.rows[0]?.completed === true;
    });
  }

  async fail(job: JobProtocolV4, reason: string): Promise<boolean> {
    return this.database.withWorkspace(job.workspaceId, async client => {
      const result = await client.query<{ failed: boolean }>(
        "SELECT deviludo.fail_job($1::uuid, $2::uuid, $3::bigint, $4::text) AS failed",
        [job.jobId, job.lease.token, job.lease.fencingToken, reason.slice(0, 2_000)],
      );
      return result.rows[0]?.failed === true;
    });
  }

  async recoverExpiredJobs(): Promise<number> {
    const result = await this.database.pool.query<{ recovered: string }>(
      "SELECT deviludo.recover_expired_jobs()::text AS recovered",
    );
    return Number(result.rows[0]?.recovered ?? 0);
  }

  async reconcileCapacity(): Promise<void> {
    await this.database.pool.query("SELECT deviludo.reconcile_p0_capacity()");
  }

  async cleanupExpiredAuthState(): Promise<number> {
    const result = await this.database.pool.query<{ removed: string }>(
      "SELECT deviludo.cleanup_expired_executor_state()::text AS removed",
    );
    return Number(result.rows[0]?.removed ?? 0);
  }

  async scheduleIdleProjectDocumentMaintenance(idleSeconds: number): Promise<number> {
    const result = await this.database.pool.query<{ scheduled: string }>(
      "SELECT deviludo.schedule_idle_project_document_maintenance($1::integer, 20)::text AS scheduled",
      [idleSeconds],
    );
    return Number(result.rows[0]?.scheduled ?? 0);
  }

  async appendSignal(
    workspaceId: string,
    workflowId: string,
    signal: WorkflowSignalInput,
  ): Promise<boolean> {
    return this.database.withWorkspace(workspaceId, async client => {
      const workflow = await client.query<{ project_id: string }>(
        "SELECT project_id::text FROM deviludo.workflow_instances WHERE id = $1::uuid",
        [workflowId],
      );
      if (workflow.rows[0]) await touchProjectActivity(client, workspaceId, workflow.rows[0].project_id);
      const result = await client.query<{ accepted: boolean }>(
        `SELECT deviludo.accept_workflow_signal(
          $1::uuid, $2::text, $3::text, $4::jsonb
        ) AS accepted`,
        [workflowId, signal.kind, signal.idempotencyKey, JSON.stringify(signal.payload)],
      );
      return result.rows[0]?.accepted === true;
    });
  }

  async workflowSignalExists(
    workspaceId: string,
    workflowId: string,
    idempotencyKey: string,
  ): Promise<boolean> {
    return this.database.withWorkspace(workspaceId, async client => {
      const result = await client.query(
        `SELECT 1 FROM deviludo.external_signals
          WHERE workflow_id = $1::uuid AND idempotency_key = $2
          LIMIT 1`,
        [workflowId, idempotencyKey],
      );
      return result.rowCount === 1;
    });
  }

  async registerSpecificationArtifact(input: Readonly<{
    workspaceId: string;
    projectId: string;
    workflowId: string;
    object: Readonly<{ bucket: string; key: string; sha256: string; sizeBytes: number }>;
  }>): Promise<void> {
    await this.database.withWorkspace(input.workspaceId, async client => {
      await client.query(
        `INSERT INTO deviludo.artifacts(
           workspace_id, project_id, workflow_id, kind, bucket, object_key, sha256, size_bytes
         ) VALUES ($1::uuid, $2::uuid, $3::uuid, 'SPECIFICATION', $4, $5, $6, $7::bigint)
         ON CONFLICT (workspace_id, object_key, sha256) DO NOTHING`,
        [input.workspaceId, input.projectId, input.workflowId, input.object.bucket, input.object.key, input.object.sha256, input.object.sizeBytes],
      );
    });
  }

  async beginOperation(job: JobProtocolV4, operationKind: string): Promise<string> {
    return this.database.withWorkspace(job.workspaceId, async client => {
      await client.query(
        `INSERT INTO deviludo.operation_receipts
          (workspace_id, project_id, workflow_id, job_id, operation_kind, idempotency_key, state, request)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, 'REGISTERED', $7::jsonb)
         ON CONFLICT (workspace_id, idempotency_key) DO NOTHING`,
        [
          job.workspaceId,
          job.projectId,
          job.workflowId,
          job.jobId,
          operationKind,
          `${job.jobId}:${operationKind}`,
          JSON.stringify(job.payload),
        ],
      );
      const result = await client.query<{ id: string; state: string }>(
        `SELECT id::text, state FROM deviludo.operation_receipts
          WHERE workspace_id = $1::uuid AND idempotency_key = $2 FOR UPDATE`,
        [job.workspaceId, `${job.jobId}:${operationKind}`],
      );
      if (result.rows[0]?.state !== "REGISTERED") {
        throw new Error(`External operation ${operationKind} requires manual reconciliation before retry`);
      }
      await client.query(
        `UPDATE deviludo.operation_receipts SET state = 'IN_PROGRESS', updated_at = clock_timestamp()
          WHERE id = $1::uuid`,
        [result.rows[0].id],
      );
      return result.rows[0].id;
    });
  }

  async finishOperation(
    job: JobProtocolV4,
    operationId: string,
    receipt: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    await this.database.withWorkspace(job.workspaceId, async client => {
      const result = await client.query(
        `UPDATE deviludo.operation_receipts
            SET state = 'RECEIPTED', receipt = $2::jsonb, updated_at = clock_timestamp()
          WHERE id = $1::uuid AND job_id = $3::uuid AND state = 'IN_PROGRESS'`,
        [operationId, JSON.stringify(receipt), job.jobId],
      );
      if (result.rowCount !== 1) throw new Error("Operation receipt was fenced or already reconciled");
    });
  }

  private async readClaimedJob(client: PoolClient, identity: ClaimedJobIdentity, expectedLeaseOwner?: string): Promise<JobProtocolV4> {
    const result = await client.query<JobRow>(
      `SELECT job.id::text, job.workflow_id::text, job.workspace_id::text, job.project_id::text,
              job.pool_kind::text, job.kind::text, job.target_operating_system::text,
              job.required_capabilities, job.exclusive, job.isolation_generation::text, job.payload,
              job.runtime_image, job.timeout_seconds, job.budget, job.output_contract,
              workflow.profile::text AS workflow_profile,
              lease_token::text, lease_expires_at::text, fencing_token::text
         FROM deviludo.jobs job
         JOIN deviludo.workflow_instances workflow
           ON workflow.workspace_id = job.workspace_id AND workflow.id = job.workflow_id
        WHERE job.id = $1::uuid AND job.lease_token = $2::uuid AND job.state = 'RUNNING'
          AND ($3::text IS NULL OR job.lease_owner = $3::text)`,
      [identity.jobId, identity.leaseToken, expectedLeaseOwner ?? null],
    );
    const row = result.rows[0];
    if (!row) throw new Error("Claimed job body is unavailable in the workspace transaction");
    if (!isServerPoolKind(row.pool_kind) || !isJobKind(row.kind)
      || !["linux", "windows", "macos", null].includes(row.target_operating_system as never)) {
      throw new Error("Stored job routing contract is invalid");
    }
    assertJobPlacement({
      kind: row.kind,
      poolKind: row.pool_kind,
      targetOperatingSystem: row.target_operating_system ?? undefined,
    });
    const inputObjects = await client.query<{
      bucket: string;
      object_key: string;
      sha256: `sha256:${string}`;
      size_bytes: string;
      kind: string;
      target_platform: ServerOperatingSystem | null;
    }>(
      `SELECT artifact.bucket, artifact.object_key, artifact.sha256, artifact.size_bytes::text,
              artifact.kind::text, artifact.target_platform::text
         FROM deviludo.artifact_inputs input
         JOIN deviludo.artifacts artifact
           ON artifact.workspace_id = input.workspace_id AND artifact.id = input.artifact_id
        WHERE input.job_id = $1::uuid AND input.expected_sha256 = artifact.sha256
        ORDER BY artifact.created_at, artifact.id`,
      [row.id],
    );
    return Object.freeze({
      schemaVersion: "deviludo.job.v4",
      jobId: row.id,
      workflowId: row.workflow_id,
      workspaceId: row.workspace_id,
      projectId: row.project_id,
      poolKind: row.pool_kind,
      jobKind: row.kind,
      targetOperatingSystem: row.target_operating_system,
      requiredCapabilities: Object.freeze([...row.required_capabilities]),
      exclusive: row.exclusive,
      isolationGeneration: Number(row.isolation_generation),
      runtimeImage: row.runtime_image,
      workflowProfile: row.workflow_profile,
      inputObjects: Object.freeze(inputObjects.rows.map(item => Object.freeze({
        kind: item.kind,
        ...(item.target_platform ? { targetPlatform: item.target_platform } : {}),
        bucket: item.bucket,
        key: item.object_key,
        sha256: item.sha256,
        sizeBytes: Number(item.size_bytes),
      }))),
      outputContract: Object.freeze({
        kinds: Object.freeze(Array.isArray(row.output_contract.kinds)
          ? row.output_contract.kinds.filter((item): item is string => typeof item === "string")
          : []),
        maxBytes: Number(row.output_contract.maxBytes ?? 0),
      }),
      budget: Object.freeze({
        cpuMillis: Number(row.budget.cpuMillis ?? 0),
        memoryBytes: Number(row.budget.memoryBytes ?? 0),
        networkBytes: Number(row.budget.networkBytes ?? 0),
      }),
      timeoutSeconds: row.timeout_seconds,
      payload: Object.freeze({ ...row.payload }),
      lease: Object.freeze({
        token: row.lease_token,
        expiresAt: row.lease_expires_at,
        fencingToken: Number(row.fencing_token),
      }),
    });
  }
}

function verifyIsolationProof(
  value: string | undefined,
  publicKey: string,
  job: JobProtocolV4,
  action: "reimage" | "cleanup",
  stage: "before" | "after",
): void {
  const [encoded, signature, extra] = String(value ?? "").split(".");
  if (!encoded || !signature || extra) throw new Error("Isolation proof envelope is invalid");
  const raw = Buffer.from(encoded, "base64url");
  let payload: Record<string, unknown>;
  try { payload = JSON.parse(raw.toString("utf8")); } catch { throw new Error("Isolation proof payload is invalid"); }
  if (payload.schemaVersion !== "deviludo.isolation-proof.v1" || payload.action !== action || payload.stage !== stage
    || payload.jobId !== job.jobId || payload.workspaceId !== job.workspaceId
    || payload.isolationGeneration !== job.isolationGeneration || payload.fencingToken !== job.lease.fencingToken
    || typeof payload.evidenceSha256 !== "string" || !/^sha256:[0-9a-f]{64}$/.test(payload.evidenceSha256)
    || !verify(null, raw, publicKey, Buffer.from(signature, "base64url"))) {
    throw new Error("Isolation proof signature or fencing identity is invalid");
  }
}

function verifyCoreExecutorProof(
  value: string | undefined,
  publicKey: string,
  job: JobProtocolV4,
  stage: "isolated" | "cleaned",
): void {
  const [actualStage, algorithm, signature, extra] = String(value ?? "").split(":");
  const payload = `${stage}:${job.jobId}:${job.isolationGeneration}:${job.lease.fencingToken}`;
  if (actualStage !== stage || algorithm !== "ed25519" || !signature || extra
    || !verify(null, Buffer.from(payload), publicKey, Buffer.from(signature, "base64url"))) {
    throw new Error("Core isolation proof signature or fencing identity is invalid");
  }
}

type ServerNodeRow = {
  id: string;
  pool_kind: string;
  operating_system: string;
  state: string;
  capabilities: string[];
  isolation_generation: string;
  current_workspace_id: string | null;
  last_heartbeat_at: string | null;
  last_reimage_proof_at: string | null;
};

function serverNodeFromRow(row: ServerNodeRow): ServerNodeRecord {
  if (!row || !isServerPoolKind(row.pool_kind)
    || !["linux", "windows", "macos"].includes(row.operating_system)
    || !["PROVISIONING", "ACTIVE", "DRAINING", "DISABLED", "REIMAGING"].includes(row.state)
    || !Number.isSafeInteger(Number(row.isolation_generation))
    || Number(row.isolation_generation) < 1) {
    throw new Error("Stored server node is invalid");
  }
  return Object.freeze({
    id: row.id,
    poolKind: row.pool_kind,
    operatingSystem: row.operating_system as ServerOperatingSystem,
    state: row.state as ServerNodeState,
    capabilities: Object.freeze([...row.capabilities]),
    isolationGeneration: Number(row.isolation_generation),
    currentWorkspaceId: row.current_workspace_id,
    lastHeartbeatAt: row.last_heartbeat_at,
    lastReimageProofAt: row.last_reimage_proof_at,
  });
}

type ClaimRow = { jobId: string; workspaceId: string; leaseToken: string };
type SourceReadyEventRow = {
  event_id: string;
  workspace_id: string;
  project_id: string;
  workflow_id: string;
  source_revision: string;
  content_digest: string;
  development_actor_account_id: string;
  created_at: string;
};
export type SourceReadyEvent = Readonly<{
  eventId: string;
  workspaceId: string;
  projectId: string;
  workflowId: string;
  sourceRevision: number;
  digest: string;
  developmentActorAccountId: string;
  createdAt: string;
}>;
type AgentSettingsRow = {
  agent_runtime: string;
  base_url: string;
  primary_model: string | null;
  opus_model: string | null;
  sonnet_model: string | null;
  haiku_model: string | null;
  subagent_model: string | null;
  credential_secret_ref: string;
  api_key_mask: string | null;
  api_key_fingerprint: string;
  credential_version: string;
  revision: string;
  updated_by: string;
  updated_at: string;
};

export type StoredInstanceAgentSettings = Readonly<{
  agentRuntime: AgentRuntimeKind;
  baseUrl: string;
  models: AgentModelConfiguration | null;
  credentialSecretRef: string;
  apiKeyMask: string | null;
  apiKeyFingerprint: string;
  credentialVersion: string;
  revision: number;
  updatedBy: string;
  updatedAt: string;
}>;

function agentSettingsFromRow(row: AgentSettingsRow): StoredInstanceAgentSettings {
  const revision = Number(row.revision);
  const models = normalizeAgentModels(row.primary_model === null ? null : {
    primary: row.primary_model,
    opus: row.opus_model,
    sonnet: row.sonnet_model,
    haiku: row.haiku_model,
    subagent: row.subagent_model,
  });
  if (!(AGENT_RUNTIME_KINDS as readonly string[]).includes(row.agent_runtime)
    || !Number.isSafeInteger(revision) || revision < 1
    || !row.credential_secret_ref.startsWith("vault://instance/agent-runtime/api-key/versions/")
    || (row.api_key_mask !== null && !/^.{3}\*{8}.{4}$/.test(row.api_key_mask))
    || !/^sha256:[0-9a-f]{12}$/.test(row.api_key_fingerprint)) {
    throw new Error("Stored instance Agent settings are invalid");
  }
  return Object.freeze({
    agentRuntime: row.agent_runtime as AgentRuntimeKind,
    baseUrl: row.base_url,
    models,
    credentialSecretRef: row.credential_secret_ref,
    apiKeyMask: row.api_key_mask,
    apiKeyFingerprint: row.api_key_fingerprint,
    credentialVersion: row.credential_version,
    revision,
    updatedBy: row.updated_by,
    updatedAt: row.updated_at,
  });
}

type JobRow = {
  id: string;
  workflow_id: string;
  workspace_id: string;
  project_id: string;
  pool_kind: string;
  kind: string;
  target_operating_system: ServerOperatingSystem | null;
  required_capabilities: string[];
  exclusive: boolean;
  isolation_generation: string;
  payload: Record<string, unknown>;
  runtime_image: string;
  workflow_profile: "VALIDATE" | "RELEASE";
  timeout_seconds: number;
  budget: Record<string, unknown>;
  output_contract: Record<string, unknown>;
  lease_token: string;
  lease_expires_at: string;
  fencing_token: string;
};

export type ProductProjectSummary = Readonly<{
  id: string;
  name: string;
  createdAt: string;
  workflowId: string;
  workflowState: string;
  workflowUpdatedAt: string;
  workflowProfile: "VALIDATE" | "RELEASE";
  targetPlatforms: readonly ServerOperatingSystem[];
  concept: string;
  specification: Readonly<Record<string, unknown>>;
  source: ProjectSourceRevision | null;
}>;

export type ProductProjectDetail = ProductProjectSummary & Readonly<{
  document: Readonly<{
    revision: number;
    content: ProjectDocumentContent;
    markdown: string;
    maintainedBy: "SYSTEM" | "USER" | "AGENT";
    lastAgentMaintainedAt: string | null;
    updatedAt: string;
    revisions: readonly Readonly<{
      revision: number;
      source: "PROJECT_CREATED" | "PROJECT_IMPORTED" | "USER_EDIT" | "AGENT_CONVERSATION" | "AGENT_IDLE_MAINTENANCE";
      authorUsername: string | null;
      createdAt: string;
    }>[];
  }>;
  jobs: readonly Readonly<{
    id: string;
    kind: string;
    poolKind: string;
    targetOperatingSystem: string | null;
    state: string;
    attempt: number;
    lastError: string | null;
    createdAt: string;
    updatedAt: string;
  }>[];
  events: readonly Readonly<{
    id: string;
    kind: string;
    data: Readonly<Record<string, unknown>>;
    createdAt: string;
  }>[];
}>;

export type ProductConversation = Readonly<{
  id: string;
  projectId: string;
  mode: "NEW_GAME" | "PROJECT_FEEDBACK";
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: readonly Readonly<{
    id: string;
    role: "USER" | "ASSISTANT";
    content: string;
    metadata: Readonly<Record<string, unknown>>;
    createdAt: string;
  }>[];
}>;

export type ProductConversationSummary = Readonly<{
  id: string;
  projectId: string;
  mode: "NEW_GAME" | "PROJECT_FEEDBACK";
  title: string;
  preview: string;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
}>;

type ProductConversationRow = {
  id: string;
  project_id: string;
  mode: "NEW_GAME" | "PROJECT_FEEDBACK";
  title: string;
  created_at: string;
  updated_at: string;
};

type ProductConversationSummaryRow = ProductConversationRow & {
  preview: string | null;
  message_count: string;
};

type ProductConversationMessageRow = {
  message_id: string;
  role: "USER" | "ASSISTANT";
  content: string;
  metadata: Record<string, unknown>;
  created_at: string;
};

type AgentProgressEventRow = {
  sequence: string;
  job_id: string;
  event_kind: AgentProgressEventKind;
  content: string;
  created_at: string;
};

type WorkspaceRow = { id: string; name: string; created_at: string };

type CreationReceiptRow = {
  idempotency_key: string;
  operation_kind: "PROJECT" | "CONVERSATION";
  workspace_id: string;
  project_id: string;
  conversation_id: string | null;
};

export type CreationReceipt = Readonly<{
  idempotencyKey: string;
  operationKind: "PROJECT" | "CONVERSATION";
  workspaceId: string;
  projectId: string;
  conversationId: string | null;
}>;

type ProductProjectRow = {
  id: string;
  name: string;
  created_at: string;
  workflow_id: string | null;
  workflow_state: string | null;
  state_data: Record<string, unknown> | null;
  workflow_updated_at: string | null;
  profile: "VALIDATE" | "RELEASE" | null;
  target_platforms: ServerOperatingSystem[] | null;
  source_revision: string | null;
  source_relative_path: string | null;
  source_digest: string | null;
  source_file_count: string | null;
  source_total_bytes: string | null;
  source_created_at: string | null;
};

type ProductJobRow = {
  id: string;
  kind: string;
  pool_kind: string;
  target_operating_system: string | null;
  state: string;
  attempt: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
};

type ProductEventRow = {
  event_id: string;
  event_kind: string;
  event_data: Record<string, unknown>;
  created_at: string;
};

type ArtifactRow = {
  id: string;
  workspace_id: string;
  project_id: string;
  workflow_id: string;
  kind: ArtifactRecord["kind"];
  target_platform: ArtifactRecord["targetPlatform"];
  bucket: string;
  object_key: string;
  sha256: string;
  size_bytes: string;
  created_at: string;
};

type ProjectDocumentRow = {
  revision: string;
  content: Record<string, unknown>;
  markdown: string;
  maintained_by: "SYSTEM" | "USER" | "AGENT";
  last_agent_maintained_at: string | null;
  updated_at: string;
};

type ProjectDocumentRevisionRow = {
  revision: string;
  source: "PROJECT_CREATED" | "PROJECT_IMPORTED" | "USER_EDIT" | "AGENT_CONVERSATION" | "AGENT_IDLE_MAINTENANCE";
  author_username: string | null;
  created_at: string;
};

function projectSummaryFromRow(row: ProductProjectRow): ProductProjectSummary {
  const stateData = row.state_data ?? {};
  const specification = stateData.specification;
  return Object.freeze({
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
    workflowId: row.workflow_id ?? "",
    workflowState: row.workflow_state ?? "DRAFT",
    workflowUpdatedAt: row.workflow_updated_at ?? row.created_at,
    workflowProfile: row.profile ?? "VALIDATE",
    targetPlatforms: Object.freeze<ServerOperatingSystem[]>(row.target_platforms ?? ["macos"]),
    concept: typeof stateData.concept === "string" ? stateData.concept : "",
    specification: specification && typeof specification === "object" && !Array.isArray(specification)
      ? Object.freeze({ ...(specification as Record<string, unknown>) })
      : Object.freeze({}),
    source: row.source_revision && row.source_relative_path && row.source_digest && row.source_created_at
      ? Object.freeze({
          revision: Number(row.source_revision),
          relativePath: row.source_relative_path,
          digest: row.source_digest,
          fileCount: Number(row.source_file_count ?? 0),
          totalBytes: Number(row.source_total_bytes ?? 0),
          createdAt: row.source_created_at,
        })
      : null,
  });
}

function artifactFromRow(row: ArtifactRow): ArtifactRecord {
  return Object.freeze({
    id: row.id,
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    workflowId: row.workflow_id,
    kind: row.kind,
    targetPlatform: row.target_platform,
    object: Object.freeze({
      bucket: row.bucket,
      key: row.object_key,
      sha256: row.sha256,
      sizeBytes: Number(row.size_bytes),
    }),
    createdAt: row.created_at,
  });
}

function agentProgressEventFromRow(row: AgentProgressEventRow): AgentProgressEvent {
  return Object.freeze({
    sequence: Number(row.sequence),
    jobId: row.job_id,
    kind: row.event_kind,
    content: row.content,
    createdAt: row.created_at,
  });
}

function projectDocumentFromRows(
  row: ProjectDocumentRow,
  revisions: readonly ProjectDocumentRevisionRow[],
): ProductProjectDetail["document"] {
  return Object.freeze({
    revision: Number(row.revision),
    content: parseProjectDocumentContent(row.content),
    markdown: row.markdown,
    maintainedBy: row.maintained_by,
    lastAgentMaintainedAt: row.last_agent_maintained_at,
    updatedAt: row.updated_at,
    revisions: Object.freeze(revisions.map(revision => Object.freeze({
      revision: Number(revision.revision),
      source: revision.source,
      authorUsername: revision.author_username,
      createdAt: revision.created_at,
    }))),
  });
}

async function insertInitialProjectDocument(
  client: PoolClient,
  input: Readonly<{
    workspaceId: string;
    projectId: string;
    name: string;
    concept: string;
    specification: Readonly<Record<string, unknown>>;
    document?: ProjectDocumentContent;
  }>,
): Promise<void> {
  const content = input.document
    ? parseProjectDocumentContent(input.document)
    : createInitialProjectDocument(input.name, input.concept, input.specification);
  const markdown = projectDocumentMarkdown(input.name, content);
  await client.query(
    `INSERT INTO deviludo.project_documents(
       workspace_id, project_id, content, markdown, maintained_by, last_agent_maintained_at
     ) VALUES ($1::uuid, $2::uuid, $3::jsonb, $4, $5, CASE WHEN $5 = 'AGENT' THEN clock_timestamp() ELSE NULL END)`,
    [input.workspaceId, input.projectId, JSON.stringify(content), markdown, input.document ? "AGENT" : "SYSTEM"],
  );
  await client.query(
    `INSERT INTO deviludo.project_document_revisions(
       workspace_id, project_id, revision, content, markdown, source
     ) VALUES ($1::uuid, $2::uuid, 1, $3::jsonb, $4, 'PROJECT_CREATED')`,
    [input.workspaceId, input.projectId, JSON.stringify(content), markdown],
  );
}

async function touchProjectActivity(
  client: PoolClient,
  workspaceId: string,
  projectId: string,
): Promise<void> {
  await client.query(
    `UPDATE deviludo.projects SET last_activity_at = clock_timestamp()
      WHERE workspace_id = $1::uuid AND id = $2::uuid`,
    [workspaceId, projectId],
  );
  await client.query(
    `UPDATE deviludo.jobs
        SET state = 'CANCELLED', lease_owner = NULL, lease_token = NULL,
            lease_expires_at = NULL, heartbeat_at = NULL,
            fencing_token = fencing_token + 1, last_error = 'superseded by project activity',
            updated_at = clock_timestamp()
      WHERE workspace_id = $1::uuid AND project_id = $2::uuid
        AND kind = 'PROJECT_DOCUMENT_MAINTENANCE'
        AND state IN ('QUEUED', 'RETRY', 'RUNNING')`,
    [workspaceId, projectId],
  );
}

function workspaceFromRow(row: WorkspaceRow): WorkspaceSummary {
  return Object.freeze({ id: row.id, name: row.name, createdAt: row.created_at });
}

function creationReceiptFromRow(row: CreationReceiptRow): CreationReceipt {
  return Object.freeze({
    idempotencyKey: row.idempotency_key,
    operationKind: row.operation_kind,
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    conversationId: row.conversation_id,
  });
}

function productSpecificationFromState(stateData: Record<string, unknown>): Readonly<Record<string, unknown>> {
  const value = stateData.specification;
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : Object.freeze({});
}

function appendRevisionNote(
  specification: Readonly<Record<string, unknown>>,
  note: string,
): Readonly<Record<string, unknown>> {
  const previous = Array.isArray(specification.revisionNotes)
    ? specification.revisionNotes.filter(value => typeof value === "string")
    : [];
  return Object.freeze({
    ...specification,
    revisionNotes: Object.freeze([...previous, note].slice(-12)),
  });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
