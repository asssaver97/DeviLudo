import { randomUUID } from "node:crypto";
import type { DeliverySignal, DeliveryState } from "../../../lib/orchestration/game-delivery";
import type { WorkflowSignalPort } from "../../temporal/src/job-processor";
import type { PostgresWorkflowClient, PostgresWorkflowPool } from "../../temporal/src/postgres-inbox";
import { specDigest } from "../../spec-dialogue/src/store";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SHA256 = /^[a-f0-9]{64}$/;
const WORKFLOW_ID = /^delivery-[a-f0-9-]{36}$/;
const CANCELLABLE_STATES = new Set<DeliveryState>([
  "IDEATION", "WAITING_SPEC_APPROVAL", "RESOLVING_AGENT_CONFIGURATION",
  "DEVELOPMENT_QUEUED", "DEVELOPING", "WAITING_PROVIDER",
  "CROSS_PLATFORM_E2E", "WAITING_USER_ACCEPTANCE", "MERGING",
  "MAIN_SHA_E2E", "WAITING_MFA", "STEAM_PRIVATE_BETA",
  "STEAM_INSTALL_E2E", "EXTERNAL_APPROVAL_REQUIRED",
]);

export interface DeliveryCancellationCommand {
  readonly operationKey: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly actorId: string;
  readonly reason: string;
}

export interface DeliveryCancellationDecision extends DeliveryCancellationCommand {
  readonly workflowId: string;
  readonly projectionSequence: number;
  readonly projectionKey: string;
  readonly projectionState: DeliveryState;
  readonly projectionDigest: string;
  readonly signalId: string;
  readonly requestedAt: string;
}

export interface DeliveryCancellationReceipt extends DeliveryCancellationDecision {
  readonly state: "CANCEL_REQUESTED";
  readonly deliveredAt: string;
}

export type DeliveryCancellationBegin =
  | { readonly kind: "PENDING_DELIVERY"; readonly decision: DeliveryCancellationDecision }
  | { readonly kind: "COMPLETED"; readonly receipt: DeliveryCancellationReceipt }
  | { readonly kind: "CONFLICT" };

export interface DeliveryCancellationStore {
  begin(command: DeliveryCancellationCommand): Promise<DeliveryCancellationBegin>;
  complete(decision: DeliveryCancellationDecision): Promise<DeliveryCancellationReceipt>;
  probe(): Promise<void>;
}

/**
 * Accepts only a user's reason. Workflow, state and history bindings are
 * derived from the current replay-validated projection under tenant RLS.
 * Re-delivery uses the same signal ID, so a crash after Temporal acceptance
 * cannot produce a second cancellation event.
 */
export class DeliveryCancellationService {
  constructor(
    private readonly store: DeliveryCancellationStore,
    private readonly signals: WorkflowSignalPort,
  ) {}

  async cancel(value: unknown): Promise<DeliveryCancellationReceipt> {
    const command = parseDeliveryCancellationCommand(value);
    const outcome = await this.store.begin(command);
    if (outcome.kind === "COMPLETED") return outcome.receipt;
    if (outcome.kind === "CONFLICT") throw new DeliveryCancellationConflict();
    const decision = outcome.decision;
    const signal: DeliverySignal = Object.freeze({
      signalId: decision.signalId,
      type: "CANCEL" as const,
      reason: decision.reason,
      expectedState: decision.projectionState,
      expectedHistoryLength: decision.projectionSequence,
    });
    await this.signals.signal(decision.workflowId, signal);
    return this.store.complete(decision);
  }

  probe(): Promise<void> { return this.store.probe(); }
}

export class PostgresDeliveryCancellationStore implements DeliveryCancellationStore {
  constructor(private readonly pool: PostgresWorkflowPool) {}

