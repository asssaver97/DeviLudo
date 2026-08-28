import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type {
  AgentRuntimeKind,
  ProjectRuntimeRole,
  ProjectRuntimeState,
} from "@/lib/product/contracts";
import type { ProjectRuntimeTurnMode } from "@/lib/product/project-runtime";
import type { Database } from "./database";
import type { StoredProjectContext } from "./project-context";

export type RuntimeRecord = Readonly<{
  workspaceId: string;
  projectId: string;
  runtime: AgentRuntimeKind;
  generation: number;
  fencingToken: number;
  state: ProjectRuntimeState;
  containerId: string | null;
  activeRole: ProjectRuntimeRole | null;
  activeTurnId: string | null;
  lastActivityAt: string;
  pausedAt: string | null;
}>;

export type StartedRuntimeTurn = Readonly<{
  id: string;
  sessionId: string;
  leaseToken: string;
  mcpToken: string;
  generation: number;
  fencingToken: number;
}>;

export type RuntimeLifecycleClaim = RuntimeRecord & Readonly<{
  action: "PAUSE" | "DESTROY";
  leaseToken: string;
}>;

export type RuntimeSwitchClaim = RuntimeRecord & Readonly<{ leaseToken: string }>;

export type ProjectContextSeed = Readonly<{
  language: "en" | "zh";
  requirements: readonly Readonly<Record<string, unknown>>[];
  projectDocument: Readonly<Record<string, unknown>>;
  documentRevision: number;
  e2eGoalRevision: number;
  e2eGoals: readonly Readonly<Record<string, unknown>>[];
  workflow: Readonly<Record<string, unknown>>;
  pendingChange: Readonly<Record<string, unknown>> | null;
}>;

export type ProjectContextRecord = Readonly<{
  revision: number;
  relativePath: string;
  sha256: string;
  sizeBytes: number;
}>;

export class ProjectRuntimeRepository {
  constructor(private readonly database: Database) {}

  async runtimeImage(runtime: AgentRuntimeKind): Promise<string> {
    const key = runtime === "CODEX_CLI" ? "AGENT_CODEX" : "AGENT_CLAUDE";
    const result = await this.database.pool.query(
      `SELECT image_reference FROM deviludo.runtime_images WHERE runtime_key = $1`, [key],
    );
    const value = result.rows[0]?.image_reference;
    if (typeof value !== "string") throw new Error(`${key} Runtime image is not registered`);
    return value;
  }

  async recordSourceRevision(input: Readonly<{
    workspaceId: string;
    projectId: string;
    revision: number;
    relativePath: string;
    digest: string;
    fileCount: number;
    totalBytes: number;
  }>): Promise<void> {
    await this.database.withWorkspace(input.workspaceId, async client => {
      const actor = await client.query(
        `SELECT created_by_actor_id FROM deviludo.projects
          WHERE workspace_id = $1::uuid AND id = $2::uuid`, [input.workspaceId, input.projectId],
      );
      if (!actor.rows[0]) throw new Error("Project does not exist");
      const recorded = await client.query(
        `INSERT INTO deviludo.project_source_revisions(
           workspace_id, project_id, revision, relative_path, content_digest,
           file_count, total_bytes, actor_id
         ) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8::uuid)
         ON CONFLICT (workspace_id, project_id, revision) DO UPDATE
           SET relative_path = EXCLUDED.relative_path
         WHERE deviludo.project_source_revisions.relative_path = EXCLUDED.relative_path
           AND deviludo.project_source_revisions.content_digest = EXCLUDED.content_digest
           AND deviludo.project_source_revisions.file_count = EXCLUDED.file_count
           AND deviludo.project_source_revisions.total_bytes = EXCLUDED.total_bytes
           AND deviludo.project_source_revisions.actor_id = EXCLUDED.actor_id
         RETURNING revision`,
        [input.workspaceId, input.projectId, input.revision, input.relativePath,
          input.digest, input.fileCount, input.totalBytes, actor.rows[0].created_by_actor_id],
      );
      if (recorded.rowCount !== 1) throw new Error("Source revision conflicts with the registered immutable snapshot");
    });
  }

  async queueGeneratedAssetCleanup(input: Readonly<{
    workspaceId: string;
    objects: readonly Readonly<{ bucket: string; objectKey: string }>[];
  }>): Promise<number> {
    if (!input.objects.length) return 0;
    return this.database.withWorkspace(input.workspaceId, async client => {
      let queued = 0;
      for (const object of input.objects) {
        if (object.bucket.length < 3 || object.bucket.length > 255
          || !object.objectKey.startsWith(`workspaces/${input.workspaceId}/`)) {
          throw new Error("Generated asset cleanup object is outside the project workspace");
        }
        const result = await client.query(
          `INSERT INTO deviludo.object_cleanup_queue(workspace_id, bucket, object_key, reason)
           VALUES ($1::uuid, $2, $3, 'retired generated asset after Runtime asset plan replacement')
           ON CONFLICT (workspace_id, bucket, object_key) DO NOTHING`,
          [input.workspaceId, object.bucket, object.objectKey],
        );
        queued += result.rowCount ?? 0;
      }
      return queued;
    });
  }

