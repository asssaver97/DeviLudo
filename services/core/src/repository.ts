import type { PoolClient } from "pg";
import { randomUUID, verify } from "node:crypto";
import { AssetManifestStore, reconcileExistingSourceAssets } from "./asset-manifest";
import {
  AGENT_RUNTIME_KINDS,
  type AgentProgressEvent,
  type AgentProgressEventKind,
  type AgentModelOverrides,
  type AgentRuntimeKind,
  type ArtifactRecord,
  type E2eGoal,
  type E2eGoalDelta,
  type ImplementationChangeRequest,
  type ProductEvent,
  type ProductJob,
  type ProductWorkflowIterationDetail,
  type ProductWorkflowIterationSummary,
  type ProjectDiscoveryReport,
  type ProjectSourceRevision,
  type ProjectSteamSettings,
  type SteamRelease,
  type WorkspaceSteamSettings,
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
  ObjectReference,
  WorkflowSignalInput,
} from "./contracts";
import { executorReceiptSigningPayload } from "./contracts";
import { normalizeAgentModel, normalizeAgentModelOverrides } from "./agent-settings";
import {
  createInitialProjectDocument,
  parseProjectDocumentContent,
  projectDocumentMarkdown,
  synchronizeSpecificationWithProjectDocument,
  type ProjectDocumentContent,
} from "@/lib/product/project-document";
import { parseResponseLanguage, type ResponseLanguage } from "@/lib/product/response-language";
import { e2eGoalsDigest, initialE2eGoals, mergeE2eGoals } from "./e2e-goals";
import type { StoredConversationImage } from "./object-store";

export class CoreRepository {
  constructor(private readonly database: Database) {}

  async ping(): Promise<void> {
    await this.database.pool.query("SELECT 1");
  }

