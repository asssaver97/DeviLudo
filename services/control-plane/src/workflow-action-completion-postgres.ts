import { createHash } from "node:crypto";
import type { DeliverySignal } from "../../temporal/src/contracts";
import { assertDeliverySignal } from "../../temporal/src/contracts";
import type {
  ControlPlaneWorkflowAction,
  ControlPlaneWorkflowBinding,
} from "./workflow-handler";
import type {
  ControlPlaneWorkflowSqlClient,
  ControlPlaneWorkflowSqlPool,
} from "./workflow-action-postgres";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,199}$/;

export type WorkflowActionCompletionSource =
  | "SPEC_SERVICE"
  | "USER_ACCEPTANCE_SERVICE"
  | "PROVIDER_MONITOR"
  | "MFA_BROKER"
  | "STEAM_APPROVAL_MONITOR";

export class WorkflowActionCompletionValidationError extends Error {}
export class WorkflowActionCompletionConflictError extends Error {}

export interface WorkflowActionCompletionReceipt {
  readonly actionId: string;
  readonly outboxId: string;
  readonly workflowId: string;
  readonly signalId: string;
  readonly signalDigest: string;
  readonly state: "PENDING_DELIVERY" | "DELIVERED";
  readonly replayed: boolean;
}

export interface WorkflowActionCompletionPort {
  complete(input: {
    readonly tenantId: string;
    readonly projectId: string;
    readonly workflowId: string;
    readonly actionId: string;
    readonly source: WorkflowActionCompletionSource;
    readonly sourceReceiptId: string;
    readonly signal: DeliverySignal;
  }): Promise<WorkflowActionCompletionReceipt>;
}

type ActionRow = {
  id: string;
  tenant_id: string;
  project_id: string;
  workflow_id: string;
  operation: ControlPlaneWorkflowAction;
  status: "WAITING" | "ACKNOWLEDGED" | "COMPLETED" | "INVALIDATED";
  binding: ControlPlaneWorkflowBinding;
  completion_signal_id: string | null;
  completion_signal_digest: string | null;
  completion_source: WorkflowActionCompletionSource | null;
  completion_receipt_id: string | null;
};

type OutboxRow = {
  id: string;
  tenant_id: string;
  project_id: string;
  workflow_id: string;
  action_id: string;
  signal_id: string;
  signal_digest: string;
  signal: unknown;
  state: "PENDING" | "DELIVERING" | "RETRYABLE_FAILED" | "DELIVERED";
};

/**
 * Atomically completes one server-authoritative wait and records its exact
 * Temporal signal. Callers are internal brokers/monitors, never browsers.
 */
export class PostgresWorkflowActionCompletionStore implements WorkflowActionCompletionPort {
  constructor(private readonly pool: ControlPlaneWorkflowSqlPool) {}

  async complete(input: {
    readonly tenantId: string;
    readonly projectId: string;
    readonly workflowId: string;
    readonly actionId: string;
    readonly source: WorkflowActionCompletionSource;
    readonly sourceReceiptId: string;
    readonly signal: DeliverySignal;
  }): Promise<WorkflowActionCompletionReceipt> {
    validateInput(input);
    const signalDigest = digest(input.signal);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [input.tenantId]);
      const actionResult = await client.query<ActionRow>(
        `SELECT id, tenant_id, project_id, workflow_id, operation, status,
                binding, completion_signal_id, completion_signal_digest,
                completion_source, completion_receipt_id
           FROM deviludo.workflow_control_actions
          WHERE tenant_id = $1::uuid AND id = $2::uuid
          FOR UPDATE`,
        [input.tenantId, input.actionId],
      );
      const action = actionResult.rows[0];
      if (!action || action.project_id !== input.projectId || action.workflow_id !== input.workflowId) {
        throw new WorkflowActionCompletionConflictError("Workflow control action is unavailable in the authorized binding");
      }
      validateSignalBinding(action.operation, action.binding, input.source, input.signal);
      if (action.status === "INVALIDATED" || action.status === "ACKNOWLEDGED") {
        throw new WorkflowActionCompletionConflictError("Workflow control action cannot be completed");
      }
      if (action.status === "COMPLETED") {
        assertReplay(action, input, signalDigest);
      } else if (action.status !== "WAITING") {
        throw new WorkflowActionCompletionConflictError("Workflow control action state is invalid");
      }

      await client.query(
        `INSERT INTO deviludo.workflow_signal_outbox
          (tenant_id, project_id, workflow_id, action_id, signal_id,
           signal_digest, signal)
         VALUES ($1::uuid, $2::uuid, $3, $4::uuid, $5, $6, $7::jsonb)
         ON CONFLICT (tenant_id, signal_id) DO NOTHING`,
        [
          input.tenantId, input.projectId, input.workflowId, input.actionId,
          input.signal.signalId, signalDigest, JSON.stringify(input.signal),
        ],
      );
      const outboxResult = await client.query<OutboxRow>(
        `SELECT id, tenant_id, project_id, workflow_id, action_id,
                signal_id, signal_digest, signal, state
           FROM deviludo.workflow_signal_outbox
          WHERE tenant_id = $1::uuid AND signal_id = $2
          FOR UPDATE`,
        [input.tenantId, input.signal.signalId],
      );
      const outbox = outboxResult.rows[0];
      assertOutbox(outbox, input, signalDigest);
      const replayed = action.status === "COMPLETED";
      if (!replayed) {
        const updated = await client.query(
          `UPDATE deviludo.workflow_control_actions
              SET status = 'COMPLETED', completion_signal_id = $3,
                  completion_signal_digest = $4,
                  completion_source = $5, completion_receipt_id = $6,
                  completed_at = now()
            WHERE tenant_id = $1::uuid AND id = $2::uuid AND status = 'WAITING'
          RETURNING id`,
          [
            input.tenantId, input.actionId, input.signal.signalId, signalDigest,
            input.source, input.sourceReceiptId,
          ],
        );
        if (updated.rows.length !== 1) {
          throw new WorkflowActionCompletionConflictError("Workflow control action completion race was lost");
        }
      }
      await client.query("COMMIT");
      return Object.freeze({
        actionId: input.actionId,
        outboxId: outbox.id,
        workflowId: input.workflowId,
        signalId: input.signal.signalId,
        signalDigest,
        state: outbox.state === "DELIVERED" ? "DELIVERED" : "PENDING_DELIVERY",
        replayed,
      });
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }
}