  async recordTestPlan(input: Readonly<{
    workspaceId: string;
    projectId: string;
    turnId: string;
    requirementRevision: number;
    sourceRevision: number;
    planRevision: number;
    plan: Readonly<Record<string, unknown>>;
  }>): Promise<Readonly<{ id: string; sha256: string }>> {
    const serialized = JSON.stringify(input.plan);
    const sha256 = `sha256:${createHash("sha256").update(serialized).digest("hex")}`;
    return this.database.withWorkspace(input.workspaceId, async client => {
      const result = await client.query(
        `INSERT INTO deviludo.test_plans_v2(
           workspace_id, project_id, requirement_revision, source_revision,
           plan_revision, plan_sha256, plan, created_by_turn_id
         ) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::jsonb, $8::uuid)
         ON CONFLICT (workspace_id, project_id, source_revision, plan_revision) DO UPDATE
           SET plan_sha256 = EXCLUDED.plan_sha256, plan = EXCLUDED.plan,
               created_by_turn_id = EXCLUDED.created_by_turn_id
         RETURNING id::text`,
        [input.workspaceId, input.projectId, input.requirementRevision,
          input.sourceRevision, input.planRevision, sha256, serialized, input.turnId],
      );
      return Object.freeze({ id: result.rows[0].id, sha256 });
    });
  }

  async readLatestTestPlan(workspaceId: string, projectId: string): Promise<Readonly<Record<string, unknown>> | null> {
    const result = await this.database.withWorkspace(workspaceId, client => client.query(
      `SELECT id::text, requirement_revision, source_revision, plan_revision,
              plan_sha256, plan, created_at::text
         FROM deviludo.test_plans_v2
        WHERE workspace_id = $1::uuid AND project_id = $2::uuid
        ORDER BY source_revision DESC, plan_revision DESC LIMIT 1`,
      [workspaceId, projectId],
    ));
    return result.rows[0] ? Object.freeze({
      id: result.rows[0].id,
      requirementRevision: Number(result.rows[0].requirement_revision),
      sourceRevision: Number(result.rows[0].source_revision),
      planRevision: Number(result.rows[0].plan_revision),
      sha256: result.rows[0].plan_sha256,
      plan: result.rows[0].plan,
      createdAt: result.rows[0].created_at,
    }) : null;
  }

  async readTestEvidence(workspaceId: string, projectId: string): Promise<readonly Readonly<Record<string, unknown>>[]> {
    const result = await this.database.withWorkspace(workspaceId, client => client.query(
      `SELECT run.id::text, run.source_revision, run.target_platform::text,
              run.state::text, run.failure_class, run.deterministic_result,
              run.evidence_summary, run.verdict, run.completed_at::text,
              plan.plan_revision, plan.plan_sha256
         FROM deviludo.platform_test_runs run
         JOIN deviludo.test_plans_v2 plan
           ON plan.workspace_id = run.workspace_id AND plan.id = run.plan_id
        WHERE run.workspace_id = $1::uuid AND run.project_id = $2::uuid
        ORDER BY run.created_at DESC, run.target_platform`,
      [workspaceId, projectId],
    ));
    return Object.freeze(result.rows.map(row => Object.freeze({
      id: row.id, sourceRevision: Number(row.source_revision), targetPlatform: row.target_platform,
      state: row.state, failureClass: row.failure_class, deterministicResult: row.deterministic_result,
      evidenceSummary: row.evidence_summary, verdict: row.verdict, completedAt: row.completed_at,
      planRevision: Number(row.plan_revision), planSha256: row.plan_sha256,
    })));
  }

