import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import type {
  PostgresQueryResult,
  PostgresWorkflowClient,
  PostgresWorkflowPool,
} from "../../temporal/src/postgres-inbox";
import { PostgresReadinessFixture } from "../../temporal/test/postgres-readiness-fixture";
import { sha256Canonical, signCanonical } from "../../runner-control/src/canonical";
import {
  validateSteamDepotFinalizerHostActuationReceipt,
  verifySteamDepotFinalizerHostActivationGrant,
  type SteamDepotFinalizerHostActivationRequest,
} from "../src/host-activation";
import {
  MtlsSteamDepotFinalizerHostActivationSigner,
  PostgresSteamDepotFinalizerHostActivations,
} from "../src/postgres-host-activations";

const keys = generateKeyPairSync("ed25519");
const keyId = "steam-finalizer-host-activation-key-2026-01";
const identity = Object.freeze({
  spiffeId: "spiffe://deviludo.internal/steam-depot-finalizer/linux-01",
  certificateFingerprint: "9".repeat(64),
});

test("PostgreSQL host activation drains global claims before issuing one host-bound grant", async () => {
  const client = new ActivationFixture();
  const authority = new PostgresSteamDepotFinalizerHostActivations(pool(client), signer());
  const request = activationRequest();
  client.activeOperationCount = 2;
  const draining = await authority.authorize(identity, request, "2026-07-26T00:00:00.000Z");
  assert.deepEqual(draining, {
    schemaVersion: "deviludo.steam-depot-finalizer-host-drain-receipt.v1",
    operationId: request.operationId,
    hostId: request.hostId,
    state: "DRAINING",
    activeOperationCount: 2,
    observedAt: "2026-07-26T00:00:00.000Z",
    retryAfterSeconds: 5,
  });
  assert.equal(client.grant, null);

  client.activeOperationCount = 0;
  const grant = await authority.authorize(identity, request, "2026-07-26T00:00:01.000Z");
  if (!("payload" in grant)) assert.fail("expected activation grant");
  const verified = verifySteamDepotFinalizerHostActivationGrant(grant, {
    publicKey: keys.publicKey, keyId, request, now: new Date("2026-07-26T00:00:02.000Z"),
  });
  assert.equal(verified.payload.activeOperationCount, 0);
  assert.equal(verified.payload.hostCertificateFingerprint, identity.certificateFingerprint);
  assert.equal(client.operation?.state, "ACTIVATION_AUTHORIZED");
  assert.ok(client.statements.some((statement) => statement.includes("steam_depot_finalizer_active_claims")));

  const replay = await authority.authorize(identity, request, "2026-07-26T00:00:03.000Z");
  assert.deepEqual(replay, grant);
  assert.equal(client.signatures, 1);
});

test("PostgreSQL host activation persists one immutable success receipt and rejects another host", async () => {
  const client = new ActivationFixture();
  const authority = new PostgresSteamDepotFinalizerHostActivations(pool(client), signer());
  const request = activationRequest();
  const grant = await authority.authorize(identity, request, "2026-07-26T00:00:00.000Z");
  if (!("payload" in grant)) assert.fail("expected activation grant");
  const receipt = actuationReceipt(grant);
  const completed = await authority.complete(identity, grant, receipt, "2026-07-26T00:01:00.000Z");
  assert.deepEqual(completed, validateSteamDepotFinalizerHostActuationReceipt(receipt, grant));
  assert.equal(client.operation?.state, "ACTIVATED");
  assert.deepEqual(await authority.complete(identity, grant, receipt, "2026-07-26T01:00:00.000Z"), receipt);
  await assert.rejects(authority.complete({ ...identity, certificateFingerprint: "8".repeat(64) }, grant, receipt),
    /host activation is invalid/);
});

test("PostgreSQL host activation rejects identity mismatch and invalid claim counts before signing", async () => {
  const client = new ActivationFixture();
  const authority = new PostgresSteamDepotFinalizerHostActivations(pool(client), signer());
  await assert.rejects(authority.authorize({ ...identity, spiffeId: "spiffe://deviludo.internal/forged-host" },
    activationRequest()), /host activation is invalid/);
  assert.equal(client.statements.length, 0);

  client.activeOperationCount = Number.NaN;
  await assert.rejects(authority.authorize(identity, activationRequest(), "2026-07-26T00:00:00.000Z"),
    /host activation is invalid/);
  assert.equal(client.signatures, 0);
  assert.ok(client.statements.includes("ROLLBACK"));
});

test("PostgreSQL host activation rejects completion from a superseded expired grant", async () => {
  const client = new ActivationFixture();
  const authority = new PostgresSteamDepotFinalizerHostActivations(pool(client), signer());
  const first = await authority.authorize(identity, activationRequest(), "2026-07-26T00:00:00.000Z");
  if (!("payload" in first)) assert.fail("expected activation grant");
  const replacement = await authority.authorize(identity, activationRequest(), "2026-07-26T00:11:00.000Z");
  if (!("payload" in replacement)) assert.fail("expected replacement activation grant");
  assert.equal(replacement.payload.grantSequence, 2);
  assert.equal(client.signatures, 2);
  await assert.rejects(authority.complete(identity, first,
    actuationReceipt(first, "2026-07-26T00:11:30.000Z"), "2026-07-26T00:11:30.000Z"),
  /host activation is invalid/);
});

