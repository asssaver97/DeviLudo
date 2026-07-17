import { Pool, type PoolClient, type PoolConfig } from "pg";
import type {
  PostgresQueryResult,
  PostgresWorkflowClient,
  PostgresWorkflowPool,
} from "./postgres-inbox";

export interface ClosablePostgresWorkflowPool extends PostgresWorkflowPool {
  probe(): Promise<void>;
  close(): Promise<void>;
}

/** Thin node-postgres adapter shared by the durable receiver and job worker. */
export class NodePostgresWorkflowPool implements ClosablePostgresWorkflowPool {
  constructor(private readonly pool: Pool) {}

  async connect(): Promise<PostgresWorkflowClient> {
    return new NodePostgresWorkflowClient(await this.pool.connect());
  }

  async probe(): Promise<void> {
    const result = await this.pool.query<{ ready: number }>("SELECT 1 AS ready");
    if (result.rows[0]?.ready !== 1) throw new Error("Workflow PostgreSQL readiness probe failed");
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

class NodePostgresWorkflowClient implements PostgresWorkflowClient {
  constructor(private readonly client: PoolClient) {}

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<PostgresQueryResult<Row>> {
    const result = await this.client.query<Row>(text, values ? [...values] : undefined);
    return Object.freeze({ rowCount: result.rowCount, rows: Object.freeze([...result.rows]) });
  }

  release(): void {
    this.client.release();
  }
}

export function postgresWorkflowPoolFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): ClosablePostgresWorkflowPool {
  const connectionString = requiredEnv(env, "DATABASE_URL");
  const url = new URL(connectionString);
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error("DATABASE_URL must use PostgreSQL");
  }
  const allowInsecure = env.DEVILUDO_ALLOW_INSECURE_LOCAL_POSTGRES === "1";
  if (env.NODE_ENV === "production" && allowInsecure) {
    throw new Error("Production workflow PostgreSQL cannot disable TLS");
  }
  const ca = env.DEVILUDO_POSTGRES_TLS_CA;
  const config: PoolConfig = {
    connectionString,
    application_name: `deviludo-workflow-${safeApplicationSuffix(env.DEVILUDO_WORKFLOW_DESTINATION)}`,
    max: positiveInteger(env.DEVILUDO_WORKFLOW_POSTGRES_POOL_SIZE, 10, 1, 100),
    ssl: allowInsecure ? false : { rejectUnauthorized: true, ...(ca ? { ca } : {}) },
  };
  return new NodePostgresWorkflowPool(new Pool(config));
}

function requiredEnv(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function safeApplicationSuffix(value: string | undefined): string {
  return value && /^[a-z][a-z-]{2,31}$/.test(value) ? value : "destination";
}

function positiveInteger(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum || String(parsed) !== value) {
    throw new Error("Workflow PostgreSQL pool size is invalid");
  }
  return parsed;
}
