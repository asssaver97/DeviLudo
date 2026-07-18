import { randomUUID } from "node:crypto";
import { sha256Canonical } from "../../runner-control/src/canonical";
import type { SourceBaselineReceipt } from "../../scm-proxy/src/source-baseline-contracts";
import type { PostgresWorkflowClient, PostgresWorkflowPool } from "../../temporal/src/postgres-inbox";
import { resolveCatalogConfiguration, type ResolvedProfileConfiguration } from "./catalog";
import type {
  AgentConfigurationClaim,
  AgentConfigurationLock,
  AgentConfigurationStore,
  AgentConfigurationWork,
  LockedAgentConfiguration,
  TargetPlatform,
} from "./contracts";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SHA1 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;

type CandidateRow = {
  action_id: string;
  tenant_id: string;
  project_id: string;
  workflow_id: string;
  action_status: "WAITING" | "COMPLETED";
  binding: unknown;
  resolution_state: "PENDING" | "CLAIMED" | "LOCKED" | null;
  claim_token: string | null;
  source_baseline_receipt_id: string | null;
  run_id: string | null;
  resolution_digest: string | null;
};

type AuthorityRow = CandidateRow & {
  spec_revision_id: string;
  spec_state: string;
  spec_digest: string;
  test_plan_revision_id: string;
  test_plan_state: string;
  test_plan_digest: string;
  bound_test_plan_digest: string;
  target_matrix: string[];
  runner_toolchain_revision_id: string;
  runner_toolchain_digest: string;
  actual_runner_toolchain_digest: string;
  baseline_operation_key: string;
  baseline_repository_binding_id: string;
  baseline_default_branch: string;
  baseline_commit_sha: string;
  baseline_source_digest: string;
  baseline_observed_at: string | Date;
  baseline_spec_revision_id: string;
  baseline_test_plan_revision_id: string;
  baseline_spec_approval_receipt_id: string;
  catalog_revision: string | number;
  catalog_payload: unknown;
};

type RunRow = {
  id: string;
  state: string;
  resolution_digest: string;
  configuration_lock: unknown;
};
type ProviderProjectionRow = { provider_revision_id: string };
type RunAuthorizationRow = { run_id: string };

