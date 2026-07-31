import { Pool, type PoolClient, type QueryResultRow } from "pg";
import type { CoreConfig } from "./config";

export type Database = Readonly<{
  pool: Pool;
  withWorkspace<T>(workspaceId: string, callback: (client: PoolClient) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}>;

export function createDatabase(config: CoreConfig): Database {
  const pool = new Pool({
    connectionString: config.databaseUrl,
    application_name: `deviludo-core-${config.role}`,
    max: config.role === "api" ? 12 : 4,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    options: [
      "-c statement_timeout=30000",
      "-c lock_timeout=5000",
      "-c idle_in_transaction_session_timeout=15000",
      ...(config.setDatabaseRole ? [`-c role=${config.databaseRole}`] : []),
    ].join(" "),
  });

  return Object.freeze({
    pool,
    async withWorkspace<T>(workspaceId: string, callback: (client: PoolClient) => Promise<T>): Promise<T> {
      if (!UUID.test(workspaceId)) throw new Error("Workspace id is invalid");
      return withTransaction(pool, callback, { workspaceId });
    },
    close: () => pool.end(),
  });
}

async function withTransaction<T>(
  pool: Pool,
  callback: (client: PoolClient) => Promise<T>,
  context: Readonly<{ workspaceId?: string }>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (context.workspaceId) await client.query("SELECT set_config('app.workspace_id', $1, true)", [context.workspaceId]);
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export function oneRow<T extends QueryResultRow>(rows: T[], message: string): T {
  if (rows.length !== 1) throw new Error(message);
  return rows[0];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
