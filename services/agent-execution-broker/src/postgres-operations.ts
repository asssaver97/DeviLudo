import { randomUUID } from "node:crypto";
import { sha256Canonical } from "../../runner-control/src/canonical";
import { validateAgentFailureDiagnostic } from "../../../lib/agent/failure-diagnostics";
import { isAdapterVersionAttested, isBuiltInAdapterVersion } from "../../../lib/agent/adapter-registry";
import type { PostgresWorkflowClient, PostgresWorkflowPool } from "../../temporal/src/postgres-inbox";
import type { AgentVersionAttestationLock } from "../../agent-configuration/src/contracts";
import type { AgentExecutionRequest, AgentExecutionStatus, LockedAgentExecution } from "./contracts";
import { parseAgentExecutionRequest, validateAgentExecutionStatus, validateAuthoritativeResult } from "./contracts";
import {
  AgentProviderUnavailable,
  type AgentExecutionOperationPersistence,
} from "./operations";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_ATTESTATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
type RepairPlatform = NonNullable<LockedAgentExecution["repairContext"]>["failedPlatforms"][number];

type AuthorityRow = {
  id: string;
  tenant_id: string;
  project_id: string;
  state: string;
  profile_revision_id: string;
  installation_id: string;
  image_digest: string;
  adapter_version: string;
  exact_agent_version: string;
  provider_revision_id: string;
  model: string;
  credential_version_id: string;
  resolution_digest: string;
  configuration_lock: unknown;
  spec_revision_id: string;
  test_plan_revision_id: string;
  source_baseline_receipt_id: string;
  agent_version_attestation_required: boolean;
  authorization_profile_revision_id: string;
  authorization_provider_revision_id: string;
  authorization_credential_version_id: string;
  authorization_models: string[];
  authorization_budget: unknown;
  authorization_nonce: string;
  authorization_state: string;
  authorization_expires_at: string;
  provider_state: string;
  failover_from_profile_revision_id: string | null;
  failover_from_provider_revision_id: string | null;
  failover_to_profile_revision_id: string | null;
  failover_to_provider_revision_id: string | null;
  failover_to_credential_version_id: string | null;
  failover_to_models: string[] | null;
  failover_to_budget: unknown | null;
  failover_authorization_nonce: string | null;
  failover_authorization_expires_at: string | null;
};

type OperationRow = {
  tenant_id: string;
  project_id: string;
  run_id: string;
  operation_key: string;
  request_digest: string;
  provider_revision_id: string;
  request_payload: unknown;
  state: string;
  attempt_count: number;
  claim_token: string | null;
  claim_expires_at: string | null;
  attempt_id: string | null;
  receipt_payload: unknown | null;
};

/** PostgreSQL + RLS is the authority for every lock, Provider and lease transition. */
export class PostgresAgentExecutionOperations implements AgentExecutionOperationPersistence {
  constructor(private readonly pool: PostgresWorkflowPool) {}

