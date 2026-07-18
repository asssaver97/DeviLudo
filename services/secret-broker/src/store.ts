import { randomUUID } from "node:crypto";
import type { PostgresWorkflowClient, PostgresWorkflowPool } from "../../temporal/src/postgres-inbox";
import {
  SecretBrokerConflictError,
  type BrokerAuditPurpose,
  type BrokerSecretRecord,
  type BrokerWriteReservation,
  type SecretBrokerStore,
} from "./contracts";

type RecordRow = {
  id: string;
  secret_ref: string;
  backend_path: string;
  write_key: string;
  purpose: BrokerSecretRecord["purpose"];
  plaintext_digest: string;
  state: BrokerSecretRecord["state"];
  claim_token: string | null;
  claim_expires_at: string | Date | null;
  expires_at: string | Date | null;
  created_at: string | Date;
  activated_at: string | Date | null;
  consumed_at: string | Date | null;
  revoked_at: string | Date | null;
};

export class PostgresSecretBrokerStore implements SecretBrokerStore {
  constructor(private readonly pool: PostgresWorkflowPool) {}

  async reserveWrite(input: Parameters<SecretBrokerStore["reserveWrite"]>[0]): Promise<BrokerWriteReservation> {
    return this.#transaction(async (client) => {
      const secretRef = secretRefFor(input.id);
      const backendPath = backendPathFor(input.id);
      await client.query(
        `INSERT INTO deviludo.secret_broker_records
          (id, secret_ref, backend_path, write_key, purpose, plaintext_digest,
           state, claim_token, claim_expires_at, expires_at, created_at)
         VALUES ($1::uuid, $2, $3, $4, $5, $6, 'PENDING', $7::uuid,
                 $8::timestamptz, $9::timestamptz, $10::timestamptz)
         ON CONFLICT (write_key) DO NOTHING`,
        [input.id, secretRef, backendPath, input.writeKey, input.purpose,
          input.plaintextDigest, input.claimToken, input.claimExpiresAt, input.expiresAt, input.at],
      );
      const selected = await client.query<RecordRow>(
        `SELECT * FROM deviludo.secret_broker_records WHERE write_key = $1 FOR UPDATE`,
        [input.writeKey],
      );
      const record = parseRow(selected.rows[0]);
      assertWriteBinding(record, input);
      if (record.state === "ACTIVE") return Object.freeze({ kind: "REPLAY", record, claimToken: null });
      if (record.state !== "PENDING") conflict();
      if (record.claimToken !== input.claimToken) {
        if (record.claimExpiresAt && Date.parse(record.claimExpiresAt) > Date.parse(input.at)) conflict();
        const claimed = await client.query<RecordRow>(
          `UPDATE deviludo.secret_broker_records
              SET claim_token = $2::uuid, claim_expires_at = $3::timestamptz
            WHERE secret_ref = $1 AND state = 'PENDING'
          RETURNING *`,
          [record.secretRef, input.claimToken, input.claimExpiresAt],
        );
        return Object.freeze({ kind: "CLAIMED", record: parseRow(claimed.rows[0]), claimToken: input.claimToken });
      }
      return Object.freeze({ kind: "CLAIMED", record, claimToken: input.claimToken });
    });
  }

  async activate(input: Parameters<SecretBrokerStore["activate"]>[0]): Promise<BrokerSecretRecord> {
    return this.#transaction(async (client) => {
      const result = await client.query<RecordRow>(
        `UPDATE deviludo.secret_broker_records
            SET state = 'ACTIVE', claim_token = NULL, claim_expires_at = NULL,
                activated_at = $3::timestamptz
          WHERE secret_ref = $1 AND state = 'PENDING' AND claim_token = $2::uuid
        RETURNING *`,
        [input.secretRef, input.claimToken, input.at],
      );
      const record = parseRow(result.rows[0]);
      await audit(client, record.secretRef, "CREATED", record.purpose,
        input.workloadSpiffeId, input.bindingDigest, input.at);
      return record;
    });
  }

  async releaseWrite(secretRef: string, claimToken: string): Promise<void> {
    await this.#transaction(async (client) => { await client.query(
      `UPDATE deviludo.secret_broker_records SET claim_token = NULL, claim_expires_at = NULL
        WHERE secret_ref = $1 AND state = 'PENDING' AND claim_token = $2::uuid`, [secretRef, claimToken]); });
  }

  async claimTake(input: Parameters<SecretBrokerStore["claimTake"]>[0]) {
    return this.#transaction(async (client) => {
      const selected = await client.query<RecordRow>(
        `SELECT * FROM deviludo.secret_broker_records WHERE secret_ref = $1 FOR UPDATE`,
        [input.secretRef],
      );
      const record = optionalRow(selected.rows[0]);
      if (!record || record.purpose !== "github-pkce-v1"
        || (record.expiresAt && Date.parse(record.expiresAt) <= Date.parse(input.at))
        || ["CONSUMED", "REVOKED", "PENDING"].includes(record.state)) return null;
      if (record.state === "TAKE_CLAIMED" && record.claimExpiresAt
        && Date.parse(record.claimExpiresAt) > Date.parse(input.at)) conflict();
      const claimed = await client.query<RecordRow>(
        `UPDATE deviludo.secret_broker_records
            SET state = 'TAKE_CLAIMED', claim_token = $2::uuid,
                claim_expires_at = $3::timestamptz
          WHERE secret_ref = $1 AND state IN ('ACTIVE', 'TAKE_CLAIMED')
        RETURNING *`,
        [input.secretRef, input.claimToken, input.claimExpiresAt],
      );
      return Object.freeze({ record: parseRow(claimed.rows[0]), claimToken: input.claimToken });
    });
  }

  async releaseTake(secretRef: string, claimToken: string): Promise<void> {
    await this.#transaction(async (client) => { await client.query(
      `UPDATE deviludo.secret_broker_records SET state = 'ACTIVE', claim_token = NULL, claim_expires_at = NULL
        WHERE secret_ref = $1 AND state = 'TAKE_CLAIMED' AND claim_token = $2::uuid`, [secretRef, claimToken]); });
  }

  async claimExpiredPkce(input: Parameters<SecretBrokerStore["claimExpiredPkce"]>[0]) {
    return this.#transaction(async (client) => {
      const selected = await client.query<{ secret_ref: string }>(
        `SELECT secret_ref
           FROM deviludo.secret_broker_records
          WHERE purpose = 'github-pkce-v1'
            AND expires_at <= $1::timestamptz
            AND (state = 'ACTIVE'
              OR (state = 'TAKE_CLAIMED' AND claim_expires_at <= $1::timestamptz))
          ORDER BY expires_at, secret_ref
          LIMIT $2
          FOR UPDATE SKIP LOCKED`,
        [input.at, input.limit],
      );
      const refs = selected.rows.map((row) => row.secret_ref);
      if (!refs.length) return Object.freeze([]);
      const claimed = await client.query<RecordRow>(
        `UPDATE deviludo.secret_broker_records
            SET state = 'TAKE_CLAIMED', claim_token = $2::uuid,
                claim_expires_at = $3::timestamptz
          WHERE secret_ref = ANY($1::text[])
        RETURNING *`,
        [refs, input.claimToken, input.claimExpiresAt],
      );
      return Object.freeze(claimed.rows.map(parseRow));
    });
  }

  async completeExpiredPkce(input: Parameters<SecretBrokerStore["completeExpiredPkce"]>[0]): Promise<void> {
    await this.#transaction(async (client) => {
      const result = await client.query<RecordRow>(
        `UPDATE deviludo.secret_broker_records
            SET state = 'REVOKED', claim_token = NULL, claim_expires_at = NULL,
                revoked_at = $3::timestamptz
          WHERE secret_ref = $1 AND purpose = 'github-pkce-v1'
            AND state = 'TAKE_CLAIMED' AND claim_token = $2::uuid
        RETURNING *`,
        [input.secretRef, input.claimToken, input.at],
      );
      const record = parseRow(result.rows[0]);
      await audit(client, record.secretRef, "REVOKED", record.purpose,
        input.workloadSpiffeId, input.bindingDigest, input.at);
    });
  }

  async consume(input: Parameters<SecretBrokerStore["consume"]>[0]): Promise<void> {
    await this.#transaction(async (client) => {
      const result = await client.query<RecordRow>(
        `UPDATE deviludo.secret_broker_records
            SET state = 'CONSUMED', claim_token = NULL, claim_expires_at = NULL,
                consumed_at = $3::timestamptz
          WHERE secret_ref = $1 AND state = 'TAKE_CLAIMED' AND claim_token = $2::uuid
        RETURNING *`,
        [input.secretRef, input.claimToken, input.at],
      );
      const record = parseRow(result.rows[0]);
      await audit(client, record.secretRef, "CONSUMED", record.purpose,
        input.workloadSpiffeId, input.bindingDigest, input.at);
    });
  }

  async revoke(input: Parameters<SecretBrokerStore["revoke"]>[0]): Promise<BrokerSecretRecord | null> {
    return this.#transaction(async (client) => {
      const selected = await client.query<RecordRow>(
        `SELECT * FROM deviludo.secret_broker_records WHERE secret_ref = $1 FOR UPDATE`,
        [input.secretRef],
      );
      const current = optionalRow(selected.rows[0]);
      if (!current) return null;
      if (current.state === "REVOKED") return current;
      if (current.state === "CONSUMED") return current;
      const result = await client.query<RecordRow>(
        `UPDATE deviludo.secret_broker_records
            SET state = 'REVOKED', claim_token = NULL, claim_expires_at = NULL,
                revoked_at = $2::timestamptz
          WHERE secret_ref = $1
        RETURNING *`,
        [input.secretRef, input.at],
      );
      const record = parseRow(result.rows[0]);
      await audit(client, record.secretRef, "REVOKED", record.purpose,
        input.workloadSpiffeId, input.bindingDigest, input.at);
      return record;
    });
  }

  async active(secretRef: string, at: string): Promise<BrokerSecretRecord | null> {
    return this.#transaction(async (client) => {
      const selected = await client.query<RecordRow>(
        `SELECT * FROM deviludo.secret_broker_records WHERE secret_ref = $1 AND state = 'ACTIVE'
          AND (expires_at IS NULL OR expires_at > $2::timestamptz) FOR SHARE`, [secretRef, at]);
      return optionalRow(selected.rows[0]);
    });
  }

  async recordLease(input: Parameters<SecretBrokerStore["recordLease"]>[0]): Promise<void> {
    await this.#transaction((client) => audit(client, input.secretRef, "LEASED", input.purpose,
      input.workloadSpiffeId, input.bindingDigest, input.at));
  }

  async probe(): Promise<void> {
    const client = await this.pool.connect();
    try { const result = await client.query<{ ready: number }>("SELECT 1 AS ready"); if (result.rows[0]?.ready !== 1) conflict(); }
    finally { client.release(); }
  }

  async #transaction<T>(operation: (client: PostgresWorkflowClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try { await client.query("BEGIN"); const result = await operation(client); await client.query("COMMIT"); return result; }
    catch (error) { try { await client.query("ROLLBACK"); } catch { /* preserve */ } throw error; }
    finally { client.release(); }
  }
}