function validateInput(input: Parameters<PostgresWorkflowActionCompletionStore["complete"]>[0]): void {
  for (const value of [input.tenantId, input.projectId, input.actionId]) {
    if (!UUID.test(value)) {
      throw new WorkflowActionCompletionValidationError("Workflow action completion UUID binding is invalid");
    }
  }
  if (!SAFE_ID.test(input.workflowId) || !SAFE_ID.test(input.sourceReceiptId)) {
    throw new WorkflowActionCompletionValidationError("Workflow action completion identity is invalid");
  }
  try {
    assertDeliverySignal(input.signal);
  } catch {
    throw new WorkflowActionCompletionValidationError("Workflow action completion delivery signal is invalid");
  }
}

function validateSignalBinding(
  operation: ControlPlaneWorkflowAction,
  binding: ControlPlaneWorkflowBinding,
  source: WorkflowActionCompletionSource,
  signal: DeliverySignal,
): void {
  const allowedSource: Record<Exclude<ControlPlaneWorkflowAction, "CANCEL_DELIVERY">, WorkflowActionCompletionSource> = {
    CONTINUE_IDEA_DIALOGUE: "SPEC_SERVICE",
    REQUEST_SPEC_APPROVAL: "SPEC_SERVICE",
    WAIT_FOR_PROVIDER: "PROVIDER_MONITOR",
    REQUEST_USER_ACCEPTANCE: "USER_ACCEPTANCE_SERVICE",
    REQUEST_FRESH_MFA: "MFA_BROKER",
    WAIT_FOR_EXTERNAL_APPROVAL: "STEAM_APPROVAL_MONITOR",
  };
  if (operation === "CANCEL_DELIVERY" || source !== allowedSource[operation]) invalidBinding();
  if (operation === "CONTINUE_IDEA_DIALOGUE" && signal.type === "SPEC_READY") return;
  if (operation === "REQUEST_SPEC_APPROVAL" && signal.type === "SPEC_APPROVED" && binding.specRevisionId) return;
  if (operation === "WAIT_FOR_PROVIDER" && signal.type === "PROVIDER_RESTORED"
    && signal.providerRevisionId === binding.providerRevisionId) return;
  if (operation === "REQUEST_USER_ACCEPTANCE"
    && (signal.type === "USER_ACCEPTED" || signal.type === "USER_FEEDBACK")
    && binding.candidateCommitSha && binding.evidenceBundleId) return;
  if (operation === "REQUEST_FRESH_MFA" && signal.type === "MFA_APPROVED"
    && binding.mainCommitSha && binding.evidenceBundleId) return;
  if (operation === "WAIT_FOR_EXTERNAL_APPROVAL" && signal.type === "EXTERNAL_APPROVED"
    && signal.gate === binding.externalGate && binding.steamBuildId && binding.evidenceBundleId) return;
  invalidBinding();
}

function assertReplay(
  action: ActionRow,
  input: Parameters<PostgresWorkflowActionCompletionStore["complete"]>[0],
  signalDigest: string,
): void {
  if (action.completion_signal_id !== input.signal.signalId
    || action.completion_signal_digest !== signalDigest
    || action.completion_source !== input.source
    || action.completion_receipt_id !== input.sourceReceiptId) {
    throw new WorkflowActionCompletionConflictError(
      "Workflow control action completion was replayed with another authority binding",
    );
  }
}

function assertOutbox(
  outbox: OutboxRow | undefined,
  input: Parameters<PostgresWorkflowActionCompletionStore["complete"]>[0],
  signalDigest: string,
): asserts outbox is OutboxRow {
  const value = typeof outbox?.signal === "string" ? JSON.parse(outbox.signal) as unknown : outbox?.signal;
  if (!outbox || !UUID.test(outbox.id) || outbox.tenant_id !== input.tenantId
    || outbox.project_id !== input.projectId || outbox.workflow_id !== input.workflowId
    || outbox.action_id !== input.actionId || outbox.signal_id !== input.signal.signalId
    || outbox.signal_digest !== signalDigest || digest(value) !== signalDigest) {
    throw new WorkflowActionCompletionConflictError("Workflow signal outbox idempotency binding mismatch");
  }
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
    .join(",")}}`;
}

async function rollback(client: ControlPlaneWorkflowSqlClient): Promise<void> {
  try { await client.query("ROLLBACK"); } catch { /* preserve primary error */ }
}

function invalidBinding(): never {
  throw new WorkflowActionCompletionValidationError("Workflow action completion signal binding is invalid");
}