  async reserve(input: Parameters<AgentExecutionOperationPersistence["reserve"]>[0]) {
    const request = parseAgentExecutionRequest(input.request);
    validSpiffe(input.submitterSpiffeId);
    validTime(input.createdAt);
    const outcome = await this.#transaction(request.tenantId, async (client) => {
      let authority = await selectAuthority(client, request.tenantId, request.projectId, request.lockedRunConfigurationId, "FOR UPDATE OF run");
      let lock = parseAuthority(authority, request);
      if (!providerAvailable(authority, input.createdAt)) {
        authority = await activateLockedFallback(client, authority, request, input.createdAt);
        lock = parseAuthority(authority, request);
      }
      const available = providerAvailable(authority, input.createdAt);
      await client.query(
        `INSERT INTO deviludo.agent_execution_operations
          (tenant_id, project_id, run_id, operation_key, request_digest,
           workflow_id, provider_revision_id, request_payload, state,
           submitter_spiffe_id, available_at, created_at, updated_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7,
                 $8::jsonb, $9, $10, $11::timestamptz, $11::timestamptz, $11::timestamptz)
         ON CONFLICT (tenant_id, operation_key) DO NOTHING`,
        [request.tenantId, request.projectId, request.lockedRunConfigurationId,
          request.operationKey, request.requestDigest, request.workflowId,
          authority.provider_revision_id, JSON.stringify(request), available ? "QUEUED" : "WAITING_PROVIDER",
          input.submitterSpiffeId, input.createdAt],
      );
      let operation = await selectOperation(client, request.tenantId, request.lockedRunConfigurationId);
      assertOperationBinding(operation, request, authority.provider_revision_id);
      if (!available) {
        await markProviderWait(client, request.tenantId, request.lockedRunConfigurationId, input.createdAt);
        return Object.freeze({ unavailableProviderRevisionId: lock.providerRevisionId });
      }
      if (operation.state === "WAITING_PROVIDER") {
        await client.query(
          `UPDATE deviludo.agent_execution_operations
              SET state = 'QUEUED', retry_at = NULL, updated_at = $3::timestamptz
            WHERE tenant_id = $1::uuid AND run_id = $2::uuid AND state = 'WAITING_PROVIDER'`,
          [request.tenantId, request.lockedRunConfigurationId, input.createdAt],
        );
        await client.query(
          `UPDATE deviludo.agent_runs SET state = 'QUEUED'
            WHERE tenant_id = $1::uuid AND project_id = $2::uuid AND id = $3::uuid
              AND state = 'WAITING_PROVIDER'`,
          [request.tenantId, request.projectId, request.lockedRunConfigurationId],
        );
        operation = await selectOperation(client, request.tenantId, request.lockedRunConfigurationId);
        authority = await selectAuthority(client, request.tenantId, request.projectId, request.lockedRunConfigurationId, "FOR SHARE");
        parseAuthority(authority, request);
      }
      return Object.freeze({ created: operation.attempt_count === 0, status: statusFromRow(operation, lock) });
    });
    if ("unavailableProviderRevisionId" in outcome) throw new AgentProviderUnavailable(outcome.unavailableProviderRevisionId);
    return outcome;
  }

  async find(lookup: Parameters<AgentExecutionOperationPersistence["find"]>[0]): Promise<AgentExecutionStatus> {
    if (!UUID.test(lookup.tenantId) || !UUID.test(lookup.runId) || !SHA256.test(lookup.requestDigest)) invalid();
    return this.#transaction(lookup.tenantId, async (client) => {
      const operation = await selectOperation(client, lookup.tenantId, lookup.runId, false);
      if (operation.operation_key !== lookup.operationKey || operation.request_digest !== lookup.requestDigest) invalid();
      const request = parseAgentExecutionRequest(operation.request_payload);
      const authority = await selectAuthority(client, lookup.tenantId, request.projectId, lookup.runId, "FOR SHARE");
      const lock = parseAuthority(authority, request);
      if (operation.state === "WAITING_PROVIDER") throw new AgentProviderUnavailable(lock.providerRevisionId);
      return statusFromRow(operation, lock);
    });
  }

  async claim(input: Parameters<AgentExecutionOperationPersistence["claim"]>[0]) {
    validateLeaseInput(input);
    const outcome = await this.#transaction(input.tenantId, async (client) => {
      const operation = await selectOperation(client, input.tenantId, input.runId);
      const request = parseAgentExecutionRequest(operation.request_payload);
      let authority = await selectAuthority(client, input.tenantId, request.projectId, input.runId, "FOR UPDATE OF run");
      let lock = parseAuthority(authority, request);
      if (!providerAvailable(authority, input.claimedAt)) {
        authority = await activateLockedFallback(client, authority, request, input.claimedAt);
        lock = parseAuthority(authority, request);
      }
      if (!providerAvailable(authority, input.claimedAt)) {
        await markProviderWait(client, input.tenantId, input.runId, input.claimedAt);
        return Object.freeze({ kind: "PROVIDER_UNAVAILABLE" as const, providerRevisionId: lock.providerRevisionId });
      }
      if (["SUCCEEDED", "FAILED", "CANCELLED"].includes(operation.state)) {
        return Object.freeze({ kind: "TERMINAL" as const, status: statusFromRow(operation, lock) });
      }
      if (["PREPARING", "RUNNING"].includes(operation.state)
        && Date.parse(operation.claim_expires_at ?? "") > Date.parse(input.claimedAt)) {
        return Object.freeze({ kind: "BUSY" as const, status: statusFromRow(operation, lock) });
      }
      const attemptId = randomUUID();
      const updated = await client.query<{ attempt_count: number }>(
        `UPDATE deviludo.agent_execution_operations
            SET state = 'RUNNING', claim_token = $3::uuid,
                claim_expires_at = $4::timestamptz, attempt_id = $5::uuid,
                attempt_count = attempt_count + 1, updated_at = $2::timestamptz
          WHERE tenant_id = $1::uuid AND run_id = $6::uuid
            AND state IN ('QUEUED', 'PREPARING', 'RUNNING')
            AND (claim_token IS NULL OR claim_expires_at <= $2::timestamptz)
        RETURNING attempt_count`,
        [input.tenantId, input.claimedAt, input.claimToken, input.claimExpiresAt, attemptId, input.runId],
      );
      const attempt = updated.rows[0]?.attempt_count;
      if (updated.rowCount !== 1 || !Number.isSafeInteger(attempt) || attempt < 1) invalid();
      const run = await client.query(
        `UPDATE deviludo.agent_runs SET state = 'RUNNING'
          WHERE tenant_id = $1::uuid AND project_id = $2::uuid AND id = $3::uuid
            AND state IN ('QUEUED', 'PREPARING', 'RUNNING') RETURNING id`,
        [input.tenantId, request.projectId, input.runId],
      );
      if (run.rowCount !== 1) invalid();
      await appendEvent(client, input.tenantId, request.projectId, input.runId, attemptId, "RUNNING", input.claimedAt,
        { attempt, resolutionDigest: lock.resolutionDigest });
      return Object.freeze({ kind: "ACQUIRED" as const, request, lock, attemptId, attempt });
    });
    if (outcome.kind === "PROVIDER_UNAVAILABLE") throw new AgentProviderUnavailable(outcome.providerRevisionId);
    return outcome;
  }

  async heartbeat(input: Parameters<AgentExecutionOperationPersistence["heartbeat"]>[0]): Promise<void> {
    validateLeaseInput(input);
    await this.#transaction(input.tenantId, async (client) => {
      const updated = await client.query(
        `UPDATE deviludo.agent_execution_operations
            SET claim_expires_at = $4::timestamptz, updated_at = $3::timestamptz
          WHERE tenant_id = $1::uuid AND run_id = $2::uuid AND state = 'RUNNING'
            AND claim_token = $5::uuid AND claim_expires_at > $3::timestamptz`,
        [input.tenantId, input.runId, input.heartbeatAt, input.claimExpiresAt, input.claimToken],
      );
      if (updated.rowCount !== 1) invalid();
    });
  }

  async complete(input: Parameters<AgentExecutionOperationPersistence["complete"]>[0]): Promise<AgentExecutionStatus> {
    validTime(input.completedAt);
    return this.#transaction(input.tenantId, async (client) => {
      const operation = await selectOperation(client, input.tenantId, input.runId);
      const request = parseAgentExecutionRequest(operation.request_payload);
      const authority = await selectAuthority(client, input.tenantId, request.projectId, input.runId, "FOR UPDATE OF run");
      const lock = parseAuthority(authority, request);
      const result = validateAuthoritativeResult(input.result, lock, operation.attempt_id ?? "");
      const receipt = validateAgentExecutionStatus({ status: result.status, runId: input.runId,
        providerRevisionId: lock.providerRevisionId, receipt: input.receipt }, request).receipt;
      if (!receipt) invalid();
      const receiptDigest = sha256Canonical(receipt);
      const updated = await client.query(
        `UPDATE deviludo.agent_execution_operations
            SET state = $4, claim_token = NULL, claim_expires_at = NULL,
                receipt_payload = $5::jsonb, receipt_digest = $6,
                completed_at = $3::timestamptz, updated_at = $3::timestamptz
          WHERE tenant_id = $1::uuid AND run_id = $2::uuid AND state = 'RUNNING'
            AND claim_token = $7::uuid AND claim_expires_at > $3::timestamptz`,
        [input.tenantId, input.runId, input.completedAt, result.status === "COMPLETED" ? "SUCCEEDED" : "FAILED",
          JSON.stringify(receipt), receiptDigest, input.claimToken],
      );
      if (updated.rowCount !== 1) invalid();
      const run = await client.query(
        `UPDATE deviludo.agent_runs SET state = $4
          WHERE tenant_id = $1::uuid AND project_id = $2::uuid AND id = $3::uuid AND state = 'RUNNING'
        RETURNING id`,
        [input.tenantId, request.projectId, input.runId, result.status === "COMPLETED" ? "SUCCEEDED" : "FAILED"],
      );
      if (run.rowCount !== 1) invalid();
      const authorization = await client.query(
        `UPDATE deviludo.inference_run_authorizations SET state = 'COMPLETED'
          WHERE tenant_id = $1::uuid AND project_id = $2::uuid AND run_id = $3::uuid AND state = 'ACTIVE'
        RETURNING run_id`,
        [input.tenantId, request.projectId, input.runId],
      );
      if (authorization.rowCount !== 1) invalid();
      await appendEvent(client, input.tenantId, request.projectId, input.runId, operation.attempt_id as string,
        result.status === "COMPLETED" ? "SUCCEEDED" : "FAILED", input.completedAt,
        { receiptId: receipt.receiptId, receiptDigest });
      return Object.freeze({ status: result.status, runId: input.runId, providerRevisionId: lock.providerRevisionId, receipt });
    });
  }

  async waitForProvider(input: Parameters<AgentExecutionOperationPersistence["waitForProvider"]>[0]): Promise<void> {
    validTime(input.observedAt);
    await this.#transaction(input.tenantId, async (client) => {
      const operation = await selectOperation(client, input.tenantId, input.runId);
      const request = parseAgentExecutionRequest(operation.request_payload);
      const authority = await selectAuthority(client, input.tenantId, request.projectId, input.runId, "FOR SHARE");
      const lock = parseAuthority(authority, request);
      if (lock.providerRevisionId !== input.providerRevisionId || operation.claim_token !== input.claimToken) invalid();
      await markProviderWait(client, input.tenantId, input.runId, input.observedAt, input.claimToken);
    });
  }

  async release(input: Parameters<AgentExecutionOperationPersistence["release"]>[0]): Promise<void> {
    validTime(input.releasedAt); validTime(input.retryAt);
    await this.#transaction(input.tenantId, async (client) => {
      const operation = await selectOperation(client, input.tenantId, input.runId);
      const request = parseAgentExecutionRequest(operation.request_payload);
      const updated = await client.query(
        `UPDATE deviludo.agent_execution_operations
            SET state = 'QUEUED', claim_token = NULL, claim_expires_at = NULL,
                retry_at = $4::timestamptz, available_at = $4::timestamptz,
                updated_at = $3::timestamptz
          WHERE tenant_id = $1::uuid AND run_id = $2::uuid AND state = 'RUNNING' AND claim_token = $5::uuid`,
        [input.tenantId, input.runId, input.releasedAt, input.retryAt, input.claimToken],
      );
      if (updated.rowCount !== 1) invalid();
      await client.query(
        `UPDATE deviludo.agent_runs SET state = 'QUEUED'
          WHERE tenant_id = $1::uuid AND project_id = $2::uuid AND id = $3::uuid AND state = 'RUNNING'`,
        [input.tenantId, request.projectId, input.runId],
      );
    });
  }

  async probe(): Promise<void> {
    const client = await this.pool.connect();
    try { await client.query("SELECT 1 AS agent_execution_broker_probe"); } finally { client.release(); }
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
      try { await client.query("ROLLBACK"); } catch { /* preserve original failure */ }
      throw error;
    } finally { client.release(); }
  }
}