export class MemorySecretBrokerStore implements SecretBrokerStore {
  readonly records = new Map<string, BrokerSecretRecord>();
  readonly writeKeys = new Map<string, string>();
  readonly audit: Array<Readonly<Record<string, string>>> = [];

  async reserveWrite(input: Parameters<SecretBrokerStore["reserveWrite"]>[0]): Promise<BrokerWriteReservation> {
    const existingRef = this.writeKeys.get(input.writeKey);
    if (existingRef) {
      const existing = this.records.get(existingRef)!;
      assertWriteBinding(existing, input);
      if (existing.state === "ACTIVE") return { kind: "REPLAY", record: existing, claimToken: null };
      if (existing.state !== "PENDING" || (existing.claimToken !== input.claimToken && existing.claimExpiresAt
        && Date.parse(existing.claimExpiresAt) > Date.parse(input.at))) conflict();
      const claimed = freezeRecord({ ...existing, claimToken: input.claimToken, claimExpiresAt: input.claimExpiresAt });
      this.records.set(existingRef, claimed);
      return { kind: "CLAIMED", record: claimed, claimToken: input.claimToken };
    }
    const record = freezeRecord({ id: input.id, secretRef: secretRefFor(input.id), backendPath: backendPathFor(input.id),
      writeKey: input.writeKey, purpose: input.purpose, plaintextDigest: input.plaintextDigest, state: "PENDING",
      claimToken: input.claimToken, claimExpiresAt: input.claimExpiresAt, expiresAt: input.expiresAt,
      createdAt: input.at, activatedAt: null, consumedAt: null, revokedAt: null });
    this.records.set(record.secretRef, record); this.writeKeys.set(input.writeKey, record.secretRef);
    return { kind: "CLAIMED", record, claimToken: input.claimToken };
  }
  async activate(input: Parameters<SecretBrokerStore["activate"]>[0]) {
    const record = this.require(input.secretRef);
    if (record.state !== "PENDING" || record.claimToken !== input.claimToken) conflict();
    const active = freezeRecord({ ...record, state: "ACTIVE", claimToken: null, claimExpiresAt: null, activatedAt: input.at });
    this.records.set(input.secretRef, active); this.addAudit(input, "CREATED", active.purpose); return active;
  }
  async releaseWrite(secretRef: string, claimToken: string) { const record = this.records.get(secretRef); if (record?.state === "PENDING" && record.claimToken === claimToken) this.records.set(secretRef, freezeRecord({ ...record, claimToken: null, claimExpiresAt: null })); }
  async claimTake(input: Parameters<SecretBrokerStore["claimTake"]>[0]) {
    const record = this.records.get(input.secretRef);
    if (!record || record.purpose !== "github-pkce-v1" || ["PENDING", "CONSUMED", "REVOKED"].includes(record.state)
      || (record.expiresAt && Date.parse(record.expiresAt) <= Date.parse(input.at))) return null;
    if (record.state === "TAKE_CLAIMED" && record.claimExpiresAt && Date.parse(record.claimExpiresAt) > Date.parse(input.at)) conflict();
    const claimed = freezeRecord({ ...record, state: "TAKE_CLAIMED", claimToken: input.claimToken, claimExpiresAt: input.claimExpiresAt });
    this.records.set(input.secretRef, claimed); return { record: claimed, claimToken: input.claimToken };
  }
  async releaseTake(secretRef: string, claimToken: string) { const record = this.records.get(secretRef); if (record?.state === "TAKE_CLAIMED" && record.claimToken === claimToken) this.records.set(secretRef, freezeRecord({ ...record, state: "ACTIVE", claimToken: null, claimExpiresAt: null })); }
  async claimExpiredPkce(input: Parameters<SecretBrokerStore["claimExpiredPkce"]>[0]) {
    const expired = [...this.records.values()]
      .filter((record) => record.purpose === "github-pkce-v1" && record.expiresAt
        && Date.parse(record.expiresAt) <= Date.parse(input.at)
        && (record.state === "ACTIVE" || (record.state === "TAKE_CLAIMED" && record.claimExpiresAt
          && Date.parse(record.claimExpiresAt) <= Date.parse(input.at))))
      .sort((left, right) => left.expiresAt!.localeCompare(right.expiresAt!) || left.secretRef.localeCompare(right.secretRef))
      .slice(0, input.limit)
      .map((record) => freezeRecord({ ...record, state: "TAKE_CLAIMED", claimToken: input.claimToken,
        claimExpiresAt: input.claimExpiresAt }));
    for (const record of expired) this.records.set(record.secretRef, record);
    return expired;
  }
  async completeExpiredPkce(input: Parameters<SecretBrokerStore["completeExpiredPkce"]>[0]) {
    const record = this.require(input.secretRef);
    if (record.purpose !== "github-pkce-v1" || record.state !== "TAKE_CLAIMED"
      || record.claimToken !== input.claimToken) conflict();
    this.records.set(record.secretRef, freezeRecord({ ...record, state: "REVOKED", claimToken: null,
      claimExpiresAt: null, revokedAt: input.at }));
    this.addAudit(input, "REVOKED", record.purpose);
  }
  async consume(input: Parameters<SecretBrokerStore["consume"]>[0]) { const record = this.require(input.secretRef); if (record.state !== "TAKE_CLAIMED" || record.claimToken !== input.claimToken) conflict(); this.records.set(input.secretRef, freezeRecord({ ...record, state: "CONSUMED", claimToken: null, claimExpiresAt: null, consumedAt: input.at })); this.addAudit(input, "CONSUMED", record.purpose); }
  async revoke(input: Parameters<SecretBrokerStore["revoke"]>[0]) { const record = this.records.get(input.secretRef); if (!record || record.state === "REVOKED" || record.state === "CONSUMED") return record ?? null; const revoked = freezeRecord({ ...record, state: "REVOKED", claimToken: null, claimExpiresAt: null, revokedAt: input.at }); this.records.set(input.secretRef, revoked); this.addAudit(input, "REVOKED", record.purpose); return revoked; }
  async active(secretRef: string, at: string) { const record = this.records.get(secretRef); return record?.state === "ACTIVE" && (!record.expiresAt || Date.parse(record.expiresAt) > Date.parse(at)) ? record : null; }
  async recordLease(input: Parameters<SecretBrokerStore["recordLease"]>[0]) { this.addAudit(input, "LEASED", input.purpose); }
  async probe() {}
  private require(ref: string) { const record = this.records.get(ref); if (!record) conflict(); return record; }
  private addAudit(input: { secretRef: string; workloadSpiffeId: string; bindingDigest: string; at: string }, action: string, purpose: BrokerAuditPurpose) { this.audit.push(Object.freeze({ secretRef: input.secretRef, action, purpose, workloadSpiffeId: input.workloadSpiffeId, bindingDigest: input.bindingDigest, at: input.at })); }
}

