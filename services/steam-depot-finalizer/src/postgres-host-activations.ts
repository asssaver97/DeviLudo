import { type KeyObject } from "node:crypto";
import type { PostgresWorkflowClient, PostgresWorkflowPool } from "../../temporal/src/postgres-inbox";
import { probePostgresRelations } from "../../temporal/src/postgres-readiness";
import { sha256Canonical, verifyCanonical } from "../../runner-control/src/canonical";
import {
  testKitArtifactBrokerHttpsJson,
  type TestKitArtifactBrokerHttp,
  type TestKitArtifactBrokerTls,
} from "../../runner-control/src/testkit-artifact-client";
import {
  createSteamDepotFinalizerHostActivationGrantPayload,
  createSteamDepotFinalizerHostDrainReceipt,
  steamDepotFinalizerHostActivationRequestDigest,
  validateSteamDepotFinalizerHostActivationRequest,
  validateSteamDepotFinalizerHostActuationReceipt,
  verifySteamDepotFinalizerHostActivationGrant,
  type SignedSteamDepotFinalizerHostActivationGrant,
  type SteamDepotFinalizerHostActivationRequest,
  type SteamDepotFinalizerHostActuationReceipt,
  type SteamDepotFinalizerHostDrainReceipt,
} from "./host-activation";

const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{2,159}$/;

export interface SteamDepotFinalizerHostActivationIdentity {
  readonly spiffeId: string;
  readonly certificateFingerprint: string;
}

export interface SteamDepotFinalizerHostActivationSigner {
  readonly keyId: string;
  readonly publicKey: KeyObject;
  sign(payload: Readonly<Record<string, unknown>>): Promise<string>;
}

export class MtlsSteamDepotFinalizerHostActivationSigner
implements SteamDepotFinalizerHostActivationSigner {
  readonly keyId: string;
  readonly publicKey: KeyObject;
  readonly #endpoint: URL;
  readonly #tls: TestKitArtifactBrokerTls;
  readonly #timeoutMs: number;
  readonly #http: TestKitArtifactBrokerHttp;

  constructor(options: Readonly<{
    endpoint: string | URL;
    keyId: string;
    publicKey: KeyObject;
    tls: TestKitArtifactBrokerTls;
    timeoutMs?: number;
    http?: TestKitArtifactBrokerHttp;
  }>) {
    this.#endpoint = strictOrigin(options.endpoint);
    if (!SAFE_ID.test(options.keyId) || options.publicKey?.type !== "public"
      || options.publicKey.asymmetricKeyType !== "ed25519") invalid();
    validateTls(options.tls);
    this.keyId = options.keyId;
    this.publicKey = options.publicKey;
    this.#tls = Object.freeze({ ...options.tls });
    this.#timeoutMs = integer(options.timeoutMs ?? 30_000, 1_000, 60_000);
    this.#http = options.http ?? testKitArtifactBrokerHttpsJson;
  }

  async sign(payload: Readonly<Record<string, unknown>>): Promise<string> {
    const payloadDigest = sha256Canonical(payload);
    const url = new URL(this.#endpoint.href);
    url.pathname = "/v1/steam-depot-finalizer-host-activations/sign-ed25519";
    const response = await this.#http({
      url,
      body: JSON.stringify({
        schemaVersion: "deviludo.steam-depot-finalizer-host-activation-sign-request.v1",
        keyId: this.keyId,
        algorithm: "Ed25519",
        payloadDigest,
        payload,
      }),
      tls: this.#tls,
      timeoutMs: this.#timeoutMs,
    });
    const body = record(response.payload);
    exactKeys(body, ["algorithm", "keyId", "payloadDigest", "schemaVersion", "signature"]);
    if (response.statusCode !== 200
      || body.schemaVersion !== "deviludo.steam-depot-finalizer-host-activation-sign-receipt.v1"
      || body.keyId !== this.keyId || body.algorithm !== "Ed25519" || body.payloadDigest !== payloadDigest
      || typeof body.signature !== "string" || body.signature.length !== 86
      || !verifyCanonical(this.publicKey, payload, body.signature)) invalid();
    return body.signature;
  }

  async probe(): Promise<void> {
    const url = new URL(this.#endpoint.href); url.pathname = "/healthz";
    const response = await this.#http({ url, method: "GET", body: "{}", tls: this.#tls, timeoutMs: this.#timeoutMs });
    const body = record(response.payload);
    exactKeys(body, ["algorithm", "keyId", "schemaVersion", "status"]);
    if (response.statusCode !== 200
      || body.schemaVersion !== "deviludo.steam-depot-finalizer-host-activation-signer-health.v1"
      || body.status !== "ok" || body.keyId !== this.keyId || body.algorithm !== "Ed25519") invalid();
  }
}