test("actuation receipt validation does not trust an unvalidated grant payload", () => {
  const malformedGrant = {
    schemaVersion: "deviludo.steam-depot-finalizer-host-activation-grant.v1",
    algorithm: "Ed25519",
    keyId,
    payload: { ...activationRequest(), schemaVersion: "forged" },
    signature: "x".repeat(86),
  } as never;
  assert.throws(() => validateSteamDepotFinalizerHostActuationReceipt({}, malformedGrant),
    /host activation grant .* is invalid/);
});

test("Finalizer host activation readiness requires the claim projection and immutable authority ledger", async () => {
  const ready = new PostgresReadinessFixture();
  const authority = new PostgresSteamDepotFinalizerHostActivations(ready, signer());
  await authority.probe();
  assert.deepEqual(ready.observedRelations(), [
    "steam_depot_finalizer_active_claims",
    "steam_depot_finalizer_host_activation_grants",
    "steam_depot_finalizer_host_activation_operations",
    "steam_depot_finalizer_host_activation_results",
  ]);
  const missing = new PostgresReadinessFixture("steam_depot_finalizer_host_activation_grants");
  await assert.rejects(new PostgresSteamDepotFinalizerHostActivations(missing, signer()).probe());
});

test("host activation signer delegates to one mTLS KMS route and verifies the returned signature", async () => {
  const calls: URL[] = [];
  const remote = new MtlsSteamDepotFinalizerHostActivationSigner({
    endpoint: "https://host-activation-kms.internal/",
    keyId,
    publicKey: keys.publicKey,
    tls: { key: Buffer.alloc(64), certificate: Buffer.alloc(64), ca: Buffer.alloc(64) },
    http: async (input) => {
      calls.push(input.url);
      if (input.method === "GET") return {
        statusCode: 200,
        payload: { schemaVersion: "deviludo.steam-depot-finalizer-host-activation-signer-health.v1",
          status: "ok", keyId, algorithm: "Ed25519" },
      };
      const body = JSON.parse(input.body) as { payload: Readonly<Record<string, unknown>>; payloadDigest: string };
      return { statusCode: 200, payload: {
        schemaVersion: "deviludo.steam-depot-finalizer-host-activation-sign-receipt.v1",
        keyId, algorithm: "Ed25519", payloadDigest: body.payloadDigest,
        signature: signCanonical(keys.privateKey, body.payload),
      } };
    },
  });
  const payload = { operationId: "00000000-0000-4000-8000-000000000099", planDigest: "1".repeat(64) };
  assert.equal((await remote.sign(payload)).length, 86);
  await remote.probe();
  assert.deepEqual(calls.map(({ pathname }) => pathname), [
    "/v1/steam-depot-finalizer-host-activations/sign-ed25519", "/healthz",
  ]);
  assert.throws(() => new MtlsSteamDepotFinalizerHostActivationSigner({
    endpoint: "http://host-activation-kms.internal/", keyId, publicKey: keys.publicKey,
    tls: { key: Buffer.alloc(64), certificate: Buffer.alloc(64), ca: Buffer.alloc(64) },
  }), /host activation is invalid/);

  const forged = new MtlsSteamDepotFinalizerHostActivationSigner({
    endpoint: "https://host-activation-kms.internal/", keyId, publicKey: keys.publicKey,
    tls: { key: Buffer.alloc(64), certificate: Buffer.alloc(64), ca: Buffer.alloc(64) },
    http: async () => ({ statusCode: 200, payload: {
      schemaVersion: "deviludo.steam-depot-finalizer-host-activation-sign-receipt.v1",
      keyId, algorithm: "Ed25519", payloadDigest: sha256Canonical(payload), signature: "x".repeat(86),
    } }),
  });
  await assert.rejects(forged.sign(payload), /host activation is invalid/);
});