async function selectAuthority(client: PostgresWorkflowClient, tenantId: string, projectId: string, runId: string, lock: string): Promise<AuthorityRow> {
  const result = await client.query<AuthorityRow>(
    `SELECT run.id::text, run.tenant_id::text, run.project_id::text, run.state,
            run.profile_revision_id, run.installation_id, run.image_digest,
            run.adapter_version, run.exact_agent_version, run.provider_revision_id,
            run.model, run.credential_version_id, run.resolution_digest,
            run.configuration_lock, run.spec_revision_id::text,
            run.test_plan_revision_id::text, run.source_baseline_receipt_id::text,
            run.agent_version_attestation_required,
            authorization.profile_revision_id AS authorization_profile_revision_id,
            authorization.provider_revision_id AS authorization_provider_revision_id,
            authorization.credential_version_id AS authorization_credential_version_id,
            authorization.models AS authorization_models,
            authorization.budget AS authorization_budget,
            authorization.nonce AS authorization_nonce,
            authorization.state AS authorization_state,
            authorization.expires_at::text AS authorization_expires_at,
            failover.from_profile_revision_id AS failover_from_profile_revision_id,
            failover.from_provider_revision_id AS failover_from_provider_revision_id,
            failover.to_profile_revision_id AS failover_to_profile_revision_id,
            failover.to_provider_revision_id AS failover_to_provider_revision_id,
            failover.to_credential_version_id AS failover_to_credential_version_id,
            failover.to_models AS failover_to_models,
            failover.to_budget AS failover_to_budget,
            failover.authorization_nonce::text AS failover_authorization_nonce,
            failover.authorization_expires_at::text AS failover_authorization_expires_at,
            provider.state AS provider_state
       FROM deviludo.agent_runs run
       JOIN deviludo.inference_run_authorizations authorization
         ON authorization.tenant_id = run.tenant_id AND authorization.project_id = run.project_id
        AND authorization.run_id = run.id
       LEFT JOIN deviludo.agent_run_provider_failovers failover
         ON failover.tenant_id = run.tenant_id AND failover.project_id = run.project_id
        AND failover.run_id = run.id
       JOIN deviludo.inference_provider_revisions provider
         ON provider.tenant_id = authorization.tenant_id
        AND provider.provider_revision_id = COALESCE(
          failover.to_provider_revision_id, authorization.provider_revision_id
        )
      WHERE run.tenant_id = $1::uuid AND run.project_id = $2::uuid AND run.id = $3::uuid
      ${lock}`,
    [tenantId, projectId, runId],
  );
  if (result.rows.length !== 1 || !result.rows[0]) invalid();
  return result.rows[0];
}