type OperationRow = {
  id: string;
  host_id: string;
  host_spiffe_id: string;
  host_certificate_fingerprint: string;
  platform: string;
  architecture: string;
  operation_state: string;
  request: unknown;
  request_digest: string;
  state: string;
  completed_at: string | null;
};

type GrantRow = { grant: unknown };
type ResultRow = { receipt: unknown; receipt_digest: string };

export class PostgresSteamDepotFinalizerHostActivations {
  readonly #durationMs: number;

  constructor(
    private readonly pool: PostgresWorkflowPool,
    private readonly signer: SteamDepotFinalizerHostActivationSigner,
    grantDurationSeconds = 600,
  ) {
    if (!SAFE_ID.test(signer.keyId) || signer.publicKey?.type !== "public"
      || signer.publicKey.asymmetricKeyType !== "ed25519" || !Number.isSafeInteger(grantDurationSeconds)
      || grantDurationSeconds < 60 || grantDurationSeconds > 900 || typeof signer.sign !== "function") invalid();
    this.#durationMs = grantDurationSeconds * 1_000;
  }

  async authorize(
    identity: SteamDepotFinalizerHostActivationIdentity,
    requestValue: unknown,
    at = new Date().toISOString(),
  ): Promise<SteamDepotFinalizerHostDrainReceipt | SignedSteamDepotFinalizerHostActivationGrant> {
    const request = validateSteamDepotFinalizerHostActivationRequest(requestValue);
    const requestDigest = steamDepotFinalizerHostActivationRequestDigest(request);
    assertIdentity(identity, request);
    const observedAt = timestamp(at);
    return this.#transaction(async (client) => {
      await client.query(
        `INSERT INTO deviludo.steam_depot_finalizer_host_activation_operations
          (id, host_id, host_spiffe_id, host_certificate_fingerprint, platform, architecture,
           operation_state, plan_digest, transaction_digest, staging_receipt_digest, release_id,
           service_release_digest, native_release_digest, previous_plan_digest,
           previous_definition_digest, definition_digest, receipt_path, request, request_digest,
           state, requested_at)
         VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::uuid, $12, $13,
                 $14, $15, $16, $17, $18::jsonb, $19, 'DRAINING', $20::timestamptz)
         ON CONFLICT (id) DO NOTHING`,
        [
          request.operationId, request.hostId, request.hostSpiffeId, request.hostCertificateFingerprint,
          request.platform, request.architecture, request.operationState, request.planDigest,
          request.transactionDigest, request.stagingReceiptDigest, request.releaseId,
          request.serviceReleaseDigest, request.nativeReleaseDigest, request.previousPlanDigest,
          request.previousDefinitionDigest, request.definitionDigest, request.receiptPath,
          JSON.stringify(request), requestDigest, observedAt,
        ],
      );
      const selected = await client.query<OperationRow>(
        `SELECT id::text, host_id, host_spiffe_id, host_certificate_fingerprint::text,
                platform, architecture, operation_state, request, request_digest::text,
                state, completed_at::text
           FROM deviludo.steam_depot_finalizer_host_activation_operations
          WHERE id = $1::uuid
             OR (host_id = $2 AND state IN ('DRAINING', 'ACTIVATION_AUTHORIZED'))
          FOR UPDATE`,
        [request.operationId, request.hostId],
      );
      if (selected.rows.length !== 1) invalid();
      const operation = selected.rows[0]!;
      assertOperation(operation, request, requestDigest);
      if (!new Set(["DRAINING", "ACTIVATION_AUTHORIZED"]).has(operation.state)) invalid();

      const active = await client.query<{ active_operation_count: string | number }>(
        `SELECT COUNT(*) AS active_operation_count
           FROM deviludo.steam_depot_finalizer_active_claims
          WHERE platform = $1 AND claim_expires_at >= $2::timestamptz`,
        [request.platform, observedAt],
      );
      const activeOperationCount = Number(active.rows[0]?.active_operation_count);
      if (!Number.isSafeInteger(activeOperationCount) || activeOperationCount < 0) invalid();
      if (activeOperationCount > 0) {
        return createSteamDepotFinalizerHostDrainReceipt({
          request, activeOperationCount, observedAt, retryAfterSeconds: 5,
        });
      }

      const replay = await client.query<GrantRow>(
        `SELECT grant
           FROM deviludo.steam_depot_finalizer_host_activation_grants
          WHERE operation_id = $1::uuid AND expires_at > $2::timestamptz
          ORDER BY grant_sequence DESC LIMIT 1 FOR SHARE`,
        [request.operationId, observedAt],
      );
      if (replay.rows[0]) return verifySteamDepotFinalizerHostActivationGrant(replay.rows[0].grant, {
        publicKey: this.signer.publicKey, keyId: this.signer.keyId, request, now: new Date(observedAt),
      });
      const sequence = await client.query<{ next_sequence: string | number }>(
        `SELECT COALESCE(MAX(grant_sequence), 0) + 1 AS next_sequence
           FROM deviludo.steam_depot_finalizer_host_activation_grants
          WHERE operation_id = $1::uuid`,
        [request.operationId],
      );
      const grantSequence = Number(sequence.rows[0]?.next_sequence);
      if (!Number.isSafeInteger(grantSequence) || grantSequence < 1) invalid();
      const expiresAt = new Date(Date.parse(observedAt) + this.#durationMs).toISOString();
      const payload = createSteamDepotFinalizerHostActivationGrantPayload({
        request, grantSequence, issuedAt: observedAt, expiresAt,
      });
      const signature = await this.signer.sign(payload as unknown as Readonly<Record<string, unknown>>);
      const grant = verifySteamDepotFinalizerHostActivationGrant({
        schemaVersion: "deviludo.steam-depot-finalizer-host-activation-grant.v1",
        algorithm: "Ed25519",
        keyId: this.signer.keyId,
        payload,
        signature,
      }, { publicKey: this.signer.publicKey, keyId: this.signer.keyId, request, now: new Date(observedAt) });
      await client.query(
        `INSERT INTO deviludo.steam_depot_finalizer_host_activation_grants
          (operation_id, grant_sequence, grant, grant_digest, signing_key_id, signature, issued_at, expires_at)
         VALUES ($1::uuid, $2, $3::jsonb, $4, $5, $6, $7::timestamptz, $8::timestamptz)`,
        [request.operationId, grantSequence, JSON.stringify(grant), sha256Canonical(grant),
          this.signer.keyId, signature, observedAt, expiresAt],
      );
      const updated = await client.query(
        `UPDATE deviludo.steam_depot_finalizer_host_activation_operations
            SET state = 'ACTIVATION_AUTHORIZED', authorized_at = COALESCE(authorized_at, $2::timestamptz)
          WHERE id = $1::uuid AND state IN ('DRAINING', 'ACTIVATION_AUTHORIZED')`,
        [request.operationId, observedAt],
      );
      if (updated.rowCount !== 1) invalid();
      return grant;
    });
  }

  async complete(
    identity: SteamDepotFinalizerHostActivationIdentity,
    grantValue: unknown,
    receiptValue: unknown,
    at = new Date().toISOString(),
  ): Promise<SteamDepotFinalizerHostActuationReceipt> {
    const completedAt = timestamp(at);
    const grant = verifySteamDepotFinalizerHostActivationGrant(grantValue, {
      publicKey: this.signer.publicKey, keyId: this.signer.keyId, now: new Date(completedAt), allowExpired: true,
    });
    if (identity.spiffeId !== grant.payload.hostSpiffeId
      || identity.certificateFingerprint !== grant.payload.hostCertificateFingerprint) invalid();
    const receipt = validateSteamDepotFinalizerHostActuationReceipt(receiptValue, grant);
    return this.#transaction(async (client) => {
      const selected = await client.query<OperationRow>(
        `SELECT id::text, host_id, host_spiffe_id, host_certificate_fingerprint::text,
                platform, architecture, operation_state, request, request_digest::text,
                state, completed_at::text
           FROM deviludo.steam_depot_finalizer_host_activation_operations
          WHERE id = $1::uuid FOR UPDATE`,
        [grant.payload.operationId],
      );
      if (selected.rows.length !== 1) invalid();
      const operation = selected.rows[0]!;
      const request = validateSteamDepotFinalizerHostActivationRequest(operation.request);
      assertOperation(operation, request, steamDepotFinalizerHostActivationRequestDigest(request));
      assertIdentity(identity, request);
      verifySteamDepotFinalizerHostActivationGrant(grant, {
        publicKey: this.signer.publicKey, keyId: this.signer.keyId, request,
        now: new Date(completedAt), allowExpired: true,
      });
      const replay = await client.query<ResultRow>(
        `SELECT receipt, receipt_digest::text
           FROM deviludo.steam_depot_finalizer_host_activation_results
          WHERE operation_id = $1::uuid FOR SHARE`,
        [request.operationId],
      );
      if (replay.rows[0]) {
        const stored = validateSteamDepotFinalizerHostActuationReceipt(replay.rows[0].receipt, grant);
        if (stored.receiptDigest !== receipt.receiptDigest || replay.rows[0].receipt_digest !== receipt.receiptDigest) invalid();
        return stored;
      }
      if (receipt.completedAt !== completedAt) invalid();
      if (operation.state !== "ACTIVATION_AUTHORIZED") invalid();
      const storedGrant = await client.query<GrantRow>(
        `SELECT grant FROM deviludo.steam_depot_finalizer_host_activation_grants
          WHERE operation_id = $1::uuid
          ORDER BY grant_sequence DESC LIMIT 1 FOR SHARE`,
        [request.operationId],
      );
      if (!storedGrant.rows[0]
        || sha256Canonical(storedGrant.rows[0].grant) !== sha256Canonical(grant)) invalid();
      await client.query(
        `INSERT INTO deviludo.steam_depot_finalizer_host_activation_results
          (operation_id, grant_sequence, state, receipt, receipt_digest, failure_digest, completed_at)
         VALUES ($1::uuid, $2, $3, $4::jsonb, $5, $6, $7::timestamptz)`,
        [request.operationId, grant.payload.grantSequence, receipt.state, JSON.stringify(receipt),
          receipt.receiptDigest, receipt.failureDigest, receipt.completedAt],
      );
      const updated = await client.query(
        `UPDATE deviludo.steam_depot_finalizer_host_activation_operations
            SET state = $2, completed_at = $3::timestamptz
          WHERE id = $1::uuid AND state = 'ACTIVATION_AUTHORIZED'`,
        [request.operationId, receipt.state, receipt.completedAt],
      );
      if (updated.rowCount !== 1) invalid();
      return receipt;
    });
  }

  async probe(): Promise<void> {
    await probePostgresRelations(this.pool, [
      "steam_depot_finalizer_active_claims",
      "steam_depot_finalizer_host_activation_grants",
      "steam_depot_finalizer_host_activation_operations",
      "steam_depot_finalizer_host_activation_results",
    ], invalid);
  }

  async #transaction<T>(operation: (client: PostgresWorkflowClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { /* preserve original failure */ }
      throw error;
    } finally { client.release(); }
  }
}