  async listHostSourceEvents(limit = 100): Promise<readonly HostSourceEvent[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
      throw new Error("Source event page size is invalid");
    }
    const result = await this.database.pool.query<HostSourceEventRow>(
      `SELECT event_id::text, workspace_id::text, project_id::text, workflow_id::text,
              source_revision::text, content_digest, actor_id::text, created_at::text
         FROM deviludo.pull_host_source_events($1::integer)`,
      [limit],
    );
    return Object.freeze(result.rows.map(row => Object.freeze({
      eventId: row.event_id,
      workspaceId: row.workspace_id,
      projectId: row.project_id,
      workflowId: row.workflow_id,
      sourceRevision: Number(row.source_revision),
      digest: row.content_digest,
      actorId: row.actor_id,
      createdAt: row.created_at,
    })));
  }

  async acknowledgeHostSourceEvents(eventIds: readonly string[]): Promise<number> {
    if (eventIds.length < 1 || eventIds.length > 500 || eventIds.some(id => !UUID.test(id))) {
      throw new Error("Source event acknowledgement is invalid");
    }
    const result = await this.database.pool.query<{ acknowledged: string }>(
      "SELECT deviludo.acknowledge_host_source_events($1::uuid[])::text AS acknowledged",
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

  async projectSourceRevisionExists(
    workspaceId: string,
    projectId: string,
    revision: number,
  ): Promise<boolean> {
    if (!UUID.test(projectId) || !Number.isSafeInteger(revision) || revision < 1) return false;
    return this.database.withWorkspace(workspaceId, async client => {
      const result = await client.query(
        `SELECT 1 FROM deviludo.project_source_revisions
          WHERE project_id = $1::uuid AND revision = $2::bigint
          LIMIT 1`,
        [projectId, revision],
      );
      return result.rowCount === 1;
    });
  }

  async readServerNodes(): Promise<readonly ServerNodeRecord[]> {
    const result = await this.database.pool.query<ServerNodeRow>(
      `SELECT id::text, pool_kind::text, operating_system::text, state::text, capabilities,
              isolation_generation::text, current_workspace_id::text, last_heartbeat_at::text,
              last_reimage_proof_at::text, preparation_state, preparation_stage,
              preparation_progress::text, preparation_message, preparation_updated_at::text
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

  async readWorkspaceSteamSettings(workspaceId: string): Promise<StoredWorkspaceSteamSettings | null> {
    return this.database.withWorkspace(workspaceId, async client => {
      const result = await client.query<WorkspaceSteamSettingsRow>(
        `SELECT builder_username, credential_secret_ref, credential_mask,
                credential_fingerprint, credential_version::text, revision::text, updated_at::text
           FROM deviludo.workspace_steam_settings
          WHERE workspace_id = $1::uuid`,
        [workspaceId],
      );
      return result.rows[0] ? workspaceSteamSettingsFromRow(result.rows[0]) : null;
    });
  }

  async saveWorkspaceSteamSettings(input: Readonly<{
    workspaceId: string;
    builderUsername: string;
    credentialSecretRef: string;
    credentialMask: string;
    credentialFingerprint: string;
    credentialVersion: string;
    updatedByActorId: string;
  }>): Promise<StoredWorkspaceSteamSettings> {
    return this.database.withWorkspace(input.workspaceId, async client => {
      const result = await client.query<WorkspaceSteamSettingsRow>(
        `INSERT INTO deviludo.workspace_steam_settings(
           workspace_id, builder_username, credential_secret_ref, credential_mask,
           credential_fingerprint, credential_version, revision, updated_by_actor_id
         ) VALUES ($1::uuid, $2, $3, $4, $5, $6::uuid, 1, $7::uuid)
         ON CONFLICT (workspace_id) DO UPDATE SET
           builder_username = EXCLUDED.builder_username,
           credential_secret_ref = EXCLUDED.credential_secret_ref,
           credential_mask = EXCLUDED.credential_mask,
           credential_fingerprint = EXCLUDED.credential_fingerprint,
           credential_version = EXCLUDED.credential_version,
           revision = deviludo.workspace_steam_settings.revision + 1,
           updated_by_actor_id = EXCLUDED.updated_by_actor_id,
           updated_at = clock_timestamp()
         RETURNING builder_username, credential_secret_ref, credential_mask,
                   credential_fingerprint, credential_version::text, revision::text, updated_at::text`,
        [input.workspaceId, input.builderUsername, input.credentialSecretRef, input.credentialMask,
          input.credentialFingerprint, input.credentialVersion, input.updatedByActorId],
      );
      return workspaceSteamSettingsFromRow(result.rows[0]);
    });
  }

  async readProjectSteamSettings(workspaceId: string, projectId: string): Promise<ProjectSteamSettings | null> {
    return this.database.withWorkspace(workspaceId, async client => {
      const result = await client.query<ProjectSteamSettingsRow>(
        `SELECT project_id::text, app_id::text, depot_linux::text, depot_windows::text,
                depot_macos::text, test_branch, revision::text, updated_at::text
           FROM deviludo.project_steam_settings
          WHERE workspace_id = $1::uuid AND project_id = $2::uuid`,
        [workspaceId, projectId],
      );
      return result.rows[0] ? projectSteamSettingsFromRow(result.rows[0]) : null;
    });
  }

  async saveProjectSteamSettings(input: Readonly<{
    workspaceId: string;
    projectId: string;
    appId: string;
    depots: Readonly<Partial<Record<ServerOperatingSystem, string>>>;
    testBranch: string;
    updatedByActorId: string;
  }>): Promise<ProjectSteamSettings> {
    return this.database.withWorkspace(input.workspaceId, async client => {
      const result = await client.query<ProjectSteamSettingsRow>(
        `INSERT INTO deviludo.project_steam_settings(
           workspace_id, project_id, app_id, depot_linux, depot_windows, depot_macos,
           test_branch, revision, updated_by_actor_id
         ) VALUES ($1::uuid, $2::uuid, $3::bigint, $4::bigint, $5::bigint, $6::bigint, $7, 1, $8::uuid)
         ON CONFLICT (workspace_id, project_id) DO UPDATE SET
           app_id = EXCLUDED.app_id, depot_linux = EXCLUDED.depot_linux,
           depot_windows = EXCLUDED.depot_windows, depot_macos = EXCLUDED.depot_macos,
           test_branch = EXCLUDED.test_branch,
           revision = deviludo.project_steam_settings.revision + 1,
           updated_by_actor_id = EXCLUDED.updated_by_actor_id,
           updated_at = clock_timestamp()
         RETURNING project_id::text, app_id::text, depot_linux::text, depot_windows::text,
                   depot_macos::text, test_branch, revision::text, updated_at::text`,
        [input.workspaceId, input.projectId, input.appId, input.depots.linux ?? null,
          input.depots.windows ?? null, input.depots.macos ?? null, input.testBranch,
          input.updatedByActorId],
      );
      return projectSteamSettingsFromRow(result.rows[0]);
    });
  }

  async listSteamReleases(workspaceId: string, projectId: string): Promise<readonly SteamRelease[]> {
    return this.database.withWorkspace(workspaceId, async client => {
      const result = await client.query<SteamReleaseRow>(
        `SELECT release.id::text, release.project_id::text, release.workflow_id::text,
                workflow.iteration_number, release.version, release.release_number::text,
                release.channel::text, release.target_branch, release.state::text,
                release.steam_build_id, release.failure_message, release.created_at::text,
                release.uploaded_at::text, release.live_at::text
           FROM deviludo.steam_releases release
           JOIN deviludo.workflow_instances workflow
             ON workflow.workspace_id = release.workspace_id AND workflow.id = release.workflow_id
          WHERE release.workspace_id = $1::uuid AND release.project_id = $2::uuid
          ORDER BY release.release_number DESC`,
        [workspaceId, projectId],
      );
      return Object.freeze(result.rows.map(steamReleaseFromRow));
    });
  }

  async createSteamRelease(input: Readonly<{
    workspaceId: string;
    projectId: string;
    workflowId: string;
    version: string;
    channel: "TEST" | "DEFAULT";
    requestedByActorId: string;
  }>): Promise<Readonly<{ release: SteamRelease; accepted: boolean }>> {
    return this.database.withWorkspace(input.workspaceId, async client => {
      await client.query(
        `SELECT 1 FROM deviludo.projects
          WHERE workspace_id = $1::uuid AND id = $2::uuid FOR UPDATE`,
        [input.workspaceId, input.projectId],
      );
      const existing = await client.query<SteamReleaseRow>(steamReleaseSelectSql("release.workflow_id = $3::uuid"),
        [input.workspaceId, input.projectId, input.workflowId]);
      if (existing.rows[0]) {
        if (existing.rows[0].version !== input.version || existing.rows[0].channel !== input.channel) {
          throw new Error("This iteration already has a different Steam release");
        }
        return Object.freeze({ release: steamReleaseFromRow(existing.rows[0]), accepted: false });
      }

      const context = await client.query<{
        iteration_number: number;
        state: string;
        target_platforms: ServerOperatingSystem[];
        app_id: string;
        depot_linux: string | null;
        depot_windows: string | null;
        depot_macos: string | null;
        test_branch: string;
        project_revision: string;
        builder_username: string;
        credential_secret_ref: string;
        credential_revision: string;
      }>(
        `SELECT workflow.iteration_number, workflow.state::text, workflow.target_platforms,
                project.app_id::text, project.depot_linux::text, project.depot_windows::text,
                project.depot_macos::text, project.test_branch, project.revision::text AS project_revision,
                workspace.builder_username, workspace.credential_secret_ref,
                workspace.revision::text AS credential_revision
           FROM deviludo.workflow_instances workflow
           JOIN deviludo.project_steam_settings project
             ON project.workspace_id = workflow.workspace_id AND project.project_id = workflow.project_id
           JOIN deviludo.workspace_steam_settings workspace
             ON workspace.workspace_id = workflow.workspace_id
          WHERE workflow.workspace_id = $1::uuid AND workflow.project_id = $2::uuid
            AND workflow.id = $3::uuid
            AND workflow.iteration_number = (
              SELECT max(latest.iteration_number) FROM deviludo.workflow_instances latest
               WHERE latest.workspace_id = workflow.workspace_id AND latest.project_id = workflow.project_id
            )
          FOR UPDATE OF workflow`,
        [input.workspaceId, input.projectId, input.workflowId],
      );
      const settings = context.rows[0];
      if (!settings) throw new Error("Steam workspace and project configuration is required");
      if (settings.state !== "RELEASE_APPROVAL_PENDING") throw new Error("Workflow is not awaiting a release decision");
      const depots = { linux: settings.depot_linux, windows: settings.depot_windows, macos: settings.depot_macos };
      for (const platform of settings.target_platforms) {
        if (!depots[platform]) throw new Error(`Steam depot is missing for ${platform}`);
      }
      const artifacts = await client.query<{ target_platform: ServerOperatingSystem; sha256: string }>(
        `SELECT artifact.target_platform, artifact.sha256
           FROM deviludo.artifacts artifact
           JOIN deviludo.jobs build ON build.workspace_id = artifact.workspace_id
             AND build.id = artifact.producing_job_id
          WHERE artifact.workspace_id = $1::uuid AND artifact.workflow_id = $2::uuid
            AND artifact.kind = 'BUILD' AND build.kind = 'BUILD' AND build.state = 'SUCCEEDED'
            AND build.id = (
              SELECT latest.id FROM deviludo.jobs latest
               WHERE latest.workspace_id = $1::uuid AND latest.workflow_id = $2::uuid
                 AND latest.kind = 'BUILD' AND latest.state = 'SUCCEEDED'
               ORDER BY latest.updated_at DESC, latest.created_at DESC LIMIT 1
            )`,
        [input.workspaceId, input.workflowId],
      );
      const buildDigests = Object.fromEntries(artifacts.rows.map(row => [row.target_platform, row.sha256]));
      if (settings.target_platforms.some(platform => !buildDigests[platform])) {
        throw new Error("Validated build artifacts are incomplete");
      }
      const nextNumber = await client.query<{ value: string }>(
        `SELECT (coalesce(max(release_number), 0) + 1)::text AS value
           FROM deviludo.steam_releases
          WHERE workspace_id = $1::uuid AND project_id = $2::uuid`,
        [input.workspaceId, input.projectId],
      );
      const releaseId = randomUUID();
      const targetBranch = input.channel === "TEST" ? settings.test_branch : "default";
      await client.query(
        `INSERT INTO deviludo.steam_releases(
           workspace_id, id, project_id, workflow_id, version, release_number, channel,
           target_branch, app_id, depot_linux, depot_windows, depot_macos,
           project_settings_revision, builder_username, credential_secret_ref,
           credential_revision, build_digests, requested_by_actor_id
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6::bigint, $7::deviludo.steam_release_channel,
           $8, $9::bigint, $10::bigint, $11::bigint, $12::bigint, $13::bigint,
           $14, $15, $16::bigint, $17::jsonb, $18::uuid
         )`,
        [input.workspaceId, releaseId, input.projectId, input.workflowId, input.version,
          nextNumber.rows[0].value, input.channel, targetBranch, settings.app_id,
          settings.depot_linux, settings.depot_windows, settings.depot_macos,
          settings.project_revision, settings.builder_username, settings.credential_secret_ref,
          settings.credential_revision, JSON.stringify(buildDigests), input.requestedByActorId],
      );
      const accepted = await client.query<{ accepted: boolean }>(
        `SELECT deviludo.start_steam_release($1::uuid, $2::uuid, $3, $4::jsonb) AS accepted`,
        [input.workflowId, releaseId, `release-approved:${releaseId}`,
          JSON.stringify({ requestedByActorId: input.requestedByActorId })],
      );
      const release = await client.query<SteamReleaseRow>(steamReleaseSelectSql("release.id = $3::uuid"),
        [input.workspaceId, input.projectId, releaseId]);
      return Object.freeze({ release: steamReleaseFromRow(release.rows[0]), accepted: accepted.rows[0]?.accepted === true });
    });
  }

  async completeWorkflowIteration(input: Readonly<{
    workspaceId: string;
    workflowId: string;
    idempotencyKey: string;
    requestedByActorId: string;
  }>): Promise<boolean> {
    return this.database.withWorkspace(input.workspaceId, async client => {
      const result = await client.query<{ accepted: boolean }>(
        `SELECT deviludo.complete_workflow_iteration($1::uuid, $2, $3::jsonb) AS accepted`,
        [input.workflowId, input.idempotencyKey,
          JSON.stringify({ requestedByActorId: input.requestedByActorId })],
      );
      return result.rows[0]?.accepted === true;
    });
  }

  async retrySteamRelease(input: Readonly<{
    workspaceId: string;
    workflowId: string;
    idempotencyKey: string;
    requestedByActorId: string;
  }>): Promise<boolean> {
    return this.database.withWorkspace(input.workspaceId, async client => {
      const result = await client.query<{ accepted: boolean }>(
        `SELECT deviludo.retry_steam_release($1::uuid, $2, $3::jsonb) AS accepted`,
        [input.workflowId, input.idempotencyKey,
          JSON.stringify({ requestedByActorId: input.requestedByActorId })],
      );
      return result.rows[0]?.accepted === true;
    });
  }

  async confirmSteamReleaseLive(input: Readonly<{
    workspaceId: string;
    projectId: string;
    releaseId: string;
  }>): Promise<SteamRelease | null> {
    return this.database.withWorkspace(input.workspaceId, async client => {
      const updated = await client.query<SteamReleaseRow>(
        `${steamReleaseSelectSql("release.id = $3::uuid", true)}
         `,
        [input.workspaceId, input.projectId, input.releaseId],
      );
      if (!updated.rows[0] || updated.rows[0].state !== "AWAITING_DEFAULT_PROMOTION") return null;
      await client.query(
        `UPDATE deviludo.steam_releases SET state = 'LIVE_DEFAULT', live_at = clock_timestamp(),
          updated_at = clock_timestamp()
         WHERE workspace_id = $1::uuid AND project_id = $2::uuid AND id = $3::uuid
           AND state = 'AWAITING_DEFAULT_PROMOTION'`,
        [input.workspaceId, input.projectId, input.releaseId],
      );
      const result = await client.query<SteamReleaseRow>(steamReleaseSelectSql("release.id = $3::uuid"),
        [input.workspaceId, input.projectId, input.releaseId]);
      return result.rows[0] ? steamReleaseFromRow(result.rows[0]) : null;
    });
  }

  async readAgentSettings(): Promise<StoredInstanceAgentSettings | null> {
    const result = await this.database.pool.query<AgentSettingsRow>(
        `SELECT agent_runtime::text, base_url, primary_model, model_overrides, image_model, credential_secret_ref,
                test_policy_ready, test_policy_checked_revision::text,
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
    primaryModel: string;
    modelOverrides: AgentModelOverrides;
    imageModel: string | null;
    credentialSecretRef: string;
    apiKeyMask: string;
    apiKeyFingerprint: string;
    credentialVersion: string;
    updatedBy: string;
  }>): Promise<StoredInstanceAgentSettings> {
      const result = await this.database.pool.query<AgentSettingsRow>(
        `INSERT INTO deviludo.instance_agent_settings(
           singleton, agent_runtime, base_url, primary_model, model_overrides, image_model, credential_secret_ref,
           api_key_mask, api_key_fingerprint, credential_version, updated_by
         ) VALUES (
           true, $1::deviludo.agent_runtime, $2, $3, $4::jsonb, $5, $6, $7, $8, $9::uuid, $10
         )
         ON CONFLICT (singleton) DO UPDATE SET
           agent_runtime = EXCLUDED.agent_runtime,
           base_url = EXCLUDED.base_url,
           primary_model = EXCLUDED.primary_model,
           model_overrides = EXCLUDED.model_overrides,
           image_model = EXCLUDED.image_model,
           credential_secret_ref = EXCLUDED.credential_secret_ref,
           api_key_mask = EXCLUDED.api_key_mask,
           api_key_fingerprint = EXCLUDED.api_key_fingerprint,
           credential_version = EXCLUDED.credential_version,
           test_policy_ready = false,
           test_policy_checked_revision = NULL,
           revision = deviludo.instance_agent_settings.revision + 1,
           updated_by = EXCLUDED.updated_by,
           updated_at = clock_timestamp()
         RETURNING agent_runtime::text, base_url, primary_model, model_overrides, image_model, credential_secret_ref,
                   test_policy_ready, test_policy_checked_revision::text,
                   api_key_mask, api_key_fingerprint, credential_version::text, revision::text,
                   updated_by, updated_at::text
       `,
        [
          input.agentRuntime,
          input.baseUrl,
          input.primaryModel,
          JSON.stringify(input.modelOverrides),
          input.imageModel,
          input.credentialSecretRef,
          input.apiKeyMask,
          input.apiKeyFingerprint,
          input.credentialVersion,
          input.updatedBy,
        ],
      );
      return agentSettingsFromRow(result.rows[0]);
  }

  async markTestPolicyReady(settingsRevision: number): Promise<boolean> {
    const result = await this.database.pool.query(
      `UPDATE deviludo.instance_agent_settings
          SET test_policy_ready = true, test_policy_checked_revision = revision,
              updated_at = clock_timestamp()
        WHERE singleton = true AND revision = $1::bigint`,
      [settingsRevision],
    );
    return (result.rowCount ?? 0) === 1;
  }

  async markTestPolicyUnavailable(settingsRevision: number): Promise<boolean> {
    const result = await this.database.pool.query(
      `UPDATE deviludo.instance_agent_settings
          SET test_policy_ready = false, test_policy_checked_revision = NULL,
              updated_at = clock_timestamp()
        WHERE singleton = true AND revision = $1::bigint`,
      [settingsRevision],
    );
    return (result.rowCount ?? 0) === 1;
  }

  async lockE2ePlayerPolicy(input: Readonly<{
    workspaceId: string;
    jobId: string;
    settingsRevision: number;
    runtime: AgentRuntimeKind;
    baseUrl: string;
    model: string;
    credentialSecretRef: string;
    configurationDigest: string;
  }>): Promise<Readonly<{
    settingsRevision: number;
    runtime: AgentRuntimeKind;
    baseUrl: string;
    model: string;
    credentialSecretRef: string;
    configurationDigest: string;
  }>> {
    return this.database.withWorkspace(input.workspaceId, async client => {
      await client.query(
        `INSERT INTO deviludo.e2e_policy_locks(
           workspace_id, job_id, settings_revision, runtime, base_url, model,
           credential_secret_ref, configuration_digest
         ) VALUES ($1::uuid, $2::uuid, $3::bigint, $4::deviludo.agent_runtime, $5, $6, $7, $8)
         ON CONFLICT (workspace_id, job_id) DO NOTHING`,
        [input.workspaceId, input.jobId, input.settingsRevision, input.runtime, input.baseUrl,
          input.model, input.credentialSecretRef, input.configurationDigest],
      );
      const locked = await client.query<{
        settings_revision: string; runtime: AgentRuntimeKind; base_url: string; model: string;
        credential_secret_ref: string; configuration_digest: string;
      }>(
        `SELECT settings_revision::text, runtime::text, base_url, model,
                credential_secret_ref, configuration_digest FROM deviludo.e2e_policy_locks
          WHERE workspace_id = $1::uuid AND job_id = $2::uuid FOR UPDATE`,
        [input.workspaceId, input.jobId],
      );
      const row = locked.rows[0];
      if (!row) throw new Error("Test Agent policy lock could not be created");
      return Object.freeze({
        settingsRevision: Number(row.settings_revision), runtime: row.runtime, baseUrl: row.base_url,
        model: row.model, credentialSecretRef: row.credential_secret_ref,
        configurationDigest: row.configuration_digest,
      });
    });
  }

  /** The last successful Agent manifest owns immutable asset-to-control intent
   * and can also carry a semantic test hint that the Test Agent revalidates. */
  async readProjectAgentManifestObject(input: Readonly<{
    workspaceId: string;
    workflowId: string;
    projectId: string;
  }>): Promise<ObjectReference | null> {
    return this.database.withWorkspace(input.workspaceId, async client => {
      const result = await client.query<{
        bucket: string;
        object_key: string;
        sha256: `sha256:${string}`;
        size_bytes: string;
      }>(
        `SELECT artifact.bucket, artifact.object_key, artifact.sha256, artifact.size_bytes::text
           FROM deviludo.artifacts artifact
           JOIN deviludo.jobs producer
             ON producer.workspace_id = artifact.workspace_id
            AND producer.id = artifact.producing_job_id
          WHERE artifact.workspace_id = $1::uuid
            AND artifact.workflow_id = $2::uuid
            AND artifact.project_id = $3::uuid
            AND artifact.kind = 'SPECIFICATION'
            AND producer.kind = 'AGENT_TURN'
            AND producer.state = 'SUCCEEDED'
          ORDER BY artifact.created_at DESC, artifact.id DESC
          LIMIT 1`,
        [input.workspaceId, input.workflowId, input.projectId],
      );
      const row = result.rows[0];
      return row ? Object.freeze({
        kind: "SPECIFICATION",
        bucket: row.bucket,
        key: row.object_key,
        sha256: row.sha256,
        sizeBytes: Number(row.size_bytes),
      }) : null;
    });
  }

  async readProjectE2eRegressionObject(input: Readonly<{
    workspaceId: string;
    projectId: string;
    platform: ServerOperatingSystem;
  }>): Promise<ObjectReference | null> {
    return this.database.withWorkspace(input.workspaceId, async client => {
      const result = await client.query<{
        bucket: string;
        object_key: string;
        sha256: `sha256:${string}`;
        size_bytes: string;
      }>(
        `SELECT artifact.bucket, artifact.object_key, artifact.sha256, artifact.size_bytes::text
           FROM deviludo.e2e_regression_traces trace
           JOIN deviludo.artifacts artifact
             ON artifact.workspace_id = trace.workspace_id AND artifact.id = trace.artifact_id
          WHERE trace.workspace_id = $1::uuid AND trace.project_id = $2::uuid
            AND trace.target_platform = $3::deviludo.server_os`,
        [input.workspaceId, input.projectId, input.platform],
      );
      const row = result.rows[0];
      return row ? Object.freeze({
        kind: "E2E_REGRESSION",
        bucket: row.bucket,
        key: row.object_key,
        sha256: row.sha256,
        sizeBytes: Number(row.size_bytes),
      }) : null;
    });
  }

  async readE2ePlayerDecision(input: Readonly<{
    workspaceId: string;
    jobId: string;
    rolloutIndex: number;
    decisionIndex: number;
    requestDigest: string;
  }>): Promise<Readonly<Record<string, unknown>> | null> {
    return this.database.withWorkspace(input.workspaceId, async client => {
      const result = await client.query<{ request_digest: string; decision: unknown }>(
        `SELECT request_digest, decision FROM deviludo.e2e_policy_decisions
          WHERE workspace_id = $1::uuid AND job_id = $2::uuid
            AND rollout_index = $3::integer AND decision_index = $4::integer`,
        [input.workspaceId, input.jobId, input.rolloutIndex, input.decisionIndex],
      );
      if (!result.rows[0]) return null;
      if (result.rows[0].request_digest !== input.requestDigest) throw new Error("E2E policy decision idempotency input changed");
      if (!result.rows[0].decision || typeof result.rows[0].decision !== "object" || Array.isArray(result.rows[0].decision)) {
        throw new Error("Stored E2E policy decision is invalid");
      }
      return Object.freeze(result.rows[0].decision as Record<string, unknown>);
    });
  }

  async withE2ePlayerDecisionLock<T>(input: Readonly<{
    workspaceId: string;
    jobId: string;
    rolloutIndex: number;
    decisionIndex: number;
  }>, operation: () => Promise<T>): Promise<T> {
    const client = await this.database.pool.connect();
    const lockKey = [input.workspaceId, input.jobId, input.rolloutIndex, input.decisionIndex].join(":");
    try {
      await client.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [lockKey]);
      return await operation();
    } finally {
      await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [lockKey]).catch(() => undefined);
      client.release();
    }
  }

  async saveE2ePlayerDecision(input: Readonly<{
    workspaceId: string;
    jobId: string;
    rolloutIndex: number;
    decisionIndex: number;
    requestDigest: string;
    screenshotDigest: string;
    decision: Readonly<Record<string, unknown>>;
    latencyMs: number;
    inputTokens: number;
    outputTokens: number;
  }>): Promise<Readonly<Record<string, unknown>>> {
    await this.database.withWorkspace(input.workspaceId, async client => {
      await client.query(
        `INSERT INTO deviludo.e2e_policy_decisions(
           workspace_id, job_id, rollout_index, decision_index, request_digest,
           screenshot_digest, decision, latency_ms, input_tokens, output_tokens
         ) VALUES ($1::uuid, $2::uuid, $3::integer, $4::integer, $5, $6, $7::jsonb, $8::integer, $9::integer, $10::integer)
         ON CONFLICT (workspace_id, job_id, rollout_index, decision_index) DO NOTHING`,
        [input.workspaceId, input.jobId, input.rolloutIndex, input.decisionIndex,
          input.requestDigest, input.screenshotDigest, JSON.stringify(input.decision), input.latencyMs,
          input.inputTokens, input.outputTokens],
      );
    });
    return await this.readE2ePlayerDecision(input) ?? input.decision;
  }

  async listProjects(workspaceId: string): Promise<readonly ProductProjectSummary[]> {
    return this.database.withWorkspace(workspaceId, async client => {
      const result = await client.query<ProductProjectRow>(
        `SELECT p.id::text, p.name, p.created_at::text,
                workflow.id::text AS workflow_id,
                workflow.iteration_number,
                workflow.state::text AS workflow_state,
                workflow.profile::text AS profile,
                workflow.target_platforms::text[] AS target_platforms,
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
             SELECT id, iteration_number, state, profile, target_platforms, state_data, updated_at
               FROM deviludo.workflow_instances
              WHERE workspace_id = p.workspace_id AND project_id = p.id
              ORDER BY iteration_number DESC
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
    actorId: string;
    workspaceId: string;
    workspaceName: string;
    projectId: string;
    workflowId: string;
    idempotencyKey: string;
    name: string;
    concept: string;
    specification: Readonly<Record<string, unknown>>;
    responseLanguage?: ResponseLanguage;
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
        `INSERT INTO deviludo.projects(workspace_id, id, created_by_actor_id, name)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4)`,
        [input.workspaceId, input.projectId, input.actorId, input.name],
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
          JSON.stringify({
            concept: input.concept,
            specification: input.specification,
            e2eGoalRevision: 1,
            responseLanguage: parseResponseLanguage(input.responseLanguage),
            iteration: initialIterationState(),
          }),
        ],
      );
      await client.query(
        `INSERT INTO deviludo.workflow_events(
           workspace_id, workflow_id, event_kind, event_data, idempotency_key
         ) VALUES ($1::uuid, $2::uuid, 'PROJECT_CREATED', $3::jsonb, 'project-created')`,
        [input.workspaceId, input.workflowId, JSON.stringify({ concept: input.concept })],
      );
      await insertInitialE2eGoalRevision(client, input.workspaceId, input.workflowId, input.specification);
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


  /**
   * Persist the directory link before any source read or Provider call. This is
   * deliberately a small transaction so the browser can leave the picker as
   * soon as a durable project card exists.
   */
  async createPendingImportedProject(input: Readonly<{
    actorId: string;
    workspaceId: string;
    workspaceName: string;
    projectId: string;
    workflowId: string;
    idempotencyKey: string;
    name: string;
    responseLanguage?: ResponseLanguage;
    source: Readonly<{
      kind: "GIT" | "LOCAL_DIRECTORY";
      repositoryUrl: string | null;
      localDirectoryBindingId: string;
      gitBranch: string | null;
      displayName: string;
    }>;
    profile: "VALIDATE" | "RELEASE";
    targetPlatforms: readonly ServerOperatingSystem[];
  }>): Promise<ProductProjectDetail> {
    const responseLanguage = parseResponseLanguage(input.responseLanguage);
    const concept = responseLanguage === "zh"
      ? `正在分析《${input.name}》的现有源码。`
      : `Analyzing the existing source for “${input.name}”.`;
    const specification = Object.freeze({ title: input.name });
    await this.database.withWorkspace(input.workspaceId, async client => {
      await client.query(
        `INSERT INTO deviludo.workspaces(id, name) VALUES ($1::uuid, $2)
         ON CONFLICT (id) DO NOTHING`,
        [input.workspaceId, input.workspaceName],
      );
      await client.query(
        `INSERT INTO deviludo.projects(workspace_id, id, created_by_actor_id, name)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4)`,
        [input.workspaceId, input.projectId, input.actorId, input.name],
      );
      await insertInitialProjectDocument(client, {
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        name: input.name,
        concept,
        specification,
        responseLanguage,
      });
      await client.query(
        `INSERT INTO deviludo.workflow_instances(
           workspace_id, id, project_id, profile, target_platforms, state_data
         ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::deviludo.workflow_profile, $5::deviludo.server_os[], $6::jsonb)`,
        [input.workspaceId, input.workflowId, input.projectId, input.profile, input.targetPlatforms, JSON.stringify({
          concept,
          specification,
          e2eGoalRevision: 1,
          responseLanguage,
          source: {
            ...input.source,
            fileCount: 0,
            totalBytes: 0,
          },
          importAnalysis: {
            status: "PENDING",
            attempts: 0,
            error: null,
          },
          iteration: initialIterationState(),
        })],
      );
      await client.query(
        `INSERT INTO deviludo.workflow_events(
           workspace_id, workflow_id, event_kind, event_data, idempotency_key
         ) VALUES ($1::uuid, $2::uuid, 'PROJECT_LINKED', $3::jsonb, 'project-linked')`,
        [input.workspaceId, input.workflowId, JSON.stringify({
          sourceKind: input.source.kind,
          repositoryUrl: input.source.repositoryUrl,
          localDirectoryBindingId: input.source.localDirectoryBindingId,
          gitBranch: input.source.gitBranch,
        })],
      );
      await insertInitialE2eGoalRevision(client, input.workspaceId, input.workflowId, specification);
      await client.query(
        `INSERT INTO deviludo.project_creation_receipts(
           idempotency_key, operation_kind, workspace_id, project_id
         ) VALUES ($1, 'PROJECT', $2::uuid, $3::uuid)`,
        [input.idempotencyKey, input.workspaceId, input.projectId],
      );
    });
    const project = await this.readProject(input.workspaceId, input.projectId);
    if (!project) throw new Error("Linked project could not be read");
    return project;
  }

  async claimProjectImportAnalysis(leaseSeconds: number): Promise<PendingProjectImportAnalysis | null> {
    if (!Number.isSafeInteger(leaseSeconds) || leaseSeconds < 60 || leaseSeconds > 3_600) {
      throw new Error("Project analysis lease is invalid");
    }
    const result = await this.database.pool.query<PendingProjectImportAnalysisRow>(
      "SELECT * FROM deviludo.claim_project_import_analysis($1::integer)",
      [leaseSeconds],
    );
    const row = result.rows[0];
    if (!row) return null;
    const languageResult = await this.database.withWorkspace(row.workspaceId, async client => client.query<{ response_language: unknown }>(
      `SELECT state_data->'responseLanguage' AS response_language
         FROM deviludo.workflow_instances WHERE id = $1::uuid`,
      [row.workflowId],
    ));
    return Object.freeze({
      workspaceId: row.workspaceId,
      projectId: row.projectId,
      workflowId: row.workflowId,
      actorId: row.actorId,
      leaseToken: row.leaseToken,
      sourceKind: row.sourceKind,
      repositoryUrl: row.repositoryUrl,
      localDirectoryBindingId: row.localDirectoryBindingId,
      gitBranch: row.gitBranch,
      displayName: row.displayName,
      responseLanguage: parseResponseLanguage(languageResult.rows[0]?.response_language),
    });
  }

  async completeProjectImportAnalysis(input: Readonly<{
    workspaceId: string;
    projectId: string;
    workflowId: string;
    actorId: string;
    leaseToken: string;
    hosted?: boolean;
    name: string;
    concept: string;
    specification: Readonly<Record<string, unknown>>;
    document: ProjectDocumentContent;
    responseLanguage?: ResponseLanguage;
    assistantContent: string;
    assistantMetadata: Readonly<Record<string, unknown>>;
    designAssistant: Readonly<{
      content: string;
      metadata: Readonly<Record<string, unknown>>;
    }>;
    discovery: ProjectDiscoveryReport;
    source: Readonly<{
      kind: "GIT" | "LOCAL_DIRECTORY";
      repositoryUrl: string | null;
      localDirectoryBindingId: string;
      gitBranch: string | null;
      displayName: string;
      fileCount: number;
      totalBytes: number;
      revision: number;
      relativePath: string;
      sha256: string;
    }>;
  }>): Promise<boolean> {
    return this.database.withWorkspace(input.workspaceId, async client => {
      const workflow = await client.query<{ state_data: Record<string, unknown>; project_name: string }>(
        `SELECT workflow.state_data, project.name AS project_name
           FROM deviludo.workflow_instances workflow
           JOIN deviludo.projects project
             ON project.workspace_id = workflow.workspace_id AND project.id = workflow.project_id
          WHERE workflow.id = $1::uuid AND workflow.project_id = $2::uuid
          FOR UPDATE OF workflow`,
        [input.workflowId, input.projectId],
      );
      const row = workflow.rows[0];
      if (!row || (!input.hosted && !analysisLeaseMatches(row.state_data, input.leaseToken))) return false;
      await client.query(
        `UPDATE deviludo.projects SET name = $3, last_activity_at = clock_timestamp()
          WHERE workspace_id = $1::uuid AND id = $2::uuid`,
        [input.workspaceId, input.projectId, input.name],
      );

      const currentDocument = await client.query<{ revision: string }>(
        "SELECT revision::text FROM deviludo.project_documents WHERE project_id = $1::uuid FOR UPDATE",
        [input.projectId],
      );
      const revision = Number(currentDocument.rows[0]?.revision ?? 0) + 1;
      const document = parseProjectDocumentContent(input.document);
      const markdown = projectDocumentMarkdown(
        input.name,
        document,
        parseResponseLanguage(input.responseLanguage ?? row.state_data.responseLanguage),
      );
      await client.query(
        `UPDATE deviludo.project_documents
            SET revision = $2::bigint, content = $3::jsonb, markdown = $4,
                maintained_by = 'AGENT', last_agent_maintained_at = clock_timestamp(),
                updated_at = clock_timestamp()
          WHERE project_id = $1::uuid`,
        [input.projectId, revision, JSON.stringify(document), markdown],
      );
      await client.query(
        `INSERT INTO deviludo.project_document_revisions(
           workspace_id, project_id, revision, content, markdown, source
         ) VALUES ($1::uuid, $2::uuid, $3::bigint, $4::jsonb, $5, 'PROJECT_IMPORTED')`,
        [input.workspaceId, input.projectId, revision, JSON.stringify(document), markdown],
      );
      const sourceRevision = await client.query(
        `INSERT INTO deviludo.project_source_revisions(
           workspace_id, project_id, revision, relative_path, content_digest,
           file_count, total_bytes, workflow_id, actor_id
         ) VALUES ($1::uuid, $2::uuid, $3::bigint, $4, $5, $6, $7, $8::uuid, $9::uuid)
         ON CONFLICT (workspace_id, project_id, revision) DO UPDATE
           SET workflow_id = EXCLUDED.workflow_id
         WHERE deviludo.project_source_revisions.relative_path = EXCLUDED.relative_path
           AND deviludo.project_source_revisions.content_digest = EXCLUDED.content_digest
           AND deviludo.project_source_revisions.file_count = EXCLUDED.file_count
           AND deviludo.project_source_revisions.total_bytes = EXCLUDED.total_bytes
           AND deviludo.project_source_revisions.actor_id = EXCLUDED.actor_id`,
        [input.workspaceId, input.projectId, input.source.revision, input.source.relativePath,
          input.source.sha256, input.source.fileCount, input.source.totalBytes,
          input.workflowId, input.actorId],
      );
      if (sourceRevision.rowCount !== 1) throw new Error("Imported source revision changed during analysis");

      const latestGoal = await client.query<{ revision: string }>(
        `SELECT revision::text FROM deviludo.workflow_e2e_goal_revisions
          WHERE workflow_id = $1::uuid ORDER BY revision DESC LIMIT 1 FOR UPDATE`,
        [input.workflowId],
      );
      const e2eGoalRevision = Number(latestGoal.rows[0]?.revision ?? 0) + 1;
      const goals = initialE2eGoals(input.specification);
      await client.query(
        `INSERT INTO deviludo.workflow_e2e_goal_revisions(
           workspace_id, workflow_id, revision, goals, goals_digest
         ) VALUES ($1::uuid, $2::uuid, $3::bigint, $4::jsonb, $5)`,
        [input.workspaceId, input.workflowId, e2eGoalRevision, JSON.stringify(goals), e2eGoalsDigest(goals)],
      );

      const currentState = row.state_data ?? {};
      const currentAnalysis = objectValue(currentState.importAnalysis);
      await client.query(
        `UPDATE deviludo.workflow_instances
            SET state_data = $2::jsonb, version = version + 1, updated_at = clock_timestamp()
          WHERE id = $1::uuid`,
        [input.workflowId, JSON.stringify({
          ...currentState,
          concept: input.concept,
          specification: input.specification,
          e2eGoalRevision,
          source: {
            kind: input.source.kind,
            repositoryUrl: input.source.repositoryUrl,
            localDirectoryBindingId: input.source.localDirectoryBindingId,
            gitBranch: input.source.gitBranch,
            displayName: input.source.displayName,
            fileCount: input.source.fileCount,
            totalBytes: input.source.totalBytes,
            sha256: input.source.sha256,
          },
          importAnalysis: {
            ...currentAnalysis,
            status: "READY",
            error: null,
            report: input.discovery,
            completedAt: new Date().toISOString(),
            leaseToken: null,
            leaseExpiresAt: null,
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
          localDirectoryBindingId: input.source.localDirectoryBindingId,
          gitBranch: input.source.gitBranch,
          fileCount: input.source.fileCount,
          totalBytes: input.source.totalBytes,
          sha256: input.source.sha256,
        })],
      );
      const conversationId = randomUUID();
      const responseLanguage = parseResponseLanguage(input.responseLanguage ?? row.state_data.responseLanguage);
      await client.query(
        `INSERT INTO deviludo.project_conversations(workspace_id, id, project_id, mode, title)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'PROJECT_FEEDBACK', $4)`,
        [input.workspaceId, conversationId, input.projectId, responseLanguage === "zh"
          ? `${row.project_name} · 关联分析`
          : `${row.project_name} · Source analysis`],
      );
      await client.query(
        `INSERT INTO deviludo.conversation_messages(workspace_id, conversation_id, role, content)
         VALUES ($1::uuid, $2::uuid, 'USER', $3)`,
        [input.workspaceId, conversationId, responseLanguage === "zh"
          ? input.source.repositoryUrl
            ? `关联并分析 Git 项目：${input.source.repositoryUrl}`
            : `关联并分析本地项目：${input.source.displayName}`
          : input.source.repositoryUrl
            ? `Import and analyze Git project: ${input.source.repositoryUrl}`
            : `Import and analyze local project: ${input.source.displayName}`],
      );
      await client.query(
        `INSERT INTO deviludo.conversation_messages(workspace_id, conversation_id, role, content, metadata)
         VALUES ($1::uuid, $2::uuid, 'ASSISTANT', $3, $4::jsonb)`,
        [input.workspaceId, conversationId, input.assistantContent, JSON.stringify({
          ...input.assistantMetadata,
          source: "PROJECT_IMPORT_AGENT",
          agentRole: "ANALYSIS",
          agentName: "DeviLudo Analysis Agent",
          appliedToDraft: true,
        })],
      );
      await client.query(
        `INSERT INTO deviludo.conversation_messages(workspace_id, conversation_id, role, content, metadata)
         VALUES ($1::uuid, $2::uuid, 'ASSISTANT', $3, $4::jsonb)`,
        [input.workspaceId, conversationId, input.designAssistant.content, JSON.stringify({
          ...input.designAssistant.metadata,
          source: "PROJECT_IMPORT_DESIGN_AGENT",
          importStage: "DESIGN",
        })],
      );
      return true;
    });
  }

  async failProjectImportAnalysis(input: Readonly<{
    workspaceId: string;
    workflowId: string;
    projectId: string;
    leaseToken: string;
    error: string;
  }>): Promise<boolean> {
    return this.database.withWorkspace(input.workspaceId, async client => {
      const result = await client.query<{ state_data: Record<string, unknown> }>(
        `SELECT state_data FROM deviludo.workflow_instances
          WHERE id = $1::uuid AND project_id = $2::uuid FOR UPDATE`,
        [input.workflowId, input.projectId],
      );
      const stateData = result.rows[0]?.state_data;
      if (!stateData || !analysisLeaseMatches(stateData, input.leaseToken)) return false;
      const analysis = objectValue(stateData.importAnalysis);
      await client.query(
        `UPDATE deviludo.workflow_instances
            SET state_data = $2::jsonb, version = version + 1, updated_at = clock_timestamp()
          WHERE id = $1::uuid`,
        [input.workflowId, JSON.stringify({
          ...stateData,
          importAnalysis: {
            ...analysis,
            status: "FAILED",
            error: input.error.slice(0, 2_000),
            failedAt: new Date().toISOString(),
            leaseToken: null,
            leaseExpiresAt: null,
          },
        })],
      );
      return true;
    });
  }

  async retryProjectImportAnalysis(workspaceId: string, projectId: string): Promise<ProductProjectDetail | null> {
    const queued = await this.database.withWorkspace(workspaceId, async client => {
      const result = await client.query<{ id: string; state_data: Record<string, unknown> }>(
        `SELECT id::text, state_data
           FROM deviludo.workflow_instances
          WHERE project_id = $1::uuid
          ORDER BY iteration_number DESC
          LIMIT 1
          FOR UPDATE`,
        [projectId],
      );
      const row = result.rows[0];
      if (!row) return false;
      const analysis = objectValue(row.state_data.importAnalysis);
      if (analysis.status !== "FAILED") {
        throw Object.assign(new Error("只有失败的项目分析可以重试"), {
          statusCode: 409,
          code: "PROJECT_ANALYSIS_NOT_FAILED",
        });
      }
      await client.query(
        `UPDATE deviludo.workflow_instances
            SET state_data = $2::jsonb, version = version + 1, updated_at = clock_timestamp()
          WHERE id = $1::uuid`,
        [row.id, JSON.stringify({
          ...row.state_data,
          importAnalysis: {
            ...analysis,
            status: "PENDING",
            error: null,
            leaseToken: null,
            leaseExpiresAt: null,
          },
        })],
      );
      return true;
    });
    return queued ? this.readProject(workspaceId, projectId) : null;
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

  async createProjectConversationShell(input: Readonly<{
    actorId: string;
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
    responseLanguage?: ResponseLanguage;
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
        `INSERT INTO deviludo.projects(workspace_id, id, created_by_actor_id, name)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4)`,
        [input.workspaceId, input.projectId, input.actorId, input.name],
      );
      await insertInitialProjectDocument(client, input);
      await client.query(
        `INSERT INTO deviludo.workflow_instances(
           workspace_id, id, project_id, profile, target_platforms, state_data
         ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::deviludo.workflow_profile,
           $5::deviludo.server_os[], $6::jsonb)`,
        [input.workspaceId, input.workflowId, input.projectId, input.profile,
          input.targetPlatforms, JSON.stringify({
            concept: input.concept,
            specification: input.specification,
            e2eGoalRevision: 1,
            responseLanguage: parseResponseLanguage(input.responseLanguage),
            iteration: initialIterationState(),
          })],
      );
      await client.query(
        `INSERT INTO deviludo.workflow_events(
           workspace_id, workflow_id, event_kind, event_data, idempotency_key
         ) VALUES ($1::uuid, $2::uuid, 'PROJECT_CREATED', $3::jsonb, 'project-created')`,
        [input.workspaceId, input.workflowId, JSON.stringify({ concept: input.concept, source: "PROJECT_RUNTIME" })],
      );
      await insertInitialE2eGoalRevision(client, input.workspaceId, input.workflowId, input.specification);
      await client.query(
        `INSERT INTO deviludo.project_conversations(workspace_id, id, project_id, mode, title)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'NEW_GAME', $4)`,
        [input.workspaceId, input.conversationId, input.projectId, input.name],
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
    if (!project || !conversation) throw new Error("Created project conversation shell could not be read");
    return Object.freeze({ project, conversation });
  }

  async createProjectConversation(input: Readonly<{
    actorId: string;
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
    responseLanguage?: ResponseLanguage;
    userContent: string;
    userAttachments?: readonly StoredConversationImage[];
    assistantMessages: readonly Readonly<{
      content: string;
      metadata: Readonly<Record<string, unknown>>;
    }>[];
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
        `INSERT INTO deviludo.projects(workspace_id, id, created_by_actor_id, name)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4)`,
        [input.workspaceId, input.projectId, input.actorId, input.name],
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
          JSON.stringify({
            concept: input.concept,
            specification: input.specification,
            e2eGoalRevision: 1,
            responseLanguage: parseResponseLanguage(input.responseLanguage),
            iteration: initialIterationState(),
          }),
        ],
      );
      await client.query(
        `INSERT INTO deviludo.workflow_events(
           workspace_id, workflow_id, event_kind, event_data, idempotency_key
         ) VALUES ($1::uuid, $2::uuid, 'PROJECT_CREATED', $3::jsonb, 'project-created')`,
        [input.workspaceId, input.workflowId, JSON.stringify({ concept: input.concept, source: "HOME_CONVERSATION" })],
      );
      await insertInitialE2eGoalRevision(client, input.workspaceId, input.workflowId, input.specification);
      await client.query(
        `INSERT INTO deviludo.project_conversations(workspace_id, id, project_id, mode, title)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'NEW_GAME', $4)`,
        [input.workspaceId, input.conversationId, input.projectId, input.name],
      );
      const userMessage = await client.query<{ message_id: string }>(
        `INSERT INTO deviludo.conversation_messages(workspace_id, conversation_id, role, content, metadata)
         VALUES ($1::uuid, $2::uuid, 'USER', $3, $4::jsonb)
         RETURNING message_id::text`,
        [input.workspaceId, input.conversationId, input.userContent, conversationImageMetadata(input.userAttachments)],
      );
      const intentDecision = input.assistantMessages
        .map(message => message.metadata.intentDecision)
        .find(value => value && typeof value === "object" && !Array.isArray(value)) as Record<string, unknown> | undefined;
      if (!intentDecision) throw new Error("Initial project conversation is missing its Intent Agent decision");
      await client.query(
        `INSERT INTO deviludo.workflow_events(
           workspace_id, workflow_id, event_kind, event_data, idempotency_key
         ) VALUES ($1::uuid, $2::uuid, 'CONVERSATION_INTENT_DECIDED', $3::jsonb, $4)`,
        [input.workspaceId, input.workflowId, JSON.stringify({
          conversationId: input.conversationId,
          sourceMessageId: userMessage.rows[0].message_id,
          intent: intentDecision.intent,
          explicitExecution: intentDecision.explicitExecution,
          actionable: intentDecision.actionable,
          targetRole: intentDecision.targetRole,
        }), `intent:${input.conversationId}:${userMessage.rows[0].message_id}`],
      );
      for (const message of input.assistantMessages) {
        const design = message.metadata.agentRole === "DESIGN";
        await client.query(
          `INSERT INTO deviludo.conversation_messages(workspace_id, conversation_id, role, content, metadata)
           VALUES ($1::uuid, $2::uuid, 'ASSISTANT', $3, $4::jsonb)`,
          [input.workspaceId, input.conversationId, message.content, JSON.stringify({
            ...message.metadata,
            appliedToDraft: design,
            projectDocumentUpdated: design,
          })],
        );
      }
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

  async synchronizeDraftSpecificationFromDocument(
    workspaceId: string,
    projectId: string,
  ): Promise<ProductProjectDetail | null> {
    await this.database.withWorkspace(workspaceId, async client => {
      const workflow = await client.query<{ id: string; state_data: Record<string, unknown> }>(
        `SELECT id::text, state_data
           FROM deviludo.workflow_instances
          WHERE project_id = $1::uuid
          ORDER BY iteration_number DESC
          LIMIT 1
          FOR UPDATE`,
        [projectId],
      );
      if (!workflow.rows[0]) return;
      const document = await client.query<{ content: Record<string, unknown> }>(
        `SELECT content FROM deviludo.project_documents WHERE project_id = $1::uuid`,
        [projectId],
      );
      if (!document.rows[0]) throw new Error("Project document not found");
      const current = productSpecificationFromState(workflow.rows[0].state_data);
      const synchronized = synchronizeSpecificationWithProjectDocument(
        current,
        parseProjectDocumentContent(document.rows[0].content),
      );
      await client.query(
        `UPDATE deviludo.workflow_instances
            SET state_data = state_data || jsonb_build_object('specification', $2::jsonb),
                version = version + 1,
                updated_at = clock_timestamp()
          WHERE id = $1::uuid AND state = 'DRAFT'`,
        [workflow.rows[0].id, JSON.stringify(synchronized)],
      );
    });
    return this.readProject(workspaceId, projectId);
  }

  async readProject(workspaceId: string, projectId: string): Promise<ProductProjectDetail | null> {
    return this.database.withWorkspace(workspaceId, async client => {
      const project = await client.query<ProductProjectRow>(
        `SELECT p.id::text, p.name, p.created_at::text,
                workflow.id::text AS workflow_id,
                workflow.iteration_number,
                workflow.state::text AS workflow_state,
                workflow.profile::text AS profile,
                workflow.target_platforms::text[] AS target_platforms,
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
             SELECT id, iteration_number, state, profile, target_platforms, state_data, updated_at
               FROM deviludo.workflow_instances
              WHERE workspace_id = p.workspace_id AND project_id = p.id
              ORDER BY iteration_number DESC
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
      const [jobs, events, document, documentRevisions, pendingChange, goalRevision] = await Promise.all([
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
                  revision.author_actor_id::text AS author_username, revision.created_at::text
             FROM deviludo.project_document_revisions revision
            WHERE revision.project_id = $1::uuid
            ORDER BY revision.revision DESC
            LIMIT 30`,
          [projectId],
        ),
        client.query<ImplementationChangeRequestRow>(
          `SELECT request.id::text, request.project_id::text, request.conversation_id::text,
                  request.state, request.summary, request.implementation_brief,
                  request.base_document_revision::text,
                  request.project_document_patch, request.e2e_goal_delta, request.explicit_execution,
                  request.created_at::text
             FROM deviludo.implementation_change_requests request
            WHERE request.project_id = $1::uuid
              AND request.state IN ('PENDING', 'WAITING_FOR_ANALYSIS')
            ORDER BY request.created_at DESC
            LIMIT 1`,
          [projectId],
        ),
        client.query<E2eGoalRevisionRow>(
          `SELECT revision::text, goals, goals_digest
             FROM deviludo.workflow_e2e_goal_revisions
            WHERE workflow_id = $1::uuid
            ORDER BY revision DESC
            LIMIT 1`,
          [row.workflow_id],
        ),
      ]);
      const currentDocument = document.rows[0];
      if (!currentDocument) throw new Error("Project document is missing");
      return Object.freeze({
        ...projectSummaryFromRow(row),
        localDirectory: localDirectoryFromState(row.state_data),
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
        pendingImplementationChange: pendingChange.rows[0]
          ? implementationChangeFromRow(pendingChange.rows[0]) : null,
        e2eGoalRevision: Number(goalRevision.rows[0]?.revision ?? 0),
        e2eGoals: parseE2eGoals(goalRevision.rows[0]?.goals ?? []),
      });
    });
  }

  async createProjectIteration(input: Readonly<{
    workspaceId: string;
    projectId: string;
    baseWorkflowId: string;
    actorId: string;
    responseLanguage?: ResponseLanguage;
  }>): Promise<Readonly<{ project: ProductProjectDetail; created: boolean }>> {
    if (!UUID.test(input.projectId) || !UUID.test(input.baseWorkflowId) || !UUID.test(input.actorId)) {
      throw iterationError("INVALID_PROJECT_ITERATION", "项目迭代请求无效", 400);
    }
    const result = await this.database.withWorkspace(input.workspaceId, async client => {
      const project = await client.query<{ id: string }>(
        `SELECT id::text FROM deviludo.projects
          WHERE id = $1::uuid
          FOR UPDATE`,
        [input.projectId],
      );
      if (!project.rows[0]) return null;

      const base = await client.query<WorkflowIterationRow>(
        `${WORKFLOW_ITERATION_SELECT}
          WHERE workflow.project_id = $1::uuid AND workflow.id = $2::uuid
          FOR UPDATE OF workflow`,
        [input.projectId, input.baseWorkflowId],
      );
      if (!base.rows[0]) {
        throw iterationError("ITERATION_BASE_NOT_FOUND", "上一轮工作流不存在或不属于当前项目", 409);
      }
      const latest = await client.query<WorkflowIterationRow>(
        `${WORKFLOW_ITERATION_SELECT}
          WHERE workflow.project_id = $1::uuid
          ORDER BY workflow.iteration_number DESC
          LIMIT 1
          FOR UPDATE OF workflow`,
        [input.projectId],
      );
      const current = latest.rows[0];
      if (!current) throw new Error("Project workflow is missing");

      const existing = await client.query<{ id: string }>(
        `SELECT id::text FROM deviludo.workflow_instances
          WHERE project_id = $1::uuid AND parent_workflow_id = $2::uuid`,
        [input.projectId, input.baseWorkflowId],
      );
      if (existing.rows[0]) {
        if (current.workflow_id !== existing.rows[0].id) {
          throw iterationError("PROJECT_ITERATION_STALE", "项目已经进入更新的迭代，请刷新后重试", 409);
        }
        return Object.freeze({ workflowId: existing.rows[0].id, created: false });
      }
      if (current.workflow_id !== input.baseWorkflowId) {
        throw iterationError("PROJECT_ITERATION_STALE", "项目状态已经变化，请刷新后重试", 409);
      }
      if (!["SUCCEEDED", "FAILED", "CANCELLED"].includes(current.state)) {
        throw iterationError("PROJECT_ITERATION_UNAVAILABLE", "当前交付仍在进行中，请完成或取消后再继续修改", 409);
      }

      const document = await client.query<{ revision: string }>(
        `SELECT revision::text FROM deviludo.project_documents
          WHERE project_id = $1::uuid
          FOR UPDATE`,
        [input.projectId],
      );
      const latestSource = await client.query<{ revision: string }>(
        `SELECT source.revision::text AS revision
           FROM deviludo.project_source_revisions source
          WHERE source.project_id = $1::uuid
          ORDER BY source.revision DESC
          LIMIT 1`,
        [input.projectId],
      );
      const previousState = current.state_data ?? {};
      const inheritedGoalRevision = await client.query<E2eGoalRevisionRow>(
        `SELECT revision::text, goals, goals_digest
           FROM deviludo.workflow_e2e_goal_revisions
          WHERE workflow_id = $1::uuid
          ORDER BY revision DESC
          LIMIT 1`,
        [input.baseWorkflowId],
      );
      const inheritedGoals = parseE2eGoals(
        inheritedGoalRevision.rows[0]?.goals
          ?? initialE2eGoals(productSpecificationFromState(previousState)),
      );
      const inheritedGoalsDigest = inheritedGoalRevision.rows[0]?.goals_digest
        ?? e2eGoalsDigest(inheritedGoals);
      const iterationNumber = current.iteration_number + 1;
      const workflowId = randomUUID();
      const analysis = objectValue(previousState.importAnalysis);
      const stateData = {
        concept: typeof previousState.concept === "string" ? previousState.concept : "",
        specification: productSpecificationFromState(previousState),
        responseLanguage: parseResponseLanguage(input.responseLanguage ?? previousState.responseLanguage),
        e2eGoalRevision: 1,
        ...(previousState.source && typeof previousState.source === "object"
          ? { source: previousState.source }
          : {}),
        ...(analysis.status === "READY" ? { importAnalysis: { ...analysis, error: null } } : {}),
        iteration: {
          number: iterationNumber,
          parentWorkflowId: input.baseWorkflowId,
          baseSourceRevision: latestSource.rows[0] ? Number(latestSource.rows[0].revision) : null,
          baseDocumentRevision: Number(document.rows[0]?.revision ?? 1),
          approvedDocumentRevision: null,
        },
      };
      await client.query(
        `INSERT INTO deviludo.workflow_instances(
           workspace_id, id, project_id, iteration_number, parent_workflow_id,
           profile, target_platforms, state_data
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, $4::integer, $5::uuid,
           $6::deviludo.workflow_profile, $7::deviludo.server_os[], $8::jsonb
         )`,
        [input.workspaceId, workflowId, input.projectId, iterationNumber, input.baseWorkflowId,
          current.profile, current.target_platforms, JSON.stringify(stateData)],
      );
      await client.query(
        `INSERT INTO deviludo.workflow_events(
           workspace_id, workflow_id, event_kind, event_data, idempotency_key
         ) VALUES ($1::uuid, $2::uuid, 'ITERATION_STARTED', $3::jsonb, 'iteration-started')`,
        [input.workspaceId, workflowId, JSON.stringify({
          iterationNumber,
          parentWorkflowId: input.baseWorkflowId,
          baseSourceRevision: stateData.iteration.baseSourceRevision,
          baseDocumentRevision: stateData.iteration.baseDocumentRevision,
          requestedByActorId: input.actorId,
        })],
      );
      await client.query(
        `INSERT INTO deviludo.workflow_e2e_goal_revisions(
           workspace_id, workflow_id, revision, goals, goals_digest
         ) VALUES ($1::uuid, $2::uuid, 1, $3::jsonb, $4)`,
        [input.workspaceId, workflowId, JSON.stringify(inheritedGoals), inheritedGoalsDigest],
      );
      await touchProjectActivity(client, input.workspaceId, input.projectId);
      return Object.freeze({ workflowId, created: true });
    });
    if (!result) throw iterationError("PROJECT_NOT_FOUND", "项目不存在", 404);
    const project = await this.readProject(input.workspaceId, input.projectId);
    if (!project || project.workflowId !== result.workflowId) throw new Error("Created project iteration is not current");
    return Object.freeze({ project, created: result.created });
  }

  async listProjectIterations(
    workspaceId: string,
    projectId: string,
  ): Promise<readonly ProductWorkflowIterationSummary[] | null> {
    return this.database.withWorkspace(workspaceId, async client => {
      const project = await client.query("SELECT 1 FROM deviludo.projects WHERE id = $1::uuid", [projectId]);
      if (!project.rows[0]) return null;
      const result = await client.query<WorkflowIterationRow>(
        `${WORKFLOW_ITERATION_SELECT}
          WHERE workflow.project_id = $1::uuid
          ORDER BY workflow.iteration_number DESC`,
        [projectId],
      );
      const currentId = result.rows[0]?.workflow_id ?? "";
      return Object.freeze(result.rows.map(row => workflowIterationSummary(row, row.workflow_id === currentId)));
    });
  }

  async readProjectIteration(
    workspaceId: string,
    projectId: string,
    workflowId: string,
  ): Promise<ProductWorkflowIterationDetail | null> {
    return this.database.withWorkspace(workspaceId, async client => {
      const iteration = await client.query<WorkflowIterationRow>(
        `${WORKFLOW_ITERATION_SELECT}
          WHERE workflow.project_id = $1::uuid AND workflow.id = $2::uuid`,
        [projectId, workflowId],
      );
      const row = iteration.rows[0];
      if (!row) return null;
      const current = await client.query<{ id: string }>(
        `SELECT id::text FROM deviludo.workflow_instances
          WHERE project_id = $1::uuid
          ORDER BY iteration_number DESC
          LIMIT 1`,
        [projectId],
      );
      const [jobs, events, artifacts] = await Promise.all([
        client.query<ProductJobRow>(
          `SELECT id::text, kind::text, pool_kind::text, target_operating_system::text,
                  state::text, attempt, last_error, created_at::text, updated_at::text
             FROM deviludo.jobs WHERE workflow_id = $1::uuid
            ORDER BY created_at, kind, target_operating_system NULLS FIRST`,
          [workflowId],
        ),
        client.query<ProductEventRow>(
          `SELECT event_id::text, event_kind, event_data, created_at::text
             FROM deviludo.workflow_events WHERE workflow_id = $1::uuid
            ORDER BY event_id DESC LIMIT 40`,
          [workflowId],
        ),
        client.query<ArtifactRow>(
          `SELECT id, workspace_id, project_id, workflow_id, kind, target_platform,
                  bucket, object_key, sha256, size_bytes, metadata, created_at
             FROM (
               SELECT DISTINCT ON (artifact.kind, artifact.target_platform)
                      artifact.id::text, artifact.workspace_id::text, artifact.project_id::text,
                      artifact.workflow_id::text, artifact.kind::text, artifact.target_platform::text,
                      artifact.bucket, artifact.object_key, artifact.sha256,
                      artifact.size_bytes::text, artifact.metadata, artifact.created_at::text
                 FROM deviludo.artifacts artifact
                WHERE artifact.project_id = $1::uuid AND artifact.workflow_id = $2::uuid
                  AND artifact.state = 'AVAILABLE'
                ORDER BY artifact.kind, artifact.target_platform NULLS FIRST,
                         artifact.created_at DESC, artifact.id DESC
             ) latest
            ORDER BY created_at DESC, id DESC`,
          [projectId, workflowId],
        ),
      ]);
      const summary = workflowIterationSummary(row, current.rows[0]?.id === row.workflow_id);
      return Object.freeze({
        ...summary,
        concept: typeof row.state_data?.concept === "string" ? row.state_data.concept : "",
        specification: Object.freeze({ ...productSpecificationFromState(row.state_data ?? {}) }),
        jobs: Object.freeze(jobs.rows.map(productJobFromRow)),
        events: Object.freeze(events.rows.map(productEventFromRow)),
        artifacts: Object.freeze(artifacts.rows.map(artifactFromRow)),
      });
    });
  }

  async listProjectArtifacts(
    workspaceId: string,
    projectId: string,
    workflowId?: string,
  ): Promise<readonly ArtifactRecord[]> {
    return this.database.withWorkspace(workspaceId, async client => {
      const result = await client.query<ArtifactRow>(
        `SELECT id, workspace_id, project_id, workflow_id, kind, target_platform,
                bucket, object_key, sha256, size_bytes, metadata, created_at
           FROM (
             SELECT DISTINCT ON (artifact.kind, artifact.target_platform)
                    artifact.id::text, artifact.workspace_id::text, artifact.project_id::text,
                    artifact.workflow_id::text, artifact.kind::text, artifact.target_platform::text,
                    artifact.bucket, artifact.object_key, artifact.sha256,
                    artifact.size_bytes::text, artifact.metadata, artifact.created_at::text
               FROM deviludo.artifacts artifact
              WHERE artifact.project_id = $1::uuid
                AND artifact.state = 'AVAILABLE'
                AND ($2::uuid IS NULL OR artifact.workflow_id = $2::uuid)
              ORDER BY artifact.kind, artifact.target_platform NULLS FIRST,
                       artifact.created_at DESC, artifact.id DESC
           ) latest
          ORDER BY created_at DESC, id DESC`,
        [projectId, workflowId ?? null],
      );
      return Object.freeze(result.rows.map(artifactFromRow));
    });
  }

  /**
   * Asset manifest reads and mutations. Generation and upload run asynchronously
   * without occupying a delivery worker; the readiness gate then freezes their
   * exact objects into the next BUILD.
   */
  get assets(): AssetManifestStore {
    return new AssetManifestStore(this.database);
  }

  async readProjectArtifact(workspaceId: string, projectId: string, artifactId: string): Promise<ArtifactRecord | null> {
    return this.database.withWorkspace(workspaceId, async client => {
      const result = await client.query<ArtifactRow>(
        `SELECT id::text, workspace_id::text, project_id::text, workflow_id::text,
                kind::text, target_platform::text, bucket, object_key, sha256,
                size_bytes::text, metadata, created_at::text
           FROM deviludo.artifacts
          WHERE project_id = $1::uuid AND id = $2::uuid AND state = 'AVAILABLE'`,
        [projectId, artifactId],
      );
      return result.rows[0] ? artifactFromRow(result.rows[0]) : null;
    });
  }

  async updateProjectDocument(input: Readonly<{
    actorId: string;
    workspaceId: string;
    projectId: string;
    expectedRevision: number;
    content: ProjectDocumentContent;
    responseLanguage?: ResponseLanguage;
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
      const responseLanguage = parseResponseLanguage(input.responseLanguage);
      const markdown = projectDocumentMarkdown(
        project.rows[0].name,
        content,
        responseLanguage,
      );
      const revision = input.expectedRevision + 1;
      await touchProjectActivity(client, input.workspaceId, input.projectId);
      await client.query(
        `UPDATE deviludo.workflow_instances
            SET state_data = coalesce(state_data, '{}'::jsonb)
                  || jsonb_build_object('responseLanguage', $2::text),
                updated_at = clock_timestamp()
          WHERE id = (
            SELECT id FROM deviludo.workflow_instances
             WHERE project_id = $1::uuid
             ORDER BY iteration_number DESC
             LIMIT 1
          )`,
        [input.projectId, responseLanguage],
      );
      await client.query(
        `UPDATE deviludo.project_documents
            SET revision = $2::bigint, content = $3::jsonb, markdown = $4,
                maintained_by = 'USER', updated_by_actor_id = $5::uuid,
                updated_at = clock_timestamp()
          WHERE project_id = $1::uuid`,
        [input.projectId, revision, JSON.stringify(content), markdown, input.actorId],
      );
      await client.query(
        `INSERT INTO deviludo.project_document_revisions(
           workspace_id, project_id, revision, content, markdown, source, author_actor_id
         ) VALUES ($1::uuid, $2::uuid, $3::bigint, $4::jsonb, $5, 'USER_EDIT', $6::uuid)`,
        [input.workspaceId, input.projectId, revision, JSON.stringify(content), markdown, input.actorId],
      );
    });
    return this.readProject(input.workspaceId, input.projectId);
  }

  async deleteProject(
    workspaceId: string,
    projectId: string,
    _beforeDelete?: () => Promise<void>,
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
          ORDER BY iteration_number DESC LIMIT 1`,
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

      const params = [workspaceId, projectId];
      await client.query(
        `INSERT INTO deviludo.project_cleanup_requests(workspace_id, project_id)
         VALUES ($1::uuid, $2::uuid)
         ON CONFLICT (workspace_id, project_id) DO NOTHING`,
        params,
      );
      await client.query(
        `DELETE FROM deviludo.project_creation_receipts
          WHERE workspace_id = $1::uuid AND project_id = $2::uuid`,
        params,
      );
      // These project-owned records reference workflow_instances without
      // ON DELETE CASCADE. They must be removed before the workflow history;
      // otherwise projects that reached asset planning or Steam delivery can
      // never be deleted.
      for (const table of ["steam_releases", "asset_manifests"] as const) {
        await client.query(
          `DELETE FROM deviludo.${table}
            WHERE workspace_id = $1::uuid AND project_id = $2::uuid`,
          params,
        );
      }
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
      await client.query(
        `DELETE FROM deviludo.job_progress_events
          WHERE workspace_id = $1::uuid AND project_id = $2::uuid`,
        params,
      );
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
        `DELETE FROM deviludo.workflow_e2e_goal_revisions goal
          WHERE goal.workspace_id = $1::uuid
            AND goal.workflow_id IN (
              SELECT id FROM deviludo.workflow_instances
               WHERE workspace_id = $1::uuid AND project_id = $2::uuid
            )`,
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
      if (deleted.rowCount !== 1) return false;
      // Managed object/source cleanup is durable and asynchronous. The optional
      // callback is reserved for self-hosted external directory bindings that
      // cannot be represented by the managed cleanup queue.
      await _beforeDelete?.();
      return true;
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
                count(message.message_id)::text AS message_count,
                count(message.message_id) FILTER (WHERE message.role = 'USER')::text AS user_message_count,
                coalesce(bool_or(message.metadata ->> 'source' = 'PROJECT_IMPORT_AGENT'), false) AS system_generated
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
        userMessageCount: Number(conversation.user_message_count),
        systemGenerated: conversation.system_generated,
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

  async completePersistentAgentTurn(
    job: JobProtocolV4,
    output: Readonly<Record<string, unknown>>,
  ): Promise<boolean> {
    return this.database.withWorkspace(job.workspaceId, async client => {
      const result = await client.query(
        `SELECT deviludo.complete_agent_turn_job(
           $1::uuid, $2::uuid, $3::uuid, $4::bigint, $5::jsonb
         ) AS completed`,
        [job.workspaceId, job.jobId, job.lease.token, job.lease.fencingToken, JSON.stringify(output)],
      );
      if (result.rows[0]?.completed !== true) return false;
      if (output.role !== "DEVELOPMENT") return true;

      const responseLanguage = output.responseLanguage === "zh" ? "zh" : "en";
      await client.query(
        `SELECT deviludo.publish_development_agent_message($1::uuid, $2::uuid, $3::text)`,
        [job.workspaceId, job.jobId, workflowDevelopmentConversationContent(output, responseLanguage)],
      );
      return true;
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

  async appendConversationTurn(input: Readonly<{
    workspaceId: string;
    conversationId: string;
    projectId: string;
    userContent: string;
    userAttachments?: readonly StoredConversationImage[];
    assistantMessages: readonly Readonly<{
      content: string;
      metadata: Readonly<Record<string, unknown>>;
    }>[];
    assistantApplyToDraft: boolean;
    assistantProjectDocument: ProjectDocumentContent | null;
    resolveImportAnalysis: boolean;
    responseLanguage?: ResponseLanguage;
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
            ORDER BY iteration_number DESC
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
      const responseLanguage = parseResponseLanguage(input.responseLanguage);
      await client.query(
        `UPDATE deviludo.workflow_instances
            SET state_data = coalesce(state_data, '{}'::jsonb)
                  || jsonb_build_object('responseLanguage', $2::text),
                updated_at = clock_timestamp()
          WHERE id = $1::uuid`,
        [project.workflowId, responseLanguage],
      );
      if (!conversation) {
        const generatedTitle = input.assistantMessages
          .map(message => objectValue(message.metadata.intentDecision).summary)
          .find(summary => typeof summary === "string" && summary.trim());
        const created = await client.query<ProductConversationRow>(
          `INSERT INTO deviludo.project_conversations(workspace_id, id, project_id, mode, title)
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5)
           RETURNING id::text, project_id::text, mode, title, created_at::text, updated_at::text`,
          [
            input.workspaceId,
            input.conversationId,
            input.projectId,
            "PROJECT_FEEDBACK",
            typeof generatedTitle === "string" ? generatedTitle.trim().slice(0, 200) : project.name,
          ],
        );
        conversation = created.rows[0];
      }

      const userMessage = await client.query<{ message_id: string }>(
        `INSERT INTO deviludo.conversation_messages(workspace_id, conversation_id, role, content, metadata)
         VALUES ($1::uuid, $2::uuid, 'USER', $3, $4::jsonb)
         RETURNING message_id::text`,
        [input.workspaceId, input.conversationId, input.userContent, conversationImageMetadata(input.userAttachments)],
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
          const markdown = projectDocumentMarkdown(
            project.name,
            content,
            parseResponseLanguage(input.responseLanguage),
          );
          await client.query(
            `UPDATE deviludo.project_documents
                SET revision = $2::bigint, content = $3::jsonb, markdown = $4,
                    maintained_by = 'AGENT', updated_by_actor_id = NULL,
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

      if (input.resolveImportAnalysis && project.workflowState === "DRAFT") {
        await client.query(
          `UPDATE deviludo.workflow_instances
              SET state_data = jsonb_set(
                    state_data,
                    '{importAnalysis}',
                    coalesce(state_data->'importAnalysis', '{}'::jsonb)
                      || jsonb_build_object(
                        'status', 'READY',
                        'error', NULL,
                        'questionsResolvedAt', clock_timestamp()
                      ),
                    true
                  ),
                  version = version + 1,
                  updated_at = clock_timestamp()
            WHERE id = $1::uuid
              AND state = 'DRAFT'
              AND state_data #>> '{importAnalysis,status}' = 'NEEDS_INPUT'`,
          [project.workflowId],
        );
      }

      const intentDecision = input.assistantMessages
        .map(message => message.metadata.intentDecision)
        .find(value => value && typeof value === "object" && !Array.isArray(value)) as Record<string, unknown> | undefined;
      if (intentDecision) {
        await client.query(
          `INSERT INTO deviludo.workflow_events(
             workspace_id, workflow_id, event_kind, event_data, idempotency_key
           ) VALUES ($1::uuid, $2::uuid, 'CONVERSATION_INTENT_DECIDED', $3::jsonb, $4)
           ON CONFLICT (workspace_id, workflow_id, idempotency_key) DO NOTHING`,
          [input.workspaceId, project.workflowId, JSON.stringify({
            conversationId: input.conversationId,
            sourceMessageId: userMessage.rows[0].message_id,
            intent: intentDecision.intent,
            explicitExecution: intentDecision.explicitExecution,
            actionable: intentDecision.actionable,
            targetRole: intentDecision.targetRole,
          }), `intent:${input.conversationId}:${userMessage.rows[0].message_id}`],
        );
      }

      for (const message of input.assistantMessages) {
        const design = message.metadata.agentRole === "DESIGN";
        await client.query(
          `INSERT INTO deviludo.conversation_messages(workspace_id, conversation_id, role, content, metadata)
           VALUES ($1::uuid, $2::uuid, 'ASSISTANT', $3, $4::jsonb)`,
          [
            input.workspaceId,
            input.conversationId,
            message.content,
            JSON.stringify({
              ...message.metadata,
              appliedToDraft: design && appliedToDraft,
              projectDocumentUpdated: design && projectDocumentUpdated,
            }),
          ],
        );
      }
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

  async createImplementationChangeRequest(input: Readonly<{
    workspaceId: string;
    projectId: string;
    workflowId: string;
    conversationId: string;
    summary: string;
    implementationBrief: string;
    projectDocumentPatch: Readonly<Record<string, unknown>>;
    e2eGoalDelta: E2eGoalDelta;
    explicitExecution: boolean;
    idempotencyKey: string;
    supersededChangeRequestId?: string;
    supersededDecisionIdempotencyKey?: string;
  }>): Promise<ImplementationChangeRequest> {
    return this.database.withWorkspace(input.workspaceId, async client => {
      const prior = await client.query<ImplementationChangeRequestRow>(
        `SELECT id::text, project_id::text, conversation_id::text, state, summary,
                implementation_brief, base_document_revision::text, project_document_patch, e2e_goal_delta,
                explicit_execution, created_at::text
           FROM deviludo.implementation_change_requests
          WHERE idempotency_key = $1`,
        [input.idempotencyKey],
      );
      if (prior.rows[0]) {
        if (prior.rows[0].project_id !== input.projectId) {
          throw Object.assign(new Error("Idempotency key was reused for another change"), { statusCode: 409, code: "IDEMPOTENCY_KEY_REUSED" });
        }
        return implementationChangeFromRow(prior.rows[0]);
      }
      const document = await client.query<{ revision: string }>(
        `SELECT revision::text FROM deviludo.project_documents
          WHERE project_id = $1::uuid FOR UPDATE`,
        [input.projectId],
      );
      const sourceMessage = await client.query<{ message_id: string }>(
        `SELECT message_id::text FROM deviludo.conversation_messages
          WHERE conversation_id = $1::uuid AND role = 'USER'
          ORDER BY message_id DESC LIMIT 1`,
        [input.conversationId],
      );
      if (!document.rows[0] || !sourceMessage.rows[0]) throw new Error("Implementation change context is unavailable");
      if ((input.supersededChangeRequestId === undefined)
        !== (input.supersededDecisionIdempotencyKey === undefined)) {
        throw new Error("A replanned change requires both supersession identifiers");
      }
      await client.query(
        `UPDATE deviludo.implementation_change_requests
            SET state = 'SUPERSEDED',
                decision = CASE WHEN id = $2::uuid THEN 'CONFIRM' ELSE decision END,
                decision_idempotency_key = CASE
                  WHEN id = $2::uuid THEN $3 ELSE decision_idempotency_key
                END,
                updated_at = clock_timestamp()
          WHERE project_id = $1::uuid AND state IN ('PENDING', 'WAITING_FOR_ANALYSIS')`,
        [input.projectId, input.supersededChangeRequestId ?? null,
          input.supersededDecisionIdempotencyKey ?? null],
      );
      const result = await client.query<ImplementationChangeRequestRow>(
        `INSERT INTO deviludo.implementation_change_requests(
           workspace_id, project_id, workflow_id, conversation_id, source_message_id,
           state, summary, implementation_brief, base_document_revision,
           project_document_patch, e2e_goal_delta, explicit_execution, idempotency_key
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::bigint,
           'PENDING', $6, $7, $8::bigint, $9::jsonb, $10::jsonb, $11, $12
         )
         RETURNING id::text, project_id::text, conversation_id::text, state, summary,
                   implementation_brief, base_document_revision::text, project_document_patch, e2e_goal_delta,
                   explicit_execution, created_at::text`,
        [input.workspaceId, input.projectId, input.workflowId, input.conversationId,
          sourceMessage.rows[0].message_id, input.summary, input.implementationBrief,
          document.rows[0].revision, JSON.stringify(input.projectDocumentPatch),
          JSON.stringify(input.e2eGoalDelta), input.explicitExecution, input.idempotencyKey],
      );
      return implementationChangeFromRow(result.rows[0]);
    });
  }

  async rejectImplementationChange(
    workspaceId: string,
    projectId: string,
    changeRequestId: string,
    decisionIdempotencyKey?: string,
  ): Promise<ImplementationChangeRequest | null> {
    return this.database.withWorkspace(workspaceId, async client => {
      const current = await client.query<ImplementationChangeRequestRow & {
        decision: "CONFIRM" | "REJECT" | null;
        decision_idempotency_key: string | null;
      }>(
        `SELECT id::text, project_id::text, conversation_id::text, state, summary,
                implementation_brief, base_document_revision::text, project_document_patch, e2e_goal_delta,
                explicit_execution, decision, decision_idempotency_key, created_at::text
           FROM deviludo.implementation_change_requests
          WHERE project_id = $1::uuid AND id = $2::uuid
          FOR UPDATE`,
        [projectId, changeRequestId],
      );
      const request = current.rows[0];
      if (!request) return null;
      if (request.state === "REJECTED" && request.decision === "REJECT"
        && request.decision_idempotency_key === (decisionIdempotencyKey ?? null)) {
        return implementationChangeFromRow(request);
      }
      if (request.decision !== null || request.decision_idempotency_key !== null) {
        throw Object.assign(new Error("Implementation change already has a different decision"), { statusCode: 409, code: "CHANGE_DECISION_CONFLICT" });
      }
      if (!["PENDING", "WAITING_FOR_ANALYSIS"].includes(request.state)) {
        throw Object.assign(new Error("Implementation change request is no longer actionable"), { statusCode: 409, code: "CHANGE_REQUEST_CLOSED" });
      }
      const result = await client.query<ImplementationChangeRequestRow>(
        `UPDATE deviludo.implementation_change_requests
            SET state = 'REJECTED', decision = 'REJECT',
                decision_idempotency_key = coalesce(decision_idempotency_key, $3),
                updated_at = clock_timestamp()
          WHERE project_id = $1::uuid AND id = $2::uuid
            AND state IN ('PENDING', 'WAITING_FOR_ANALYSIS')
          RETURNING id::text, project_id::text, conversation_id::text, state, summary,
                    implementation_brief, base_document_revision::text, project_document_patch, e2e_goal_delta,
                    explicit_execution, created_at::text`,
        [projectId, changeRequestId, decisionIdempotencyKey ?? null],
      );
      return result.rows[0] ? implementationChangeFromRow(result.rows[0]) : null;
    });
  }

  async readImplementationChangeDecision(
    workspaceId: string,
    projectId: string,
    changeRequestId: string,
  ): Promise<Readonly<{
    request: ImplementationChangeRequest;
    decision: "CONFIRM" | "REJECT" | null;
    decisionIdempotencyKey: string | null;
    sourceWorkflowId: string;
    appliedWorkflowId: string | null;
  }> | null> {
    return this.database.withWorkspace(workspaceId, async client => {
      const result = await client.query<ImplementationChangeRequestRow & {
        decision: "CONFIRM" | "REJECT" | null;
        decision_idempotency_key: string | null;
        workflow_id: string;
        applied_workflow_id: string | null;
      }>(
        `SELECT id::text, project_id::text, conversation_id::text, workflow_id::text,
                state, summary, implementation_brief, base_document_revision::text, project_document_patch,
                e2e_goal_delta, explicit_execution, decision, decision_idempotency_key,
                applied_workflow_id::text, created_at::text
           FROM deviludo.implementation_change_requests
          WHERE project_id = $1::uuid AND id = $2::uuid`,
        [projectId, changeRequestId],
      );
      const row = result.rows[0];
      return row ? Object.freeze({
        request: implementationChangeFromRow(row),
        decision: row.decision,
        decisionIdempotencyKey: row.decision_idempotency_key,
        sourceWorkflowId: row.workflow_id,
        appliedWorkflowId: row.applied_workflow_id,
      }) : null;
    });
  }

  async applyImplementationChange(input: Readonly<{
    workspaceId: string;
    projectId: string;
    changeRequestId: string;
    actorId: string;
    responseLanguage: ResponseLanguage;
    specificationObject?: Readonly<{ bucket: string; key: string; sha256: string; sizeBytes: number }>;
    decisionIdempotencyKey?: string;
  }>): Promise<"WAITING_FOR_ANALYSIS" | "AGENT_STARTED" | "AGENT_RERUN_STARTED" | "NEW_ITERATION_STARTED"> {
    return this.database.withWorkspace(input.workspaceId, async client => {
      const request = await client.query<ImplementationChangeRequestRow & {
        workflow_id: string; base_document_revision: string; applied_workflow_id: string | null;
        decision: "CONFIRM" | "REJECT" | null; decision_idempotency_key: string | null;
      }>(
        `SELECT id::text, project_id::text, conversation_id::text, workflow_id::text,
                state, summary, implementation_brief, base_document_revision::text,
                project_document_patch, e2e_goal_delta, explicit_execution,
                decision, decision_idempotency_key, applied_workflow_id::text, created_at::text
           FROM deviludo.implementation_change_requests
          WHERE project_id = $1::uuid AND id = $2::uuid
          FOR UPDATE`,
        [input.projectId, input.changeRequestId],
      );
      const change = request.rows[0];
      if (!change) throw new Error("Implementation change request not found");
      if ((change.decision !== null && change.decision !== "CONFIRM")
        || (change.decision_idempotency_key !== null
          && change.decision_idempotency_key !== (input.decisionIdempotencyKey ?? change.decision_idempotency_key))) {
        throw Object.assign(new Error("Implementation change already has a different decision"), { statusCode: 409, code: "CHANGE_DECISION_CONFLICT" });
      }
      if (change.state === "APPLIED") {
        if (change.decision !== "CONFIRM"
          || change.decision_idempotency_key !== (input.decisionIdempotencyKey ?? change.decision_idempotency_key)) {
          throw Object.assign(new Error("Implementation change decision does not match the completed request"), { statusCode: 409, code: "CHANGE_DECISION_CONFLICT" });
        }
        return change.applied_workflow_id === change.workflow_id ? "AGENT_RERUN_STARTED" : "NEW_ITERATION_STARTED";
      }
      if (!["PENDING", "WAITING_FOR_ANALYSIS"].includes(change.state)) {
        throw Object.assign(new Error("Implementation change request is no longer actionable"), { statusCode: 409, code: "CHANGE_REQUEST_CLOSED" });
      }
      const workflow = await client.query<{
        id: string; iteration_number: number; state: string; profile: "VALIDATE" | "RELEASE";
        target_platforms: ServerOperatingSystem[]; state_data: Record<string, unknown>;
      }>(
        `SELECT id::text, iteration_number, state::text, profile::text,
                target_platforms::text[], state_data
           FROM deviludo.workflow_instances
          WHERE project_id = $1::uuid
          ORDER BY iteration_number DESC LIMIT 1
          FOR UPDATE`,
        [input.projectId],
      );
      const current = workflow.rows[0];
      if (!current || current.id !== change.workflow_id) {
        await client.query(`UPDATE deviludo.implementation_change_requests SET state = 'SUPERSEDED', updated_at = clock_timestamp() WHERE id = $1::uuid`, [change.id]);
        throw Object.assign(new Error("Project changed while the proposal was awaiting a decision"), { statusCode: 409, code: "CHANGE_REQUEST_STALE" });
      }
      const analysisStatus = objectValue(current.state_data.importAnalysis).status;
      if (["PENDING", "ANALYZING"].includes(String(analysisStatus))) {
        if (change.decision_idempotency_key
          && change.decision_idempotency_key !== (input.decisionIdempotencyKey ?? change.decision_idempotency_key)) {
          throw Object.assign(new Error("Implementation change already has a different decision"), { statusCode: 409, code: "CHANGE_DECISION_CONFLICT" });
        }
        await client.query(
          `UPDATE deviludo.implementation_change_requests
              SET state = 'WAITING_FOR_ANALYSIS', decision = 'CONFIRM',
                  decision_idempotency_key = coalesce(decision_idempotency_key, $2),
                  updated_at = clock_timestamp()
            WHERE id = $1::uuid`,
          [change.id, input.decisionIdempotencyKey ?? null],
        );
        return "WAITING_FOR_ANALYSIS";
      }
      if (!input.specificationObject) throw new Error("Confirmed implementation change is missing its specification object");

      const project = await client.query<{ name: string }>(
        `SELECT name FROM deviludo.projects WHERE id = $1::uuid FOR UPDATE`, [input.projectId],
      );
      const documentRow = await client.query<{ revision: string; content: Record<string, unknown> }>(
        `SELECT revision::text, content FROM deviludo.project_documents WHERE project_id = $1::uuid FOR UPDATE`, [input.projectId],
      );
      if (!project.rows[0] || !documentRow.rows[0]
        || (change.state !== "WAITING_FOR_ANALYSIS"
          && Number(documentRow.rows[0].revision) !== Number(change.base_document_revision))) {
        await client.query(`UPDATE deviludo.implementation_change_requests SET state = 'SUPERSEDED', updated_at = clock_timestamp() WHERE id = $1::uuid`, [change.id]);
        throw Object.assign(new Error("Project document changed while the proposal was awaiting a decision"), { statusCode: 409, code: "CHANGE_REQUEST_STALE" });
      }
      const document = parseProjectDocumentContent({ ...documentRow.rows[0].content, ...change.project_document_patch });
      const specification = synchronizeSpecificationWithProjectDocument(
        productSpecificationFromState(current.state_data), document,
      );
      const currentGoals = await client.query<E2eGoalRevisionRow>(
        `SELECT revision::text, goals, goals_digest
           FROM deviludo.workflow_e2e_goal_revisions
          WHERE workflow_id = $1::uuid ORDER BY revision DESC LIMIT 1 FOR UPDATE`,
        [current.id],
      );
      const goals = mergeE2eGoals(
        parseE2eGoals(currentGoals.rows[0]?.goals ?? initialE2eGoals(productSpecificationFromState(current.state_data))),
        parseStoredE2eGoalDelta(change.e2e_goal_delta),
        specification,
      );
      const hasRelease = await client.query(
        `SELECT 1 FROM deviludo.steam_releases WHERE project_id = $1::uuid AND workflow_id = $2::uuid LIMIT 1`,
        [input.projectId, current.id],
      );
      const newIteration = current.state === "STEAM_PUBLISHING" || hasRelease.rowCount === 1;
      const latestSource = newIteration ? await client.query<{ revision: string }>(
        `SELECT revision::text FROM deviludo.project_source_revisions
          WHERE project_id = $1::uuid ORDER BY revision DESC LIMIT 1`,
        [input.projectId],
      ) : null;
      const targetWorkflowId = newIteration ? randomUUID() : current.id;
      const goalRevision = newIteration ? 1 : Number(currentGoals.rows[0]?.revision ?? 0) + 1;
      const nextDocumentRevision = Number(documentRow.rows[0].revision) + 1;
      const markdown = projectDocumentMarkdown(project.rows[0].name, document, input.responseLanguage);

      await client.query(
        `UPDATE deviludo.project_documents
            SET revision = $2::bigint, content = $3::jsonb, markdown = $4,
                maintained_by = 'AGENT', updated_by_actor_id = NULL,
                last_agent_maintained_at = clock_timestamp(), updated_at = clock_timestamp()
          WHERE project_id = $1::uuid`,
        [input.projectId, nextDocumentRevision, JSON.stringify(document), markdown],
      );
      await client.query(
        `INSERT INTO deviludo.project_document_revisions(
           workspace_id, project_id, revision, content, markdown, source
         ) VALUES ($1::uuid, $2::uuid, $3::bigint, $4::jsonb, $5, 'AGENT_CONVERSATION')`,
        [input.workspaceId, input.projectId, nextDocumentRevision, JSON.stringify(document), markdown],
      );

      if (newIteration) {
        const stateData = {
          ...current.state_data,
          specification,
          responseLanguage: input.responseLanguage,
          e2eGoalRevision: goalRevision,
          iteration: {
            number: current.iteration_number + 1,
            parentWorkflowId: current.id,
            baseSourceRevision: latestSource?.rows[0] ? Number(latestSource.rows[0].revision) : null,
            baseDocumentRevision: nextDocumentRevision,
            approvedDocumentRevision: nextDocumentRevision,
          },
        };
        await client.query(
          `INSERT INTO deviludo.workflow_instances(
             workspace_id, id, project_id, iteration_number, parent_workflow_id,
             development_actor_id, profile, target_platforms, state, state_data
           ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::uuid, $6::uuid,
                     $7::deviludo.workflow_profile, $8::deviludo.server_os[], 'DEVELOPING', $9::jsonb)`,
          [input.workspaceId, targetWorkflowId, input.projectId, current.iteration_number + 1,
            current.id, input.actorId, current.profile, current.target_platforms, JSON.stringify(stateData)],
        );
      } else {
        await client.query(
          `INSERT INTO deviludo.job_progress_events(
             workspace_id, project_id, workflow_id, job_id, event_kind, content
           )
           SELECT workspace_id, project_id, workflow_id, id, 'SUPERSEDED',
                  'Superseded by a confirmed implementation change'
             FROM deviludo.jobs
            WHERE workflow_id = $1::uuid AND state IN ('QUEUED', 'RETRY', 'RUNNING')`,
          [current.id],
        );
        await client.query(
          `UPDATE deviludo.jobs
              SET state = 'CANCELLED', lease_owner = NULL, lease_token = NULL,
                  lease_expires_at = NULL, heartbeat_at = NULL,
                  fencing_token = fencing_token + 1,
                  last_error = 'superseded by confirmed implementation change',
                  updated_at = clock_timestamp()
            WHERE workflow_id = $1::uuid AND kind <> 'STEAM_PUBLISH'
              AND state IN ('QUEUED', 'RETRY', 'RUNNING')`,
          [current.id],
        );
        await client.query(
          `UPDATE deviludo.workflow_instances
              SET state = 'DESIGNING', version = version + 1,
                  development_actor_id = $2::uuid,
                  state_data = state_data || jsonb_build_object(
                    'specification', $3::jsonb, 'responseLanguage', $4::text,
                    'e2eGoalRevision', $5::bigint
                  ), updated_at = clock_timestamp()
            WHERE id = $1::uuid`,
          [current.id, input.actorId, JSON.stringify(specification), input.responseLanguage, goalRevision],
        );
        await client.query(
          `UPDATE deviludo.asset_manifests SET auto_generate_enabled = false, updated_at = clock_timestamp()
            WHERE project_id = $1::uuid`, [input.projectId],
        );
        await client.query(
          `UPDATE deviludo.asset_items item
              SET status = 'failed', generation_lease_expires_at = NULL,
                  error_message = 'superseded by confirmed implementation change', updated_at = clock_timestamp()
            FROM deviludo.asset_manifests manifest
           WHERE manifest.workspace_id = item.workspace_id AND manifest.id = item.manifest_id
             AND manifest.project_id = $1::uuid AND item.status = 'generating'`,
          [input.projectId],
        );
      }
      await client.query(
        `INSERT INTO deviludo.workflow_e2e_goal_revisions(
           workspace_id, workflow_id, revision, change_request_id, goals, goals_digest
         ) VALUES ($1::uuid, $2::uuid, $3::bigint, $4::uuid, $5::jsonb, $6)`,
        [input.workspaceId, targetWorkflowId, goalRevision, change.id, JSON.stringify(goals), e2eGoalsDigest(goals)],
      );
      await client.query(
        `INSERT INTO deviludo.artifacts(
           workspace_id, project_id, workflow_id, kind, bucket, object_key, sha256, size_bytes
         ) VALUES ($1::uuid, $2::uuid, $3::uuid, 'SPECIFICATION', $4, $5, $6, $7::bigint)
         ON CONFLICT (workspace_id, workflow_id, object_key, sha256) DO NOTHING`,
        [input.workspaceId, input.projectId, targetWorkflowId, input.specificationObject.bucket,
          input.specificationObject.key, input.specificationObject.sha256, input.specificationObject.sizeBytes],
      );
      const settings = await client.query<{
        agent_runtime: string; base_url: string; primary_model: string;
        model_overrides: Record<string, unknown>; credential_secret_ref: string; revision: string;
      }>(
        `SELECT agent_runtime::text, base_url, primary_model, model_overrides,
                credential_secret_ref, revision::text
           FROM deviludo.instance_agent_settings WHERE singleton = true`,
      );
      const agent = settings.rows[0];
      const payload = agent ? {
        role: "DESIGN",
        purpose: "DESIGN",
        changeRequestId: change.id,
        implementationBrief: change.implementation_brief,
        e2eGoalRevision: goalRevision,
        e2eGoals: goals,
        agentConfiguration: {
          runtime: agent.agent_runtime,
          baseUrl: agent.base_url,
          model: typeof agent.model_overrides.development === "string"
            ? agent.model_overrides.development : agent.primary_model,
          credentialRef: agent.credential_secret_ref,
          revision: Number(agent.revision),
        },
      } : {
        role: "DESIGN",
        purpose: "DESIGN",
        changeRequestId: change.id,
        implementationBrief: change.implementation_brief,
        e2eGoalRevision: goalRevision,
        e2eGoals: goals,
      };
      await client.query(
        `SELECT deviludo.enqueue_job($1::uuid, $2::uuid, $3::uuid, 'AGENT_TURN', NULL, $4, $5::jsonb)`,
        [input.workspaceId, targetWorkflowId, input.projectId,
          `${targetWorkflowId}:agent:change:${change.id}`, JSON.stringify(payload)],
      );
      await client.query(
        `INSERT INTO deviludo.workflow_events(workspace_id, workflow_id, event_kind, event_data, idempotency_key)
         VALUES ($1::uuid, $2::uuid, 'IMPLEMENTATION_CHANGE_APPLIED', $3::jsonb, $4)`,
        [input.workspaceId, targetWorkflowId, JSON.stringify({ changeRequestId: change.id, goalRevision }), `change-applied:${change.id}`],
      );
      await client.query(
        `UPDATE deviludo.implementation_change_requests
            SET state = 'APPLIED', applied_workflow_id = $2::uuid,
                decision = 'CONFIRM', decision_idempotency_key = coalesce(decision_idempotency_key, $3),
                updated_at = clock_timestamp()
          WHERE id = $1::uuid`,
        [change.id, targetWorkflowId, input.decisionIdempotencyKey ?? null],
      );
      await touchProjectActivity(client, input.workspaceId, input.projectId);
      if (newIteration) return "NEW_ITERATION_STARTED";
      return current.state === "DRAFT" ? "AGENT_STARTED" : "AGENT_RERUN_STARTED";
    });
  }

  private async readConversationMessages(
    client: PoolClient,
    conversation: ProductConversationRow,
  ): Promise<ProductConversation> {
    const messages = await client.query<ProductConversationMessageRow>(
      `SELECT message_id::text, role, content, metadata, created_at::text, completed_at::text
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
        attachments: publicConversationImages(message.metadata),
        metadata: publicConversationMetadata(message.metadata),
        createdAt: message.created_at,
        completedAt: new Date(message.completed_at).toISOString(),
      }))),
    });
  }

  async readConversationImage(
    workspaceId: string,
    conversationId: string,
    messageId: string,
    imageId: string,
  ): Promise<Readonly<{ projectId: string; image: StoredConversationImage }> | null> {
    return this.database.withWorkspace(workspaceId, async client => {
      const result = await client.query<{ project_id: string; metadata: Record<string, unknown> }>(
        `SELECT conversation.project_id::text, message.metadata
           FROM deviludo.conversation_messages message
           JOIN deviludo.project_conversations conversation
             ON conversation.workspace_id = message.workspace_id
            AND conversation.id = message.conversation_id
          WHERE message.conversation_id = $1::uuid
            AND message.message_id = $2::bigint
            AND message.role = 'USER'`,
        [conversationId, messageId],
      );
      const row = result.rows[0];
      if (!row) return null;
      const image = storedConversationImages(row.metadata).find(candidate => candidate.id === imageId);
      return image ? Object.freeze({ projectId: row.project_id, image }) : null;
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
                 last_reimage_proof_at::text, preparation_state, preparation_stage,
                 preparation_progress::text, preparation_message, preparation_updated_at::text`,
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
                  last_reimage_proof_at::text, preparation_state, preparation_stage,
                  preparation_progress::text, preparation_message, preparation_updated_at::text`,
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
      `INSERT INTO deviludo.e2e_enrollment_tokens(token_hash, pool_kind, expires_at, created_by_actor_id)
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
      const token = await client.query<{ id: string; node_id: string | null; used_at: string | null; expires_at: string }>(
        `SELECT id::text, node_id::text, used_at::text, expires_at::text
           FROM deviludo.e2e_enrollment_tokens
          WHERE token_hash = $1 AND pool_kind = $2::deviludo.server_pool_kind
          FOR UPDATE`,
        [input.tokenHash, input.poolKind],
      );
      if (!token.rows[0] || (!token.rows[0].used_at && Date.parse(token.rows[0].expires_at) <= Date.now())) {
        throw Object.assign(new Error("Enrollment token is invalid or expired"), { statusCode: 401 });
      }
      if (token.rows[0].used_at && token.rows[0].node_id) {
        const existing = await client.query<{ public_key_pem: string; operating_system: string }>(
          `SELECT identity.public_key_pem, node.operating_system::text
             FROM deviludo.executor_identities identity
             JOIN deviludo.server_nodes node ON node.id = identity.node_id
            WHERE identity.node_id = $1::uuid AND identity.enabled = true`,
          [token.rows[0].node_id],
        );
        if (existing.rows[0]?.public_key_pem !== input.receiptPublicKey
          || existing.rows[0]?.operating_system !== input.operatingSystem) {
          throw Object.assign(new Error("Enrollment token is already bound to another node"), { statusCode: 401 });
        }
        await client.query("COMMIT");
        return token.rows[0].node_id;
      }
      const node = await client.query<{ id: string }>(
        `INSERT INTO deviludo.server_nodes(pool_kind, operating_system, state, capabilities)
         VALUES ($1::deviludo.server_pool_kind, $2::deviludo.server_os, 'PROVISIONING',
                 ARRAY['E2E_PLATFORM_RUN'])
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

  async reserveDevelopmentE2eEnrollment(input: Readonly<{
    tokenHash: string;
    poolKind: Extract<ServerPoolKind, `E2E_${string}`>;
    operatingSystem: ServerOperatingSystem;
    receiptPublicKey: string;
    nodeAuthTokenHash: string;
    runtimeImage: string;
  }>): Promise<string> {
    const client = await this.database.pool.connect();
    try {
      await client.query("BEGIN");
      const token = await client.query<{ id: string; node_id: string | null; used_at: string | null; expires_at: string }>(
        `SELECT id::text, node_id::text, used_at::text, expires_at::text
           FROM deviludo.e2e_enrollment_tokens
          WHERE token_hash = $1 AND pool_kind = $2::deviludo.server_pool_kind
          FOR UPDATE`,
        [input.tokenHash, input.poolKind],
      );
      if (!token.rows[0] || (!token.rows[0].used_at && Date.parse(token.rows[0].expires_at) <= Date.now())) {
        throw Object.assign(new Error("Enrollment token is invalid or expired"), { statusCode: 401 });
      }
      if (token.rows[0].used_at && token.rows[0].node_id) {
        const existing = await client.query<{
          public_key_pem: string;
          operating_system: string;
          development_auth_token_hash: string | null;
        }>(
          `SELECT identity.public_key_pem, node.operating_system::text, node.development_auth_token_hash
             FROM deviludo.executor_identities identity
             JOIN deviludo.server_nodes node ON node.id = identity.node_id
            WHERE identity.node_id = $1::uuid AND identity.enabled = true`,
          [token.rows[0].node_id],
        );
        if (existing.rows[0]?.public_key_pem !== input.receiptPublicKey
          || existing.rows[0]?.operating_system !== input.operatingSystem
          || existing.rows[0]?.development_auth_token_hash !== input.nodeAuthTokenHash) {
          throw Object.assign(new Error("Enrollment token is already bound to another node"), { statusCode: 401 });
        }
        await client.query("COMMIT");
        return token.rows[0].node_id;
      }
      const node = await client.query<{ id: string }>(
        `INSERT INTO deviludo.server_nodes(
           pool_kind, operating_system, state, capabilities, development_auth_token_hash
         )
         VALUES ($1::deviludo.server_pool_kind, $2::deviludo.server_os, 'ACTIVE', ARRAY['E2E_PLATFORM_RUN'], $3)
         RETURNING id::text`,
        [input.poolKind, input.operatingSystem, input.nodeAuthTokenHash],
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
      await client.query(
        `INSERT INTO deviludo.runtime_images(runtime_key, image_reference, release_version, verified_at)
         VALUES ($1, $2, 'local-remote', clock_timestamp())
         ON CONFLICT (runtime_key) DO UPDATE SET image_reference = EXCLUDED.image_reference,
           release_version = EXCLUDED.release_version, verified_at = EXCLUDED.verified_at,
           updated_at = clock_timestamp()`,
        [input.poolKind, input.runtimeImage],
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

  async authenticateDevelopmentE2eNode(nodeId: string, tokenHash: string): Promise<boolean> {
    const result = await this.database.pool.query(
      `SELECT 1
         FROM deviludo.server_nodes node
        WHERE node.id = $1::uuid AND node.development_auth_token_hash = $2
          AND node.state IN ('ACTIVE', 'DRAINING')
        LIMIT 1`,
      [nodeId, tokenHash],
    );
    return result.rowCount === 1;
  }

  async heartbeatServerNode(nodeId: string, poolKind: ServerPoolKind): Promise<boolean> {
    const result = await this.database.pool.query(
      `UPDATE deviludo.server_nodes
          SET last_heartbeat_at = clock_timestamp(), updated_at = clock_timestamp()
        WHERE id = $1::uuid AND pool_kind = $2::deviludo.server_pool_kind AND state = 'ACTIVE'`,
      [nodeId, poolKind],
    );
    return result.rowCount === 1;
  }

  async updateE2eNodePreparation(input: Readonly<{
    nodeId: string;
    state: "PREPARING" | "READY" | "FAILED";
    stage: string;
    progress: number;
    message: string;
  }>): Promise<boolean> {
    const result = await this.database.pool.query(
      `UPDATE deviludo.server_nodes
          SET preparation_state = $2,
              preparation_stage = $3,
              preparation_progress = $4,
              preparation_message = $5,
              preparation_updated_at = clock_timestamp(),
              updated_at = clock_timestamp()
        WHERE id = $1::uuid AND pool_kind::text LIKE 'E2E_%'`,
      [input.nodeId, input.state, input.stage, input.progress, input.message],
    );
    return result.rowCount === 1;
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

  async attachHostAdmission(job: JobProtocolV4, reservationId: string, reservedUnits: number): Promise<boolean> {
    if (reservationId.length < 1 || reservationId.length > 2_000 || /[\r\n\0]/.test(reservationId)) {
      throw new Error("Host admission reservation is invalid");
    }
    if (!Number.isSafeInteger(reservedUnits) || reservedUnits < 1 || reservedUnits > 86_400) {
      throw new Error("Host admission reserved units are invalid");
    }
    return this.database.withWorkspace(job.workspaceId, async client => {
      const result = await client.query(
        `UPDATE deviludo.jobs
            SET payload = CASE
                  WHEN payload ? 'hostAdmissionReservationId' THEN payload
                  ELSE jsonb_set(
                    jsonb_set(
                      jsonb_set(payload, '{hostAdmissionReservationId}', to_jsonb($4::text), true),
                      '{hostAdmissionReservedUnits}', to_jsonb($5::integer), true
                    ),
                    '{hostAdmissionStartedAt}', to_jsonb(clock_timestamp()::text), true
                  )
                END,
                updated_at = clock_timestamp()
          WHERE id=$1::uuid AND state='RUNNING' AND lease_token=$2::uuid AND fencing_token=$3::bigint
            AND (NOT payload ? 'hostAdmissionReservationId' OR payload->>'hostAdmissionReservationId'=$4::text)`,
        [job.jobId, job.lease.token, job.lease.fencingToken, reservationId, reservedUnits],
      );
      return result.rowCount === 1;
    });
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
      const completed = result.rows[0]?.completed === true;
      if (completed && job.jobKind === "AGENT_TURN") {
        await reconcileExistingSourceAssets(
          client,
          job.workspaceId,
          job.projectId,
          (completion.receipt as Record<string, unknown>).assetManifest,
        );
      }
      return completed;
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

  async claimLocalGitCommit(leaseSeconds: number): Promise<PendingLocalGitCommit | null> {
    if (!Number.isSafeInteger(leaseSeconds) || leaseSeconds < 30 || leaseSeconds > 600) {
      throw new Error("Local Git commit lease is invalid");
    }
    const result = await this.database.pool.query<PendingLocalGitCommitRow>(
      `SELECT "workspaceId"::text, "projectId"::text, "workflowId"::text,
              "requestId"::text, "leaseToken"::text, "bindingId"::text,
              "expectedSourceDigest", "iterationNumber", attempt
         FROM deviludo.claim_local_git_commit($1::integer)`,
      [leaseSeconds],
    );
    const row = result.rows[0];
    return row ? Object.freeze({
      workspaceId: row.workspaceId,
      projectId: row.projectId,
      workflowId: row.workflowId,
      requestId: row.requestId,
      leaseToken: row.leaseToken,
      bindingId: row.bindingId,
      expectedSourceDigest: row.expectedSourceDigest,
      iterationNumber: row.iterationNumber,
      attempt: row.attempt,
    }) : null;
  }

  async completeLocalGitCommit(input: Readonly<{
    workflowId: string;
    requestId: string;
    leaseToken: string;
    outcome: "COMMITTED" | "NO_CHANGES" | "NOT_GIT";
    commitHash: string | null;
    branch: string | null;
  }>): Promise<boolean> {
    const result = await this.database.pool.query<{ completed: boolean }>(
      `SELECT deviludo.complete_local_git_commit(
         $1::uuid, $2::uuid, $3::uuid, $4::text, $5::text, $6::text
       ) AS completed`,
      [input.workflowId, input.requestId, input.leaseToken, input.outcome, input.commitHash, input.branch],
    );
    return result.rows[0]?.completed === true;
  }

  async failLocalGitCommit(input: Readonly<{
    workflowId: string;
    requestId: string;
    leaseToken: string;
    error: string;
  }>): Promise<boolean> {
    const result = await this.database.pool.query<{ failed: boolean }>(
      `SELECT deviludo.fail_local_git_commit(
         $1::uuid, $2::uuid, $3::uuid, $4::text
       ) AS failed`,
      [input.workflowId, input.requestId, input.leaseToken, input.error.slice(0, 2_000)],
    );
    return result.rows[0]?.failed === true;
  }

  async claimObjectCleanup(leaseSeconds: number): Promise<PendingObjectCleanup | null> {
    if (!Number.isSafeInteger(leaseSeconds) || leaseSeconds < 30 || leaseSeconds > 600) {
      throw new Error("Object cleanup lease is invalid");
    }
    const result = await this.database.pool.query<PendingObjectCleanupRow>(
      `SELECT "workspaceId"::text, bucket, "objectKey", "leaseToken"::text, attempt
         FROM deviludo.claim_object_cleanup($1::integer)`,
      [leaseSeconds],
    );
    return result.rows[0] ? Object.freeze(result.rows[0]) : null;
  }

  async enqueueExpiredArtifacts(retentionDays: number, limit = 25): Promise<number> {
    if (!Number.isSafeInteger(retentionDays) || retentionDays < 1 || retentionDays > 3_650
      || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
      throw new Error("Artifact retention sweep is invalid");
    }
    const result = await this.database.pool.query<{ enqueued: number }>(
      "SELECT deviludo.enqueue_expired_artifacts($1::integer, $2::integer) AS enqueued",
      [retentionDays, limit],
    );
    return result.rows[0]?.enqueued ?? 0;
  }

  async recordPendingOutput(job: JobProtocolV4, object: Readonly<{
    kind: string;
    targetPlatform?: string;
    bucket: string;
    key: string;
    sha256: string;
    sizeBytes: number;
  }>): Promise<void> {
    const prefix = `workspaces/${job.workspaceId}/projects/${job.projectId}/jobs/${job.jobId}/`;
    if (object.bucket.length < 3
      || !object.key.startsWith(prefix)
      || !/^sha256:[0-9a-f]{64}$/.test(object.sha256)
      || !Number.isSafeInteger(object.sizeBytes)
      || object.sizeBytes < 1
      || object.sizeBytes > job.outputContract.maxBytes
      || (object.targetPlatform !== undefined && object.targetPlatform !== job.targetOperatingSystem)
      || !job.outputContract.kinds.includes(object.kind)) {
      throw new Error("Pending output boundary is invalid");
    }
    await this.database.withWorkspace(job.workspaceId, client => client.query(
      `INSERT INTO deviludo.pending_object_uploads(
         workspace_id, job_id, bucket, object_key, kind, target_platform, sha256, size_bytes, cleanup_after
       ) VALUES(
         $1::uuid, $2::uuid, $3, $4, $5::deviludo.artifact_kind, $6::deviludo.server_os,
         $7, $8, clock_timestamp() + interval '1 day'
       )
       ON CONFLICT (workspace_id, bucket, object_key) DO UPDATE
         SET job_id = $2::uuid, kind = $5::deviludo.artifact_kind,
             target_platform = $6::deviludo.server_os, sha256 = $7, size_bytes = $8,
             cleanup_after = clock_timestamp() + interval '1 day'`,
      [
        job.workspaceId,
        job.jobId,
        object.bucket,
        object.key,
        object.kind,
        object.targetPlatform ?? null,
        object.sha256,
        String(object.sizeBytes),
      ],
    ));
  }

  async reconcileExpiredUploads(limit = 25): Promise<number> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
      throw new Error("Pending upload sweep is invalid");
    }
    const result = await this.database.pool.query<{ enqueued: number }>(
      "SELECT deviludo.reconcile_expired_uploads($1::integer) AS enqueued",
      [limit],
    );
    return result.rows[0]?.enqueued ?? 0;
  }

  async completeObjectCleanup(input: PendingObjectCleanup): Promise<boolean> {
    const result = await this.database.pool.query<{ completed: boolean }>(
      "SELECT deviludo.complete_object_cleanup($1::uuid, $2::text, $3::text, $4::uuid) AS completed",
      [input.workspaceId, input.bucket, input.objectKey, input.leaseToken],
    );
    return result.rows[0]?.completed === true;
  }

  async failObjectCleanup(input: PendingObjectCleanup, error: string): Promise<boolean> {
    const result = await this.database.pool.query<{ failed: boolean }>(
      "SELECT deviludo.fail_object_cleanup($1::uuid, $2::text, $3::text, $4::uuid, $5::text) AS failed",
      [input.workspaceId, input.bucket, input.objectKey, input.leaseToken, error.slice(0, 2_000)],
    );
    return result.rows[0]?.failed === true;
  }

  async claimProjectCleanup(leaseSeconds: number): Promise<PendingProjectCleanup | null> {
    if (!Number.isSafeInteger(leaseSeconds) || leaseSeconds < 30 || leaseSeconds > 600) throw new Error("Project cleanup lease is invalid");
    const result = await this.database.pool.query<PendingProjectCleanupRow>(
      `SELECT "workspaceId"::text, "projectId"::text, "leaseToken"::text, attempt
         FROM deviludo.claim_project_cleanup($1::integer)`,
      [leaseSeconds],
    );
    return result.rows[0] ? Object.freeze(result.rows[0]) : null;
  }

  async completeProjectCleanup(input: PendingProjectCleanup): Promise<boolean> {
    const result = await this.database.pool.query<{ completed: boolean }>(
      "SELECT deviludo.complete_project_cleanup($1::uuid, $2::uuid, $3::uuid) AS completed",
      [input.workspaceId, input.projectId, input.leaseToken],
    );
    return result.rows[0]?.completed === true;
  }

  async failProjectCleanup(input: PendingProjectCleanup, error: string): Promise<boolean> {
    const result = await this.database.pool.query<{ failed: boolean }>(
      "SELECT deviludo.fail_project_cleanup($1::uuid, $2::uuid, $3::uuid, $4::text) AS failed",
      [input.workspaceId, input.projectId, input.leaseToken, error.slice(0, 2_000)],
    );
    return result.rows[0]?.failed === true;
  }

  async reconcileHostAdmissionEvents(): Promise<number> {
    const result = await this.database.pool.query<{ inserted: string }>(
      "SELECT deviludo.reconcile_host_admission_events()::text AS inserted",
    );
    return Number(result.rows[0]?.inserted ?? 0);
  }

  async claimHostAdmissionEvent(leaseSeconds: number): Promise<PendingHostAdmissionEvent | null> {
    if (!Number.isSafeInteger(leaseSeconds) || leaseSeconds < 30 || leaseSeconds > 600) {
      throw new Error("Host admission event lease is invalid");
    }
    const result = await this.database.pool.query<PendingHostAdmissionEventRow>(
      `SELECT "workspaceId"::text, "eventId"::text, "reservationId", action,
              "actualUnits", "leaseToken"::text, attempt
         FROM deviludo.claim_host_admission_event($1::integer)`,
      [leaseSeconds],
    );
    return result.rows[0] ? Object.freeze(result.rows[0]) : null;
  }

  async completeHostAdmissionEvent(input: PendingHostAdmissionEvent): Promise<boolean> {
    const result = await this.database.pool.query<{ completed: boolean }>(
      "SELECT deviludo.complete_host_admission_event($1::uuid, $2::uuid, $3::uuid) AS completed",
      [input.workspaceId, input.eventId, input.leaseToken],
    );
    return result.rows[0]?.completed === true;
  }

  async failHostAdmissionEvent(input: PendingHostAdmissionEvent, error: string): Promise<boolean> {
    const result = await this.database.pool.query<{ failed: boolean }>(
      "SELECT deviludo.fail_host_admission_event($1::uuid, $2::uuid, $3::uuid, $4::text) AS failed",
      [input.workspaceId, input.eventId, input.leaseToken, error.slice(0, 2_000)],
    );
    return result.rows[0]?.failed === true;
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
      if (workflow.rows[0] && (signal.payload.responseLanguage === "en" || signal.payload.responseLanguage === "zh")) {
        await client.query(
          `UPDATE deviludo.workflow_instances
              SET state_data = coalesce(state_data, '{}'::jsonb)
                    || jsonb_build_object('responseLanguage', $2::text),
                  updated_at = clock_timestamp()
            WHERE id = $1::uuid`,
          [workflowId, signal.payload.responseLanguage],
        );
      }
      if (signal.kind === "SPEC_APPROVED" && workflow.rows[0]) {
        await client.query(
          `UPDATE deviludo.workflow_instances target
              SET state_data = coalesce(target.state_data, '{}'::jsonb)
                    || jsonb_build_object(
                      'iteration',
                      coalesce(target.state_data->'iteration', '{}'::jsonb)
                        || jsonb_build_object('approvedDocumentRevision', document.revision)
                    ),
                  version = version + 1,
                  updated_at = clock_timestamp()
             FROM deviludo.project_documents document
            WHERE target.id = $1::uuid
              AND target.project_id = document.project_id
              AND target.state = 'DRAFT'`,
          [workflowId],
        );
      }
      const result = await client.query<{ accepted: boolean }>(
        `SELECT deviludo.accept_workflow_signal(
          $1::uuid, $2::text, $3::text, $4::jsonb
        ) AS accepted`,
        [workflowId, signal.kind, signal.idempotencyKey, JSON.stringify(signal.payload)],
      );
      return result.rows[0]?.accepted === true;
    });
  }

  async rerunStage(
    workspaceId: string,
    workflowId: string,
    signal: WorkflowSignalInput & Readonly<{ kind: "STAGE_RERUN_REQUESTED" }>,
  ): Promise<boolean> {
    return this.database.withWorkspace(workspaceId, async client => {
      const workflow = await client.query<{ project_id: string }>(
        "SELECT project_id::text FROM deviludo.workflow_instances WHERE id = $1::uuid",
        [workflowId],
      );
      if (workflow.rows[0]) await touchProjectActivity(client, workspaceId, workflow.rows[0].project_id);
      const result = await client.query<{ accepted: boolean }>(
        `SELECT deviludo.request_stage_rerun($1::uuid, $2::text, $3::jsonb) AS accepted`,
        [workflowId, signal.idempotencyKey, JSON.stringify(signal.payload)],
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
         ON CONFLICT (workspace_id, workflow_id, object_key, sha256) DO NOTHING`,
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
              workflow.profile::text AS workflow_profile, workflow.state_data AS workflow_state_data,
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
    const artifactObjects = inputObjects.rows.map(item => Object.freeze({
      kind: item.kind,
      ...(item.target_platform ? { targetPlatform: item.target_platform } : {}),
      bucket: item.bucket,
      key: item.object_key,
      sha256: item.sha256,
      sizeBytes: Number(item.size_bytes),
    }));
    const assetObjects = buildAssetInputObjects(row);
    const sourceState = row.workflow_state_data?.source as Record<string, unknown> | undefined;
    const localDirectoryBindingId = sourceState && typeof sourceState === "object" && !Array.isArray(sourceState)
      && typeof sourceState.localDirectoryBindingId === "string"
      && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(sourceState.localDirectoryBindingId)
      ? sourceState.localDirectoryBindingId
      : null;
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
      inputObjects: Object.freeze([...artifactObjects, ...assetObjects]),
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
      payload: Object.freeze({
        ...row.payload,
        responseLanguage: parseResponseLanguage(row.workflow_state_data?.responseLanguage),
        ...(row.kind === "AGENT_TURN" && localDirectoryBindingId ? { localDirectoryBindingId } : {}),
      }),
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
  preparation_state: string | null;
  preparation_stage: string | null;
  preparation_progress: string | null;
  preparation_message: string | null;
  preparation_updated_at: string | null;
};

function serverNodeFromRow(row: ServerNodeRow): ServerNodeRecord {
  if (!row) throw new Error("Stored server node is invalid");
  const preparationProgress = row.preparation_progress === null ? null : Number(row.preparation_progress);
  if (!isServerPoolKind(row.pool_kind)
    || !["linux", "windows", "macos"].includes(row.operating_system)
    || !["PROVISIONING", "ACTIVE", "DRAINING", "DISABLED", "REIMAGING"].includes(row.state)
    || !Number.isSafeInteger(Number(row.isolation_generation))
    || Number(row.isolation_generation) < 1
    || (row.preparation_state !== null
      && (!(["PREPARING", "READY", "FAILED"] as readonly string[]).includes(row.preparation_state)
        || typeof row.preparation_stage !== "string"
        || !/^[A-Z][A-Z0-9_]{1,39}$/.test(row.preparation_stage)
        || preparationProgress === null || !Number.isSafeInteger(preparationProgress)
        || preparationProgress < 0 || preparationProgress > 100
        || typeof row.preparation_message !== "string" || row.preparation_message.length < 1
        || row.preparation_message.length > 240 || typeof row.preparation_updated_at !== "string"))) {
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
    preparation: row.preparation_state === null ? null : Object.freeze({
      state: row.preparation_state as "PREPARING" | "READY" | "FAILED",
      stage: row.preparation_stage as string,
      progress: preparationProgress as number,
      message: row.preparation_message as string,
      updatedAt: row.preparation_updated_at as string,
    }),
  });
}

type ClaimRow = { jobId: string; workspaceId: string; leaseToken: string };
type PendingLocalGitCommitRow = {
  workspaceId: string;
  projectId: string;
  workflowId: string;
  requestId: string;
  leaseToken: string;
  bindingId: string;
  expectedSourceDigest: `sha256:${string}`;
  iterationNumber: number;
  attempt: number;
};
export type PendingLocalGitCommit = Readonly<PendingLocalGitCommitRow>;

type PendingObjectCleanupRow = {
  workspaceId: string;
  bucket: string;
  objectKey: string;
  leaseToken: string;
  attempt: number;
};

export type PendingObjectCleanup = Readonly<PendingObjectCleanupRow>;
type PendingProjectCleanupRow = {
  workspaceId: string;
  projectId: string;
  leaseToken: string;
  attempt: number;
};
export type PendingProjectCleanup = Readonly<PendingProjectCleanupRow>;
type PendingHostAdmissionEventRow = {
  workspaceId: string;
  eventId: string;
  reservationId: string;
  action: "SETTLE" | "CANCEL";
  actualUnits: number | null;
  leaseToken: string;
  attempt: number;
};
export type PendingHostAdmissionEvent = Readonly<PendingHostAdmissionEventRow>;
type AgentSettingsRow = {
  agent_runtime: string;
  base_url: string;
  primary_model: string | null;
  model_overrides: unknown;
  image_model: string | null;
  credential_secret_ref: string;
  test_policy_ready: boolean;
  test_policy_checked_revision: string | null;
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
  primaryModel: string;
  modelOverrides: AgentModelOverrides;
  imageModel: string | null;
  credentialSecretRef: string;
  testPolicyReady: boolean;
  testPolicyCheckedRevision: number | null;
  apiKeyMask: string | null;
  apiKeyFingerprint: string;
  credentialVersion: string;
  revision: number;
  updatedBy: string;
  updatedAt: string;
}>;

function agentSettingsFromRow(row: AgentSettingsRow): StoredInstanceAgentSettings {
  const revision = Number(row.revision);
  const primaryModel = normalizeAgentModel(row.primary_model);
  const modelOverrides = normalizeAgentModelOverrides(row.model_overrides);
  const imageModel = row.image_model === null ? null : normalizeAgentModel(row.image_model);
  const testPolicyCheckedRevision = row.test_policy_checked_revision === null ? null : Number(row.test_policy_checked_revision);
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
    primaryModel,
    modelOverrides,
    imageModel,
    credentialSecretRef: row.credential_secret_ref,
    testPolicyReady: row.test_policy_ready,
    testPolicyCheckedRevision,
    apiKeyMask: row.api_key_mask,
    apiKeyFingerprint: row.api_key_fingerprint,
    credentialVersion: row.credential_version,
    revision,
    updatedBy: row.updated_by,
    updatedAt: row.updated_at,
  });
}

function buildAssetInputObjects(row: JobRow): readonly ObjectReference[] {
  if (row.kind !== "BUILD") return Object.freeze([]);
  const value = row.payload.assetInputs;
  // Jobs queued before the asset-materialization migration have no snapshot and
  // remain runnable during a rolling deployment.
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value) || value.length > 500) throw new Error("Stored build asset inputs are invalid");
  const seenKeys = new Set<string>();
  const seenObjects = new Set<string>();
  const prefix = `workspaces/${row.workspace_id}/projects/${row.project_id}/assets/`;
  const objects = value.map(entry => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("Stored build asset input is invalid");
    }
    const item = entry as Record<string, unknown>;
    const assetKey = item.assetKey;
    const bucket = item.bucket;
    const key = item.objectKey;
    const sha256 = item.sha256;
    const sizeBytes = Number(item.sizeBytes);
    if (typeof assetKey !== "string"
      || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(assetKey)
      || /(^|\/)\.{1,2}(\/|$)|\/\//.test(assetKey) || assetKey.endsWith("/")
      || typeof bucket !== "string" || bucket.length < 3 || bucket.length > 255
      || typeof key !== "string" || !key.startsWith(prefix)
      || typeof sha256 !== "string" || !/^sha256:[0-9a-f]{64}$/.test(sha256)
      || !Number.isSafeInteger(sizeBytes) || sizeBytes < 1 || sizeBytes > 100 * 1024 * 1024
      || seenKeys.has(assetKey) || seenObjects.has(key)) {
      throw new Error("Stored build asset input is invalid");
    }
    seenKeys.add(assetKey);
    seenObjects.add(key);
    return Object.freeze({
      kind: "ASSET", assetKey, bucket, key,
      sha256: sha256 as ObjectReference["sha256"],
      sizeBytes,
    }) satisfies ObjectReference;
  });
  return Object.freeze(objects);
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
  workflow_state_data: Record<string, unknown> | null;
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
  iterationNumber: number;
  workflowState: string;
  workflowUpdatedAt: string;
  workflowProfile: "VALIDATE" | "RELEASE";
  targetPlatforms: readonly ServerOperatingSystem[];
  concept: string;
  specification: Readonly<Record<string, unknown>>;
  source: ProjectSourceRevision | null;
  analysisStatus: "READY" | "PENDING" | "ANALYZING" | "NEEDS_INPUT" | "FAILED";
  analysisError: string | null;
  discovery: ProjectDiscoveryReport | null;
}>;

export type ProductProjectDetail = ProductProjectSummary & Readonly<{
  localDirectory: Readonly<{
    bindingId: string;
    sourceKind: "LOCAL_DIRECTORY" | "GIT";
    repositoryUrl: string | null;
    initialGitBranch: string | null;
  }> | null;
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
  pendingImplementationChange: ImplementationChangeRequest | null;
  e2eGoalRevision: number;
  e2eGoals: readonly E2eGoal[];
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
    attachments: readonly Readonly<{
      id: string;
      filename: string;
      contentType: "image/png" | "image/jpeg" | "image/webp";
      sizeBytes: number;
    }>[];
    metadata: Readonly<Record<string, unknown>>;
    createdAt: string;
    completedAt: string;
  }>[];
}>;

export type ProductConversationSummary = Readonly<{
  id: string;
  projectId: string;
  mode: "NEW_GAME" | "PROJECT_FEEDBACK";
  title: string;
  preview: string;
  messageCount: number;
  userMessageCount: number;
  systemGenerated: boolean;
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
  user_message_count: string;
  system_generated: boolean;
};

type ProductConversationMessageRow = {
  message_id: string;
  role: "USER" | "ASSISTANT";
  content: string;
  metadata: Record<string, unknown>;
  created_at: string;
  completed_at: string;
};

const CONVERSATION_IMAGES_METADATA_KEY = "conversationImages";

function conversationImageMetadata(images: readonly StoredConversationImage[] | undefined): string {
  return JSON.stringify(images?.length ? { [CONVERSATION_IMAGES_METADATA_KEY]: images } : {});
}

function storedConversationImages(metadata: Readonly<Record<string, unknown>>): readonly StoredConversationImage[] {
  const value = metadata[CONVERSATION_IMAGES_METADATA_KEY];
  if (!Array.isArray(value)) return Object.freeze([]);
  const images = value.flatMap(candidate => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return [];
    const image = candidate as Record<string, unknown>;
    if (typeof image.id !== "string" || !UUID.test(image.id)
      || typeof image.filename !== "string" || image.filename.length < 1 || image.filename.length > 180
      || !["image/png", "image/jpeg", "image/webp"].includes(String(image.contentType))
      || !Number.isSafeInteger(image.sizeBytes) || Number(image.sizeBytes) < 1
      || typeof image.bucket !== "string" || !image.bucket
      || typeof image.key !== "string" || !image.key
      || typeof image.sha256 !== "string" || !/^sha256:[0-9a-f]{64}$/.test(image.sha256)) return [];
    return [Object.freeze({
      id: image.id,
      filename: image.filename,
      contentType: image.contentType as StoredConversationImage["contentType"],
      sizeBytes: Number(image.sizeBytes),
      bucket: image.bucket,
      key: image.key,
      sha256: image.sha256,
    })];
  });
  return Object.freeze(images);
}

