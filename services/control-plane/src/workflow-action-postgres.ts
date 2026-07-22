import { createHash } from "node:crypto";
import type {
  ControlPlaneWorkflowAction,
  ControlPlaneWorkflowActionReceipt,
  ControlPlaneWorkflowBinding,
  ControlPlaneWorkflowPort,
} from "./workflow-handler";
import { probePostgresRelations } from "../../temporal/src/postgres-readiness";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SHA256 = /^[a-f0-9]{64}$/;

export interface ControlPlaneWorkflowSqlResult<Row extends Record<string, unknown>> {
  readonly rows: readonly Row[];
}

export interface ControlPlaneWorkflowSqlClient {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    values?: readonly unknown[],
  ): Promise<ControlPlaneWorkflowSqlResult<Row>>;
  release(): void;
}

export interface ControlPlaneWorkflowSqlPool {
  connect(): Promise<ControlPlaneWorkflowSqlClient>;
}

type ActionRow = {
  id: string;
  tenant_id: string;
  project_id: string;
  workflow_id: string;
  operation_key: string;
  request_digest: string;
  operation: ControlPlaneWorkflowAction;
  status: "WAITING" | "ACKNOWLEDGED";
  binding: ControlPlaneWorkflowBinding;
};

type CancellationRevocationRow = {
  id: string;
  tenant_id: string;
  project_id: string;
  workflow_id: string;
  action_id: string;
  operation_key: string;
  request_digest: string;
  run_id: string | null;
  release_id: string | null;
  steam_build_id: string | null;
  reason_digest: string;
};

/** PostgreSQL/RLS implementation for durable, idempotent UI and approval waits. */
export class PostgresControlPlaneWorkflowActionStore implements ControlPlaneWorkflowPort {
  constructor(private readonly pool: ControlPlaneWorkflowSqlPool) {}

  async probe(): Promise<void> {
    await probePostgresRelations(
      this.pool,
      ["delivery_cancellation_revocations", "workflow_control_actions"],
      () => new Error("Control-plane workflow action PostgreSQL schema is not ready"),
    );
  }

  async ensureAction(input: Parameters<ControlPlaneWorkflowPort["ensureAction"]>[0]): Promise<ControlPlaneWorkflowActionReceipt> {
    validateInput(input);
    await input.heartbeat();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [input.tenantId]);
      const expectedStatus = input.operation === "CANCEL_DELIVERY" ? "ACKNOWLEDGED" : "WAITING";
      await client.query(
        `INSERT INTO deviludo.workflow_control_actions
          (tenant_id, project_id, workflow_id, operation_key, request_digest,
           operation, status, binding)
         VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8::jsonb)
         ON CONFLICT (tenant_id, operation_key) DO NOTHING`,
        [
          input.tenantId,
          input.projectId,
          input.workflowId,
          input.operationKey,
          input.requestDigest,
          input.operation,
          expectedStatus,
          JSON.stringify(input.binding),
        ],
      );
      const selected = await client.query<ActionRow>(
        `SELECT id, tenant_id, project_id, workflow_id, operation_key,
                request_digest, operation, status, binding
           FROM deviludo.workflow_control_actions
          WHERE tenant_id = $1::uuid AND operation_key = $2`,
        [input.tenantId, input.operationKey],
      );
      const row = selected.rows[0];
      if (!row || !UUID.test(row.id)
        || row.tenant_id !== input.tenantId || row.project_id !== input.projectId
        || row.workflow_id !== input.workflowId || row.operation_key !== input.operationKey
        || row.request_digest !== input.requestDigest || row.operation !== input.operation
        || row.status !== expectedStatus || canonicalJson(row.binding) !== canonicalJson(input.binding)) {
        throw new Error("Control-plane workflow action idempotency binding mismatch");
      }
      let cancellationRevocationId: string | null = null;
      if (input.operation === "CANCEL_DELIVERY") {
        const reason = input.binding.cancellationReason;
        if (!reason) throw new Error("Cancellation workflow action is missing its reason binding");
        const reasonDigest = createHash("sha256").update(reason).digest("hex");
        await client.query(
          `INSERT INTO deviludo.delivery_cancellation_revocations
            (tenant_id, project_id, workflow_id, action_id, operation_key,
             request_digest, run_id, release_id, steam_build_id, reason_digest, revoked_at)
           VALUES ($1::uuid, $2::uuid, $3, $4::uuid, $5, $6,
                   $7::uuid, $8::uuid, $9, $10, now())
           ON CONFLICT (tenant_id, workflow_id) DO NOTHING`,
          [input.tenantId, input.projectId, input.workflowId, row.id, input.operationKey,
            input.requestDigest, input.binding.lockedRunConfigurationId,
            input.binding.releaseId, input.binding.steamBuildId, reasonDigest],
        );
        const revoked = await client.query<CancellationRevocationRow>(
          `SELECT id::text, tenant_id::text, project_id::text, workflow_id,
                  action_id::text, operation_key, request_digest, run_id::text,
                  release_id::text, steam_build_id, reason_digest
             FROM deviludo.delivery_cancellation_revocations
            WHERE tenant_id = $1::uuid AND workflow_id = $2`,
          [input.tenantId, input.workflowId],
        );
        const revocation = revoked.rows[0];
        if (!revocation || !UUID.test(revocation.id)
          || revocation.tenant_id !== input.tenantId || revocation.project_id !== input.projectId
          || revocation.workflow_id !== input.workflowId || revocation.action_id !== row.id
          || revocation.operation_key !== input.operationKey || revocation.request_digest !== input.requestDigest
          || revocation.run_id !== input.binding.lockedRunConfigurationId
          || revocation.release_id !== input.binding.releaseId
          || revocation.steam_build_id !== input.binding.steamBuildId
          || revocation.reason_digest !== reasonDigest) {
          throw new Error("Delivery cancellation revocation idempotency binding mismatch");
        }
        cancellationRevocationId = revocation.id;
      }
      await client.query("COMMIT");
      return Object.freeze({
        receiptId: `control-receipt:${row.id}`,
        // This value is used directly as the authenticated completion route
        // parameter and therefore must preserve the PostgreSQL UUID exactly.
        actionId: row.id,
        operation: row.operation,
        requestDigest: row.request_digest,
        status: row.status,
        cancellationRevocationId,
      });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

function validateInput(input: Parameters<ControlPlaneWorkflowPort["ensureAction"]>[0]): void {
  for (const value of [input.tenantId, input.projectId, input.workflowId, input.operationKey]) {
    if (!value || value.length > 512 || /[\u0000-\u001f\u007f]/.test(value)) {
      throw new Error("Control-plane workflow action identifier is invalid");
    }
  }
  if (!SHA256.test(input.requestDigest)) throw new Error("Control-plane workflow action digest is invalid");
  if (!input.binding || input.binding.state.length > 80) throw new Error("Control-plane workflow action binding is invalid");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(",")}}`;
}
