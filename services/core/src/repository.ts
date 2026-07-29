import type { PoolClient } from "pg";
import {
  AGENT_RUNTIME_KINDS,
  type AgentModelConfiguration,
  type AgentRuntimeKind,
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
import { assertJobPlacement, isJobKind, type E2eJobKind } from "@/lib/runtime/job-routing";
import type { Database } from "./database";
import { createProductConversationReply } from "./product-conversation";
import type {
  ClaimedJobIdentity,
  JobCompletion,
  JobProtocolV3,
  WorkflowSignalInput,
} from "./contracts";
import { normalizeAgentModels } from "./agent-settings";

export class CoreRepository {
  constructor(private readonly database: Database) {}

  async ping(): Promise<void> {
    await this.database.pool.query("SELECT 1");
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

  async listWorkspaces(): Promise<readonly WorkspaceSummary[]> {
    const result = await this.database.pool.query<WorkspaceRow>(
      `SELECT id::text, name, created_at::text FROM deviludo.list_workspaces()`,
    );
    return Object.freeze(result.rows.map(workspaceFromRow));
  }

  async createWorkspace(input: Readonly<{ id: string; name: string }>): Promise<WorkspaceSummary> {
    return this.database.withWorkspace(input.id, async client => {
      const result = await client.query<WorkspaceRow>(
        `INSERT INTO deviludo.workspaces(id, name)
         VALUES ($1::uuid, $2)
         RETURNING id::text, name, created_at::text`,
        [input.id, input.name],
      );
      return workspaceFromRow(result.rows[0]);
    });
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
                workflow.state_data,
                workflow.updated_at::text AS workflow_updated_at
           FROM deviludo.projects p
           LEFT JOIN LATERAL (
             SELECT id, state, state_data, updated_at
               FROM deviludo.workflow_instances
              WHERE workspace_id = p.workspace_id AND project_id = p.id
              ORDER BY created_at DESC
              LIMIT 1
           ) workflow ON true
          ORDER BY p.created_at DESC`,
      );
      return Object.freeze(result.rows.map(projectSummaryFromRow));
    });
  }

  async createProject(input: Readonly<{
    workspaceId: string;
    workspaceName: string;
    projectId: string;
    workflowId: string;
    idempotencyKey: string;
    name: string;
    concept: string;
    specification: Readonly<Record<string, unknown>>;
  }>): Promise<ProductProjectDetail> {
    await this.database.withWorkspace(input.workspaceId, async client => {
      await client.query(
        `INSERT INTO deviludo.workspaces(id, name) VALUES ($1::uuid, $2)
         ON CONFLICT (id) DO NOTHING`,
        [input.workspaceId, input.workspaceName],
      );
      await client.query(
        `INSERT INTO deviludo.projects(workspace_id, id, name)
         VALUES ($1::uuid, $2::uuid, $3)`,
        [input.workspaceId, input.projectId, input.name],
      );
      await client.query(
        `INSERT INTO deviludo.workflow_instances(workspace_id, id, project_id, state_data)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::jsonb)`,
        [
          input.workspaceId,
          input.workflowId,
          input.projectId,
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

  async readProjectCreationReceipt(idempotencyKey: string): Promise<CreationReceipt | null> {
    const result = await this.database.pool.query<CreationReceiptRow>(
      `SELECT idempotency_key, operation_kind, workspace_id::text, project_id::text,
              conversation_id::text
         FROM deviludo.project_creation_receipts
        WHERE idempotency_key = $1`,
      [idempotencyKey],
    );
    return result.rows[0] ? creationReceiptFromRow(result.rows[0]) : null;
  }

  async createProjectConversation(input: Readonly<{
    workspaceId: string;
    workspaceName: string;
    projectId: string;
    workflowId: string;
    conversationId: string;
    idempotencyKey: string;
    name: string;
    concept: string;
    specification: Readonly<Record<string, unknown>>;
    userContent: string;
  }>): Promise<Readonly<{ project: ProductProjectDetail; conversation: ProductConversation }>> {
    await this.database.withWorkspace(input.workspaceId, async client => {
      await client.query(
        `INSERT INTO deviludo.workspaces(id, name) VALUES ($1::uuid, $2)
         ON CONFLICT (id) DO NOTHING`,
        [input.workspaceId, input.workspaceName],
      );
      await client.query(
        `INSERT INTO deviludo.projects(workspace_id, id, name) VALUES ($1::uuid, $2::uuid, $3)`,
        [input.workspaceId, input.projectId, input.name],
      );
      await client.query(
        `INSERT INTO deviludo.workflow_instances(workspace_id, id, project_id, state_data)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::jsonb)`,
        [
          input.workspaceId,
          input.workflowId,
          input.projectId,
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
      const assistant = createProductConversationReply({
        userContent: input.userContent,
        turnNumber: 1,
        project: null,
      });
      await client.query(
        `INSERT INTO deviludo.conversation_messages(workspace_id, conversation_id, role, content, metadata)
         VALUES ($1::uuid, $2::uuid, 'ASSISTANT', $3, $4::jsonb)`,
        [input.workspaceId, input.conversationId, assistant.content, JSON.stringify({ appliedToDraft: false })],
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
                workflow.state_data,
                workflow.updated_at::text AS workflow_updated_at
           FROM deviludo.projects p
           LEFT JOIN LATERAL (
             SELECT id, state, state_data, updated_at
               FROM deviludo.workflow_instances
              WHERE workspace_id = p.workspace_id AND project_id = p.id
              ORDER BY created_at DESC
              LIMIT 1
           ) workflow ON true
          WHERE p.id = $1::uuid`,
        [projectId],
      );
      const row = project.rows[0];
      if (!row || !row.workflow_id) return null;
      const [jobs, events] = await Promise.all([
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
      ]);
      return Object.freeze({
        ...projectSummaryFromRow(row),
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

  async appendConversationTurn(input: Readonly<{
    workspaceId: string;
    conversationId: string;
    projectId: string;
    userContent: string;
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
      const turnCount = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM deviludo.conversation_messages
          WHERE conversation_id = $1::uuid AND role = 'USER'`,
        [input.conversationId],
      );
      const assistant = createProductConversationReply({
        userContent: input.userContent,
        turnNumber: Number(turnCount.rows[0]?.count ?? 1),
        project: conversation.mode === "NEW_GAME"
          ? null
          : { name: project.name, workflowState: project.workflowState },
      });

      if (assistant.appliedToDraft) {
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

      await client.query(
        `INSERT INTO deviludo.conversation_messages(workspace_id, conversation_id, role, content, metadata)
         VALUES ($1::uuid, $2::uuid, 'ASSISTANT', $3, $4::jsonb)`,
        [
          input.workspaceId,
          input.conversationId,
          assistant.content,
          JSON.stringify({ appliedToDraft: assistant.appliedToDraft }),
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

  async claimJob(input: Readonly<{
    workerId: string;
    poolKind: ServerPoolKind;
    leaseSeconds: number;
  }>): Promise<JobProtocolV3 | null> {
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

  async loadLeasedJob(identity: ClaimedJobIdentity): Promise<JobProtocolV3> {
    return this.database.withWorkspace(identity.workspaceId, async client => this.readClaimedJob(client, identity));
  }

  async heartbeat(job: JobProtocolV3): Promise<boolean> {
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

  async complete(job: JobProtocolV3, completion: JobCompletion): Promise<boolean> {
    return this.database.withWorkspace(job.workspaceId, async client => {
      const result = await client.query<{ completed: boolean }>(
        `SELECT deviludo.complete_job(
          $1::uuid, $2::uuid, $3::bigint, $4::bigint, $5::jsonb,
          $6::text, $7::text, $8::text
        ) AS completed`,
        [
          job.jobId,
          completion.leaseToken,
          completion.fencingToken,
          completion.isolationGeneration,
          JSON.stringify(completion.receipt),
          completion.beforeReimageProof ?? null,
          completion.cleanupProof ?? null,
          completion.afterReimageProof ?? null,
        ],
      );
      return result.rows[0]?.completed === true;
    });
  }

  async fail(job: JobProtocolV3, reason: string): Promise<boolean> {
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

  async appendSignal(
    workspaceId: string,
    workflowId: string,
    signal: WorkflowSignalInput,
  ): Promise<boolean> {
    return this.database.withWorkspace(workspaceId, async client => {
      const result = await client.query<{ accepted: boolean }>(
        `SELECT deviludo.accept_workflow_signal(
          $1::uuid, $2::text, $3::text, $4::jsonb
        ) AS accepted`,
        [workflowId, signal.kind, signal.idempotencyKey, JSON.stringify(signal.payload)],
      );
      return result.rows[0]?.accepted === true;
    });
  }

  async createMacSmokeJob(ids: Readonly<{
    workspaceId: string;
    projectId: string;
    workflowId: string;
    jobId: string;
    jobKind: E2eJobKind;
  }>): Promise<void> {
    await this.database.withWorkspace(ids.workspaceId, async client => {
      await client.query("INSERT INTO deviludo.workspaces(id, name) VALUES ($1, 'Local smoke workspace')", [ids.workspaceId]);
      await client.query(
        "INSERT INTO deviludo.projects(workspace_id, id, name) VALUES ($1, $2, 'Local smoke project')",
        [ids.workspaceId, ids.projectId],
      );
      await client.query(
        `INSERT INTO deviludo.workflow_instances(workspace_id, id, project_id, state)
         VALUES ($1, $2, $3, 'DRAFT')`,
        [ids.workspaceId, ids.workflowId, ids.projectId],
      );
      await client.query(
        `INSERT INTO deviludo.jobs(
          workspace_id, id, workflow_id, project_id, kind, pool_kind, target_operating_system,
          required_capabilities, exclusive, idempotency_key, payload
        ) VALUES (
          $1, $2, $3, $4, $5::deviludo.job_kind, 'E2E_MACOS', 'macos',
          deviludo.required_capabilities($5::deviludo.job_kind), true,
          $6::text, '{"smoke":true}'::jsonb
        )`,
        [
          ids.workspaceId,
          ids.jobId,
          ids.workflowId,
          ids.projectId,
          ids.jobKind,
          `${ids.workflowId}:local-mac-smoke:${ids.jobKind}`,
        ],
      );
    });
  }

  async verifyWorkspaceIsolation(ids: Readonly<{
    firstWorkspaceId: string;
    firstProjectId: string;
    secondWorkspaceId: string;
    secondProjectId: string;
    forbiddenProjectId: string;
  }>): Promise<Readonly<{
    ownRead: boolean;
    crossWorkspaceHidden: boolean;
    missingContextHidden: boolean;
    crossWorkspaceWriteRejected: boolean;
  }>> {
    await this.database.withWorkspace(ids.firstWorkspaceId, async client => {
      await client.query("INSERT INTO deviludo.workspaces(id, name) VALUES ($1, 'Isolation workspace A')", [ids.firstWorkspaceId]);
      await client.query(
        "INSERT INTO deviludo.projects(workspace_id, id, name) VALUES ($1, $2, 'Isolation project A')",
        [ids.firstWorkspaceId, ids.firstProjectId],
      );
    });
    await this.database.withWorkspace(ids.secondWorkspaceId, async client => {
      await client.query("INSERT INTO deviludo.workspaces(id, name) VALUES ($1, 'Isolation workspace B')", [ids.secondWorkspaceId]);
      await client.query(
        "INSERT INTO deviludo.projects(workspace_id, id, name) VALUES ($1, $2, 'Isolation project B')",
        [ids.secondWorkspaceId, ids.secondProjectId],
      );
    });
    const ownRead = await this.database.withWorkspace(ids.firstWorkspaceId, async client => {
      const result = await client.query(
        "SELECT 1 FROM deviludo.projects WHERE id = $1::uuid",
        [ids.firstProjectId],
      );
      return result.rowCount === 1;
    });
    const crossWorkspaceHidden = await this.database.withWorkspace(ids.secondWorkspaceId, async client => {
      const result = await client.query(
        "SELECT 1 FROM deviludo.projects WHERE id = $1::uuid",
        [ids.firstProjectId],
      );
      return result.rowCount === 0;
    });
    const missing = await this.database.pool.query(
      "SELECT 1 FROM deviludo.projects WHERE id = $1::uuid",
      [ids.firstProjectId],
    );
    let crossWorkspaceWriteRejected = false;
    try {
      await this.database.withWorkspace(ids.secondWorkspaceId, async client => {
        await client.query(
          "INSERT INTO deviludo.projects(workspace_id, id, name) VALUES ($1, $2, 'Forbidden project')",
          [ids.firstWorkspaceId, ids.forbiddenProjectId],
        );
      });
    } catch {
      crossWorkspaceWriteRejected = true;
    }
    return Object.freeze({
      ownRead,
      crossWorkspaceHidden,
      missingContextHidden: missing.rowCount === 0,
      crossWorkspaceWriteRejected,
    });
  }

  async readJobStatus(workspaceId: string, jobId: string): Promise<Readonly<{
    state: string;
    beforeReimageProof: string | null;
    cleanupProof: string | null;
    afterReimageProof: string | null;
    lastError: string | null;
  }> | null> {
    return this.database.withWorkspace(workspaceId, async client => {
      const result = await client.query<{
        state: string;
        before_reimage_proof: string | null;
        cleanup_proof: string | null;
        after_reimage_proof: string | null;
        last_error: string | null;
      }>(
        `SELECT state::text, before_reimage_proof, cleanup_proof, after_reimage_proof, last_error
           FROM deviludo.jobs WHERE id = $1::uuid`,
        [jobId],
      );
      const row = result.rows[0];
      return row ? Object.freeze({
        state: row.state,
        beforeReimageProof: row.before_reimage_proof,
        cleanupProof: row.cleanup_proof,
        afterReimageProof: row.after_reimage_proof,
        lastError: row.last_error,
      }) : null;
    });
  }

  async registerOperation(job: JobProtocolV3, operationKind: string): Promise<string> {
    return this.database.withWorkspace(job.workspaceId, async client => {
      const result = await client.query<{ id: string }>(
        `INSERT INTO deviludo.operation_receipts
          (workspace_id, project_id, workflow_id, job_id, operation_kind, idempotency_key, state, request)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, 'REGISTERED', $7::jsonb)
         ON CONFLICT (workspace_id, idempotency_key)
         DO UPDATE SET updated_at = deviludo.operation_receipts.updated_at
         RETURNING id::text`,
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
      return result.rows[0].id;
    });
  }

  async finishOperation(
    job: JobProtocolV3,
    operationId: string,
    receipt: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    await this.database.withWorkspace(job.workspaceId, async client => {
      const result = await client.query(
        `UPDATE deviludo.operation_receipts
            SET state = 'RECEIPTED', receipt = $2::jsonb, updated_at = clock_timestamp()
          WHERE id = $1::uuid AND job_id = $3::uuid AND state IN ('REGISTERED', 'IN_PROGRESS')`,
        [operationId, JSON.stringify(receipt), job.jobId],
      );
      if (result.rowCount !== 1) throw new Error("Operation receipt was fenced or already reconciled");
    });
  }

  private async readClaimedJob(client: PoolClient, identity: ClaimedJobIdentity): Promise<JobProtocolV3> {
    const result = await client.query<JobRow>(
      `SELECT id::text, workflow_id::text, workspace_id::text, project_id::text,
              pool_kind::text, kind::text, target_operating_system::text,
              required_capabilities, exclusive, isolation_generation::text, payload,
              lease_token::text, lease_expires_at::text, fencing_token::text
         FROM deviludo.jobs
        WHERE id = $1::uuid AND lease_token = $2::uuid AND state = 'RUNNING'`,
      [identity.jobId, identity.leaseToken],
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
    return Object.freeze({
      schemaVersion: "deviludo.job.v3",
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
      payload: Object.freeze({ ...row.payload }),
      lease: Object.freeze({
        token: row.lease_token,
        expiresAt: row.lease_expires_at,
        fencingToken: Number(row.fencing_token),
      }),
    });
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
  concept: string;
  specification: Readonly<Record<string, unknown>>;
}>;

export type ProductProjectDetail = ProductProjectSummary & Readonly<{
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

type ProductConversationRow = {
  id: string;
  project_id: string;
  mode: "NEW_GAME" | "PROJECT_FEEDBACK";
  title: string;
  created_at: string;
  updated_at: string;
};

type ProductConversationMessageRow = {
  message_id: string;
  role: "USER" | "ASSISTANT";
  content: string;
  metadata: Record<string, unknown>;
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
    concept: typeof stateData.concept === "string" ? stateData.concept : "",
    specification: specification && typeof specification === "object" && !Array.isArray(specification)
      ? Object.freeze({ ...(specification as Record<string, unknown>) })
      : Object.freeze({}),
  });
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
