import { Pool, type PoolClient, type QueryResultRow } from "pg";
import type { CoreConfig } from "./config";

export type Database = Readonly<{
  pool: Pool;
  withTenant<T>(tenantId: string, callback: (client: PoolClient) => Promise<T>): Promise<T>;
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
    async withTenant<T>(tenantId: string, callback: (client: PoolClient) => Promise<T>): Promise<T> {
      if (!UUID.test(tenantId)) throw new Error("Tenant id is invalid");
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
        const result = await callback(client);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  });
}

export function oneRow<T extends QueryResultRow>(rows: T[], message: string): T {
  if (rows.length !== 1) throw new Error(message);
  return rows[0];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