async function selectOperation(client: PostgresWorkflowClient, tenantId: string, runId: string, forUpdate = true): Promise<OperationRow> {
  const result = await client.query<OperationRow>(
    `SELECT tenant_id::text, project_id::text, run_id::text, operation_key,
            request_digest, provider_revision_id, request_payload, state,
            attempt_count, claim_token::text, claim_expires_at::text,
            attempt_id::text, receipt_payload
       FROM deviludo.agent_execution_operations
      WHERE tenant_id = $1::uuid AND run_id = $2::uuid ${forUpdate ? "FOR UPDATE" : ""}`,
    [tenantId, runId],
  );
  if (result.rows.length !== 1 || !result.rows[0]) invalid();
  return result.rows[0];
}

function parseAuthority(row: AuthorityRow, request: AgentExecutionRequest): LockedAgentExecution {
  const value = record(row.configuration_lock);
  const primaryBudget = record(value.budget);
  const primaryModelRoles = parseModelRoles(value.modelRoles);
  if (typeof row.agent_version_attestation_required !== "boolean") invalid();
  const primaryAgentVersionAttestation = parseAgentVersionAttestation(
    value.agentVersionAttestation,
    value.agent,
    value.adapterVersion,
    row.agent_version_attestation_required,
  );
  const fallbackValue = value.fallback === null || value.fallback === undefined
    ? null
    : record(value.fallback);
  const fallbackAgentVersionAttestation = fallbackValue === null
    ? null
    : parseAgentVersionAttestation(
      fallbackValue.agentVersionAttestation,
      fallbackValue.agent,
      fallbackValue.adapterVersion,
      row.agent_version_attestation_required,
    );
  const authBudget = record(row.authorization_budget);
  if (row.id !== request.lockedRunConfigurationId || row.tenant_id !== request.tenantId || row.project_id !== request.projectId
    || !["QUEUED", "PREPARING", "RUNNING", "WAITING_PROVIDER", "SUCCEEDED", "FAILED", "CANCELLED"].includes(row.state)
    || value.resolutionDigest !== row.resolution_digest || sha256Canonical(withoutResolutionDigest(value)) !== row.resolution_digest
    || value.profileRevisionId !== row.profile_revision_id || value.installationId !== row.installation_id
    || value.imageDigest !== row.image_digest || value.adapterVersion !== row.adapter_version
    || value.exactAgentVersion !== row.exact_agent_version || value.providerRevisionId !== row.provider_revision_id
    || value.credentialVersionId !== row.credential_version_id || value.specRevisionId !== row.spec_revision_id
    || value.testPlanRevisionId !== row.test_plan_revision_id || value.sourceBaselineReceiptId !== row.source_baseline_receipt_id
    || row.authorization_profile_revision_id !== row.profile_revision_id
    || row.authorization_provider_revision_id !== row.provider_revision_id
    || row.authorization_credential_version_id !== row.credential_version_id
    || authBudget.maxCostUsd !== primaryBudget.maxUsd || !Array.isArray(row.authorization_models)
    || row.model !== primaryModelRoles.primaryModel
    || !sameStringSet(row.authorization_models, Object.values(primaryModelRoles))) invalid();

  let runtime = value;
  let modelRoles = primaryModelRoles;
  let authorizedModels = row.authorization_models;
  let budget = primaryBudget;
  let authorizationNonce = row.authorization_nonce;
  let authorizationExpiresAt = row.authorization_expires_at;
  let agentVersionAttestation = primaryAgentVersionAttestation;
  const failoverValues = [row.failover_from_profile_revision_id, row.failover_from_provider_revision_id,
    row.failover_to_profile_revision_id, row.failover_to_provider_revision_id,
    row.failover_to_credential_version_id, row.failover_to_models, row.failover_to_budget,
    row.failover_authorization_nonce, row.failover_authorization_expires_at];
  const hasFailover = failoverValues.some((entry) => entry !== null && entry !== undefined);
  if (hasFailover) {
    if (failoverValues.some((entry) => entry === null || entry === undefined)) invalid();
    if (fallbackValue === null) invalid();
    const fallback = fallbackValue;
    const fallbackModels = parseModelRoles(fallback.modelRoles);
    const fallbackBudget = record(fallback.budget);
    const fallbackAuthorizationBudget = record(row.failover_to_budget);
    if (value.profileSource !== `project:${row.project_id}` || fallback.agent !== value.agent
      || row.failover_from_profile_revision_id !== value.profileRevisionId
      || row.failover_from_provider_revision_id !== value.providerRevisionId
      || row.failover_to_profile_revision_id !== fallback.profileRevisionId
      || row.failover_to_provider_revision_id !== fallback.providerRevisionId
      || row.failover_to_credential_version_id !== fallback.credentialVersionId
      || !Array.isArray(row.failover_to_models)
      || !sameStringSet(row.failover_to_models, Object.values(fallbackModels))
      || fallbackAuthorizationBudget.maxCostUsd !== fallbackBudget.maxUsd
      || row.failover_authorization_expires_at !== fallback.inferenceAuthorizationExpiresAt
      || !UUID.test(row.failover_authorization_nonce ?? "")) invalid();
    runtime = fallback;
    modelRoles = fallbackModels;
    authorizedModels = row.failover_to_models;
    budget = fallbackBudget;
    authorizationNonce = string(row.failover_authorization_nonce);
    authorizationExpiresAt = string(row.failover_authorization_expires_at);
    agentVersionAttestation = fallbackAgentVersionAttestation;
  }
  const agent = runtime.agent;
  const protocol = runtime.providerProtocol;
  if ((agent !== "claude-code" && agent !== "codex-cli")
    || (protocol !== "anthropic-messages" && protocol !== "openai-responses")) invalid();
  const repairContext = parseRepairContext(value.repairContext, row.id);
  if ((repairContext === null && request.repairAttempts !== 0)
    || (repairContext !== null && request.repairAttempts !== repairContext.attempt)) invalid();
  return Object.freeze({
    tenantId: row.tenant_id, projectId: row.project_id, runId: row.id,
    resolutionDigest: row.resolution_digest, profileRevisionId: string(runtime.profileRevisionId),
    installationId: string(runtime.installationId), imageDigest: string(runtime.imageDigest),
    exactAgentVersion: string(runtime.exactAgentVersion), adapterVersion: string(runtime.adapterVersion),
    agentVersionAttestation,
    agent, providerRevisionId: string(runtime.providerRevisionId), providerProtocol: protocol,
    providerBaseUrl: string(runtime.providerBaseUrl), credentialVersionId: string(runtime.credentialVersionId),
    model: modelRoles.primaryModel, modelRoles, authorizedModels: Object.freeze([...authorizedModels]),
    authorizationNonce: string(authorizationNonce), authorizationExpiresAt: string(authorizationExpiresAt),
    budget: Object.freeze({ maxUsd: number(budget.maxUsd), maxTurns: integer(budget.maxTurns), timeoutSeconds: integer(budget.timeoutSeconds) }),
    specRevisionId: row.spec_revision_id, specDigest: digest(value.specDigest),
    testPlanRevisionId: row.test_plan_revision_id, testPlanDigest: digest(value.testPlanDigest),
    targetMatrix: platforms(value.targetMatrix),
    sourceBaselineReceiptId: row.source_baseline_receipt_id,
    baseCommitSha: string(value.commitSha), sourceDigest: string(value.sourceDigest),
    repairContext,
  });
}

