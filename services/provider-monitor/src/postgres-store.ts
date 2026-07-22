import { randomUUID } from "node:crypto";
import type { WorkflowActionCompletionReceipt } from "../../control-plane/src/workflow-action-completion-postgres";
import type { PostgresWorkflowClient, PostgresWorkflowPool } from "../../temporal/src/postgres-inbox";
import { probePostgresRelations } from "../../temporal/src/postgres-readiness";
import {
  parseProviderRecoveryRequest,
  providerRecoveryRequest,
  providerRecoveryRequestDigest,
  validSchedulerSubject,
  type ProviderRecoveryAuthority,
  type ProviderRecoveryReceipt,
  type ProviderRecoveryRequest,
} from "./contracts";
import {
  ProviderRecoveryConflict,
  type ProviderRecoveryClaim,
  type ProviderRecoveryStore,
} from "./service";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SHA256 = /^[a-f0-9]{64}$/;
const SIGNAL_ID = /^provider-recovery-[a-f0-9-]{36}$/;

type RecoveryRow = {
  operation_key: string; request_digest: string; tenant_id: string; project_id: string;
  action_id: string; workflow_id: string; run_id: string; provider_revision_id: string;
  scheduler_subject: string; signal_id: string; state: "PENDING" | "COMPLETED";
  claim_token: string | null; claim_active: boolean; retry_due: boolean;
  attempt_count: number; receipt: unknown | null;
};
type AuthorityRow = {
  tenant_id: string; project_id: string; action_id: string; workflow_id: string;
  action_operation: string; action_status: string; action_binding: unknown;
  run_id: string; run_state: string; resolution_digest: string; configuration_lock: unknown;
  authorization_profile_revision_id: string; authorization_provider_revision_id: string;
  authorization_credential_version_id: string; authorization_state: string; authorization_expires_at: string;
  failover_from_profile_revision_id: string | null; failover_from_provider_revision_id: string | null;
  failover_to_profile_revision_id: string | null; failover_to_provider_revision_id: string | null;
  failover_to_credential_version_id: string | null; failover_authorization_expires_at: string | null;
  operation_state: string; operation_workflow_id: string; effective_authorization_active: boolean;
  active_claims: string | number;
  provider_revision_id: string; provider_state: string; provider_agent: string; provider_protocol: string;
  provider_base_url: string; provider_approved_ports: number[]; provider_authentication: string;
  provider_models: unknown; provider_credential_version_id: string;
};

export class PostgresProviderRecoveryStore implements ProviderRecoveryStore {
  readonly #claimId: () => string;
  readonly #signalId: () => string;
  constructor(private readonly pool: PostgresWorkflowPool, options: Readonly<{
    claimId?: () => string; signalId?: () => string;
  }> = {}) {
    this.#claimId = options.claimId ?? randomUUID;
    this.#signalId = options.signalId ?? (() => `provider-recovery-${randomUUID()}`);
  }