/** RLS authority that atomically snapshots moving administrator defaults into one AgentRun. */
export class PostgresAgentConfigurationStore implements AgentConfigurationStore {
  constructor(
    private readonly pool: PostgresWorkflowPool,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async claimNext(tenantId: string): Promise<AgentConfigurationWork | null> {
    if (!UUID.test(tenantId)) invalid();
    const claimToken = randomUUID();
    return this.#transaction(tenantId, async (client) => {
      const candidate = await client.query<CandidateRow>(
        `SELECT action.id::text AS action_id, action.tenant_id::text,
                action.project_id::text, action.workflow_id,
                action.status AS action_status, action.binding,
                resolution.state AS resolution_state,
                resolution.claim_token::text,
                resolution.source_baseline_receipt_id::text,
                resolution.run_id::text, resolution.resolution_digest
           FROM deviludo.workflow_control_actions action
           LEFT JOIN deviludo.agent_configuration_resolutions resolution
             ON resolution.tenant_id = action.tenant_id
            AND resolution.project_id = action.project_id
            AND resolution.workflow_id = action.workflow_id
            AND resolution.action_id = action.id
          WHERE action.tenant_id = $1::uuid
            AND action.operation = 'RESOLVE_AGENT_RUN_CONFIGURATION'
            AND (
              (action.status = 'WAITING' AND (
                resolution.action_id IS NULL OR resolution.state = 'PENDING'
                OR (resolution.state = 'CLAIMED' AND resolution.claim_expires_at <= now())
                OR resolution.state = 'LOCKED'
              ))
              OR (action.status = 'COMPLETED'
                AND action.completion_source = 'AGENT_CONFIGURATION_SERVICE'
                AND resolution.state = 'LOCKED')
            )
          ORDER BY action.created_at ASC
          LIMIT 1 FOR UPDATE OF action SKIP LOCKED`,
        [tenantId],
      );
      if (candidate.rows.length === 0) return null;
      const action = candidate.rows[0]!;
      const authority = actionBinding(action);
      await client.query(
        `INSERT INTO deviludo.agent_configuration_resolutions
          (tenant_id, project_id, workflow_id, action_id, spec_revision_id,
           test_plan_revision_id, spec_approval_receipt_id, state)
         VALUES ($1::uuid, $2::uuid, $3, $4::uuid, $5::uuid, $6::uuid, $7, 'PENDING')
         ON CONFLICT (tenant_id, action_id) DO NOTHING`,
        [authority.tenantId, authority.projectId, authority.workflowId, authority.actionId,
          authority.specRevisionId, authority.testPlanRevisionId, authority.specApprovalReceiptId],
      );
      const selected = await client.query<CandidateRow>(
        `SELECT resolution.action_id::text, resolution.tenant_id::text,
                resolution.project_id::text, resolution.workflow_id,
                action.status AS action_status, action.binding,
                resolution.state AS resolution_state,
                resolution.claim_token::text,
                resolution.source_baseline_receipt_id::text,
                resolution.run_id::text, resolution.resolution_digest
           FROM deviludo.agent_configuration_resolutions resolution
           JOIN deviludo.workflow_control_actions action
             ON action.tenant_id = resolution.tenant_id
            AND action.project_id = resolution.project_id
            AND action.workflow_id = resolution.workflow_id
            AND action.id = resolution.action_id
          WHERE resolution.tenant_id = $1::uuid AND resolution.action_id = $2::uuid
          FOR UPDATE OF resolution`,
        [tenantId, authority.actionId],
      );
      const row = selected.rows[0];
      if (selected.rows.length !== 1 || !row) conflict();
      const current = actionBinding(row);
      assertSameAuthority(authority, current);
      if (row.resolution_state === "LOCKED") return lockedFromRow(row, current);
      const claimed = await client.query(
        `UPDATE deviludo.agent_configuration_resolutions
            SET state = 'CLAIMED', claim_token = $3::uuid,
                claim_expires_at = now() + interval '2 minutes'
          WHERE tenant_id = $1::uuid AND action_id = $2::uuid
            AND (state = 'PENDING' OR (state = 'CLAIMED' AND claim_expires_at <= now()))
        RETURNING action_id`,
        [tenantId, authority.actionId, claimToken],
      );
      if (claimed.rowCount !== 1) return null;
      return Object.freeze({ kind: "CLAIMED", ...authority, claimToken });
    });
  }

  async lock(claim: AgentConfigurationClaim, baseline: SourceBaselineReceipt): Promise<LockedAgentConfiguration> {
    validateClaim(claim);
    assertBaselineClaim(baseline, claim);
    return this.#transaction(claim.tenantId, async (client) => {
      const selected = await client.query<AuthorityRow>(
        `SELECT action.id::text AS action_id, action.tenant_id::text,
                action.project_id::text, action.workflow_id,
                action.status AS action_status, action.binding,
                resolution.state AS resolution_state, resolution.claim_token::text,
                resolution.source_baseline_receipt_id::text,
                resolution.run_id::text, resolution.resolution_digest,
                spec.id::text AS spec_revision_id, spec.state AS spec_state,
                spec.payload_digest AS spec_digest,
                plan.id::text AS test_plan_revision_id, plan.state AS test_plan_state,
                plan.payload_digest AS test_plan_digest,
                binding.test_plan_digest AS bound_test_plan_digest,
                binding.target_matrix,
                binding.runner_toolchain_revision_id::text,
                binding.runner_toolchain_digest,
                toolchain.payload_digest AS actual_runner_toolchain_digest,
                baseline.operation_key AS baseline_operation_key,
                baseline.repository_binding_id::text AS baseline_repository_binding_id,
                baseline.default_branch AS baseline_default_branch,
                baseline.commit_sha AS baseline_commit_sha,
                baseline.source_digest AS baseline_source_digest,
                baseline.observed_at AS baseline_observed_at,
                baseline.spec_revision_id::text AS baseline_spec_revision_id,
                baseline.test_plan_revision_id::text AS baseline_test_plan_revision_id,
                baseline.spec_approval_receipt_id AS baseline_spec_approval_receipt_id,
                catalog.revision AS catalog_revision, catalog.payload AS catalog_payload
           FROM deviludo.agent_configuration_resolutions resolution
           JOIN deviludo.workflow_control_actions action
             ON action.tenant_id = resolution.tenant_id
            AND action.project_id = resolution.project_id
            AND action.workflow_id = resolution.workflow_id
            AND action.id = resolution.action_id
           JOIN deviludo.immutable_revisions spec
             ON spec.tenant_id = resolution.tenant_id
            AND spec.project_id = resolution.project_id
            AND spec.id = resolution.spec_revision_id
            AND spec.aggregate_type = 'GAME_SPEC'
           JOIN deviludo.immutable_revisions plan
             ON plan.tenant_id = resolution.tenant_id
            AND plan.project_id = resolution.project_id
            AND plan.id = resolution.test_plan_revision_id
            AND plan.aggregate_type = 'TEST_PLAN'
           JOIN deviludo.approved_test_plan_bindings binding
             ON binding.tenant_id = resolution.tenant_id
            AND binding.project_id = resolution.project_id
            AND binding.spec_revision_id = spec.id
            AND binding.test_plan_revision_id = plan.id
           JOIN deviludo.runner_toolchain_revisions toolchain
             ON toolchain.tenant_id = binding.tenant_id
            AND toolchain.project_id = binding.project_id
            AND toolchain.id = binding.runner_toolchain_revision_id
           JOIN deviludo.github_source_baseline_receipts baseline
             ON baseline.tenant_id = resolution.tenant_id
            AND baseline.project_id = resolution.project_id
            AND baseline.id = $4::uuid
            AND baseline.spec_revision_id = spec.id
            AND baseline.test_plan_revision_id = plan.id
            AND baseline.spec_approval_receipt_id = resolution.spec_approval_receipt_id
           CROSS JOIN deviludo.admin_catalog_state catalog
          WHERE resolution.tenant_id = $1::uuid AND resolution.action_id = $2::uuid
            AND resolution.state = 'CLAIMED' AND resolution.claim_token = $3::uuid
            AND resolution.claim_expires_at > now()
          FOR UPDATE OF resolution, action
          FOR SHARE OF spec, plan, binding, toolchain, baseline, catalog`,
        [claim.tenantId, claim.actionId, claim.claimToken, baseline.sourceBaselineReceiptId],
      );
      const row = selected.rows[0];
      if (selected.rows.length !== 1 || !row) conflict();
      const authority = actionBinding(row);
      assertSameAuthority(claim, authority);
      assertAuthority(row, baseline);
      const catalog = resolveCatalogConfiguration({
        revision: row.catalog_revision,
        payload: row.catalog_payload,
        tenantId: claim.tenantId,
        projectId: claim.projectId,
      });
      const resolvedAt = this.now();
      if (!Number.isFinite(resolvedAt.getTime())) invalid();
      const authorizationExpiresAt = new Date(resolvedAt.getTime() + catalog.budget.timeoutSeconds * 1_000);
      const targetMatrix = targetPlatforms(row.target_matrix);
      const lockWithoutDigest = Object.freeze({
        profileRevisionId: catalog.profileRevisionId,
        profileSource: catalog.profileSource,
        installationId: catalog.installationId,
        workerPool: catalog.workerPool,
        imageDigest: catalog.imageDigest,
        agentVersionId: catalog.agentVersionId,
        exactAgentVersion: catalog.exactAgentVersion,
        agentVersionSourceDigest: catalog.agentVersionSourceDigest,
        adapterVersion: catalog.adapterVersion,
        workerImageId: catalog.workerImageId,
        buildReceiptId: catalog.buildReceiptId,
        buildReceiptDigest: catalog.buildReceiptDigest,
        agent: catalog.agent,
        providerRevisionId: catalog.providerRevisionId,
        providerProtocol: catalog.providerProtocol,
        providerBaseUrl: catalog.providerBaseUrl,
        providerApprovedPorts: catalog.providerApprovedPorts,
        providerAuthentication: catalog.providerAuthentication,
        providerPricing: catalog.providerPricing,
        providerGovernance: catalog.providerGovernance,
        inferenceAuthorizationExpiresAt: authorizationExpiresAt.toISOString(),
        modelRoles: catalog.modelRoles,
        credentialVersionId: catalog.credentialVersionId,
        budget: catalog.budget,
        fallback: catalog.fallback === null ? null : Object.freeze({
          ...catalog.fallback,
          inferenceAuthorizationExpiresAt: new Date(
            resolvedAt.getTime() + catalog.fallback.budget.timeoutSeconds * 1_000,
          ).toISOString(),
        }),
        specRevisionId: row.spec_revision_id,
        specDigest: row.spec_digest,
        testPlanRevisionId: row.test_plan_revision_id,
        testPlanDigest: row.test_plan_digest,
        specApprovalReceiptId: claim.specApprovalReceiptId,
        runnerToolchainRevisionId: row.runner_toolchain_revision_id,
        runnerToolchainDigest: row.runner_toolchain_digest,
        sourceBaselineReceiptId: baseline.sourceBaselineReceiptId,
        commitSha: row.baseline_commit_sha,
        sourceDigest: row.baseline_source_digest,
        targetMatrix,
        adminCatalogRevision: catalog.catalogRevision,
        resolvedAt: resolvedAt.toISOString(),
      });
      const resolutionDigest = sha256Canonical(lockWithoutDigest);
      const configurationLock: AgentConfigurationLock = Object.freeze({ ...lockWithoutDigest, resolutionDigest });
      await ensureProviderProjection(client, claim.tenantId, catalog);
      if (catalog.fallback !== null) await ensureProviderProjection(client, claim.tenantId, catalog.fallback);
      const runId = randomUUID();
      await client.query(
        `INSERT INTO deviludo.agent_runs
          (id, tenant_id, project_id, iteration_id, idempotency_key, state,
           profile_revision_id, installation_id, image_digest, adapter_version,
           exact_agent_version, provider_revision_id, model,
           credential_version_id, configuration_lock, resolution_digest,
           spec_revision_id, test_plan_revision_id, spec_approval_receipt_id,
           source_baseline_receipt_id)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, 'QUEUED',
                 $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15,
                 $16::uuid, $17::uuid, $18, $19::uuid)
         ON CONFLICT (tenant_id, idempotency_key) DO NOTHING`,
        [runId, claim.tenantId, claim.projectId, claim.actionId,
          `agent-config:${claim.actionId}`, catalog.profileRevisionId,
          catalog.installationId, catalog.imageDigest, catalog.adapterVersion,
          catalog.exactAgentVersion, catalog.providerRevisionId,
          catalog.modelRoles.primaryModel, catalog.credentialVersionId,
          JSON.stringify(configurationLock), resolutionDigest, claim.specRevisionId,
          claim.testPlanRevisionId, claim.specApprovalReceiptId, baseline.sourceBaselineReceiptId],
      );
      const runResult = await client.query<RunRow>(
        `SELECT id::text, state, resolution_digest, configuration_lock
           FROM deviludo.agent_runs
          WHERE tenant_id = $1::uuid AND idempotency_key = $2
          FOR SHARE`,
        [claim.tenantId, `agent-config:${claim.actionId}`],
      );
      const run = runResult.rows[0];
      if (runResult.rows.length !== 1 || !run || !UUID.test(run.id) || run.state !== "QUEUED"
        || run.resolution_digest !== resolutionDigest
        || sha256Canonical(record(run.configuration_lock)) !== sha256Canonical(configurationLock)) conflict();
      const authorizationModels = [...new Set(Object.values(catalog.modelRoles))];
      const authorizationBudget = Object.freeze({ maxCostUsd: catalog.budget.maxUsd });
      const authorizationNonce = randomUUID();
      await client.query(
        `INSERT INTO deviludo.inference_run_authorizations
          (run_id, tenant_id, project_id, profile_revision_id,
           provider_revision_id, credential_version_id, models, budget,
           nonce, state, expires_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7::text[],
                 $8::jsonb, $9, 'ACTIVE', $10::timestamptz)
         ON CONFLICT (tenant_id, run_id) DO NOTHING`,
        [run.id, claim.tenantId, claim.projectId, catalog.profileRevisionId,
          catalog.providerRevisionId, catalog.credentialVersionId,
          authorizationModels, JSON.stringify(authorizationBudget),
          authorizationNonce, authorizationExpiresAt.toISOString()],
      );
      const authorization = await client.query<RunAuthorizationRow>(
        `SELECT run_id::text
           FROM deviludo.inference_run_authorizations
          WHERE tenant_id = $2::uuid AND project_id = $3::uuid
            AND run_id = $1::uuid AND profile_revision_id = $4
            AND provider_revision_id = $5 AND credential_version_id = $6
            AND models = $7::text[] AND budget = $8::jsonb AND nonce = $9
            AND state = 'ACTIVE' AND expires_at = $10::timestamptz
          FOR SHARE`,
        [run.id, claim.tenantId, claim.projectId, catalog.profileRevisionId,
          catalog.providerRevisionId, catalog.credentialVersionId,
          authorizationModels, JSON.stringify(authorizationBudget),
          authorizationNonce, authorizationExpiresAt.toISOString()],
      );
      if (authorization.rows.length !== 1 || authorization.rows[0]?.run_id !== run.id) conflict();
      const updated = await client.query(
        `UPDATE deviludo.agent_configuration_resolutions
            SET state = 'LOCKED', claim_token = NULL, claim_expires_at = NULL,
                source_baseline_receipt_id = $4::uuid, run_id = $5::uuid,
                resolution_digest = $6, locked_at = now()
          WHERE tenant_id = $1::uuid AND action_id = $2::uuid
            AND state = 'CLAIMED' AND claim_token = $3::uuid
        RETURNING action_id`,
        [claim.tenantId, claim.actionId, claim.claimToken,
          baseline.sourceBaselineReceiptId, run.id, resolutionDigest],
      );
      if (updated.rowCount !== 1) conflict();
      return Object.freeze({
        kind: "LOCKED", ...authority,
        sourceBaselineReceiptId: baseline.sourceBaselineReceiptId,
        runId: run.id,
        resolutionDigest,
      });
    });
  }

  async complete(work: LockedAgentConfiguration, outboxId: string): Promise<void> {
    validateLocked(work);
    if (!UUID.test(outboxId)) invalid();
    await this.#transaction(work.tenantId, async (client) => {
      const completed = await client.query(
        `UPDATE deviludo.agent_configuration_resolutions resolution
            SET state = 'COMPLETED', completion_outbox_id = $5::uuid,
                completed_at = now()
           FROM deviludo.workflow_control_actions action
          WHERE resolution.tenant_id = $1::uuid AND resolution.action_id = $2::uuid
            AND resolution.state = 'LOCKED' AND resolution.run_id = $3::uuid
            AND resolution.resolution_digest = $4
            AND action.tenant_id = resolution.tenant_id
            AND action.project_id = resolution.project_id
            AND action.workflow_id = resolution.workflow_id
            AND action.id = resolution.action_id AND action.status = 'COMPLETED'
            AND action.completion_source = 'AGENT_CONFIGURATION_SERVICE'
            AND action.completion_receipt_id = resolution.resolution_digest
            AND action.completion_signal_id = $6
        RETURNING resolution.action_id`,
        [work.tenantId, work.actionId, work.runId, work.resolutionDigest, outboxId,
          signalId(work.resolutionDigest)],
      );
      if (completed.rowCount !== 1) conflict();
    });
  }

  async release(claim: AgentConfigurationClaim): Promise<void> {
    validateClaim(claim);
    await this.#transaction(claim.tenantId, async (client) => {
      await client.query(
        `UPDATE deviludo.agent_configuration_resolutions
            SET state = 'PENDING', claim_token = NULL, claim_expires_at = NULL
          WHERE tenant_id = $1::uuid AND action_id = $2::uuid
            AND state = 'CLAIMED' AND claim_token = $3::uuid`,
        [claim.tenantId, claim.actionId, claim.claimToken],
      );
    });
  }

  async probe(): Promise<void> {
    const client = await this.pool.connect();
    try { await client.query("SELECT 1 AS agent_configuration_probe"); }
    finally { client.release(); }
  }

  async #transaction<T>(tenantId: string, operation: (client: PostgresWorkflowClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { /* preserve authority error */ }
      throw error;
    } finally { client.release(); }
  }
}