function publicConversationImages(metadata: Readonly<Record<string, unknown>>) {
  return Object.freeze(storedConversationImages(metadata).map(image => Object.freeze({
    id: image.id,
    filename: image.filename,
    contentType: image.contentType,
    sizeBytes: image.sizeBytes,
  })));
}

function publicConversationMetadata(metadata: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const result = { ...metadata };
  delete result[CONVERSATION_IMAGES_METADATA_KEY];
  return Object.freeze(result);
}

type ImplementationChangeRequestRow = {
  id: string;
  project_id: string;
  conversation_id: string;
  state: string;
  summary: string;
  implementation_brief: string;
  base_document_revision: string;
  project_document_patch: Record<string, unknown>;
  e2e_goal_delta: Record<string, unknown>;
  explicit_execution: boolean;
  created_at: string;
};

type E2eGoalRevisionRow = {
  revision: string;
  goals: unknown;
  goals_digest: string;
};

type AgentProgressEventRow = {
  sequence: string;
  job_id: string;
  event_kind: AgentProgressEventKind;
  content: string;
  created_at: string;
};

type WorkspaceRow = { id: string; name: string; created_at: string };

type WorkspaceSteamSettingsRow = {
  builder_username: string;
  credential_secret_ref: string;
  credential_mask: string;
  credential_fingerprint: string;
  credential_version: string;
  revision: string;
  updated_at: string;
};