function parseAgentVersionAttestation(
  value: unknown,
  agentValue: unknown,
  adapterVersionValue: unknown,
  required: boolean,
): AgentVersionAttestationLock | null {
  if (value === null || value === undefined) {
    if (required) invalid();
    return null;
  }
  const agent = agentValue;
  const adapterVersion = string(adapterVersionValue);
  if ((agent !== "claude-code" && agent !== "codex-cli")
    || (required && !isBuiltInAdapterVersion(agent, adapterVersion))) invalid();
  const attestation = record(value);
  const expectedKeys = ["adapterCompatibility", "catalogReceiptDigest", "supplyChainEvidenceDigest",
    "validatedAdapterVersion", "validationReceiptDigest", "validationReceiptId"];
  if (JSON.stringify(Object.keys(attestation).sort()) !== JSON.stringify([...expectedKeys].sort())) invalid();
  const compatibility = record(attestation.adapterCompatibility);
  if (JSON.stringify(Object.keys(compatibility).sort()) !== JSON.stringify(["maxExclusive", "min"])) invalid();
  const validatedAdapterVersion = string(attestation.validatedAdapterVersion);
  const adapterCompatibility = Object.freeze({
    min: string(compatibility.min),
    maxExclusive: string(compatibility.maxExclusive),
  });
  if (!isAdapterVersionAttested(adapterVersion, validatedAdapterVersion, adapterCompatibility)
    || typeof attestation.validationReceiptId !== "string"
    || !SAFE_ATTESTATION_ID.test(attestation.validationReceiptId)
    || ![attestation.catalogReceiptDigest, attestation.validationReceiptDigest,
      attestation.supplyChainEvidenceDigest]
      .every((digestValue) => typeof digestValue === "string" && SHA256.test(digestValue))) invalid();
  return Object.freeze({
    catalogReceiptDigest: attestation.catalogReceiptDigest as string,
    validationReceiptId: attestation.validationReceiptId,
    validationReceiptDigest: attestation.validationReceiptDigest as string,
    supplyChainEvidenceDigest: attestation.supplyChainEvidenceDigest as string,
    validatedAdapterVersion,
    adapterCompatibility,
  });
}