  async listDue(tenantId: string, limit: number): Promise<readonly ProviderRecoveryRequest[]> {
    if (!UUID.test(tenantId) || !Number.isInteger(limit) || limit < 1 || limit > 100) invalid();
    const normalizedTenantId = tenantId.toLowerCase();
    return this.#transaction(normalizedTenantId, async (client) => {
      const selected = await client.query<{ candidate_project_id: string; candidate_action_id: string }>(
        `SELECT action.project_id::text AS candidate_project_id,
                action.id::text AS candidate_action_id
           FROM deviludo.workflow_control_actions action
           JOIN deviludo.agent_runs run
             ON run.tenant_id = action.tenant_id AND run.project_id = action.project_id
            AND run.id::text = action.binding->>'lockedRunConfigurationId'
           JOIN deviludo.inference_run_authorizations authorization
             ON authorization.tenant_id = run.tenant_id AND authorization.project_id = run.project_id
            AND authorization.run_id = run.id
           LEFT JOIN deviludo.agent_run_provider_failovers failover
             ON failover.tenant_id = run.tenant_id AND failover.project_id = run.project_id
            AND failover.run_id = run.id
           JOIN deviludo.agent_execution_operations execution
             ON execution.tenant_id = run.tenant_id AND execution.project_id = run.project_id
            AND execution.run_id = run.id
           JOIN deviludo.inference_provider_revisions provider
             ON provider.tenant_id = run.tenant_id
            AND provider.provider_revision_id = action.binding->>'providerRevisionId'
           LEFT JOIN deviludo.provider_recovery_checks recovery
             ON recovery.tenant_id = action.tenant_id AND recovery.project_id = action.project_id
            AND recovery.action_id = action.id
          WHERE action.tenant_id = $1::uuid
            AND action.operation = 'WAIT_FOR_PROVIDER' AND action.status = 'WAITING'
            AND action.binding->>'state' = 'WAITING_PROVIDER'
            AND run.state = 'WAITING_PROVIDER' AND execution.state = 'WAITING_PROVIDER'
            AND execution.workflow_id = action.workflow_id
            AND authorization.state = 'ACTIVE' AND provider.state = 'ACTIVE'
            AND COALESCE(failover.to_provider_revision_id, authorization.provider_revision_id)
                = provider.provider_revision_id
            AND COALESCE(failover.to_credential_version_id, authorization.credential_version_id)
                = provider.credential_version_id
            AND COALESCE(failover.authorization_expires_at, authorization.expires_at)
                > now() + interval '30 seconds'
            AND NOT EXISTS (
              SELECT 1 FROM deviludo.inference_request_claims claim
               WHERE claim.tenant_id = run.tenant_id AND claim.run_id = run.id
                 AND claim.state IN ('ACTIVE', 'INDETERMINATE')
            )
            AND (recovery.action_id IS NULL OR (
              recovery.state = 'PENDING' AND recovery.next_probe_at <= now()
              AND (recovery.claim_token IS NULL OR recovery.claim_expires_at <= now())
            ))
          ORDER BY action.created_at, action.id
          LIMIT $2`,
        [normalizedTenantId, limit],
      );
      return Object.freeze(selected.rows.map((row) => providerRecoveryRequest({
        tenantId: normalizedTenantId,
        projectId: row.candidate_project_id,
        actionId: row.candidate_action_id,
      })));
    });
  }

  async begin(input: { readonly request: ProviderRecoveryRequest; readonly schedulerSubject: string }) {
    const request = parseProviderRecoveryRequest(input.request);
    if (!validSchedulerSubject(input.schedulerSubject)) invalid();
    const requestDigest = providerRecoveryRequestDigest(request);
    const claimToken = this.#claimId();
    const signalId = this.#signalId();
    if (!UUID.test(claimToken) || !SIGNAL_ID.test(signalId)) invalid();
    return this.#transaction(request.tenantId, async (client) => {
      const existing = await selectRecovery(client, request);
      if (existing) return existingOutcome(existing, request, requestDigest, claimToken, client);
      const authority = parseAuthority(await selectAuthority(client, request), request);
      await client.query(
        `INSERT INTO deviludo.provider_recovery_checks
          (operation_key, request_digest, tenant_id, project_id, action_id,
           workflow_id, run_id, provider_revision_id, scheduler_subject, signal_id,
           state, claim_token, claim_expires_at, attempt_count, next_probe_at)
         VALUES ($1, $2, $3::uuid, $4::uuid, $5::uuid, $6, $7::uuid, $8, $9, $10,
                 'PENDING', $11::uuid, now() + interval '2 minutes', 1, now())
         ON CONFLICT DO NOTHING`,
        [request.operationKey, requestDigest, request.tenantId, request.projectId, request.actionId,
          authority.workflowId, authority.runId, authority.provider.id, input.schedulerSubject,
          signalId, claimToken],
      );
      const selected = await selectRecovery(client, request);
      if (!selected) conflict();
      assertRecoveryBinding(selected, request, requestDigest);
      if (selected.claim_token !== claimToken || selected.signal_id !== signalId || selected.state !== "PENDING") {
        return selected.receipt !== null
          ? { kind: "COMPLETED" as const, receipt: parseReceipt(selected.receipt, selected) }
          : { kind: "BUSY" as const };
      }
      return { kind: "CLAIMED" as const, claim: claimFrom(selected, request, input.schedulerSubject, requestDigest, claimToken, authority) };
    });
  }

  async complete(input: { readonly claim: ProviderRecoveryClaim; readonly probeDigest: string; readonly probedAt: string;
    readonly delivery: WorkflowActionCompletionReceipt }): Promise<ProviderRecoveryReceipt> {
    validateClaim(input.claim);
    if (!SHA256.test(input.probeDigest) || !Number.isFinite(Date.parse(input.probedAt))) invalid();
    validateDelivery(input.delivery, input.claim);
    const receipt = Object.freeze({
      schemaVersion: "deviludo.provider-recovery-receipt.v1" as const,
      operationKey: input.claim.request.operationKey, actionId: input.claim.request.actionId,
      workflowId: input.claim.workflowId, runId: input.claim.runId,
      providerRevisionId: input.claim.provider.id, probeDigest: input.probeDigest,
      probedAt: new Date(input.probedAt).toISOString(), schedulerSubject: input.claim.schedulerSubject,
      delivery: Object.freeze({ ...input.delivery }), replayed: input.delivery.replayed,
    });
    return this.#transaction(input.claim.request.tenantId, async (client) => {
      const updated = await client.query(
        `UPDATE deviludo.provider_recovery_checks
            SET state = 'COMPLETED', claim_token = NULL, claim_expires_at = NULL,
                probe_digest = $5, probed_at = $6::timestamptz,
                completion_outbox_id = $7::uuid, receipt = $8::jsonb,
                completed_at = now(), updated_at = now()
          WHERE tenant_id = $1::uuid AND operation_key = $2
            AND request_digest = $3 AND claim_token = $4::uuid
            AND state = 'PENDING' AND receipt IS NULL
        RETURNING operation_key`,
        [input.claim.request.tenantId, input.claim.request.operationKey, input.claim.requestDigest,
          input.claim.claimToken, input.probeDigest, receipt.probedAt, input.delivery.outboxId,
          JSON.stringify(receipt)],
      );
      if (updated.rowCount !== 1) conflict();
      return receipt;
    });
  }

  async defer(claim: ProviderRecoveryClaim, failureCode:
    | "PROVIDER_PROBE_FAILED"
    | "PROVIDER_RECOVERY_DELIVERY_FAILED"): Promise<void> {
    validateClaim(claim);
    if (failureCode !== "PROVIDER_PROBE_FAILED" && failureCode !== "PROVIDER_RECOVERY_DELIVERY_FAILED") invalid();
    await this.#transaction(claim.request.tenantId, async (client) => {
      await client.query(
        `UPDATE deviludo.provider_recovery_checks
            SET claim_token = NULL, claim_expires_at = NULL,
                next_probe_at = now() + make_interval(secs => LEAST(
                  300, (5 * power(2, LEAST(attempt_count - 1, 6)))::integer
                )),
                last_failure_code = $5, updated_at = now()
          WHERE tenant_id = $1::uuid AND operation_key = $2
            AND request_digest = $3 AND claim_token = $4::uuid
            AND state = 'PENDING' AND receipt IS NULL`,
        [claim.request.tenantId, claim.request.operationKey, claim.requestDigest,
          claim.claimToken, failureCode],
      );
    });
  }

  async release(claim: ProviderRecoveryClaim): Promise<void> {
    validateClaim(claim);
    await this.#transaction(claim.request.tenantId, async (client) => {
      await client.query(
        `UPDATE deviludo.provider_recovery_checks
            SET claim_token = NULL, claim_expires_at = NULL, updated_at = now()
          WHERE tenant_id = $1::uuid AND operation_key = $2
            AND request_digest = $3 AND claim_token = $4::uuid
            AND state = 'PENDING' AND receipt IS NULL`,
        [claim.request.tenantId, claim.request.operationKey, claim.requestDigest, claim.claimToken],
      );
    });
  }

  async probe(): Promise<void> {
    await probePostgresRelations(this.pool, [
      "agent_execution_operations", "agent_run_provider_failovers", "agent_runs", "inference_provider_revisions",
      "inference_request_claims", "inference_run_authorizations", "provider_recovery_checks",
      "workflow_control_actions", "workflow_signal_outbox",
    ], () => new ProviderRecoveryConflict("PROVIDER_RECOVERY_CONFLICT"));
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
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }
}