export type StoredWorkspaceSteamSettings = WorkspaceSteamSettings & Readonly<{
  credentialSecretRef: string;
  credentialFingerprint: string;
  credentialVersion: string;
}>;

type ProjectSteamSettingsRow = {
  project_id: string;
  app_id: string;
  depot_linux: string | null;
  depot_windows: string | null;
  depot_macos: string | null;
  test_branch: string;
  revision: string;
  updated_at: string;
};

type SteamReleaseRow = {
  id: string;
  project_id: string;
  workflow_id: string;
  iteration_number: number;
  version: string;
  release_number: string;
  channel: "TEST" | "DEFAULT";
  target_branch: string;
  state: SteamRelease["state"];
  steam_build_id: string | null;
  failure_message: string | null;
  created_at: string;
  uploaded_at: string | null;
  live_at: string | null;
};

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

export type PendingProjectImportAnalysis = Readonly<{
  workspaceId: string;
  projectId: string;
  workflowId: string;
  actorId: string;
  leaseToken: string;
  sourceKind: "GIT" | "LOCAL_DIRECTORY";
  repositoryUrl: string | null;
  localDirectoryBindingId: string;
  gitBranch: string | null;
  displayName: string;
  responseLanguage: ResponseLanguage;
}>;

export type HostSourceEvent = Readonly<{
  eventId: string;
  workspaceId: string;
  projectId: string;
  workflowId: string;
  sourceRevision: number;
  digest: string;
  actorId: string;
  createdAt: string;
}>;

