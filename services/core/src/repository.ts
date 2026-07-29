import type { PoolClient } from "pg";
import { AGENT_RUNTIME_KINDS, type AgentRuntimeKind } from "@/lib/product/contracts";
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

export class CoreRepository {
  constructor(private readonly database: Database) {}

  async ping(): Promise<void> {
    await this.database.pool.query("SELECT 1");
  }

  async readServerNodes(): Promise<readonly ServerNodeRecord[]> {
    const result = await this.database.pool.query<ServerNodeRow>(
      `SELECT id::text, pool_kind::text, operating_system::text, state::text, capabilities,
              isolation_generation::text, current_tenant_id::text, last_heartbeat_at::text,
              last_reimage_proof_at::text
         FROM deviludo.server_nodes
        ORDER BY pool_kind, id`,
    );
    return Object.freeze(result.rows.map(serverNodeFromRow));
  }

  async readServerPools() {
    return fixedPoolRecords(await this.readServerNodes());
  }

  async readAgentSettings(tenantId: string): Promise<StoredTenantAgentSettings | null> {
    return this.database.withTenant(tenantId, async client => {
      const result = await client.query<AgentSettingsRow>(
        `SELECT agent_runtime::text, base_url, credential_secret_ref,
                api_key_fingerprint, credential_version::text, revision::text,
                updated_by, updated_at::text
           FROM deviludo.tenant_agent_settings
          WHERE tenant_id = $1::uuid`,
        [tenantId],
      );
      return result.rows[0] ? agentSettingsFromRow(result.rows[0]) : null;
    });
  }

  async saveAgentSettings(input: Readonly<{
    tenantId: string;
    tenantName: string;
    agentRuntime: AgentRuntimeKind;
    baseUrl: string;
    credentialSecretRef: string;
    apiKeyFingerprint: string;
    credentialVersion: string;
    updatedBy: string;
  }>): Promise<StoredTenantAgentSettings> {
    return this.database.withTenant(input.tenantId, async client => {
      await client.query(
        `INSERT INTO deviludo.tenants(id, name) VALUES ($1::uuid, $2)
         ON CONFLICT (id) DO NOTHING`,
        [input.tenantId, input.tenantName],
      );
      const result = await client.query<AgentSettingsRow>(
        `INSERT INTO deviludo.tenant_agent_settings(
           tenant_id, agent_runtime, base_url, credential_secret_ref,
           api_key_fingerprint, credential_version, updated_by
         ) VALUES (
           $1::uuid, $2::deviludo.agent_runtime, $3, $4, $5, $6::uuid, $7
         )
         ON CONFLICT (tenant_id) DO UPDATE SET
           agent_runtime = EXCLUDED.agent_runtime,
           base_url = EXCLUDED.base_url,
           credential_secret_ref = EXCLUDED.credential_secret_ref,
           api_key_fingerprint = EXCLUDED.api_key_fingerprint,
           credential_version = EXCLUDED.credential_version,
           revision = deviludo.tenant_agent_settings.revision + 1,
           updated_by = EXCLUDED.updated_by,
           updated_at = clock_timestamp()
         RETURNING agent_runtime::text, base_url, credential_secret_ref,
                   api_key_fingerprint, credential_version::text, revision::text,
                   updated_by, updated_at::text`,
        [
          input.tenantId,
          input.agentRuntime,
          input.baseUrl,
          input.credentialSecretRef,
          input.apiKeyFingerprint,
          input.credentialVersion,
          input.updatedBy,
        ],
      );
      return agentSettingsFromRow(result.rows[0]);
    });
  }