async function ensureProviderProjection(
  client: PostgresWorkflowClient,
  tenantId: string,
  configuration: ResolvedProfileConfiguration,
): Promise<void> {
  const providerModels = JSON.stringify(configuration.modelRoles);
  const providerPricing = configuration.providerPricing;
  const values = [tenantId, configuration.providerRevisionId, configuration.agent,
    configuration.providerProtocol, configuration.providerBaseUrl,
    configuration.providerApprovedPorts, configuration.providerAuthentication,
    providerModels, configuration.credentialVersionId,
    providerPricing.inputUsdPerMillionTokens,
    providerPricing.outputUsdPerMillionTokens] as const;
  await client.query(
    `INSERT INTO deviludo.inference_provider_revisions
      (provider_revision_id, tenant_id, project_id, source_revision_id,
       agent, protocol, base_url, approved_ports, authentication, models,
       credential_version_id, input_usd_per_million_tokens,
       output_usd_per_million_tokens, state)
     VALUES ($2, $1::uuid, NULL, $2, $3, $4, $5, $6::integer[], $7,
             $8::jsonb, $9, $10::numeric, $11::numeric, 'ACTIVE')
     ON CONFLICT (tenant_id, provider_revision_id) DO NOTHING`,
    values,
  );
  const projection = await client.query<ProviderProjectionRow>(
    `SELECT provider_revision_id
       FROM deviludo.inference_provider_revisions
      WHERE tenant_id = $1::uuid AND provider_revision_id = $2
        AND project_id IS NULL AND source_revision_id = $2
        AND agent = $3 AND protocol = $4 AND base_url = $5
        AND approved_ports = $6::integer[] AND authentication = $7
        AND models = $8::jsonb AND credential_version_id = $9
        AND input_usd_per_million_tokens = $10::numeric
        AND output_usd_per_million_tokens = $11::numeric
        AND state = 'ACTIVE'
      FOR SHARE`,
    values,
  );
  if (projection.rows.length !== 1
    || projection.rows[0]?.provider_revision_id !== configuration.providerRevisionId) conflict();
}