type HostSourceEventRow = {
  event_id: string;
  workspace_id: string;
  project_id: string;
  workflow_id: string;
  source_revision: string;
  content_digest: string;
  actor_id: string;
  created_at: string;
};

type PendingProjectImportAnalysisRow = {
  workspaceId: string;
  projectId: string;
  workflowId: string;
  actorId: string;
  leaseToken: string;
  sourceKind: "GIT" | "LOCAL_DIRECTORY";
  repositoryUrl: string | null;
  localDirectoryBindingId: string;
  gitBranch: string | null;
  displayName: string;
};

type ProductProjectRow = {
  id: string;
  name: string;
  created_at: string;
  workflow_id: string | null;
  iteration_number: number | null;
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

type WorkflowIterationRow = {
  workflow_id: string;
  iteration_number: number;
  parent_workflow_id: string | null;
  state: string;
  profile: "VALIDATE" | "RELEASE";
  target_platforms: ServerOperatingSystem[];
  state_data: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
  output_source_revision: string | null;
};

const WORKFLOW_ITERATION_SELECT = `
  SELECT workflow.id::text AS workflow_id,
         workflow.iteration_number,
         workflow.parent_workflow_id::text,
         workflow.state::text,
         workflow.profile::text,
         workflow.target_platforms::text[] AS target_platforms,
         workflow.state_data,
         workflow.created_at::text,
         workflow.updated_at::text,
         output_source.revision::text AS output_source_revision
    FROM deviludo.workflow_instances workflow
    LEFT JOIN LATERAL (
      SELECT revision
        FROM deviludo.project_source_revisions source
       WHERE source.workspace_id = workflow.workspace_id
         AND source.project_id = workflow.project_id
         AND source.workflow_id = workflow.id
       ORDER BY revision DESC
       LIMIT 1
    ) output_source ON true`;

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
  metadata: Record<string, unknown>;
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
  const analysis = stateData.importAnalysis && typeof stateData.importAnalysis === "object"
    && !Array.isArray(stateData.importAnalysis)
    ? stateData.importAnalysis as Record<string, unknown>
    : null;
  const analysisStatus = analysis && ["PENDING", "ANALYZING", "NEEDS_INPUT", "FAILED", "READY"].includes(String(analysis.status))
    ? analysis.status as ProductProjectSummary["analysisStatus"]
    : "READY";
  return Object.freeze({
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
    workflowId: row.workflow_id ?? "",
    iterationNumber: row.iteration_number ?? 1,
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
    analysisStatus,
    analysisError: analysisStatus === "FAILED" && typeof analysis?.error === "string"
      ? analysis.error
      : null,
    discovery: projectDiscoveryFromValue(analysis?.report),
  });
}

