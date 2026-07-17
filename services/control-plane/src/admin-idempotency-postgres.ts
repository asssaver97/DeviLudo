import type { OnApplicationShutdown } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import {
  AdminIdempotencyStore,
  InMemoryAdminIdempotencyStore,
  type AdminIdempotencyClaim,
  validatePayload,
} from "./admin-idempotency";

type IdempotencyRow = {
  request_fingerprint: string;
  state: "AVAILABLE" | "CLAIMED" | "COMPLETED";
  claim_active: boolean;
  response_payload: unknown | null;
};

export class PostgresAdminIdempotencyStore extends AdminIdempotencyStore implements OnApplicationShutdown {
  constructor(private readonly pool: Pool) {
    super();
  }

  async acquire(input: {
    readonly identityDigest: string;
    readonly requestFingerprint: string;
  }): Promise<AdminIdempotencyClaim> {
    const claimToken = randomUUID();
    return this.#transaction(async (client) => {
      await client.query(
        `DELETE FROM deviludo.admin_idempotency_results
          WHERE identity_digest = $1 AND expires_at <= now()`,
        [input.identityDigest],
      );
      await client.query(
        `INSERT INTO deviludo.admin_idempotency_results
          (identity_digest, request_fingerprint, state, claim_token,
           claim_expires_at, expires_at)
         VALUES ($1, $2, 'CLAIMED', $3::uuid, now() + interval '30 seconds',
                 now() + interval '24 hours')
         ON CONFLICT (identity_digest) DO NOTHING`,
        [input.identityDigest, input.requestFingerprint, claimToken],
      );
      const selected = await client.query<IdempotencyRow>(
        `SELECT request_fingerprint, state,
                COALESCE(claim_expires_at > now(), false) AS claim_active,
                response_payload
           FROM deviludo.admin_idempotency_results
          WHERE identity_digest = $1
          FOR UPDATE`,
        [input.identityDigest],
      );
      const row = selected.rows[0];
      if (!row) throw new Error("Administrator idempotency claim is unavailable");
      if (row.request_fingerprint !== input.requestFingerprint) return Object.freeze({ kind: "CONFLICT" as const });
      if (row.state === "COMPLETED") {
        return Object.freeze({ kind: "REPLAY" as const, payload: structuredClone(row.response_payload) });
      }
      if (row.state === "CLAIMED" && row.claim_active) {
        const owned = await client.query(
          `SELECT 1 FROM deviludo.admin_idempotency_results
            WHERE identity_digest = $1 AND claim_token = $2::uuid`,
          [input.identityDigest, claimToken],
        );
        if (owned.rowCount === 1) return Object.freeze({ kind: "ACQUIRED" as const, claimToken });
        return Object.freeze({ kind: "BUSY" as const });
      }
      const reclaimed = await client.query(
        `UPDATE deviludo.admin_idempotency_results
            SET state = 'CLAIMED', claim_token = $3::uuid,
                claim_expires_at = now() + interval '30 seconds', updated_at = now()
          WHERE identity_digest = $1 AND request_fingerprint = $2
            AND state <> 'COMPLETED'
            AND (claim_token IS NULL OR claim_expires_at <= now())
        RETURNING identity_digest`,
        [input.identityDigest, input.requestFingerprint, claimToken],
      );
      return reclaimed.rowCount === 1
        ? Object.freeze({ kind: "ACQUIRED" as const, claimToken })
        : Object.freeze({ kind: "BUSY" as const });
    });
  }

  async complete(input: {
    readonly identityDigest: string;
    readonly requestFingerprint: string;
    readonly claimToken: string;
    readonly payload: unknown;
  }): Promise<void> {
    validatePayload(input.payload);
    const completed = await this.pool.query(
      `UPDATE deviludo.admin_idempotency_results
          SET state = 'COMPLETED', claim_token = NULL, claim_expires_at = NULL,
              response_payload = $4::jsonb, completed_at = now(), updated_at = now()
        WHERE identity_digest = $1 AND request_fingerprint = $2
          AND state = 'CLAIMED' AND claim_token = $3::uuid
      RETURNING identity_digest`,
      [input.identityDigest, input.requestFingerprint, input.claimToken, JSON.stringify(input.payload)],
    );
    if (completed.rowCount !== 1) throw new Error("Administrator idempotency claim was lost before completion");
  }

  async release(input: {
    readonly identityDigest: string;
    readonly requestFingerprint: string;
    readonly claimToken: string;
  }): Promise<void> {
    await this.pool.query(
      `UPDATE deviludo.admin_idempotency_results
          SET state = 'AVAILABLE', claim_token = NULL, claim_expires_at = NULL,
              updated_at = now()
        WHERE identity_digest = $1 AND request_fingerprint = $2
          AND state = 'CLAIMED' AND claim_token = $3::uuid`,
      [input.identityDigest, input.requestFingerprint, input.claimToken],
    );
  }

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }

  async #transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { /* preserve original error */ }
      throw error;
    } finally {
      client.release();
    }
  }
}

export function createAdminIdempotencyStore(): AdminIdempotencyStore {
  if (process.env.NODE_ENV !== "production") return new InMemoryAdminIdempotencyStore();
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required for production admin persistence");
  const url = new URL(connectionString);
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") throw new Error("DATABASE_URL must use PostgreSQL");
  const ca = process.env.DEVILUDO_POSTGRES_TLS_CA;
  return new PostgresAdminIdempotencyStore(new Pool({
    connectionString,
    application_name: "deviludo-control-plane",
    max: 10,
    ssl: { rejectUnauthorized: true, ...(ca ? { ca } : {}) },
  }));
}