function assertIdentity(
  identity: SteamDepotFinalizerHostActivationIdentity,
  request: SteamDepotFinalizerHostActivationRequest,
): void {
  if (!identity || identity.spiffeId !== request.hostSpiffeId
    || identity.certificateFingerprint !== request.hostCertificateFingerprint
    || !SHA256.test(identity.certificateFingerprint)) invalid();
}

function assertOperation(
  row: OperationRow,
  request: SteamDepotFinalizerHostActivationRequest,
  requestDigest: string,
): void {
  const stored = validateSteamDepotFinalizerHostActivationRequest(row.request);
  if (row.id !== request.operationId || row.host_id !== request.hostId || row.host_spiffe_id !== request.hostSpiffeId
    || row.host_certificate_fingerprint !== request.hostCertificateFingerprint || row.platform !== request.platform
    || row.architecture !== request.architecture || row.operation_state !== request.operationState
    || row.request_digest !== requestDigest || JSON.stringify(stored) !== JSON.stringify(request)) invalid();
}

function timestamp(value: string): string {
  if (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) invalid();
  return value;
}

function strictOrigin(value: string | URL): URL {
  let url: URL; try { url = new URL(value); } catch { invalid(); }
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password || url.search || url.hash
    || url.pathname !== "/") invalid();
  return url;
}
function validateTls(value: TestKitArtifactBrokerTls): void {
  if (![value?.key, value?.certificate, value?.ca].every((item) => Buffer.isBuffer(item)
    && item.byteLength >= 32 && item.byteLength <= 1024 * 1024)) invalid();
}
function integer(value: number, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) invalid();
  return value;
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}
function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) invalid();
}

function invalid(): never { throw new Error("PostgreSQL Steam depot Finalizer host activation is invalid"); }