async function selectRecovery(client: PostgresWorkflowClient, request: ProviderRecoveryRequest) {
  const selected = await client.query<RecoveryRow>(
    `SELECT operation_key, request_digest, tenant_id::text, project_id::text,
            action_id::text, workflow_id, run_id::text, provider_revision_id,
            scheduler_subject, signal_id, state, claim_token::text,
            COALESCE(claim_expires_at > now(), false) AS claim_active,
            next_probe_at <= now() AS retry_due, attempt_count, receipt
       FROM deviludo.provider_recovery_checks
      WHERE tenant_id = $1::uuid AND (operation_key = $2 OR action_id = $3::uuid)
      FOR UPDATE`, [request.tenantId, request.operationKey, request.actionId],
  );
  if (selected.rows.length > 1) conflict();
  return selected.rows[0] ?? null;
}

async function selectAuthority(client: PostgresWorkflowClient, request: ProviderRecoveryRequest): Promise<AuthorityRow> {
  const selected = await client.query<AuthorityRow>(
    `SELECT action.tenant_id::text, action.project_id::text,
            action.id::text AS action_id, action.workflow_id,
            action.operation AS action_operation, action.status AS action_status,
            action.binding AS action_binding,
            run.id::text AS run_id, run.state AS run_state,
            run.resolution_digest, run.configuration_lock,
            authorization.profile_revision_id AS authorization_profile_revision_id,
            authorization.provider_revision_id AS authorization_provider_revision_id,
            authorization.credential_version_id AS authorization_credential_version_id,
            authorization.state AS authorization_state,
            authorization.expires_at::text AS authorization_expires_at,
            failover.from_profile_revision_id AS failover_from_profile_revision_id,
            failover.from_provider_revision_id AS failover_from_provider_revision_id,
            failover.to_profile_revision_id AS failover_to_profile_revision_id,
            failover.to_provider_revision_id AS failover_to_provider_revision_id,
            failover.to_credential_version_id AS failover_to_credential_version_id,
            failover.authorization_expires_at::text AS failover_authorization_expires_at,
            execution.state AS operation_state, execution.workflow_id AS operation_workflow_id,
            COALESCE(failover.authorization_expires_at, authorization.expires_at)
              > now() + interval '30 seconds' AS effective_authorization_active,
            (SELECT count(*) FROM deviludo.inference_request_claims claim
              WHERE claim.tenant_id = run.tenant_id AND claim.run_id = run.id
                AND claim.state IN ('ACTIVE', 'INDETERMINATE')) AS active_claims,
            provider.provider_revision_id, provider.state AS provider_state,
            provider.agent AS provider_agent, provider.protocol AS provider_protocol,
            provider.base_url AS provider_base_url,
            provider.approved_ports AS provider_approved_ports,
            provider.authentication AS provider_authentication,
            provider.models AS provider_models,
            provider.credential_version_id AS provider_credential_version_id
       FROM deviludo.workflow_control_actions action
       JOIN deviludo.agent_runs run
         ON run.tenant_id = action.tenant_id AND run.project_id = action.project_id
        AND run.id::text = action.binding->>'lockedRunConfigurationId'
       JOIN deviludo.inference_run_authorizations authorization
         ON authorization.tenant_id = run.tenant_id AND authorization.project_id = run.project_id
        AND authorization.run_id = run.id
       LEFT JOIN deviludo.agent_run_provider_failovers failover
         ON failover.tenant_id = run.tenant_id AND failover.project_id = run.project_id
        AND failover.run_id = run.id
       JOIN deviludo.agent_execution_operations execution
         ON execution.tenant_id = run.tenant_id AND execution.project_id = run.project_id
        AND execution.run_id = run.id
       JOIN deviludo.inference_provider_revisions provider
         ON provider.tenant_id = run.tenant_id
        AND provider.provider_revision_id = action.binding->>'providerRevisionId'
      WHERE action.tenant_id = $1::uuid AND action.project_id = $2::uuid
        AND action.id = $3::uuid
      FOR UPDATE OF action, run, execution`,
    [request.tenantId, request.projectId, request.actionId],
  );
  if (selected.rows.length !== 1 || !selected.rows[0]) conflict();
  return selected.rows[0];
}