function statusFromRow(row: OperationRow, lock: LockedAgentExecution): AgentExecutionStatus {
  if (["QUEUED", "PREPARING", "RUNNING"].includes(row.state)) {
    return Object.freeze({ status: "RUNNING", runId: row.run_id, providerRevisionId: lock.providerRevisionId, receipt: null });
  }
  if (row.state === "CANCELLED") {
    return validateAgentExecutionStatus({ status: "CANCELLED", runId: row.run_id,
      providerRevisionId: lock.providerRevisionId, receipt: null }, { lockedRunConfigurationId: row.run_id });
  }
  if (row.state !== "SUCCEEDED" && row.state !== "FAILED") invalid();
  return validateAgentExecutionStatus({ status: row.state === "SUCCEEDED" ? "COMPLETED" : "FAILED",
    runId: row.run_id, providerRevisionId: lock.providerRevisionId, receipt: row.receipt_payload },
  { lockedRunConfigurationId: row.run_id });
}

function assertOperationBinding(row: OperationRow, request: AgentExecutionRequest, providerRevisionId: string): void {
  if (row.tenant_id !== request.tenantId || row.project_id !== request.projectId || row.run_id !== request.lockedRunConfigurationId
    || row.operation_key !== request.operationKey || row.request_digest !== request.requestDigest
    || row.provider_revision_id !== providerRevisionId
    || sha256Canonical(parseAgentExecutionRequest(row.request_payload)) !== sha256Canonical(request)) invalid();
}

function providerAvailable(row: AuthorityRow, now: string): boolean {
  const expiresAt = row.failover_authorization_expires_at ?? row.authorization_expires_at;
  return row.provider_state === "ACTIVE" && row.authorization_state === "ACTIVE"
    && Date.parse(expiresAt) > Date.parse(now) + 30_000;
}