export function agentConfigurationSignalId(resolutionDigest: string): string { return signalId(resolutionDigest); }

function actionBinding(row: CandidateRow) {
  const binding = record(row.binding);
  if (!UUID.test(row.action_id) || !UUID.test(row.tenant_id) || !UUID.test(row.project_id)
    || row.workflow_id !== `delivery-${row.project_id}` || binding.state !== "RESOLVING_AGENT_CONFIGURATION") invalid();
  const specRevisionId = uuid(binding.specRevisionId);
  const testPlanRevisionId = uuid(binding.testPlanRevisionId);
  const specApprovalReceiptId = match(binding.specApprovalReceiptId, SHA256);
  return Object.freeze({
    tenantId: row.tenant_id,
    projectId: row.project_id,
    workflowId: row.workflow_id,
    actionId: row.action_id,
    specRevisionId,
    testPlanRevisionId,
    specApprovalReceiptId,
  });
}
function lockedFromRow(row: CandidateRow, authority: ReturnType<typeof actionBinding>): LockedAgentConfiguration {
  if (!row.source_baseline_receipt_id || !row.run_id || !row.resolution_digest) conflict();
  return Object.freeze({
    kind: "LOCKED", ...authority,
    sourceBaselineReceiptId: uuid(row.source_baseline_receipt_id),
    runId: uuid(row.run_id),
    resolutionDigest: match(row.resolution_digest, SHA256),
  });
}
function assertAuthority(row: AuthorityRow, baseline: SourceBaselineReceipt): void {
  if (row.action_status !== "WAITING" || row.resolution_state !== "CLAIMED"
    || row.spec_state !== "APPROVED" || row.test_plan_state !== "FROZEN"
    || row.spec_revision_id !== baseline.specRevisionId
    || row.test_plan_revision_id !== baseline.testPlanRevisionId
    || !SHA256.test(row.spec_digest) || !SHA256.test(row.test_plan_digest)
    || row.bound_test_plan_digest !== row.test_plan_digest
    || row.runner_toolchain_digest !== row.actual_runner_toolchain_digest
    || !UUID.test(row.runner_toolchain_revision_id) || !SHA256.test(row.runner_toolchain_digest)
    || row.baseline_operation_key !== baseline.operationKey
    || row.baseline_repository_binding_id !== baseline.repositoryBindingId
    || row.baseline_default_branch !== baseline.defaultBranch
    || row.baseline_commit_sha !== baseline.commitSha
    || row.baseline_source_digest !== baseline.sourceDigest
    || row.baseline_spec_revision_id !== baseline.specRevisionId
    || row.baseline_test_plan_revision_id !== baseline.testPlanRevisionId
    || row.baseline_spec_approval_receipt_id !== baseline.specApprovalReceiptId
    || new Date(row.baseline_observed_at).toISOString() !== baseline.observedAt) conflict();
}
function assertBaselineClaim(baseline: SourceBaselineReceipt, claim: AgentConfigurationClaim): void {
  if (baseline.replayed !== false && baseline.replayed !== true) invalid();
  if (baseline.tenantId !== claim.tenantId || baseline.projectId !== claim.projectId
    || baseline.workflowId !== claim.workflowId || baseline.specRevisionId !== claim.specRevisionId
    || baseline.testPlanRevisionId !== claim.testPlanRevisionId
    || baseline.specApprovalReceiptId !== claim.specApprovalReceiptId
    || !UUID.test(baseline.sourceBaselineReceiptId) || !UUID.test(baseline.repositoryBindingId)
    || !SHA1.test(baseline.commitSha) || !SHA256.test(baseline.sourceDigest)
    || !Number.isFinite(Date.parse(baseline.observedAt))) invalid();
}
function assertSameAuthority(left: ReturnType<typeof actionBinding> | AgentConfigurationClaim, right: ReturnType<typeof actionBinding>): void {
  if (left.tenantId !== right.tenantId || left.projectId !== right.projectId
    || left.workflowId !== right.workflowId || left.actionId !== right.actionId
    || left.specRevisionId !== right.specRevisionId || left.testPlanRevisionId !== right.testPlanRevisionId
    || left.specApprovalReceiptId !== right.specApprovalReceiptId) conflict();
}
function targetPlatforms(value: string[]): readonly TargetPlatform[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 3 || new Set(value).size !== value.length
    || value.some((item) => item !== "linux" && item !== "macos" && item !== "windows")
    || JSON.stringify([...value].sort()) !== JSON.stringify(value)) invalid();
  return Object.freeze([...value]) as readonly TargetPlatform[];
}
function validateClaim(value: AgentConfigurationClaim): void {
  if (value.kind !== "CLAIMED" || !UUID.test(value.claimToken)) invalid();
  validateAuthority(value);
}
function validateLocked(value: LockedAgentConfiguration): void {
  if (value.kind !== "LOCKED" || !UUID.test(value.sourceBaselineReceiptId)
    || !UUID.test(value.runId) || !SHA256.test(value.resolutionDigest)) invalid();
  validateAuthority(value);
}
function validateAuthority(value: Omit<AgentConfigurationClaim, "kind" | "claimToken">): void {
  if (!UUID.test(value.tenantId) || !UUID.test(value.projectId) || !UUID.test(value.actionId)
    || value.workflowId !== `delivery-${value.projectId}` || !UUID.test(value.specRevisionId)
    || !UUID.test(value.testPlanRevisionId) || !SHA256.test(value.specApprovalReceiptId)) invalid();
}
function signalId(digest: string): string {
  if (!SHA256.test(digest)) invalid();
  return `run-configuration-locked-${digest}`;
}
function record(value: unknown): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as Readonly<Record<string, unknown>>;
}
function uuid(value: unknown): string { return match(value, UUID); }
function match(value: unknown, pattern: RegExp): string {
  if (typeof value !== "string" || !pattern.test(value)) invalid();
  return value;
}
function invalid(): never { throw new Error("Agent configuration binding is invalid"); }
function conflict(): never { throw new Error("Agent configuration authority conflicts with persisted state"); }