function parseAuthority(row: AuthorityRow, request: ProviderRecoveryRequest): ProviderRecoveryAuthority {
  const binding = record(row.action_binding);
  const lock = record(row.configuration_lock);
  const models = exactModels(row.provider_models);
  const selectedProvider = row.failover_to_provider_revision_id ?? row.authorization_provider_revision_id;
  const selectedCredential = row.failover_to_credential_version_id ?? row.authorization_credential_version_id;
  const selectedExpiry = row.failover_authorization_expires_at ?? row.authorization_expires_at;
  if (row.tenant_id !== request.tenantId || row.project_id !== request.projectId
    || row.action_id !== request.actionId || row.action_operation !== "WAIT_FOR_PROVIDER" || row.action_status !== "WAITING"
    || binding.state !== "WAITING_PROVIDER" || binding.lockedRunConfigurationId !== row.run_id
    || binding.providerRevisionId !== row.provider_revision_id || selectedProvider !== row.provider_revision_id
    || row.run_state !== "WAITING_PROVIDER" || row.operation_state !== "WAITING_PROVIDER"
    || row.operation_workflow_id !== row.workflow_id
    || lock.resolutionDigest !== row.resolution_digest || lock.agent !== row.provider_agent
    || row.authorization_state !== "ACTIVE" || row.provider_state !== "ACTIVE"
    || selectedCredential !== row.provider_credential_version_id
    || !row.effective_authorization_active || !Number.isFinite(Date.parse(selectedExpiry))
    || Number(row.active_claims) !== 0) conflict();
  if (row.failover_to_provider_revision_id !== null) {
    const fallback = record(lock.fallback);
    if (lock.profileSource !== `project:${request.projectId}` || fallback.agent !== lock.agent
      || row.failover_from_profile_revision_id !== lock.profileRevisionId
      || row.failover_from_provider_revision_id !== lock.providerRevisionId
      || row.authorization_profile_revision_id !== lock.profileRevisionId
      || row.authorization_provider_revision_id !== lock.providerRevisionId
      || row.authorization_credential_version_id !== lock.credentialVersionId
      || fallback.profileRevisionId !== row.failover_to_profile_revision_id
      || fallback.providerRevisionId !== row.failover_to_provider_revision_id
      || fallback.credentialVersionId !== row.failover_to_credential_version_id
      || !sameModels(fallback.modelRoles, models)) conflict();
  } else if (lock.providerRevisionId !== row.provider_revision_id
    || lock.profileRevisionId !== row.authorization_profile_revision_id
    || lock.credentialVersionId !== row.authorization_credential_version_id
    || !sameModels(lock.modelRoles, models)) conflict();
  const agent = row.provider_agent;
  const protocol = row.provider_protocol;
  const authentication = row.provider_authentication;
  if ((agent !== "claude-code" && agent !== "codex-cli")
    || (protocol !== "anthropic-messages" && protocol !== "openai-responses")
    || (authentication !== "bearer" && authentication !== "x-api-key" && authentication !== "authorization-bearer")
    || (agent === "codex-cli") !== (protocol === "openai-responses")) conflict();
  return Object.freeze({ workflowId: row.workflow_id, runId: row.run_id, provider: Object.freeze({
    id: row.provider_revision_id, agent, protocol, baseUrl: row.provider_base_url,
    approvedPorts: Object.freeze([...row.provider_approved_ports]), authentication,
    models, credentialVersionId: row.provider_credential_version_id,
  }) });
}