async function activateLockedFallback(
  client: PostgresWorkflowClient,
  row: AuthorityRow,
  request: AgentExecutionRequest,
  activatedAt: string,
): Promise<AuthorityRow> {
  if (row.failover_to_provider_revision_id !== null || row.provider_state === "ACTIVE"
    || row.authorization_state !== "ACTIVE"
    || Date.parse(row.authorization_expires_at) <= Date.parse(activatedAt) + 30_000) return row;
  const value = record(row.configuration_lock);
  if (value.fallback === null || value.fallback === undefined
    || value.profileSource !== `project:${request.projectId}`) return row;
  const fallback = record(value.fallback);
  if (fallback.agent !== value.agent) invalid();
  const modelRoles = parseModelRoles(fallback.modelRoles);
  const budget = record(fallback.budget);
  const expiresAt = string(fallback.inferenceAuthorizationExpiresAt);
  if (Date.parse(expiresAt) <= Date.parse(activatedAt) + 30_000) return row;
  const providerRevisionId = string(fallback.providerRevisionId);
  const provider = await client.query<{ state: string }>(
    `SELECT state FROM deviludo.inference_provider_revisions
      WHERE tenant_id = $1::uuid AND provider_revision_id = $2
      FOR SHARE`,
    [request.tenantId, providerRevisionId],
  );
  if (provider.rows.length !== 1 || provider.rows[0]?.state !== "ACTIVE") return row;
  const models = [...new Set(Object.values(modelRoles))];
  const nonce = randomUUID();
  await client.query(
    `INSERT INTO deviludo.agent_run_provider_failovers
      (tenant_id, project_id, run_id, from_profile_revision_id,
       from_provider_revision_id, to_profile_revision_id,
       to_provider_revision_id, to_credential_version_id, to_models,
       to_budget, authorization_nonce, authorization_expires_at,
       reason, activated_at)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8,
             $9::text[], $10::jsonb, $11::uuid, $12::timestamptz,
             'PRIMARY_PROVIDER_UNAVAILABLE', $13::timestamptz)
     ON CONFLICT (tenant_id, run_id) DO NOTHING`,
    [request.tenantId, request.projectId, request.lockedRunConfigurationId,
      string(value.profileRevisionId), string(value.providerRevisionId),
      string(fallback.profileRevisionId), providerRevisionId,
      string(fallback.credentialVersionId), models,
      JSON.stringify({ maxCostUsd: number(budget.maxUsd) }), nonce, expiresAt, activatedAt],
  );
  return selectAuthority(client, request.tenantId, request.projectId,
    request.lockedRunConfigurationId, "FOR SHARE");
}

async function markProviderWait(client: PostgresWorkflowClient, tenantId: string, runId: string, observedAt: string, claimToken?: string): Promise<void> {
  await client.query(
    `UPDATE deviludo.agent_execution_operations
        SET state = 'WAITING_PROVIDER', claim_token = NULL, claim_expires_at = NULL,
            retry_at = NULL, updated_at = $3::timestamptz
      WHERE tenant_id = $1::uuid AND run_id = $2::uuid
        AND state IN ('QUEUED', 'PREPARING', 'RUNNING', 'WAITING_PROVIDER')
        AND ($4::uuid IS NULL OR claim_token = $4::uuid)`,
    [tenantId, runId, observedAt, claimToken ?? null],
  );
  await client.query(
    `UPDATE deviludo.agent_runs SET state = 'WAITING_PROVIDER'
      WHERE tenant_id = $1::uuid AND id = $2::uuid
        AND state IN ('QUEUED', 'PREPARING', 'RUNNING', 'WAITING_PROVIDER')`,
    [tenantId, runId],
  );
}

async function appendEvent(client: PostgresWorkflowClient, tenantId: string, projectId: string, runId: string,
  attemptId: string, state: string, recordedAt: string, payload: Readonly<Record<string, unknown>>): Promise<void> {
  const payloadDigest = sha256Canonical(payload);
  await client.query(
    `INSERT INTO deviludo.agent_execution_events
      (tenant_id, project_id, run_id, attempt_id, state, payload_digest, payload, recorded_at)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7::jsonb, $8::timestamptz)`,
    [tenantId, projectId, runId, attemptId, state, payloadDigest, JSON.stringify(payload), recordedAt],
  );
}