function projectDiscoveryFromValue(value: unknown): ProjectDiscoveryReport | null {
  const report = objectValue(value);
  const text = (candidate: unknown): string | null => typeof candidate === "string" && candidate.trim()
    ? candidate.trim()
    : null;
  const list = (candidate: unknown): readonly string[] | null => Array.isArray(candidate)
    && candidate.every(item => typeof item === "string")
    ? Object.freeze(candidate.map(item => item.trim()).filter(Boolean))
    : null;
  const gameContent = text(report.gameContent);
  const currentDevelopmentState = text(report.currentDevelopmentState);
  const completedWork = list(report.completedWork);
  const remainingWork = list(report.remainingWork);
  const startupFlow = text(report.startupFlow);
  const startupIssues = list(report.startupIssues);
  const risks = list(report.risks);
  if (!gameContent || !currentDevelopmentState || !completedWork || !remainingWork || !startupFlow
    || !startupIssues || !risks) return null;
  return Object.freeze({
    gameContent,
    currentDevelopmentState,
    completedWork,
    remainingWork,
    startupFlow,
    startupIssues,
    risks,
  });
}

function workflowIterationSummary(
  row: WorkflowIterationRow,
  current: boolean,
): ProductWorkflowIterationSummary {
  const metadata = objectValue(row.state_data?.iteration);
  return Object.freeze({
    workflowId: row.workflow_id,
    iterationNumber: row.iteration_number,
    parentWorkflowId: row.parent_workflow_id,
    state: row.state,
    profile: row.profile,
    targetPlatforms: Object.freeze([...row.target_platforms]),
    baseSourceRevision: nullablePositiveInteger(metadata.baseSourceRevision),
    outputSourceRevision: row.output_source_revision ? Number(row.output_source_revision) : null,
    baseDocumentRevision: nullablePositiveInteger(metadata.baseDocumentRevision) ?? 1,
    approvedDocumentRevision: nullablePositiveInteger(metadata.approvedDocumentRevision),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    current,
  });
}