class ActivationFixture implements PostgresWorkflowClient {
  statements: string[] = [];
  activeOperationCount = 0;
  signatures = 0;
  operation: Record<string, unknown> | null = null;
  grant: unknown | null = null;
  grantExpiresAt: string | null = null;
  grantSequence = 0;
  receipt: unknown | null = null;

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<PostgresQueryResult<Row>> {
    this.statements.push(text);
    if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") return result<Row>(1, []);
    if (text.includes("INSERT INTO deviludo.steam_depot_finalizer_host_activation_operations")) {
      if (!this.operation) this.operation = {
        id: values[0], host_id: values[1], host_spiffe_id: values[2], host_certificate_fingerprint: values[3],
        platform: values[4], architecture: values[5], operation_state: values[6],
        request: JSON.parse(values[17] as string), request_digest: values[18], state: "DRAINING", completed_at: null,
      };
      return result<Row>(1, []);
    }
    if (text.includes("FROM deviludo.steam_depot_finalizer_host_activation_operations")) {
      return result<Row>(this.operation ? 1 : 0, this.operation ? [this.operation as Row] : []);
    }
    if (text.includes("FROM deviludo.steam_depot_finalizer_active_claims")) {
      return result<Row>(1, [{ active_operation_count: this.activeOperationCount } as unknown as Row]);
    }
    if (text.includes("FROM deviludo.steam_depot_finalizer_host_activation_grants")
      && text.includes("expires_at")) {
      const valid = this.grant && this.grantExpiresAt
        && Date.parse(this.grantExpiresAt) > Date.parse(String(values[1]));
      return result<Row>(valid ? 1 : 0, valid ? [{ grant: this.grant } as unknown as Row] : []);
    }
    if (text.includes("COALESCE(MAX(grant_sequence)")) {
      return result<Row>(1, [{ next_sequence: this.grantSequence + 1 } as unknown as Row]);
    }
    if (text.includes("INSERT INTO deviludo.steam_depot_finalizer_host_activation_grants")) {
      this.grant = JSON.parse(values[2] as string); this.grantSequence = Number(values[1]);
      this.grantExpiresAt = String(values[7]); this.signatures += 1; return result<Row>(1, []);
    }
    if (text.includes("SET state = 'ACTIVATION_AUTHORIZED'")) {
      if (!this.operation) return result<Row>(0, []);
      this.operation.state = "ACTIVATION_AUTHORIZED"; return result<Row>(1, []);
    }
    if (text.includes("FROM deviludo.steam_depot_finalizer_host_activation_results")) {
      return result<Row>(this.receipt ? 1 : 0, this.receipt
        ? [{ receipt: this.receipt, receipt_digest: (this.receipt as { receiptDigest: string }).receiptDigest } as unknown as Row] : []);
    }
    if (text.includes("SELECT grant FROM deviludo.steam_depot_finalizer_host_activation_grants")) {
      return result<Row>(this.grant ? 1 : 0, this.grant ? [{ grant: this.grant } as unknown as Row] : []);
    }
    if (text.includes("INSERT INTO deviludo.steam_depot_finalizer_host_activation_results")) {
      this.receipt = JSON.parse(values[3] as string); return result<Row>(1, []);
    }
    if (text.includes("SET state = $2")) {
      if (!this.operation) return result<Row>(0, []);
      this.operation.state = values[1]; this.operation.completed_at = values[2]; return result<Row>(1, []);
    }
    throw new Error(`Unexpected SQL: ${text}`);
  }

  release(): void {}
}

function signer() {
  return {
    keyId,
    publicKey: keys.publicKey,
    async sign(payload: Readonly<Record<string, unknown>>) { return signCanonical(keys.privateKey, payload); },
  };
}

function activationRequest(): SteamDepotFinalizerHostActivationRequest {
  return {
    schemaVersion: "deviludo.steam-depot-finalizer-host-activation-request.v1",
    operationId: "00000000-0000-4000-8000-000000000099",
    hostId: "steam-finalizer-linux-01",
    hostSpiffeId: identity.spiffeId,
    hostCertificateFingerprint: identity.certificateFingerprint,
    planDigest: "1".repeat(64),
    transactionDigest: "2".repeat(64),
    stagingReceiptDigest: "3".repeat(64),
    releaseId: "00000000-0000-4000-8000-000000000001",
    serviceReleaseDigest: "4".repeat(64),
    nativeReleaseDigest: "5".repeat(64),
    platform: "linux",
    architecture: "x86_64",
    operationState: "INITIALIZING",
    previousPlanDigest: null,
    previousDefinitionDigest: null,
    definitionDigest: "6".repeat(64),
    receiptPath: "/var/lib/deviludo/steam-depot-finalizer/activation-receipt.json",
  };
}

function actuationReceipt(
  grant: Extract<Awaited<ReturnType<PostgresSteamDepotFinalizerHostActivations["authorize"]>>, { payload: unknown }>,
  completedAt = "2026-07-26T00:01:00.000Z",
) {
  const payload = grant.payload;
  const core = {
    schemaVersion: "deviludo.steam-depot-finalizer-host-actuation-receipt.v1",
    state: "ACTIVATED" as const,
    operationId: payload.operationId,
    grantSequence: payload.grantSequence,
    hostId: payload.hostId,
    hostSpiffeId: payload.hostSpiffeId,
    hostCertificateFingerprint: payload.hostCertificateFingerprint,
    transactionDigest: payload.transactionDigest,
    planDigest: payload.planDigest,
    stagingReceiptDigest: payload.stagingReceiptDigest,
    releaseId: payload.releaseId,
    platform: payload.platform,
    architecture: payload.architecture,
    previousDefinitionDigest: payload.previousDefinitionDigest,
    failureDigest: null,
    completedAt,
  };
  return Object.freeze({ ...core, receiptDigest: sha256Canonical(core) });
}

function pool(client: PostgresWorkflowClient): PostgresWorkflowPool {
  return { async connect() { return client; } };
}
function result<Row extends Record<string, unknown>>(rowCount: number, rows: readonly Row[]): PostgresQueryResult<Row> {
  return { rowCount, rows };
}