  async updateContext<T>(
    workspaceId: string,
    projectId: string,
    operation: (current: ProjectContextRecord | null) => Promise<Readonly<{
      stored: StoredProjectContext | null;
      result: T;
    }>>,
  ): Promise<T> {
    return this.database.withWorkspace(workspaceId, async client => {
      // Context bytes live on the shared project volume, so a row lock alone
      // cannot serialize first-time creation. The transaction-scoped advisory
      // lock covers the complete read -> atomic file rename -> metadata update
      // sequence across Core API, scheduler and sandbox processes.
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`deviludo-project-context:${workspaceId}:${projectId}`],
      );
      const selected = await client.query(
        `SELECT revision, relative_path, sha256, size_bytes
           FROM deviludo.project_contexts
          WHERE workspace_id = $1::uuid AND project_id = $2::uuid
          FOR UPDATE`,
        [workspaceId, projectId],
      );
      const current = contextRecord(selected.rows[0]);
      const outcome = await operation(current);
      if (!outcome.stored) return outcome.result;
      const stored = outcome.stored;
      if (stored.context.workspaceId !== workspaceId || stored.context.projectId !== projectId) {
        throw new Error("Project context storage identity does not match the locked project");
      }
      const expectedRevision = current ? current.revision + 1 : null;
      if ((expectedRevision !== null && stored.context.revision !== expectedRevision)
        || (expectedRevision === null && stored.context.revision < 1)) {
        throw new Error(expectedRevision === null
          ? "Initial project context revision is invalid"
          : `Project context revision must advance to ${expectedRevision}`);
      }
      await client.query(
        `INSERT INTO deviludo.project_contexts(
           workspace_id, project_id, revision, relative_path, sha256, size_bytes
         ) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6)
         ON CONFLICT (workspace_id, project_id) DO UPDATE
           SET revision = EXCLUDED.revision, relative_path = EXCLUDED.relative_path,
               sha256 = EXCLUDED.sha256, size_bytes = EXCLUDED.size_bytes,
               updated_at = clock_timestamp()`,
        [workspaceId, projectId, stored.context.revision,
          stored.relativePath, stored.sha256, stored.sizeBytes],
      );
      return outcome.result;
    });
  }

  async readContextRecord(workspaceId: string, projectId: string): Promise<ProjectContextRecord | null> {
    const result = await this.database.withWorkspace(workspaceId, client => client.query(
      `SELECT revision, relative_path, sha256, size_bytes
         FROM deviludo.project_contexts
        WHERE workspace_id = $1::uuid AND project_id = $2::uuid`, [workspaceId, projectId],
    ));
    return contextRecord(result.rows[0]);
  }

  async readProjectInput(workspaceId: string, projectId: string): Promise<Readonly<{
    concept: string;
    source: Readonly<{ revision: number; relativePath: string; digest: string }> | null;
  }> | null> {
    const result = await this.database.withWorkspace(workspaceId, client => client.query(
      `SELECT coalesce(workflow.state_data->>'concept', '') AS concept,
              source.revision, source.relative_path, source.content_digest
         FROM deviludo.projects project
         LEFT JOIN LATERAL (
           SELECT state_data
             FROM deviludo.workflow_instances
            WHERE workspace_id = project.workspace_id AND project_id = project.id
            ORDER BY iteration_number DESC LIMIT 1
         ) workflow ON true
         LEFT JOIN LATERAL (
           SELECT revision, relative_path, content_digest
             FROM deviludo.project_source_revisions
            WHERE workspace_id = project.workspace_id AND project_id = project.id
            ORDER BY revision DESC LIMIT 1
         ) source ON true
        WHERE project.workspace_id = $1::uuid AND project.id = $2::uuid`,
      [workspaceId, projectId],
    ));
    const row = result.rows[0];
    if (!row) return null;
    return Object.freeze({
      concept: row.concept,
      source: row.revision === null ? null : Object.freeze({
        revision: Number(row.revision),
        relativePath: row.relative_path,
        digest: row.content_digest,
      }),
    });
  }

  async readProjectContextSeed(workspaceId: string, projectId: string): Promise<ProjectContextSeed | null> {
    const result = await this.database.withWorkspace(workspaceId, client => client.query(
      `SELECT project.name AS project_name,
              coalesce(workflow.state_data->>'concept', '') AS concept,
              workflow.id::text AS workflow_id,
              workflow.iteration_number, workflow.state::text,
              workflow.target_platforms::text[], workflow.state_data,
              document.revision AS document_revision, document.content AS project_document,
              coalesce(goals.revision, 0) AS goal_revision,
              coalesce(goals.goals, '[]'::jsonb) AS e2e_goals,
              pending.id::text AS pending_id, pending.state AS pending_state,
              pending.summary AS pending_summary,
              pending.implementation_brief AS pending_implementation_brief,
              pending.base_document_revision AS pending_base_document_revision,
              pending.project_document_patch AS pending_project_document_patch,
              pending.e2e_goal_delta AS pending_e2e_goal_delta,
              pending.explicit_execution AS pending_explicit_execution,
              pending.created_at::text AS pending_created_at
         FROM deviludo.projects project
         JOIN LATERAL (
           SELECT * FROM deviludo.workflow_instances
            WHERE workspace_id = project.workspace_id AND project_id = project.id
            ORDER BY iteration_number DESC LIMIT 1
         ) workflow ON true
         JOIN deviludo.project_documents document
           ON document.workspace_id = project.workspace_id AND document.project_id = project.id
         LEFT JOIN LATERAL (
           SELECT revision, goals FROM deviludo.workflow_e2e_goal_revisions
            WHERE workspace_id = project.workspace_id AND workflow_id = workflow.id
            ORDER BY revision DESC LIMIT 1
         ) goals ON true
         LEFT JOIN LATERAL (
           SELECT * FROM deviludo.implementation_change_requests
            WHERE workspace_id = project.workspace_id AND project_id = project.id
              AND state IN ('PENDING', 'WAITING_FOR_ANALYSIS')
            ORDER BY created_at DESC LIMIT 1
         ) pending ON true
        WHERE project.workspace_id = $1::uuid AND project.id = $2::uuid`,
      [workspaceId, projectId],
    ));
    const row = result.rows[0];
    if (!row) return null;
    const stateData = objectValue(row.state_data);
    const goals = arrayOfObjects(row.e2e_goals);
    const requirements = [Object.freeze({
      id: "initial-concept",
      text: String(row.concept ?? ""),
      source: "PROJECT_CONCEPT",
    }), ...goals.map(goal => Object.freeze({
      id: goal.id,
      text: goal.description,
      source: goal.source,
    }))];
    const language = stateData.responseLanguage === "zh" ? "zh" : "en";
    return Object.freeze({
      language,
      requirements: Object.freeze(requirements),
      projectDocument: Object.freeze(objectValue(row.project_document)),
      documentRevision: Number(row.document_revision),
      e2eGoalRevision: Number(row.goal_revision),
      e2eGoals: goals,
      workflow: Object.freeze({
        id: row.workflow_id,
        projectName: row.project_name,
        concept: String(row.concept ?? ""),
        iterationNumber: Number(row.iteration_number),
        state: row.state,
        stopped: row.state === "STOPPED",
        targetPlatforms: Object.freeze(Array.isArray(row.target_platforms) ? [...row.target_platforms] : []),
        documentRevision: Number(row.document_revision),
        goalRevision: Number(row.goal_revision),
      }),
      pendingChange: row.pending_id ? Object.freeze({
        id: row.pending_id,
        state: row.pending_state,
        summary: row.pending_summary,
        implementationBrief: row.pending_implementation_brief,
        baseDocumentRevision: Number(row.pending_base_document_revision),
        projectDocumentPatch: Object.freeze(objectValue(row.pending_project_document_patch)),
        e2eGoalDelta: Object.freeze(objectValue(row.pending_e2e_goal_delta)),
        explicitExecution: Boolean(row.pending_explicit_execution),
        createdAt: row.pending_created_at,
      }) : null,
    });
  }

  async ensureContainer(workspaceId: string, projectId: string, runtime: AgentRuntimeKind): Promise<RuntimeRecord> {
    return this.database.withWorkspace(workspaceId, async client => {
      await client.query(
        `INSERT INTO deviludo.agent_containers(workspace_id, project_id, runtime)
         VALUES ($1::uuid, $2::uuid, $3::deviludo.agent_runtime)
         ON CONFLICT (workspace_id, project_id) DO NOTHING`, [workspaceId, projectId, runtime],
      );
      const result = await client.query(
        `SELECT * FROM deviludo.agent_containers
          WHERE workspace_id = $1::uuid AND project_id = $2::uuid FOR UPDATE`, [workspaceId, projectId],
      );
      const row = result.rows[0];
      if (!row) throw new Error("Project Runtime record was not created");
      if (row.runtime !== runtime) {
        throw new Error("Project Runtime must be compacted and switched before using another Runtime");
      }
      return runtimeRecord(row);
    });
  }

  async claimRuntimeSwitch(
    workspaceId: string,
    projectId: string,
    runtime: AgentRuntimeKind,
  ): Promise<RuntimeSwitchClaim | null> {
    return this.database.withWorkspace(workspaceId, async client => {
      const container = await lockedContainer(client, workspaceId, projectId);
      if (container.runtime === runtime) return null;
      const active = await client.query(
        `SELECT 1 FROM deviludo.agent_turns
          WHERE workspace_id = $1::uuid AND project_id = $2::uuid AND state = 'RUNNING'
          LIMIT 1`, [workspaceId, projectId],
      );
      if (active.rowCount || container.lease_token) return null;
      const leaseToken = randomUUID();
      await client.query(
        `UPDATE deviludo.agent_containers
            SET state = 'COMPACTING', lease_token = $3::uuid,
                lease_expires_at = clock_timestamp() + interval '24 hours',
                updated_at = clock_timestamp()
          WHERE workspace_id = $1::uuid AND project_id = $2::uuid`,
        [workspaceId, projectId, leaseToken],
      );
      return Object.freeze({ ...runtimeRecord({ ...container, state: "COMPACTING" }), leaseToken });
    });
  }

  async switchContainerRuntime(
    workspaceId: string,
    projectId: string,
    runtime: AgentRuntimeKind,
    leaseToken: string,
  ): Promise<RuntimeRecord> {
    return this.database.withWorkspace(workspaceId, async client => {
      const active = await client.query(
        `SELECT 1 FROM deviludo.agent_turns
          WHERE workspace_id = $1::uuid AND project_id = $2::uuid AND state = 'RUNNING'
          LIMIT 1`, [workspaceId, projectId],
      );
      if (active.rowCount) throw new Error("Project Runtime can switch only at a safe point");
      const updated = await client.query(
        `UPDATE deviludo.agent_containers
            SET runtime = $3::deviludo.agent_runtime, generation = generation + 1,
                fencing_token = fencing_token + 1, state = 'DESTROYED',
                container_id = NULL, paused_at = NULL, destroyed_at = clock_timestamp(),
                lease_token = NULL, lease_expires_at = NULL,
                last_activity_at = clock_timestamp(), updated_at = clock_timestamp()
          WHERE workspace_id = $1::uuid AND project_id = $2::uuid
            AND lease_token = $4::uuid AND state = 'COMPACTING'
          RETURNING *`,
        [workspaceId, projectId, runtime, leaseToken],
      );
      if (!updated.rows[0]) throw new Error("Project Runtime switch lease was rejected");
      return runtimeRecord(updated.rows[0]);
    });
  }

  async setStopped(workspaceId: string, projectId: string, stopped: boolean): Promise<RuntimeRecord> {
    return this.database.withWorkspace(workspaceId, async client => {
      const container = await lockedContainer(client, workspaceId, projectId);
      if (stopped) {
        await client.query(
          `UPDATE deviludo.agent_turns SET state = 'CANCELLED', lease_token = NULL,
                  mcp_token_hash = NULL, mcp_token_expires_at = NULL,
                  completed_at = clock_timestamp(), output_summary = 'stopped by user'
            WHERE workspace_id = $1::uuid AND project_id = $2::uuid AND state = 'RUNNING'`,
          [workspaceId, projectId],
        );
        await client.query(
          `UPDATE deviludo.agent_sessions SET active_turn_id = NULL, updated_at = clock_timestamp()
            WHERE workspace_id = $1::uuid AND project_id = $2::uuid`, [workspaceId, projectId],
        );
        await client.query(
          `UPDATE deviludo.jobs SET state = 'CANCELLED', fencing_token = fencing_token + 1,
                  lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
                  heartbeat_at = NULL, last_error = 'stopped by user', updated_at = clock_timestamp()
            WHERE workspace_id = $1::uuid AND project_id = $2::uuid
              AND kind <> 'STEAM_PUBLISH' AND state IN ('QUEUED', 'RETRY', 'RUNNING')`,
          [workspaceId, projectId],
        );
        await client.query(
          `UPDATE deviludo.workflow_instances
              SET state_data = state_data || jsonb_build_object('resumeState', state::text),
                  state = 'STOPPED', version = version + 1, updated_at = clock_timestamp()
            WHERE workspace_id = $1::uuid AND project_id = $2::uuid
              AND state NOT IN ('SUCCEEDED', 'FAILED', 'CANCELLED')`, [workspaceId, projectId],
        );
      } else {
        const stoppedWorkflows = await client.query<{ id: string; resume_state: string | null }>(
          `SELECT id::text, state_data->>'resumeState' AS resume_state
             FROM deviludo.workflow_instances
            WHERE workspace_id = $1::uuid AND project_id = $2::uuid AND state = 'STOPPED'
            FOR UPDATE`,
          [workspaceId, projectId],
        );
        await client.query(
          `UPDATE deviludo.workflow_instances
              SET state = CASE
                    WHEN state_data->>'resumeState' IN ('ANALYZING','DESIGNING','DEVELOPING','BUILDING','TEST_PLANNING','TESTING')
                      THEN (state_data->>'resumeState')::deviludo.workflow_state
                    ELSE 'DEVELOPING'::deviludo.workflow_state END,
                  state_data = state_data - 'resumeState', version = version + 1,
                  updated_at = clock_timestamp()
            WHERE workspace_id = $1::uuid AND project_id = $2::uuid AND state = 'STOPPED'`,
          [workspaceId, projectId],
        );
        for (const workflow of stoppedWorkflows.rows) {
          const resume = workflow.resume_state ?? "DEVELOPING";
          const resumedAt = randomUUID();
          if (resume === "DESIGNING") {
            await client.query(
              `SELECT deviludo.enqueue_job($1::uuid, $2::uuid, $3::uuid, 'AGENT_TURN', NULL, $4, $5::jsonb)`,
              [workspaceId, workflow.id, projectId, `${workflow.id}:resume:design:${resumedAt}`,
                JSON.stringify({ role: "DESIGN", purpose: "DESIGN", resumed: true })],
            );
          } else if (resume === "DEVELOPING") {
            await client.query(
              `SELECT deviludo.enqueue_job($1::uuid, $2::uuid, $3::uuid, 'AGENT_TURN', NULL, $4, $5::jsonb)`,
              [workspaceId, workflow.id, projectId, `${workflow.id}:resume:development:${resumedAt}`,
                JSON.stringify({ role: "DEVELOPMENT", purpose: "DEVELOPMENT", resumed: true })],
            );
          } else if (resume === "BUILDING") {
            await client.query(
              `SELECT deviludo.enqueue_job($1::uuid, $2::uuid, $3::uuid, 'BUILD', NULL, $4, $5::jsonb)`,
              [workspaceId, workflow.id, projectId, `${workflow.id}:resume:build:${resumedAt}`,
                JSON.stringify({ resumed: true })],
            );
          } else if (resume === "TEST_PLANNING" || resume === "TESTING") {
            await client.query(
              `UPDATE deviludo.workflow_instances SET state = 'TEST_PLANNING', updated_at = clock_timestamp()
                WHERE workspace_id = $1::uuid AND id = $2::uuid`, [workspaceId, workflow.id],
            );
            await client.query(
              `SELECT deviludo.enqueue_job($1::uuid, $2::uuid, $3::uuid, 'AGENT_TURN', NULL, $4, $5::jsonb)`,
              [workspaceId, workflow.id, projectId, `${workflow.id}:resume:test-plan:${resumedAt}`,
                JSON.stringify({ role: "TEST", purpose: "TEST_PLAN", resumed: true })],
            );
          }
        }
      }
      const nextState = stopped ? "STOPPED" : "DESTROYED";
      await client.query(
        `UPDATE deviludo.agent_containers
            SET generation = generation + 1, fencing_token = fencing_token + 1,
                state = $3::deviludo.agent_container_state, container_id = NULL,
                paused_at = NULL, destroyed_at = CASE WHEN $3 = 'DESTROYED' THEN clock_timestamp() ELSE NULL END,
                lease_token = NULL, lease_expires_at = NULL,
                last_activity_at = clock_timestamp(), updated_at = clock_timestamp()
          WHERE workspace_id = $1::uuid AND project_id = $2::uuid`,
        [workspaceId, projectId, nextState],
      );
      return runtimeRecord({ ...container, generation: Number(container.generation) + 1,
        fencing_token: Number(container.fencing_token) + 1, state: nextState,
        container_id: null, paused_at: null,
        destroyed_at: stopped ? null : new Date().toISOString(), last_activity_at: new Date().toISOString() });
    });
  }

  async readWorkflowState(workspaceId: string, projectId: string): Promise<string | null> {
    const result = await this.database.withWorkspace(workspaceId, client => client.query<{ state: string }>(
      `SELECT state::text FROM deviludo.workflow_instances
        WHERE workspace_id = $1::uuid AND project_id = $2::uuid
        ORDER BY iteration_number DESC LIMIT 1`, [workspaceId, projectId],
    ));
    return result.rows[0]?.state ?? null;
  }

  async readContainer(workspaceId: string, projectId: string): Promise<RuntimeRecord | null> {
    const result = await this.database.withWorkspace(workspaceId, client => client.query(
      `SELECT * FROM deviludo.agent_containers
        WHERE workspace_id = $1::uuid AND project_id = $2::uuid`, [workspaceId, projectId],
    ));
    return result.rows[0] ? runtimeRecord(result.rows[0]) : null;
  }

  async listContainers(): Promise<readonly RuntimeRecord[]> {
    const result = await this.database.pool.query(
      `SELECT * FROM deviludo.agent_containers ORDER BY last_activity_at, project_id`,
    );
    return Object.freeze(result.rows.map(row => runtimeRecord(row)));
  }

  async markContainer(workspaceId: string, projectId: string, input: Readonly<{
    generation: number;
    fencingToken: number;
    state: ProjectRuntimeState;
    containerId: string | null;
  }>): Promise<boolean> {
    const result = await this.database.withWorkspace(workspaceId, client => client.query(
      `UPDATE deviludo.agent_containers
          SET state = $5::deviludo.agent_container_state, container_id = $6,
              paused_at = CASE WHEN $5 = 'PAUSED' THEN clock_timestamp() ELSE NULL END,
              destroyed_at = CASE WHEN $5 = 'DESTROYED' THEN clock_timestamp() ELSE NULL END,
              last_activity_at = clock_timestamp(), updated_at = clock_timestamp()
        WHERE workspace_id = $1::uuid AND project_id = $2::uuid
          AND generation = $3 AND fencing_token = $4`,
      [workspaceId, projectId, input.generation, input.fencingToken, input.state, input.containerId],
    ));
    return result.rowCount === 1;
  }

  async startTurn(input: Readonly<{
    workspaceId: string;
    projectId: string;
    workflowJobId?: string;
    role: ProjectRuntimeRole;
    mode: ProjectRuntimeTurnMode;
    runtime: AgentRuntimeKind;
    contextRevision: number;
    sourceRevision: number | null;
    responseLanguage: "en" | "zh";
    lifecycleLeaseToken?: string;
  }>): Promise<StartedRuntimeTurn> {
    return this.database.withWorkspace(input.workspaceId, async client => {
      const container = await lockedContainer(client, input.workspaceId, input.projectId);
      if (container.runtime !== input.runtime) throw new Error("Project Runtime selection changed before the turn started");
      if (container.lease_token && container.lease_token !== input.lifecycleLeaseToken) {
        throw new Error("Project Runtime is completing a lifecycle transition");
      }
      if (container.state === "FAILED"
        || (container.state === "STOPPED" && input.role !== "INTENT" && input.mode !== "COMPACT")) {
        throw new Error(`Project Runtime is ${container.state.toLowerCase()}`);
      }
      const session = await client.query(
        `INSERT INTO deviludo.agent_sessions(
           workspace_id, project_id, role, runtime, container_generation, context_revision
         ) VALUES ($1::uuid, $2::uuid, $3::deviludo.agent_role, $4::deviludo.agent_runtime, $5, $6)
         ON CONFLICT (workspace_id, project_id, role, container_generation) DO UPDATE
           SET context_revision = greatest(deviludo.agent_sessions.context_revision, EXCLUDED.context_revision),
               updated_at = clock_timestamp()
         RETURNING id, active_turn_id`,
        [input.workspaceId, input.projectId, input.role, input.runtime, container.generation, input.contextRevision],
      );
      if (input.mode !== "READ_ONLY_BRANCH" && session.rows[0].active_turn_id) {
        const activeTurnId = String(session.rows[0].active_turn_id);
        const active = await client.query<{ output_summary: string | null; started_at: string }>(
          `SELECT output_summary, started_at::text
             FROM deviludo.agent_turns
            WHERE workspace_id = $1::uuid AND id = $2::uuid AND state = 'RUNNING'`,
          [input.workspaceId, activeTurnId],
        );
        const otherWorkflowJob = input.workflowJobId
          ? await client.query(
            `SELECT 1 FROM deviludo.jobs
              WHERE workspace_id = $1::uuid AND project_id = $2::uuid
                AND kind = 'AGENT_TURN' AND state = 'RUNNING' AND id <> $3::uuid
              LIMIT 1`,
            [input.workspaceId, input.projectId, input.workflowJobId],
          )
          : null;
        const marker = input.workflowJobId ? `workflow-job:${input.workflowJobId}` : null;
        const legacyOrphan = Boolean(input.workflowJobId && active.rows[0]
          && !active.rows[0].output_summary
          && Date.parse(active.rows[0].started_at) <= Date.now() - 2 * 60_000);
        const recoverable = Boolean(input.workflowJobId
          && otherWorkflowJob?.rowCount === 0
          && (!active.rows[0] || active.rows[0].output_summary === marker || legacyOrphan));
        if (!recoverable) {
          throw new Error(`${input.role} Runtime session already has an active primary turn`);
        }
        await client.query(
          `UPDATE deviludo.agent_turns
              SET state = 'FAILED', lease_token = NULL, mcp_token_hash = NULL,
                  mcp_token_expires_at = NULL,
                  output_summary = 'Recovered after its workflow Job was interrupted',
                  completed_at = clock_timestamp()
            WHERE workspace_id = $1::uuid AND id = $2::uuid AND state = 'RUNNING'`,
          [input.workspaceId, activeTurnId],
        );
        await client.query(
          `UPDATE deviludo.agent_sessions
              SET active_turn_id = NULL, updated_at = clock_timestamp()
            WHERE workspace_id = $1::uuid AND id = $2::uuid
              AND active_turn_id = $3::uuid`,
          [input.workspaceId, session.rows[0].id, activeTurnId],
        );
      }
      const turnId = randomUUID();
      const leaseToken = randomUUID();
      const mcpToken = randomBytes(48).toString("base64url");
      const mcpHash = `sha256:${createHash("sha256").update(mcpToken).digest("hex")}`;
      const expiresAt = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
      await client.query(
         `INSERT INTO deviludo.agent_turns(
           workspace_id, id, project_id, session_id, role, mode, state,
           context_revision, source_revision, response_language, lease_token,
           mcp_token_hash, mcp_token_expires_at, fencing_token, output_summary, started_at
         ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::deviludo.agent_role,
           $6::deviludo.agent_turn_mode, 'RUNNING', $7, $8, $9, $10::uuid,
           $11, $12::timestamptz, $13, $14, clock_timestamp())`,
        [input.workspaceId, turnId, input.projectId, session.rows[0].id, input.role,
          input.mode, input.contextRevision, input.sourceRevision, input.responseLanguage,
          leaseToken, mcpHash, expiresAt, container.fencing_token,
          input.workflowJobId ? `workflow-job:${input.workflowJobId}` : null],
      );
      if (input.mode !== "READ_ONLY_BRANCH") {
        await client.query(
          `UPDATE deviludo.agent_sessions
              SET active_turn_id = $3::uuid, updated_at = clock_timestamp()
            WHERE workspace_id = $1::uuid AND id = $2::uuid`,
          [input.workspaceId, session.rows[0].id, turnId],
        );
      }
      await client.query(
        `UPDATE deviludo.agent_containers
            SET state = 'RUNNING', paused_at = NULL, destroyed_at = NULL,
                last_activity_at = clock_timestamp(), updated_at = clock_timestamp()
          WHERE workspace_id = $1::uuid AND project_id = $2::uuid`,
        [input.workspaceId, input.projectId],
      );
      return Object.freeze({
        id: turnId, sessionId: session.rows[0].id, leaseToken, mcpToken,
        generation: Number(container.generation), fencingToken: Number(container.fencing_token),
      });
    });
  }

  async completeTurn(input: Readonly<{
    workspaceId: string;
    projectId: string;
    turnId: string;
    leaseToken: string;
    fencingToken: number;
    nativeSessionId: string;
    outputSummary: string;
    structuredOutput: Readonly<Record<string, unknown>>;
    toolSummary: readonly Readonly<Record<string, unknown>>[];
  }>): Promise<boolean> {
    return this.database.withWorkspace(input.workspaceId, async client => {
      const updated = await client.query(
        `UPDATE deviludo.agent_turns turn_row
            SET state = 'SUCCEEDED', lease_token = NULL, mcp_token_hash = NULL,
                mcp_token_expires_at = NULL, output_summary = $6,
                structured_output = $7::jsonb, tool_summary = $8::jsonb,
                completed_at = clock_timestamp()
          WHERE turn_row.workspace_id = $1::uuid AND turn_row.project_id = $2::uuid
            AND turn_row.id = $3::uuid AND turn_row.lease_token = $4::uuid
            AND turn_row.fencing_token = $5 AND turn_row.state = 'RUNNING'
          RETURNING turn_row.session_id, turn_row.mode`,
        [input.workspaceId, input.projectId, input.turnId, input.leaseToken,
          input.fencingToken, input.outputSummary.slice(0, 64_000),
          JSON.stringify(input.structuredOutput), JSON.stringify(input.toolSummary)],
      );
      if (updated.rowCount !== 1) return false;
      if (updated.rows[0].mode !== "READ_ONLY_BRANCH") {
        await client.query(
          `UPDATE deviludo.agent_sessions
              SET native_session_id = $3, summary = $4, active_turn_id = NULL,
                  updated_at = clock_timestamp()
            WHERE workspace_id = $1::uuid AND id = $2::uuid`,
          [input.workspaceId, updated.rows[0].session_id, input.nativeSessionId, input.outputSummary.slice(0, 64_000)],
        );
      }
      await client.query(
        `UPDATE deviludo.agent_containers
            SET last_activity_at = clock_timestamp(), updated_at = clock_timestamp()
          WHERE workspace_id = $1::uuid AND project_id = $2::uuid AND fencing_token = $3`,
        [input.workspaceId, input.projectId, input.fencingToken],
      );
      return true;
    });
  }

  async failTurn(input: Readonly<{
    workspaceId: string; projectId: string; turnId: string; leaseToken: string;
    fencingToken: number; error: string;
  }>): Promise<boolean> {
    return this.database.withWorkspace(input.workspaceId, async client => {
      const result = await client.query(
        `UPDATE deviludo.agent_turns
            SET state = 'FAILED', lease_token = NULL, mcp_token_hash = NULL,
                mcp_token_expires_at = NULL, output_summary = $6,
                completed_at = clock_timestamp()
          WHERE workspace_id = $1::uuid AND project_id = $2::uuid AND id = $3::uuid
            AND lease_token = $4::uuid AND fencing_token = $5 AND state = 'RUNNING'
          RETURNING mode`,
        [input.workspaceId, input.projectId, input.turnId, input.leaseToken,
          input.fencingToken, input.error.slice(0, 2_000)],
      );
      if (result.rowCount === 1 && result.rows[0].mode !== "READ_ONLY_BRANCH") {
        await client.query(
          `UPDATE deviludo.agent_sessions
              SET active_turn_id = NULL, updated_at = clock_timestamp()
            WHERE workspace_id = $1::uuid AND active_turn_id = $2::uuid`,
          [input.workspaceId, input.turnId],
        );
      }
      if (result.rowCount === 1) await client.query(
        `UPDATE deviludo.agent_containers
            SET last_activity_at = clock_timestamp(), updated_at = clock_timestamp()
          WHERE workspace_id = $1::uuid AND project_id = $2::uuid AND fencing_token = $3`,
        [input.workspaceId, input.projectId, input.fencingToken],
      );
      return result.rowCount === 1;
    });
  }

  async authorizeTool(input: Readonly<{
    workspaceId: string; projectId: string; turnId: string; role: ProjectRuntimeRole; token: string;
  }>): Promise<Readonly<{ sessionId: string; fencingToken: number; mode: ProjectRuntimeTurnMode }> | null> {
    const hash = `sha256:${createHash("sha256").update(input.token).digest("hex")}`;
    const result = await this.database.withWorkspace(input.workspaceId, client => client.query(
      `SELECT turn_row.session_id, turn_row.fencing_token, turn_row.mode
         FROM deviludo.agent_turns turn_row
         JOIN deviludo.agent_containers container
           ON container.workspace_id = turn_row.workspace_id AND container.project_id = turn_row.project_id
         JOIN deviludo.agent_sessions session
           ON session.workspace_id = turn_row.workspace_id AND session.id = turn_row.session_id
        WHERE turn_row.workspace_id = $1::uuid AND turn_row.project_id = $2::uuid
          AND turn_row.id = $3::uuid AND turn_row.role = $4::deviludo.agent_role
          AND turn_row.state = 'RUNNING' AND turn_row.mcp_token_hash = $5
          AND turn_row.mcp_token_expires_at > clock_timestamp()
          AND (turn_row.mode = 'READ_ONLY_BRANCH' OR session.active_turn_id = turn_row.id)
          AND container.fencing_token = turn_row.fencing_token`,
      [input.workspaceId, input.projectId, input.turnId, input.role, hash],
    ));
    return result.rows[0] ? Object.freeze({
      sessionId: result.rows[0].session_id,
      fencingToken: Number(result.rows[0].fencing_token),
      mode: result.rows[0].mode as ProjectRuntimeTurnMode,
    }) : null;
  }

  async beginToolCall(input: Readonly<{
    workspaceId: string; projectId: string; sessionId: string; turnId: string;
    role: ProjectRuntimeRole; name: string; arguments: Readonly<Record<string, unknown>>;
  }>): Promise<string> {
    const id = randomUUID();
    await this.database.withWorkspace(input.workspaceId, client => client.query(
      `INSERT INTO deviludo.agent_tool_calls(
         workspace_id, id, project_id, session_id, turn_id, role, tool_name,
         argument_summary, state
       ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
         $6::deviludo.agent_role, $7, $8::jsonb, 'RUNNING')`,
      [input.workspaceId, id, input.projectId, input.sessionId, input.turnId,
        input.role, input.name, JSON.stringify(input.arguments)],
    ));
    return id;
  }

  async finishToolCall(workspaceId: string, id: string, result: Readonly<Record<string, unknown>>, failed = false): Promise<void> {
    await this.database.withWorkspace(workspaceId, client => client.query(
      `UPDATE deviludo.agent_tool_calls
          SET state = $3, result_summary = $4::jsonb, completed_at = clock_timestamp()
        WHERE workspace_id = $1::uuid AND id = $2::uuid AND state = 'RUNNING'`,
      [workspaceId, id, failed ? "FAILED" : "SUCCEEDED", JSON.stringify(result)],
    ));
  }

  async sessionRoles(workspaceId: string, projectId: string, generation: number): Promise<readonly ProjectRuntimeRole[]> {
    const result = await this.database.withWorkspace(workspaceId, client => client.query(
      `SELECT role::text
         FROM deviludo.agent_sessions
        WHERE workspace_id = $1::uuid AND project_id = $2::uuid AND container_generation = $3
        ORDER BY created_at, role`,
      [workspaceId, projectId, generation],
    ));
    return Object.freeze(result.rows.map(row => row.role as ProjectRuntimeRole));
  }

  async claimLifecycle(): Promise<RuntimeLifecycleClaim | null> {
    const result = await this.database.pool.query(
      `SELECT * FROM deviludo.claim_agent_container_lifecycle($1, $2, $3)`,
      // Compaction is sequential across role sessions and can legitimately
      // exceed three minutes. Keep one owner for the complete bounded pass.
      [300, 1800, 900],
    );
    return lifecycleClaim(result.rows[0]);
  }

  async claimPressureLifecycle(): Promise<RuntimeLifecycleClaim | null> {
    const result = await this.database.pool.query(
      `SELECT * FROM deviludo.claim_paused_agent_container_for_pressure($1)`, [180],
    );
    return lifecycleClaim(result.rows[0]);
  }

  async completeLifecycle(claim: RuntimeLifecycleClaim): Promise<boolean> {
    const result = await this.database.pool.query(
      `SELECT deviludo.complete_agent_container_lifecycle(
         $1::uuid, $2::uuid, $3::uuid, $4::deviludo.agent_lifecycle_action
       ) AS completed`,
      [claim.workspaceId, claim.projectId, claim.leaseToken, claim.action],
    );
    return result.rows[0]?.completed === true;
  }

  async failLifecycle(claim: RuntimeLifecycleClaim): Promise<boolean> {
    const result = await this.database.pool.query(
      `SELECT deviludo.fail_agent_container_lifecycle($1::uuid, $2::uuid, $3::uuid) AS failed`,
      [claim.workspaceId, claim.projectId, claim.leaseToken],
    );
    return result.rows[0]?.failed === true;
  }
}