async function audit(client: PostgresWorkflowClient, secretRef: string, action: string, purpose: BrokerAuditPurpose,
  workload: string, bindingDigest: string, at: string): Promise<void> {
  await client.query(
    `INSERT INTO deviludo.secret_broker_audit
      (id, secret_ref, action, purpose, workload_spiffe_id, binding_digest, occurred_at)
     VALUES ($1::uuid, $2, $3, $4, $5, $6, $7::timestamptz)`,
    [randomUUID(), secretRef, action, purpose, workload, bindingDigest, at],
  );
}
function parseRow(row: RecordRow | undefined): BrokerSecretRecord { if (!row) conflict(); return freezeRecord({
  id: row.id, secretRef: row.secret_ref, backendPath: row.backend_path, writeKey: row.write_key,
  purpose: row.purpose, plaintextDigest: row.plaintext_digest, state: row.state, claimToken: row.claim_token,
  claimExpiresAt: iso(row.claim_expires_at), expiresAt: iso(row.expires_at), createdAt: requiredIso(row.created_at),
  activatedAt: iso(row.activated_at), consumedAt: iso(row.consumed_at), revokedAt: iso(row.revoked_at),
}); }
function optionalRow(row: RecordRow | undefined): BrokerSecretRecord | null { return row ? parseRow(row) : null; }
function freezeRecord(record: BrokerSecretRecord): BrokerSecretRecord { return Object.freeze(record); }
function secretRefFor(id: string): string { return `vault://kv/deviludo/records/${id}`; }
function backendPathFor(id: string): string { return `records/${id}`; }
function assertWriteBinding(record: BrokerSecretRecord, input: { purpose: string; plaintextDigest: string; expiresAt: string | null }): void { if (record.purpose !== input.purpose || record.plaintextDigest !== input.plaintextDigest || record.expiresAt !== input.expiresAt) conflict(); }
function iso(value: string | Date | null): string | null { return value === null ? null : requiredIso(value); }
function requiredIso(value: string | Date): string { const result = new Date(value).toISOString(); if (!Number.isFinite(Date.parse(result))) conflict(); return result; }
function conflict(): never { throw new SecretBrokerConflictError("Secret Broker operation conflicts with immutable state"); }
