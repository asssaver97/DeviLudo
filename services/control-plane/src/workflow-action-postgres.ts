import type {
  ControlPlaneWorkflowAction,
  ControlPlaneWorkflowActionReceipt,
  ControlPlaneWorkflowBinding,
  ControlPlaneWorkflowPort,
} from "./workflow-handler";

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

/** PostgreSQL/RLS implementation for durable, idempotent UI and approval waits. */
export class PostgresControlPlaneWorkflowActionStore implements ControlPlaneWorkflowPort {
  constructor(private readonly pool: ControlPlaneWorkflowSqlPool) {}

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
      await client.query("COMMIT");
      return Object.freeze({
        receiptId: `control-receipt:${row.id}`,
        // This value is used directly as the authenticated completion route
        // parameter and therefore must preserve the PostgreSQL UUID exactly.
        actionId: row.id,
        operation: row.operation,
        requestDigest: row.request_digest,
        status: row.status,
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