  async begin(command: DeliveryCancellationCommand): Promise<DeliveryCancellationBegin> {
    validateCommand(command);
    const requestDigest = specDigest(command);
    return this.#transaction(command.tenantId, async (client) => {
      let row = await selectDecision(client, command.tenantId, command.operationKey, true);
      if (row) return parseExisting(row, command, requestDigest);
      const authority = await client.query<AuthorityRow>(
        `SELECT projection.workflow_id, projection.projection_sequence,
                projection.projection_key, projection.state AS projection_state,
                projection.snapshot_digest AS projection_digest
           FROM deviludo.delivery_state_projections projection
           JOIN deviludo.spec_delivery_workflows delivery
             ON delivery.tenant_id = projection.tenant_id
            AND delivery.project_id = projection.project_id
            AND delivery.workflow_id = projection.workflow_id
            AND delivery.state = 'ACTIVE'
           JOIN deviludo.tenant_memberships membership
             ON membership.tenant_id = projection.tenant_id
            AND membership.user_id = $3::uuid
            AND membership.status = 'ACTIVE'
            AND membership.role IN ('TenantAdmin', 'ProjectOwner')
          WHERE projection.tenant_id = $1::uuid
            AND projection.project_id = $2::uuid
            AND projection.state NOT IN ('READY_TO_PUBLISH', 'RELEASED', 'CANCELLED')
          FOR SHARE OF projection, delivery, membership`,
        [command.tenantId, command.projectId, command.actorId],
      );
      if (authority.rows.length !== 1) return Object.freeze({ kind: "CONFLICT" as const });
      const source = parseAuthority(authority.rows[0]!);
      const decision: DeliveryCancellationDecision = Object.freeze({
        ...command,
        workflowId: source.workflow_id,
        projectionSequence: Number(source.projection_sequence),
        projectionKey: source.projection_key,
        projectionState: source.projection_state,
        projectionDigest: source.projection_digest,
        signalId: `cancel-${randomUUID()}`,
        requestedAt: new Date().toISOString(),
      });
      const inserted = await client.query(
        `INSERT INTO deviludo.delivery_cancellation_requests
          (operation_key, tenant_id, project_id, actor_id, request_digest,
           reason, workflow_id, projection_sequence, projection_key,
           projection_state, projection_digest, signal_id, state, requested_at)
         VALUES ($1, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, $9,
                 $10, $11, $12, 'PENDING_DELIVERY', $13::timestamptz)
         ON CONFLICT DO NOTHING`,
        [decision.operationKey, decision.tenantId, decision.projectId,
          decision.actorId, requestDigest, decision.reason, decision.workflowId,
          decision.projectionSequence, decision.projectionKey,
          decision.projectionState, decision.projectionDigest,
          decision.signalId, decision.requestedAt],
      );
      if (inserted.rowCount !== 1) return Object.freeze({ kind: "CONFLICT" as const });
      row = await selectDecision(client, command.tenantId, command.operationKey, true);
      if (!row) invalid();
      return parseExisting(row, command, requestDigest);
    });
  }

  async complete(decision: DeliveryCancellationDecision): Promise<DeliveryCancellationReceipt> {
    validateDecision(decision);
    return this.#transaction(decision.tenantId, async (client) => {
      const row = await selectDecision(client, decision.tenantId, decision.operationKey, true);
      if (!row || specDigest(parseDecision(row)) !== specDigest(decision)) invalid();
      if (row.state === "DELIVERED") return parseReceipt(row.completion_receipt, decision);
      if (row.state !== "PENDING_DELIVERY") invalid();
      const receipt: DeliveryCancellationReceipt = Object.freeze({
        ...decision,
        state: "CANCEL_REQUESTED",
        deliveredAt: new Date().toISOString(),
      });
      const updated = await client.query(
        `UPDATE deviludo.delivery_cancellation_requests
            SET state = 'DELIVERED', completion_receipt = $3::jsonb,
                delivered_at = $4::timestamptz
          WHERE tenant_id = $1::uuid AND operation_key = $2
            AND state = 'PENDING_DELIVERY'`,
        [decision.tenantId, decision.operationKey, JSON.stringify(receipt), receipt.deliveredAt],
      );
      if (updated.rowCount !== 1) invalid();
      return receipt;
    });
  }

  async probe(): Promise<void> {
    const client = await this.pool.connect();
    try { await client.query("SELECT 1 AS delivery_cancellation_store_probe"); }
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
      try { await client.query("ROLLBACK"); } catch { /* preserve primary error */ }
      throw error;
    } finally { client.release(); }
  }
}

export class DeliveryCancellationConflict extends Error {
  readonly code = "DELIVERY_CANCELLATION_CONFLICT";
  constructor() { super("Delivery cancellation conflicts with the authoritative projection"); }
}
export class DeliveryCancellationRequestError extends Error {
  readonly code = "INVALID_DELIVERY_CANCELLATION_REQUEST";
  constructor() { super("Delivery cancellation request is invalid"); }
}

type AuthorityRow = {
  workflow_id: string;
  projection_sequence: string | number;
  projection_key: string;
  projection_state: DeliveryState;
  projection_digest: string;
};
type DecisionRow = {
  operation_key: string;
  tenant_id: string;
  project_id: string;
  actor_id: string;
  request_digest: string;
  reason: string;
  workflow_id: string;
  projection_sequence: string | number;
  projection_key: string;
  projection_state: DeliveryState;
  projection_digest: string;
  signal_id: string;
  state: string;
  requested_at: string | Date;
  completion_receipt: unknown | null;
};

async function selectDecision(
  client: PostgresWorkflowClient,
  tenantId: string,
  operationKey: string,
  lock: boolean,
): Promise<DecisionRow | null> {
  const selected = await client.query<DecisionRow>(
    `SELECT operation_key, tenant_id::text, project_id::text, actor_id,
            request_digest, reason, workflow_id, projection_sequence,
            projection_key, projection_state, projection_digest,
            signal_id, state, requested_at, completion_receipt
       FROM deviludo.delivery_cancellation_requests
      WHERE tenant_id = $1::uuid AND operation_key = $2${lock ? " FOR UPDATE" : ""}`,
    [tenantId, operationKey],
  );
  if (selected.rows.length > 1) invalid();
  return selected.rows[0] ?? null;
}