function validateLeaseInput(value: { tenantId: string; runId: string; claimToken: string; claimedAt?: string;
  heartbeatAt?: string; claimExpiresAt: string }): void {
  if (!UUID.test(value.tenantId) || !UUID.test(value.runId) || !UUID.test(value.claimToken)) invalid();
  const start = validTime(value.claimedAt ?? value.heartbeatAt ?? "");
  const end = validTime(value.claimExpiresAt);
  const duration = Date.parse(end) - Date.parse(start);
  if (duration < 30_000 || duration > 15 * 60_000) invalid();
}
function validSpiffe(value: string): void { const url = new URL(value); if (url.protocol !== "spiffe:" || !url.hostname || url.pathname === "/") invalid(); }
function validTime(value: string): string { if (!Number.isFinite(Date.parse(value))) invalid(); return value; }
function record(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) invalid(); return value as Record<string, unknown>; }
function withoutResolutionDigest(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "resolutionDigest"));
}
function string(value: unknown): string { if (typeof value !== "string" || !value) invalid(); return value; }
function number(value: unknown): number { if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) invalid(); return value; }
function integer(value: unknown): number { if (!Number.isSafeInteger(value) || (value as number) <= 0) invalid(); return value as number; }
function digest(value: unknown): string { if (typeof value !== "string" || !SHA256.test(value)) invalid(); return value; }
function parseModelRoles(value: unknown): LockedAgentExecution["modelRoles"] {
  const body = record(value);
  const keys = ["planningModel", "primaryModel", "smallFastModel", "subagentModel"];
  if (JSON.stringify(Object.keys(body).sort()) !== JSON.stringify(keys)) invalid();
  const result = Object.freeze({
    primaryModel: string(body.primaryModel),
    planningModel: string(body.planningModel),
    smallFastModel: string(body.smallFastModel),
    subagentModel: string(body.subagentModel),
  });
  return result;
}
function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === new Set(left).size
    && JSON.stringify([...left].sort()) === JSON.stringify([...new Set(right)].sort());
}
function platforms(value: unknown): readonly ("linux" | "macos" | "windows")[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 3
    || value.some((item) => item !== "linux" && item !== "macos" && item !== "windows")
    || new Set(value).size !== value.length
    || JSON.stringify([...value].sort()) !== JSON.stringify(value)) invalid();
  return Object.freeze([...(value as ("linux" | "macos" | "windows")[])]);
}
function parseRepairContext(value: unknown, runId: string): LockedAgentExecution["repairContext"] {
  // Locks created before automatic successor repairs did not serialize this
  // optional field. Treat absence as the canonical non-repair value so those
  // immutable in-flight runs remain resumable after the schema rollout.
  if (value === null || value === undefined) return null;
  const body = record(value);
  const expected = ["attempt", "reason", "fromRunConfigurationId", "diagnosticId", "agentDiagnostic", "evidenceBundleId",
    "evidenceBundleDigest", "repairPromptId", "candidateCommitSha", "draftPullRequest", "failedPlatforms"];
  const legacyExpected = expected.filter((key) => key !== "agentDiagnostic");
  const actualKeys = JSON.stringify(Object.keys(body).sort());
  if (actualKeys !== JSON.stringify(expected.sort()) && actualKeys !== JSON.stringify(legacyExpected.sort())) invalid();
  const agentDiagnostic = body.agentDiagnostic ?? null;
  if (!Number.isSafeInteger(body.attempt) || (body.attempt as number) < 1
    || typeof body.fromRunConfigurationId !== "string" || !UUID.test(body.fromRunConfigurationId)
    || body.fromRunConfigurationId === runId || !Array.isArray(body.failedPlatforms)) invalid();
  if (body.reason === "AGENT_FAILURE") {
    if (typeof body.diagnosticId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(body.diagnosticId)
      || body.evidenceBundleId !== null || body.evidenceBundleDigest !== null || body.repairPromptId !== null
      || body.candidateCommitSha !== null || body.draftPullRequest !== null || body.failedPlatforms.length !== 0) invalid();
    if (agentDiagnostic !== null) {
      const diagnostic = validateAgentFailureDiagnostic(agentDiagnostic);
      if (diagnostic.diagnosticId !== body.diagnosticId || diagnostic.runId !== body.fromRunConfigurationId) invalid();
    }
  } else if (body.reason === "E2E_FAILURE") {
    if (body.diagnosticId !== null || agentDiagnostic !== null
      || typeof body.evidenceBundleId !== "string" || !UUID.test(body.evidenceBundleId)
      || typeof body.evidenceBundleDigest !== "string" || !SHA256.test(body.evidenceBundleDigest)
      || body.repairPromptId !== `repair:${body.evidenceBundleDigest}`
      || typeof body.candidateCommitSha !== "string" || !/^[a-f0-9]{40}$/.test(body.candidateCommitSha)
      || !Number.isSafeInteger(body.draftPullRequest) || (body.draftPullRequest as number) < 1
      || body.failedPlatforms.length < 1 || body.failedPlatforms.length > 3) invalid();
  } else invalid();
  const failedPlatforms = body.failedPlatforms.map((value) => {
    const item = record(value);
    const keys = ["platform", "runnerId", "logsDigest", "junitDigest", "screenshotManifestDigest", "videoManifestDigest"];
    if (JSON.stringify(Object.keys(item).sort()) !== JSON.stringify(keys.sort())
      || (item.platform !== "linux" && item.platform !== "macos" && item.platform !== "windows")
      || typeof item.runnerId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(item.runnerId)
      || ![item.logsDigest, item.junitDigest, item.screenshotManifestDigest, item.videoManifestDigest]
        .every((entry) => typeof entry === "string" && SHA256.test(entry))) invalid();
    return Object.freeze({ ...item }) as RepairPlatform;
  });
  if (new Set(failedPlatforms.map((item) => item.platform)).size !== failedPlatforms.length) invalid();
  return Object.freeze({ ...body, agentDiagnostic, failedPlatforms: Object.freeze(failedPlatforms) }) as LockedAgentExecution["repairContext"];
}
function invalid(): never { throw new Error("PostgreSQL Agent execution operation is invalid"); }