function productJobFromRow(job: ProductJobRow): ProductJob {
  return Object.freeze({
    id: job.id,
    kind: job.kind,
    poolKind: job.pool_kind,
    targetOperatingSystem: job.target_operating_system,
    state: job.state,
    attempt: job.attempt,
    lastError: job.last_error,
    createdAt: job.created_at,
    updatedAt: job.updated_at,
  });
}

function productEventFromRow(event: ProductEventRow): ProductEvent {
  return Object.freeze({
    id: event.event_id,
    kind: event.event_kind,
    data: Object.freeze({ ...event.event_data }),
    createdAt: event.created_at,
  });
}

function nullablePositiveInteger(value: unknown): number | null {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function iterationError(code: string, message: string, statusCode: number): Error {
  return Object.assign(new Error(message), { code, statusCode });
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function workflowDevelopmentConversationContent(
  output: Readonly<Record<string, unknown>>,
  responseLanguage: "en" | "zh",
): string {
  const structured = objectValue(output.structured);
  const authored = typeof structured.content === "string" ? structured.content.trim() : "";
  if (authored) return authored.slice(0, 4_000);
  const summary = typeof objectValue(structured.handoff).summary === "string"
    ? String(objectValue(structured.handoff).summary).trim()
    : "";
  const revision = Number(output.sourceRevision ?? structured.sourceRevision);
  const transition = responseLanguage === "zh"
    ? `游戏生成已完成${Number.isSafeInteger(revision) && revision > 0 ? `，源码版本 ${revision} 已提交` : ""}，现已进入受控构建与测试流程。`
    : `Game generation is complete${Number.isSafeInteger(revision) && revision > 0 ? ` and source revision ${revision} is committed` : ""}. Controlled build and testing are now starting.`;
  return `${summary ? `${summary}\n\n` : ""}${transition}`.slice(0, 4_000);
}

function analysisLeaseMatches(stateData: Record<string, unknown>, leaseToken: string): boolean {
  const analysis = objectValue(stateData.importAnalysis);
  return analysis.status === "ANALYZING" && analysis.leaseToken === leaseToken;
}

function localDirectoryFromState(stateData: Record<string, unknown> | null): ProductProjectDetail["localDirectory"] {
  const source = stateData?.source;
  if (!source || typeof source !== "object" || Array.isArray(source)) return null;
  const value = source as Record<string, unknown>;
  if (!UUID.test(typeof value.localDirectoryBindingId === "string" ? value.localDirectoryBindingId : "")
    || !["LOCAL_DIRECTORY", "GIT"].includes(typeof value.kind === "string" ? value.kind : "")) {
    return null;
  }
  return Object.freeze({
    bindingId: value.localDirectoryBindingId as string,
    sourceKind: value.kind as "LOCAL_DIRECTORY" | "GIT",
    repositoryUrl: typeof value.repositoryUrl === "string" ? value.repositoryUrl : null,
    initialGitBranch: typeof value.gitBranch === "string" ? value.gitBranch : null,
  });
}

function artifactFromRow(row: ArtifactRow): ArtifactRecord {
  const evidence = e2eEvidenceSummary(row.metadata?.e2eEvidence);
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
    ...(evidence ? { e2eEvidence: evidence } : {}),
    createdAt: row.created_at,
  });
}