function parseExisting(
  row: DecisionRow,
  command: DeliveryCancellationCommand,
  requestDigest: string,
): DeliveryCancellationBegin {
  if (row.operation_key !== command.operationKey || row.tenant_id !== command.tenantId
    || row.project_id !== command.projectId || row.actor_id !== command.actorId
    || row.reason !== command.reason || row.request_digest !== requestDigest) {
    return Object.freeze({ kind: "CONFLICT" });
  }
  const decision = parseDecision(row);
  if (row.state === "PENDING_DELIVERY") return Object.freeze({ kind: "PENDING_DELIVERY", decision });
  if (row.state === "DELIVERED") return Object.freeze({ kind: "COMPLETED", receipt: parseReceipt(row.completion_receipt, decision) });
  invalid();
}

function parseDecision(row: DecisionRow): DeliveryCancellationDecision {
  const decision: DeliveryCancellationDecision = Object.freeze({
    operationKey: row.operation_key,
    tenantId: row.tenant_id,
    projectId: row.project_id,
    actorId: row.actor_id,
    reason: row.reason,
    workflowId: row.workflow_id,
    projectionSequence: Number(row.projection_sequence),
    projectionKey: row.projection_key,
    projectionState: row.projection_state,
    projectionDigest: row.projection_digest,
    signalId: row.signal_id,
    requestedAt: new Date(row.requested_at).toISOString(),
  });
  validateDecision(decision);
  return decision;
}

function parseReceipt(value: unknown, decision: DeliveryCancellationDecision): DeliveryCancellationReceipt {
  const body = object(value);
  const deliveredAt = typeof body.deliveredAt === "string" ? new Date(body.deliveredAt) : new Date(NaN);
  if (body.state !== "CANCEL_REQUESTED" || !Number.isFinite(deliveredAt.getTime())
    || specDigest(Object.fromEntries(Object.entries(body).filter(([key]) => !["state", "deliveredAt"].includes(key))))
      !== specDigest(decision)) invalid();
  return Object.freeze({ ...decision, state: "CANCEL_REQUESTED", deliveredAt: deliveredAt.toISOString() });
}

export function parseDeliveryCancellationCommand(value: unknown): DeliveryCancellationCommand {
  const body = object(value);
  if (JSON.stringify(Object.keys(body).sort())
    !== JSON.stringify(["actorId", "operationKey", "projectId", "reason", "tenantId"])) requestInvalid();
  const command = Object.freeze({
    operationKey: string(body.operationKey),
    tenantId: string(body.tenantId),
    projectId: string(body.projectId),
    actorId: string(body.actorId),
    reason: string(body.reason).trim(),
  });
  validateCommand(command);
  return command;
}

function validateCommand(command: DeliveryCancellationCommand): void {
  if (!SHA256.test(command.operationKey) || !UUID.test(command.tenantId)
    || !UUID.test(command.projectId) || !UUID.test(command.actorId)
    || !command.reason || command.reason.length > 2_000 || /\u0000/.test(command.reason)) requestInvalid();
}
function validateDecision(decision: DeliveryCancellationDecision): void {
  validateCommand(decision);
  if (!WORKFLOW_ID.test(decision.workflowId)
    || !Number.isSafeInteger(decision.projectionSequence) || decision.projectionSequence < 0
    || decision.projectionSequence > 100_000 || !decision.projectionKey
    || decision.projectionKey.length > 512 || /[\u0000-\u001f\u007f]/.test(decision.projectionKey)
    || !CANCELLABLE_STATES.has(decision.projectionState) || !SHA256.test(decision.projectionDigest)
    || !/^cancel-[a-f0-9-]{36}$/.test(decision.signalId)
    || !Number.isFinite(Date.parse(decision.requestedAt))) invalid();
}
function parseAuthority(row: AuthorityRow): AuthorityRow {
  const sequence = Number(row.projection_sequence);
  if (!WORKFLOW_ID.test(row.workflow_id) || !Number.isSafeInteger(sequence)
    || sequence < 0 || sequence > 100_000 || !row.projection_key
    || row.projection_key.length > 512 || /[\u0000-\u001f\u007f]/.test(row.projection_key)
    || !CANCELLABLE_STATES.has(row.projection_state) || !SHA256.test(row.projection_digest)) invalid();
  return row;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) requestInvalid();
  return value as Record<string, unknown>;
}
function string(value: unknown): string { if (typeof value !== "string") requestInvalid(); return value; }
function requestInvalid(): never { throw new DeliveryCancellationRequestError(); }
function invalid(): never { throw new Error("Delivery cancellation authority is invalid"); }