function lifecycleClaim(row: Record<string, unknown> | undefined): RuntimeLifecycleClaim | null {
  if (!row) return null;
  return Object.freeze({
    workspaceId: String(row.workspace_id), projectId: String(row.project_id),
    runtime: row.runtime as AgentRuntimeKind, generation: Number(row.generation),
    fencingToken: Number(row.fencing_token), state: row.action === "PAUSE" ? "COMPACTING" : "DESTROYED",
    containerId: row.container_id ? String(row.container_id) : null,
    activeRole: null, activeTurnId: null,
    lastActivityAt: new Date().toISOString(), pausedAt: null,
    action: row.action as RuntimeLifecycleClaim["action"], leaseToken: String(row.lease_token),
  });
}

async function lockedContainer(client: PoolClient, workspaceId: string, projectId: string) {
  const result = await client.query(
    `SELECT * FROM deviludo.agent_containers
      WHERE workspace_id = $1::uuid AND project_id = $2::uuid FOR UPDATE`, [workspaceId, projectId],
  );
  if (!result.rows[0]) throw new Error("Project Runtime has not been initialized");
  return result.rows[0];
}

function runtimeRecord(row: Record<string, unknown>): RuntimeRecord {
  return Object.freeze({
    workspaceId: String(row.workspace_id), projectId: String(row.project_id),
    runtime: row.runtime as AgentRuntimeKind, generation: Number(row.generation),
    fencingToken: Number(row.fencing_token), state: row.state as ProjectRuntimeState,
    containerId: row.container_id ? String(row.container_id) : null,
    activeRole: null,
    activeTurnId: null,
    lastActivityAt: new Date(String(row.last_activity_at)).toISOString(),
    pausedAt: row.paused_at ? new Date(String(row.paused_at)).toISOString() : null,
  });
}

function contextRecord(row: Record<string, unknown> | undefined): ProjectContextRecord | null {
  return row ? Object.freeze({
    revision: Number(row.revision),
    relativePath: String(row.relative_path),
    sha256: String(row.sha256),
    sizeBytes: Number(row.size_bytes),
  }) : null;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}

function arrayOfObjects(value: unknown): readonly Readonly<Record<string, unknown>>[] {
  if (!Array.isArray(value)) return Object.freeze([]);
  return Object.freeze(value
    .filter(item => item && typeof item === "object" && !Array.isArray(item))
    .map(item => Object.freeze({ ...(item as Record<string, unknown>) })));
}