function e2eEvidenceSummary(value: unknown): ArtifactRecord["e2eEvidence"] | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const summary = value as Record<string, unknown>;
  if (!["PASSED", "FAILED"].includes(String(summary.result))
    || !Number.isSafeInteger(summary.screenshotCount) || Number(summary.screenshotCount) < 0
    || typeof summary.hasVisualDiff !== "boolean") return null;
  const counts = [
    "headlessCheckCount", "interactiveJourneyCount", "deterministicInputCount", "realInputCount",
    "keyboardMouseInputCount", "gamepadInputCount", "adaptiveRolloutCount", "adaptiveSuccessCount",
    "adaptiveDecisionCount", "coveredPlayerRequirementCount", "playerRequirementCount",
    "plannedAssetPlacementCount", "verifiedAssetPlacementCount", "visualBaselineCount", "videoCount",
    "frameRateSampleCount", "inputResponseSampleCount",
  ] as const;
  if (summary.schema !== "deviludo.e2e-evidence" || Object.hasOwn(summary, "protocol")
    || counts.some(key => !Number.isSafeInteger(summary[key]) || Number(summary[key]) < 0)
    || Number(summary.coveredPlayerRequirementCount) > Number(summary.playerRequirementCount)
    || Number(summary.verifiedAssetPlacementCount) > Number(summary.plannedAssetPlacementCount)
    || Number(summary.adaptiveRolloutCount) > 3
    || Number(summary.adaptiveSuccessCount) > Number(summary.adaptiveRolloutCount)
    || !nullableNonNegativeNumber(summary.minimumFps)
    || !nullableNonNegativeNumber(summary.p10Fps)
    || !nullableNonNegativeNumber(summary.medianFps)
    || !nullableNonNegativeNumber(summary.p95InputResponseMs)
    || !nullableNonNegativeNumber(summary.maxInputResponseMs)
    || typeof summary.performancePassed !== "boolean"
    || !metricsMatchSampleCount(Number(summary.frameRateSampleCount), [summary.minimumFps, summary.p10Fps, summary.medianFps])
    || !metricsMatchSampleCount(Number(summary.inputResponseSampleCount), [summary.p95InputResponseMs, summary.maxInputResponseMs])
    || (summary.regressionTraceDigest !== null && !/^sha256:[0-9a-f]{64}$/.test(String(summary.regressionTraceDigest)))
    || ![null, "KEYBOARD_MOUSE", "GAMEPAD"].includes(summary.regressionInputProfile as never)
    || (summary.regressionEstimatedDurationMs !== null
      && (!Number.isSafeInteger(summary.regressionEstimatedDurationMs)
        || Number(summary.regressionEstimatedDurationMs) < 1 || Number(summary.regressionEstimatedDurationMs) > 300_000))
    || ((summary.regressionTraceDigest === null) !== (summary.regressionInputProfile === null))
    || ((summary.regressionTraceDigest === null) !== (summary.regressionEstimatedDurationMs === null))
    || ![null, "MACOS_LAUNCH_SERVICES", "WINDOWS_FINAL_EXE", "LINUX_RELEASE_EXECUTABLE"].includes(summary.packageLaunchMode as never)) return null;
  return Object.freeze({
    schema: "deviludo.e2e-evidence", result: summary.result as "PASSED" | "FAILED",
    headlessCheckCount: Number(summary.headlessCheckCount), interactiveJourneyCount: Number(summary.interactiveJourneyCount),
    deterministicInputCount: Number(summary.deterministicInputCount), realInputCount: Number(summary.realInputCount),
    keyboardMouseInputCount: Number(summary.keyboardMouseInputCount), gamepadInputCount: Number(summary.gamepadInputCount),
    adaptiveRolloutCount: Number(summary.adaptiveRolloutCount), adaptiveSuccessCount: Number(summary.adaptiveSuccessCount),
    adaptiveDecisionCount: Number(summary.adaptiveDecisionCount),
    coveredPlayerRequirementCount: Number(summary.coveredPlayerRequirementCount),
    playerRequirementCount: Number(summary.playerRequirementCount),
    plannedAssetPlacementCount: Number(summary.plannedAssetPlacementCount),
    verifiedAssetPlacementCount: Number(summary.verifiedAssetPlacementCount),
    screenshotCount: Number(summary.screenshotCount),
    visualBaselineCount: Number(summary.visualBaselineCount), videoCount: Number(summary.videoCount), hasVisualDiff: summary.hasVisualDiff,
    frameRateSampleCount: Number(summary.frameRateSampleCount), minimumFps: summary.minimumFps as number | null,
    p10Fps: summary.p10Fps as number | null, medianFps: summary.medianFps as number | null,
    inputResponseSampleCount: Number(summary.inputResponseSampleCount), p95InputResponseMs: summary.p95InputResponseMs as number | null,
    maxInputResponseMs: summary.maxInputResponseMs as number | null, performancePassed: summary.performancePassed,
    regressionTraceDigest: summary.regressionTraceDigest as string | null,
    regressionInputProfile: summary.regressionInputProfile as "KEYBOARD_MOUSE" | "GAMEPAD" | null,
    regressionEstimatedDurationMs: summary.regressionEstimatedDurationMs as number | null,
    packageLaunchMode: summary.packageLaunchMode as "MACOS_LAUNCH_SERVICES" | "WINDOWS_FINAL_EXE" | "LINUX_RELEASE_EXECUTABLE" | null,
  });
}

function nullableNonNegativeNumber(value: unknown): boolean {
  return value === null || (typeof value === "number" && Number.isFinite(value) && value >= 0);
}

function metricsMatchSampleCount(count: number, metrics: readonly unknown[]): boolean {
  return count === 0
    ? metrics.every(value => value === null)
    : metrics.every(value => typeof value === "number" && Number.isFinite(value));
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
    responseLanguage?: ResponseLanguage;
  }>,
): Promise<void> {
  const content = input.document
    ? parseProjectDocumentContent(input.document)
    : createInitialProjectDocument(input.name, input.concept, input.specification, parseResponseLanguage(input.responseLanguage));
  const markdown = projectDocumentMarkdown(
    input.name,
    content,
    parseResponseLanguage(input.responseLanguage),
  );
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

async function insertInitialE2eGoalRevision(
  client: PoolClient,
  workspaceId: string,
  workflowId: string,
  specification: Readonly<Record<string, unknown>>,
): Promise<void> {
  const goals = initialE2eGoals(specification);
  await client.query(
    `INSERT INTO deviludo.workflow_e2e_goal_revisions(
       workspace_id, workflow_id, revision, goals, goals_digest
     ) VALUES ($1::uuid, $2::uuid, 1, $3::jsonb, $4)
     ON CONFLICT (workspace_id, workflow_id, revision) DO NOTHING`,
    [workspaceId, workflowId, JSON.stringify(goals), e2eGoalsDigest(goals)],
  );
}

function parseE2eGoals(value: unknown): readonly E2eGoal[] {
  if (!Array.isArray(value)) throw new Error("Stored E2E goals are invalid");
  const ids = new Set<string>();
  return Object.freeze(value.map(entry => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("Stored E2E goal is invalid");
    const goal = entry as Record<string, unknown>;
    if (typeof goal.id !== "string" || !/^[a-z0-9][a-z0-9-]{0,119}$/.test(goal.id)
      || typeof goal.description !== "string" || !goal.description.trim()
      || !["CORE_LOOP", "ACCEPTANCE"].includes(String(goal.source)) || ids.has(goal.id)) {
      throw new Error("Stored E2E goal is invalid");
    }
    ids.add(goal.id);
    return Object.freeze({ id: goal.id, description: goal.description.trim(), source: goal.source as E2eGoal["source"] });
  }));
}

function parseStoredE2eGoalDelta(value: unknown): E2eGoalDelta {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Stored E2E goal delta is invalid");
  const delta = value as Record<string, unknown>;
  const add = Array.isArray(delta.add) ? delta.add : null;
  const replace = Array.isArray(delta.replace) ? delta.replace : null;
  const retire = Array.isArray(delta.retire) ? delta.retire : null;
  if (!add || !replace || !retire) throw new Error("Stored E2E goal delta is invalid");
  const parseGoal = (entry: unknown, withId: boolean) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("Stored E2E goal delta is invalid");
    const goal = entry as Record<string, unknown>;
    if ((withId && (typeof goal.id !== "string" || !goal.id))
      || typeof goal.description !== "string" || !goal.description.trim()
      || !["CORE_LOOP", "ACCEPTANCE"].includes(String(goal.source))) {
      throw new Error("Stored E2E goal delta is invalid");
    }
    return Object.freeze({ ...(withId ? { id: String(goal.id) } : {}), description: goal.description.trim(), source: goal.source as E2eGoal["source"] });
  };
  if (retire.some(id => typeof id !== "string" || !id)) throw new Error("Stored E2E goal delta is invalid");
  return Object.freeze({
    add: Object.freeze(add.map(entry => parseGoal(entry, false) as Omit<E2eGoal, "id">)),
    replace: Object.freeze(replace.map(entry => parseGoal(entry, true) as E2eGoal)),
    retire: Object.freeze(retire as string[]),
  });
}

function implementationChangeFromRow(row: ImplementationChangeRequestRow): ImplementationChangeRequest {
  return Object.freeze({
    id: row.id,
    projectId: row.project_id,
    conversationId: row.conversation_id,
    state: row.state as ImplementationChangeRequest["state"],
    summary: row.summary,
    implementationBrief: row.implementation_brief,
    baseDocumentRevision: Number(row.base_document_revision),
    documentPatch: Object.freeze({ ...row.project_document_patch }),
    e2eGoalDelta: parseStoredE2eGoalDelta(row.e2e_goal_delta),
    explicitExecution: row.explicit_execution,
    createdAt: row.created_at,
  });
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
}

function workspaceFromRow(row: WorkspaceRow): WorkspaceSummary {
  return Object.freeze({ id: row.id, name: row.name, createdAt: row.created_at });
}

function workspaceSteamSettingsFromRow(row: WorkspaceSteamSettingsRow): StoredWorkspaceSteamSettings {
  return Object.freeze({
    builderUsername: row.builder_username,
    credentialMask: row.credential_mask,
    credentialSecretRef: row.credential_secret_ref,
    credentialFingerprint: row.credential_fingerprint,
    credentialVersion: row.credential_version,
    revision: Number(row.revision),
    updatedAt: row.updated_at,
  });
}

function projectSteamSettingsFromRow(row: ProjectSteamSettingsRow): ProjectSteamSettings {
  return Object.freeze({
    projectId: row.project_id,
    appId: row.app_id,
    depots: Object.freeze({
      ...(row.depot_linux ? { linux: row.depot_linux } : {}),
      ...(row.depot_windows ? { windows: row.depot_windows } : {}),
      ...(row.depot_macos ? { macos: row.depot_macos } : {}),
    }),
    testBranch: row.test_branch,
    revision: Number(row.revision),
    updatedAt: row.updated_at,
  });
}

function steamReleaseSelectSql(where: string, forUpdate = false): string {
  return `SELECT release.id::text, release.project_id::text, release.workflow_id::text,
                 workflow.iteration_number, release.version, release.release_number::text,
                 release.channel::text, release.target_branch, release.state::text,
                 release.steam_build_id, release.failure_message, release.created_at::text,
                 release.uploaded_at::text, release.live_at::text
            FROM deviludo.steam_releases release
            JOIN deviludo.workflow_instances workflow
              ON workflow.workspace_id = release.workspace_id AND workflow.id = release.workflow_id
           WHERE release.workspace_id = $1::uuid AND release.project_id = $2::uuid AND ${where}
           ${forUpdate ? "FOR UPDATE OF release" : ""}`;
}

function steamReleaseFromRow(row: SteamReleaseRow): SteamRelease {
  return Object.freeze({
    id: row.id,
    projectId: row.project_id,
    workflowId: row.workflow_id,
    iterationNumber: row.iteration_number,
    version: row.version,
    releaseNumber: Number(row.release_number),
    channel: row.channel,
    targetBranch: row.target_branch,
    state: row.state,
    steamBuildId: row.steam_build_id,
    failureMessage: row.failure_message,
    createdAt: row.created_at,
    uploadedAt: row.uploaded_at,
    liveAt: row.live_at,
  });
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

function initialIterationState(): Readonly<Record<string, unknown>> {
  return Object.freeze({
    number: 1,
    parentWorkflowId: null,
    baseSourceRevision: null,
    baseDocumentRevision: 1,
    approvedDocumentRevision: null,
  });
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
