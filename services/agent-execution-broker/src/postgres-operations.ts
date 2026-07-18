import { randomUUID } from "node:crypto";
import { sha256Canonical } from "../../runner-control/src/canonical";
import type { PostgresWorkflowClient, PostgresWorkflowPool } from "../../temporal/src/postgres-inbox";
import type { AgentExecutionRequest, AgentExecutionStatus, LockedAgentExecution } from "./contracts";
import { parseAgentExecutionRequest, validateAgentExecutionStatus, validateAuthoritativeResult } from "./contracts";
import {
  AgentProviderUnavailable,
  type AgentExecutionOperationPersistence,
} from "./operations";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SHA256 = /^[a-f0-9]{64}$/;

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
  authorization_profile_revision_id: string;
  authorization_provider_revision_id: string;
  authorization_credential_version_id: string;
  authorization_models: string[];
  authorization_budget: unknown;
  authorization_nonce: string;
  authorization_state: string;
  authorization_expires_at: string;
  provider_state: string;
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
      const lock = parseAuthority(authority, request);
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
          lock.providerRevisionId, JSON.stringify(request), available ? "QUEUED" : "WAITING_PROVIDER",
          input.submitterSpiffeId, input.createdAt],
      );
      let operation = await selectOperation(client, request.tenantId, request.lockedRunConfigurationId);
      assertOperationBinding(operation, request, lock.providerRevisionId);
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
      const authority = await selectAuthority(client, input.tenantId, request.projectId, input.runId, "FOR UPDATE OF run");
      const lock = parseAuthority(authority, request);
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
      if (operation.provider_revision_id !== input.providerRevisionId || operation.claim_token !== input.claimToken) invalid();
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
            authorization.profile_revision_id AS authorization_profile_revision_id,
            authorization.provider_revision_id AS authorization_provider_revision_id,
            authorization.credential_version_id AS authorization_credential_version_id,
            authorization.models AS authorization_models,
            authorization.budget AS authorization_budget,
            authorization.nonce AS authorization_nonce,
            authorization.state AS authorization_state,
            authorization.expires_at::text AS authorization_expires_at,
            provider.state AS provider_state
       FROM deviludo.agent_runs run
       JOIN deviludo.inference_run_authorizations authorization
         ON authorization.tenant_id = run.tenant_id AND authorization.project_id = run.project_id
        AND authorization.run_id = run.id
       JOIN deviludo.inference_provider_revisions provider
         ON provider.tenant_id = authorization.tenant_id
        AND provider.provider_revision_id = authorization.provider_revision_id
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
  const budget = record(value.budget);
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
    || authBudget.maxCostUsd !== budget.maxUsd || !Array.isArray(row.authorization_models)
    || !row.authorization_models.includes(row.model)) invalid();
  const agent = value.agent;
  const protocol = value.providerProtocol;
  if ((agent !== "claude-code" && agent !== "codex-cli")
    || (protocol !== "anthropic-messages" && protocol !== "openai-responses")) invalid();
  return Object.freeze({
    tenantId: row.tenant_id, projectId: row.project_id, runId: row.id,
    resolutionDigest: row.resolution_digest, profileRevisionId: row.profile_revision_id,
    installationId: row.installation_id, imageDigest: row.image_digest,
    exactAgentVersion: row.exact_agent_version, adapterVersion: row.adapter_version,
    agent, providerRevisionId: row.provider_revision_id, providerProtocol: protocol,
    providerBaseUrl: string(value.providerBaseUrl), credentialVersionId: row.credential_version_id,
    model: row.model, authorizedModels: Object.freeze([...row.authorization_models]),
    authorizationNonce: row.authorization_nonce, authorizationExpiresAt: row.authorization_expires_at,
    budget: Object.freeze({ maxUsd: number(budget.maxUsd), maxTurns: integer(budget.maxTurns), timeoutSeconds: integer(budget.timeoutSeconds) }),
    specRevisionId: row.spec_revision_id, specDigest: digest(value.specDigest),
    testPlanRevisionId: row.test_plan_revision_id, testPlanDigest: digest(value.testPlanDigest),
    targetMatrix: platforms(value.targetMatrix),
    sourceBaselineReceiptId: row.source_baseline_receipt_id,
    baseCommitSha: string(value.commitSha), sourceDigest: string(value.sourceDigest),
  });
}

function statusFromRow(row: OperationRow, lock: LockedAgentExecution): AgentExecutionStatus {
  if (["QUEUED", "PREPARING", "RUNNING"].includes(row.state)) {
    return Object.freeze({ status: "RUNNING", runId: row.run_id, providerRevisionId: lock.providerRevisionId, receipt: null });
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
  return row.provider_state === "ACTIVE" && row.authorization_state === "ACTIVE"
    && Date.parse(row.authorization_expires_at) > Date.parse(now) + 30_000;
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
function platforms(value: unknown): readonly ("linux" | "macos" | "windows")[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 3
    || value.some((item) => item !== "linux" && item !== "macos" && item !== "windows")
    || new Set(value).size !== value.length
    || JSON.stringify([...value].sort()) !== JSON.stringify(value)) invalid();
  return Object.freeze([...(value as ("linux" | "macos" | "windows")[])]);
}
function invalid(): never { throw new Error("PostgreSQL Agent execution operation is invalid"); }