async function existingOutcome(row: RecoveryRow, request: ProviderRecoveryRequest,
  requestDigest: string, claimToken: string, client: PostgresWorkflowClient) {
  assertRecoveryBinding(row, request, requestDigest);
  if (row.state === "COMPLETED") return { kind: "COMPLETED" as const, receipt: parseReceipt(row.receipt, row) };
  if (row.claim_active || !row.retry_due) return { kind: "BUSY" as const };
  const updated = await client.query(
    `UPDATE deviludo.provider_recovery_checks
        SET claim_token = $4::uuid, claim_expires_at = now() + interval '2 minutes',
            attempt_count = attempt_count + 1, next_probe_at = now(), updated_at = now()
      WHERE tenant_id = $1::uuid AND operation_key = $2 AND request_digest = $3
        AND state = 'PENDING' AND (claim_token IS NULL OR claim_expires_at <= now())
    RETURNING operation_key`, [request.tenantId, request.operationKey, requestDigest, claimToken],
  );
  if (updated.rowCount !== 1) return { kind: "BUSY" as const };
  const authority = parseAuthority(await selectAuthority(client, request), request);
  return { kind: "CLAIMED" as const,
    claim: claimFrom(row, request, row.scheduler_subject, requestDigest, claimToken, authority) };
}