  async listProjects(tenantId: string): Promise<readonly ProductProjectSummary[]> {
    return this.database.withTenant(tenantId, async client => {
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
              WHERE tenant_id = p.tenant_id AND project_id = p.id
              ORDER BY created_at DESC
              LIMIT 1
           ) workflow ON true
          ORDER BY p.created_at DESC`,
      );
      return Object.freeze(result.rows.map(projectSummaryFromRow));
    });
  }

  async createProject(input: Readonly<{
    tenantId: string;
    tenantName: string;
    projectId: string;
    workflowId: string;
    name: string;
    concept: string;
    specification: Readonly<Record<string, unknown>>;
  }>): Promise<ProductProjectDetail> {
    await this.database.withTenant(input.tenantId, async client => {
      await client.query(
        `INSERT INTO deviludo.tenants(id, name) VALUES ($1::uuid, $2)
         ON CONFLICT (id) DO NOTHING`,
        [input.tenantId, input.tenantName],
      );
      await client.query(
        `INSERT INTO deviludo.projects(tenant_id, id, name)
         VALUES ($1::uuid, $2::uuid, $3)`,
        [input.tenantId, input.projectId, input.name],
      );
      await client.query(
        `INSERT INTO deviludo.workflow_instances(tenant_id, id, project_id, state_data)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::jsonb)`,
        [
          input.tenantId,
          input.workflowId,
          input.projectId,
          JSON.stringify({ concept: input.concept, specification: input.specification }),
        ],
      );
      await client.query(
        `INSERT INTO deviludo.workflow_events(
           tenant_id, workflow_id, event_kind, event_data, idempotency_key
         ) VALUES ($1::uuid, $2::uuid, 'PROJECT_CREATED', $3::jsonb, 'project-created')`,
        [input.tenantId, input.workflowId, JSON.stringify({ concept: input.concept })],
      );
    });
    const created = await this.readProject(input.tenantId, input.projectId);
    if (!created) throw new Error("Created project could not be read");
    return created;
  }

  async updateProjectSpecification(input: Readonly<{
    tenantId: string;
    projectId: string;
    specification: Readonly<Record<string, unknown>>;
    note: string;
    idempotencyKey: string;
  }>): Promise<ProductProjectDetail | null> {
    await this.database.withTenant(input.tenantId, async client => {
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
           tenant_id, workflow_id, event_kind, event_data, idempotency_key
         ) VALUES ($1::uuid, $2::uuid, 'SPEC_REFINED', $3::jsonb, $4)
         ON CONFLICT (tenant_id, workflow_id, idempotency_key) DO NOTHING`,
        [input.tenantId, workflow.rows[0].id, JSON.stringify({ note: input.note }), input.idempotencyKey],
      );
    });
    return this.readProject(input.tenantId, input.projectId);
  }

  async readProject(tenantId: string, projectId: string): Promise<ProductProjectDetail | null> {
    return this.database.withTenant(tenantId, async client => {
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
              WHERE tenant_id = p.tenant_id AND project_id = p.id
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

  async readConversation(tenantId: string, conversationId: string): Promise<ProductConversation | null> {
    return this.database.withTenant(tenantId, async client => {
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
    tenantId: string;
    tenantName: string;
    conversationId: string;
    projectId: string | null;
    userContent: string;
  }>): Promise<ProductConversation> {
    return this.database.withTenant(input.tenantId, async client => {
      await client.query(
        `INSERT INTO deviludo.tenants(id, name) VALUES ($1::uuid, $2)
         ON CONFLICT (id) DO NOTHING`,
        [input.tenantId, input.tenantName],
      );

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

      let project: { name: string; workflowId: string; workflowState: string; stateData: Record<string, unknown> } | null = null;
      if (input.projectId) {
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
          `INSERT INTO deviludo.project_conversations(tenant_id, id, project_id, mode, title)
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5)
           RETURNING id::text, project_id::text, mode, title, created_at::text, updated_at::text`,
          [
            input.tenantId,
            input.conversationId,
            input.projectId,
            input.projectId ? "PROJECT_FEEDBACK" : "NEW_GAME",
            conversationTitleFromContent(input.userContent),
          ],
        );
        conversation = created.rows[0];
      }

      const userMessage = await client.query<{ message_id: string }>(
        `INSERT INTO deviludo.conversation_messages(tenant_id, conversation_id, role, content)
         VALUES ($1::uuid, $2::uuid, 'USER', $3)
         RETURNING message_id::text`,
        [input.tenantId, input.conversationId, input.userContent],
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
        project: project ? { name: project.name, workflowState: project.workflowState } : null,
      });

      if (assistant.appliedToDraft && project) {
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
             tenant_id, workflow_id, event_kind, event_data, idempotency_key
           ) VALUES ($1::uuid, $2::uuid, 'SPEC_REFINED', $3::jsonb, $4)
           ON CONFLICT (tenant_id, workflow_id, idempotency_key) DO NOTHING`,
          [
            input.tenantId,
            project.workflowId,
            JSON.stringify({ note: input.userContent, source: "HOME_CONVERSATION" }),
            `conversation:${input.conversationId}:${userMessage.rows[0].message_id}`,
          ],
        );
      }

      await client.query(
        `INSERT INTO deviludo.conversation_messages(tenant_id, conversation_id, role, content, metadata)
         VALUES ($1::uuid, $2::uuid, 'ASSISTANT', $3, $4::jsonb)`,
        [
          input.tenantId,
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
                 isolation_generation::text, current_tenant_id::text, last_heartbeat_at::text,
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
                  isolation_generation::text, current_tenant_id::text, last_heartbeat_at::text,
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
      `SELECT "jobId"::text, "tenantId"::text, "leaseToken"::text
         FROM deviludo.claim_job($1, $2::deviludo.server_pool_kind, $3)`,
      [input.workerId, input.poolKind, input.leaseSeconds],
    );
    if (!claimed.rows[0]) return null;
    const identity: ClaimedJobIdentity = Object.freeze({
      jobId: claimed.rows[0].jobId,
      tenantId: claimed.rows[0].tenantId,
      leaseToken: claimed.rows[0].leaseToken,
    });
    return this.database.withTenant(identity.tenantId, async client => this.readClaimedJob(client, identity));
  }

  async loadLeasedJob(identity: ClaimedJobIdentity): Promise<JobProtocolV3> {
    return this.database.withTenant(identity.tenantId, async client => this.readClaimedJob(client, identity));
  }

  async heartbeat(job: JobProtocolV3): Promise<boolean> {
    return this.database.withTenant(job.tenantId, async client => {
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
    return this.database.withTenant(job.tenantId, async client => {
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
    return this.database.withTenant(job.tenantId, async client => {
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
    tenantId: string,
    workflowId: string,
    signal: WorkflowSignalInput,
  ): Promise<boolean> {
    return this.database.withTenant(tenantId, async client => {
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
    tenantId: string;
    projectId: string;
    workflowId: string;
    jobId: string;
    jobKind: E2eJobKind;
  }>): Promise<void> {
    await this.database.withTenant(ids.tenantId, async client => {
      await client.query("INSERT INTO deviludo.tenants(id, name) VALUES ($1, 'Local smoke tenant')", [ids.tenantId]);
      await client.query(
        "INSERT INTO deviludo.projects(tenant_id, id, name) VALUES ($1, $2, 'Local smoke project')",
        [ids.tenantId, ids.projectId],
      );
      await client.query(
        `INSERT INTO deviludo.workflow_instances(tenant_id, id, project_id, state)
         VALUES ($1, $2, $3, 'DRAFT')`,
        [ids.tenantId, ids.workflowId, ids.projectId],
      );
      await client.query(
        `INSERT INTO deviludo.jobs(
          tenant_id, id, workflow_id, project_id, kind, pool_kind, target_operating_system,
          required_capabilities, exclusive, idempotency_key, payload
        ) VALUES (
          $1, $2, $3, $4, $5::deviludo.job_kind, 'E2E_MACOS', 'macos',
          deviludo.required_capabilities($5::deviludo.job_kind), true,
          $6::text, '{"smoke":true}'::jsonb
        )`,
        [
          ids.tenantId,
          ids.jobId,
          ids.workflowId,
          ids.projectId,
          ids.jobKind,
          `${ids.workflowId}:local-mac-smoke:${ids.jobKind}`,
        ],
      );
    });
  }

  async verifyTenantIsolation(ids: Readonly<{
    firstTenantId: string;
    firstProjectId: string;
    secondTenantId: string;
    secondProjectId: string;
    forbiddenProjectId: string;
  }>): Promise<Readonly<{
    ownRead: boolean;
    crossTenantHidden: boolean;
    missingContextHidden: boolean;
    crossTenantWriteRejected: boolean;
  }>> {
    await this.database.withTenant(ids.firstTenantId, async client => {
      await client.query("INSERT INTO deviludo.tenants(id, name) VALUES ($1, 'Isolation tenant A')", [ids.firstTenantId]);
      await client.query(
        "INSERT INTO deviludo.projects(tenant_id, id, name) VALUES ($1, $2, 'Isolation project A')",
        [ids.firstTenantId, ids.firstProjectId],
      );
    });
    await this.database.withTenant(ids.secondTenantId, async client => {
      await client.query("INSERT INTO deviludo.tenants(id, name) VALUES ($1, 'Isolation tenant B')", [ids.secondTenantId]);
      await client.query(
        "INSERT INTO deviludo.projects(tenant_id, id, name) VALUES ($1, $2, 'Isolation project B')",
        [ids.secondTenantId, ids.secondProjectId],
      );
    });
    const ownRead = await this.database.withTenant(ids.firstTenantId, async client => {
      const result = await client.query(
        "SELECT 1 FROM deviludo.projects WHERE id = $1::uuid",
        [ids.firstProjectId],
      );
      return result.rowCount === 1;
    });
    const crossTenantHidden = await this.database.withTenant(ids.secondTenantId, async client => {
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
    let crossTenantWriteRejected = false;
    try {
      await this.database.withTenant(ids.secondTenantId, async client => {
        await client.query(
          "INSERT INTO deviludo.projects(tenant_id, id, name) VALUES ($1, $2, 'Forbidden project')",
          [ids.firstTenantId, ids.forbiddenProjectId],
        );
      });
    } catch {
      crossTenantWriteRejected = true;
    }
    return Object.freeze({
      ownRead,
      crossTenantHidden,
      missingContextHidden: missing.rowCount === 0,
      crossTenantWriteRejected,
    });
  }

  async readJobStatus(tenantId: string, jobId: string): Promise<Readonly<{
    state: string;
    beforeReimageProof: string | null;
    cleanupProof: string | null;
    afterReimageProof: string | null;
    lastError: string | null;
  }> | null> {
    return this.database.withTenant(tenantId, async client => {
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
    return this.database.withTenant(job.tenantId, async client => {
      const result = await client.query<{ id: string }>(
        `INSERT INTO deviludo.operation_receipts
          (tenant_id, project_id, workflow_id, job_id, operation_kind, idempotency_key, state, request)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, 'REGISTERED', $7::jsonb)
         ON CONFLICT (tenant_id, idempotency_key)
         DO UPDATE SET updated_at = deviludo.operation_receipts.updated_at
         RETURNING id::text`,
        [
          job.tenantId,
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
    await this.database.withTenant(job.tenantId, async client => {
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
      `SELECT id::text, workflow_id::text, tenant_id::text, project_id::text,
              pool_kind::text, kind::text, target_operating_system::text,
              required_capabilities, exclusive, isolation_generation::text, payload,
              lease_token::text, lease_expires_at::text, fencing_token::text
         FROM deviludo.jobs
        WHERE id = $1::uuid AND lease_token = $2::uuid AND state = 'RUNNING'`,
      [identity.jobId, identity.leaseToken],
    );
    const row = result.rows[0];
    if (!row) throw new Error("Claimed job body is unavailable in the tenant transaction");
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
      tenantId: row.tenant_id,
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
  current_tenant_id: string | null;
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
    currentTenantId: row.current_tenant_id,
    lastHeartbeatAt: row.last_heartbeat_at,
    lastReimageProofAt: row.last_reimage_proof_at,
  });
}

type ClaimRow = { jobId: string; tenantId: string; leaseToken: string };
type AgentSettingsRow = {
  agent_runtime: string;
  base_url: string;
  credential_secret_ref: string;
  api_key_fingerprint: string;
  credential_version: string;
  revision: string;
  updated_by: string;
  updated_at: string;
};

export type StoredTenantAgentSettings = Readonly<{
  agentRuntime: AgentRuntimeKind;
  baseUrl: string;
  credentialSecretRef: string;
  apiKeyFingerprint: string;
  credentialVersion: string;
  revision: number;
  updatedBy: string;
  updatedAt: string;
}>;

function agentSettingsFromRow(row: AgentSettingsRow): StoredTenantAgentSettings {
  const revision = Number(row.revision);
  if (!(AGENT_RUNTIME_KINDS as readonly string[]).includes(row.agent_runtime)
    || !Number.isSafeInteger(revision) || revision < 1
    || !row.credential_secret_ref.startsWith("vault://tenants/")
    || !/^sha256:[0-9a-f]{12}$/.test(row.api_key_fingerprint)) {
    throw new Error("Stored tenant Agent settings are invalid");
  }
  return Object.freeze({
    agentRuntime: row.agent_runtime as AgentRuntimeKind,
    baseUrl: row.base_url,
    credentialSecretRef: row.credential_secret_ref,
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
  tenant_id: string;
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
  projectId: string | null;
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
  project_id: string | null;
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

function conversationTitleFromContent(content: string): string {
  const firstSentence = content.split(/[。！？.!?\n]/, 1)[0].trim() || "新游戏对话";
  return firstSentence.slice(0, 80);
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