function claimFrom(row: RecoveryRow, request: ProviderRecoveryRequest, subject: string, requestDigest: string,
  claimToken: string, authority: ProviderRecoveryAuthority): ProviderRecoveryClaim {
  if (row.workflow_id !== authority.workflowId || row.run_id !== authority.runId
    || row.provider_revision_id !== authority.provider.id) conflict();
  return Object.freeze({ claimToken, requestDigest, request, schedulerSubject: subject,
    signalId: row.signal_id, ...authority });
}
function assertRecoveryBinding(row: RecoveryRow, request: ProviderRecoveryRequest, digest: string): void {
  if (row.operation_key !== request.operationKey || row.request_digest !== digest
    || row.tenant_id !== request.tenantId || row.project_id !== request.projectId
    || row.action_id !== request.actionId || !validSchedulerSubject(row.scheduler_subject)) conflict();
}
function exactModels(value: unknown) {
  const body = record(value);
  const keys = ["planningModel", "primaryModel", "smallFastModel", "subagentModel"];
  if (JSON.stringify(Object.keys(body).sort()) !== JSON.stringify(keys)
    || keys.some((key) => typeof body[key] !== "string" || !(body[key] as string).length)) conflict();
  return Object.freeze({ primaryModel: body.primaryModel as string, planningModel: body.planningModel as string,
    smallFastModel: body.smallFastModel as string, subagentModel: body.subagentModel as string });
}
function sameModels(value: unknown, expected: ReturnType<typeof exactModels>): boolean {
  try {
    const actual = exactModels(value);
    return JSON.stringify(actual) === JSON.stringify(expected);
  } catch { return false; }
}
function parseReceipt(value: unknown, row: RecoveryRow): ProviderRecoveryReceipt {
  const body = record(value); const delivery = record(body.delivery);
  if (body.schemaVersion !== "deviludo.provider-recovery-receipt.v1"
    || body.operationKey !== row.operation_key || body.actionId !== row.action_id
    || body.workflowId !== row.workflow_id || body.runId !== row.run_id
    || body.providerRevisionId !== row.provider_revision_id || typeof body.probeDigest !== "string"
    || !SHA256.test(body.probeDigest) || typeof body.probedAt !== "string"
    || body.schedulerSubject !== row.scheduler_subject || typeof body.replayed !== "boolean"
    || delivery.signalId !== row.signal_id) conflict();
  return body as unknown as ProviderRecoveryReceipt;
}
function validateClaim(claim: ProviderRecoveryClaim): void {
  parseProviderRecoveryRequest(claim.request);
  if (!UUID.test(claim.claimToken) || !SHA256.test(claim.requestDigest) || !SIGNAL_ID.test(claim.signalId)
    || !validSchedulerSubject(claim.schedulerSubject) || claim.provider.id.length < 1) invalid();
}
function validateDelivery(value: WorkflowActionCompletionReceipt, claim: ProviderRecoveryClaim): void {
  if (value.actionId !== claim.request.actionId || value.workflowId !== claim.workflowId
    || value.signalId !== claim.signalId || !UUID.test(value.outboxId) || !SHA256.test(value.signalDigest)) conflict();
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) conflict();
  return value as Record<string, unknown>;
}
function invalid(): never { throw new Error("Provider recovery persistence input is invalid"); }
function conflict(): never { throw new ProviderRecoveryConflict("PROVIDER_RECOVERY_CONFLICT"); }
