import { request as httpsRequest, type RequestOptions } from "node:https";
import type { IncomingHttpHeaders } from "node:http";
import type { KeyObject } from "node:crypto";
import type { Client } from "@temporalio/client";
import {
  testKitArtifactBrokerHttpsJson,
  type TestKitArtifactBrokerHttp,
  type TestKitArtifactBrokerTls,
} from "../../runner-control/src/testkit-artifact-client";
import { signalGameDelivery } from "../../temporal/src/client";
import { steamCanonicalDigest, verifySteamPublishAuthorization } from "./artifacts";
import type {
  SteamAuthenticatedLogin,
  SteamConfigVault,
  SteamGuardChallenge,
  SteamInteractiveLoginConnector,
} from "./enrollment-contracts";
import type {
  FreshMfaVerification,
  ReleaseMfaChallengeIssuer,
  ReleaseMfaVerifier,
  ReleaseMfaWorkflowSignal,
  SteamPublishAuthorizationArchive,
  SteamPublishAuthorizationSigner,
} from "./release-authorization-contracts";
import type { PostgresReleaseAuthorizationStore } from "./release-authorization-postgres";
import type { SignedSteamPublishAuthorization, SteamPublishAuthorizationClaims } from "./contracts";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const SECRET_REF = /^vault:\/\/[A-Za-z0-9._~:/?=&%-]{1,500}$/;
const NUMERIC_ID = /^[1-9][0-9]{0,19}$/;
const MAX_BINARY_RESPONSE = 1024 * 1024;

export interface SteamAccessBinaryResponse {
  readonly statusCode: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: Buffer;
}

export type SteamAccessBinaryHttp = (input: Readonly<{
  url: URL;
  method: "GET" | "POST" | "PUT" | "DELETE";
  headers?: Readonly<Record<string, string>>;
  body?: Uint8Array;
  tls: TestKitArtifactBrokerTls;
  timeoutMs: number;
  maxResponseBytes?: number;
}>) => Promise<SteamAccessBinaryResponse>;

export class MtlsSteamInteractiveLoginConnector implements SteamInteractiveLoginConnector {
  readonly #endpoint: URL;
  readonly #tls: TestKitArtifactBrokerTls;
  readonly #timeoutMs: number;
  readonly #http: SteamAccessBinaryHttp;

  constructor(options: Readonly<{
    endpoint: string | URL;
    tls: TestKitArtifactBrokerTls;
    timeoutMs?: number;
    http?: SteamAccessBinaryHttp;
  }>) {
    this.#endpoint = strictOrigin(options.endpoint);
    this.#tls = validatedTls(options.tls);
    this.#timeoutMs = integer(options.timeoutMs ?? 60_000, 1_000, 120_000);
    this.#http = options.http ?? steamAccessBinaryHttps;
  }

  async begin(input: { enrollmentId: string; accountName: string; password: Uint8Array }): Promise<SteamAuthenticatedLogin | SteamGuardChallenge> {
    return this.#login("begin", input.enrollmentId, input.password, { "x-steam-account-name": input.accountName });
  }

  async completeGuard(input: { enrollmentId: string; challengeSecretRef: string; guardCode: Uint8Array }): Promise<SteamAuthenticatedLogin> {
    if (!SECRET_REF.test(input.challengeSecretRef)) invalid("Steam login challenge");
    const result = await this.#login("guard", input.enrollmentId, input.guardCode, {
      "x-deviludo-challenge-secret-ref": input.challengeSecretRef,
    });
    if (result.kind !== "AUTHENTICATED") invalid("Steam Guard completion");
    return result;
  }

  async probe(): Promise<void> {
    const response = await this.#http({
      url: route(this.#endpoint, "/healthz"), method: "GET", tls: this.#tls,
      timeoutMs: this.#timeoutMs, maxResponseBytes: 8 * 1024,
    });
    const body = json(response.body);
    exactKeys(body, ["schemaVersion", "status"]);
    if (response.statusCode !== 200 || body.schemaVersion !== "deviludo.steam-login-connector-health.v1" || body.status !== "ok") {
      invalid("Steam login health");
    }
  }

  async #login(
    action: "begin" | "guard",
    enrollmentId: string,
    sensitive: Uint8Array,
    headers: Readonly<Record<string, string>>,
  ): Promise<SteamAuthenticatedLogin | SteamGuardChallenge> {
    if (!/^[a-f0-9-]{36}$/.test(enrollmentId) || !(sensitive instanceof Uint8Array)) invalid("Steam login request");
    const response = await this.#http({
      url: route(this.#endpoint, `/v1/steam-login/enrollments/${encodeURIComponent(enrollmentId)}/${action}`),
      method: "POST", headers, body: sensitive, tls: this.#tls, timeoutMs: this.#timeoutMs,
    });
    try {
      if (response.statusCode !== 200) invalid("Steam login response");
      const result = singleHeader(response.headers, "x-deviludo-steam-login-result");
      if (result === "guard-required") {
        const challengeSecretRef = singleHeader(response.headers, "x-deviludo-challenge-secret-ref");
        if (response.body.byteLength !== 0 || !challengeSecretRef || !SECRET_REF.test(challengeSecretRef)) invalid("Steam Guard challenge");
        return Object.freeze({ kind: "GUARD_REQUIRED", challengeSecretRef });
      }
      if (result !== "authenticated" || response.body.byteLength < 8) invalid("Steam authenticated login");
      const accountId = requiredHeader(response.headers, "x-steam-account-id", SAFE_ID);
      const accountName = requiredHeader(response.headers, "x-steam-account-name", /^[A-Za-z0-9_-]{3,64}$/);
      const allowedAppIds = listHeader(response.headers, "x-steam-allowed-app-ids", NUMERIC_ID);
      const permissions = listHeader(response.headers, "x-steam-permissions", /^(EditAppMetadata|PublishAppChanges)$/);
      if (permissions.join(",") !== "EditAppMetadata,PublishAppChanges") invalid("Steam permissions");
      const expiresAt = requiredIso(singleHeader(response.headers, "x-steam-session-expires-at"));
      return Object.freeze({
        kind: "AUTHENTICATED", accountId, accountName,
        configVdf: new Uint8Array(response.body.buffer, response.body.byteOffset, response.body.byteLength),
        allowedAppIds: Object.freeze(allowedAppIds),
        permissions: Object.freeze(permissions as ("EditAppMetadata" | "PublishAppChanges")[]),
        expiresAt,
      });
    } catch (error) {
      response.body.fill(0);
      throw error;
    }
  }
}

export class MtlsSteamConfigVault implements SteamConfigVault {
  readonly #endpoint: URL;
  readonly #tls: TestKitArtifactBrokerTls;
  readonly #timeoutMs: number;
  readonly #http: SteamAccessBinaryHttp;
  constructor(options: Readonly<{ endpoint: string | URL; tls: TestKitArtifactBrokerTls; timeoutMs?: number; http?: SteamAccessBinaryHttp }>) {
    this.#endpoint = strictOrigin(options.endpoint); this.#tls = validatedTls(options.tls);
    this.#timeoutMs = integer(options.timeoutMs ?? 30_000, 1_000, 60_000); this.#http = options.http ?? steamAccessBinaryHttps;
  }
  async write(input: { path: string; plaintext: Uint8Array }) {
    if (!/^[A-Za-z0-9][A-Za-z0-9/_-]{2,300}$/.test(input.path) || input.path.includes("..")
      || !(input.plaintext instanceof Uint8Array) || input.plaintext.byteLength < 8 || input.plaintext.byteLength > MAX_BINARY_RESPONSE) invalid("Steam Vault write");
    const response = await this.#http({ url: route(this.#endpoint, "/v1/steam-config-vdf"), method: "PUT",
      headers: { "x-deviludo-secret-path": input.path }, body: input.plaintext, tls: this.#tls,
      timeoutMs: this.#timeoutMs, maxResponseBytes: 16 * 1024 });
    const body = json(response.body); exactKeys(body, ["secretRef", "maskedFingerprint"]);
    if (response.statusCode !== 201 || typeof body.secretRef !== "string" || !SECRET_REF.test(body.secretRef)
      || typeof body.maskedFingerprint !== "string" || !/^sha256:[a-f0-9]{8}…[a-f0-9]{6}$/i.test(body.maskedFingerprint)) invalid("Steam Vault receipt");
    return Object.freeze({ secretRef: body.secretRef, maskedFingerprint: body.maskedFingerprint });
  }
  async revoke(secretRef: string): Promise<void> {
    if (!SECRET_REF.test(secretRef)) invalid("Steam Vault revoke");
    const response = await this.#http({ url: route(this.#endpoint, "/v1/steam-config-vdf"), method: "DELETE",
      headers: { "x-deviludo-secret-ref": secretRef }, tls: this.#tls, timeoutMs: this.#timeoutMs, maxResponseBytes: 8 * 1024 });
    if (response.statusCode !== 204 || response.body.byteLength !== 0) invalid("Steam Vault revoke receipt");
  }
  async probe(): Promise<void> {
    const response = await this.#http({ url: route(this.#endpoint, "/healthz"), method: "GET", tls: this.#tls,
      timeoutMs: this.#timeoutMs, maxResponseBytes: 8 * 1024 });
    const body = json(response.body); exactKeys(body, ["schemaVersion", "status"]);
    if (response.statusCode !== 200 || body.schemaVersion !== "deviludo.steam-config-vault-health.v1" || body.status !== "ok") invalid("Steam Vault health");
  }
}

export class FixedReleaseMfaChallengeIssuer implements ReleaseMfaChallengeIssuer {
  readonly #origin: URL;
  constructor(publicOrigin: string | URL) { this.#origin = strictOrigin(publicOrigin); }
  async begin(input: { approvalId: string }): Promise<{ authorizationUrl: string }> {
    if (!SAFE_ID.test(input.approvalId)) invalid("MFA approval");
    return Object.freeze({ authorizationUrl: new URL(`/approvals/${encodeURIComponent(input.approvalId)}`, this.#origin).href });
  }
}

export class MtlsReleaseMfaVerifier implements ReleaseMfaVerifier {
  readonly #endpoint: URL; readonly #tls: TestKitArtifactBrokerTls; readonly #timeoutMs: number; readonly #http: TestKitArtifactBrokerHttp;
  constructor(options: Readonly<{ endpoint: string | URL; tls: TestKitArtifactBrokerTls; timeoutMs?: number; http?: TestKitArtifactBrokerHttp }>) {
    this.#endpoint = strictOrigin(options.endpoint); this.#tls = validatedTls(options.tls);
    this.#timeoutMs = integer(options.timeoutMs ?? 30_000, 1_000, 60_000); this.#http = options.http ?? testKitArtifactBrokerHttpsJson;
  }
  async verify(input: { approvalId: string; assertion: unknown }): Promise<FreshMfaVerification> {
    if (!SAFE_ID.test(input.approvalId) || !input.assertion || typeof input.assertion !== "object" || Array.isArray(input.assertion)) invalid("MFA verification request");
    const response = await this.#http({ url: route(this.#endpoint, "/v1/steam-release-mfa/verifications"),
      body: JSON.stringify({ schemaVersion: "deviludo.steam-release-mfa-verification-request.v1", approvalId: input.approvalId, assertion: input.assertion }),
      tls: this.#tls, timeoutMs: this.#timeoutMs });
    const body = record(response.payload); exactKeys(body, ["schemaVersion", "approvalId", "userId", "assertionId", "assuranceLevel", "verifiedAt"]);
    if (response.statusCode !== 200 || body.schemaVersion !== "deviludo.steam-release-mfa-verification-receipt.v1"
      || body.approvalId !== input.approvalId || typeof body.userId !== "string" || !SAFE_ID.test(body.userId)
      || typeof body.assertionId !== "string" || !SAFE_ID.test(body.assertionId) || body.assuranceLevel !== "AAL2") invalid("MFA verification receipt");
    return Object.freeze({ approvalId: input.approvalId, userId: body.userId, assertionId: body.assertionId,
      assuranceLevel: "AAL2", verifiedAt: requiredIso(body.verifiedAt) });
  }
  async probe(): Promise<void> { await jsonHealth(this.#endpoint, this.#tls, this.#timeoutMs, this.#http,
    "deviludo.steam-release-mfa-verifier-health.v1"); }
}

export class MtlsSteamPublishAuthorizationSigner implements SteamPublishAuthorizationSigner {
  readonly #endpoint: URL; readonly #keyId: string; readonly #publicKey: KeyObject;
  readonly #tls: TestKitArtifactBrokerTls; readonly #timeoutMs: number; readonly #http: TestKitArtifactBrokerHttp;
  constructor(options: Readonly<{ endpoint: string | URL; keyId: string; publicKey: KeyObject; tls: TestKitArtifactBrokerTls; timeoutMs?: number; http?: TestKitArtifactBrokerHttp }>) {
    this.#endpoint = strictOrigin(options.endpoint); this.#keyId = options.keyId; this.#publicKey = options.publicKey;
    if (!SAFE_ID.test(this.#keyId) || this.#publicKey.type !== "public" || this.#publicKey.asymmetricKeyType !== "ed25519") invalid("authorization signing key");
    this.#tls = validatedTls(options.tls); this.#timeoutMs = integer(options.timeoutMs ?? 30_000, 1_000, 60_000);
    this.#http = options.http ?? testKitArtifactBrokerHttpsJson;
  }
  async sign(claims: SteamPublishAuthorizationClaims): Promise<SignedSteamPublishAuthorization> {
    const claimsDigest = steamCanonicalDigest(claims);
    const response = await this.#http({ url: route(this.#endpoint, "/v1/steam-publish-authorization/sign-ed25519"),
      body: JSON.stringify({ schemaVersion: "deviludo.steam-publish-authorization-sign-request.v1", keyId: this.#keyId,
        algorithm: "Ed25519", claimsDigest, claims }), tls: this.#tls, timeoutMs: this.#timeoutMs });
    const body = record(response.payload); exactKeys(body, ["schemaVersion", "keyId", "algorithm", "claimsDigest", "authorization"]);
    if (response.statusCode !== 200 || body.schemaVersion !== "deviludo.steam-publish-authorization-sign-receipt.v1"
      || body.keyId !== this.#keyId || body.algorithm !== "Ed25519" || body.claimsDigest !== claimsDigest) invalid("authorization signing receipt");
    const authorization = signedAuthorization(body.authorization);
    if (authorization.keyId !== this.#keyId || steamCanonicalDigest(authorization.claims) !== claimsDigest
      || !verifySteamPublishAuthorization(this.#publicKey, authorization)) invalid("signed authorization");
    return authorization;
  }
  async probe(): Promise<void> { await jsonHealth(this.#endpoint, this.#tls, this.#timeoutMs, this.#http,
    "deviludo.steam-publish-authorization-signer-health.v1", this.#keyId); }
}

export class PostgresSteamPublishAuthorizationArchive implements SteamPublishAuthorizationArchive {
  constructor(private readonly store: Pick<PostgresReleaseAuthorizationStore, "find">) {}
  async persist(input: { approvalId: string; tenantId: string; releaseId: string; authorization: SignedSteamPublishAuthorization }): Promise<void> {
    const record = await this.store.find({ tenantId: input.tenantId, approvalId: input.approvalId });
    if (record.snapshot.releaseId !== input.releaseId || record.state !== "VERIFIED" || !record.signedAuthorization
      || steamCanonicalDigest(record.signedAuthorization) !== steamCanonicalDigest(input.authorization)) invalid("authorization archive");
  }
}

export class TemporalReleaseMfaWorkflowSignal implements ReleaseMfaWorkflowSignal {
  constructor(private readonly client: Client) {}
  async signal(input: { workflowId: string; signalId: string; approvalId: string }): Promise<void> {
    await signalGameDelivery(this.client, input.workflowId, Object.freeze({
      type: "MFA_APPROVED", signalId: input.signalId, approvalId: input.approvalId,
    }));
  }
}

export function steamAccessBinaryHttps(input: Parameters<SteamAccessBinaryHttp>[0]): Promise<SteamAccessBinaryResponse> {
  strictOriginRoot(input.url);
  validateTls(input.tls);
  const maximum = integer(input.maxResponseBytes ?? MAX_BINARY_RESPONSE, 0, MAX_BINARY_RESPONSE);
  return new Promise((resolve, reject) => {
    const body = input.body;
    const options: RequestOptions = {
      method: input.method, key: input.tls.key, cert: input.tls.certificate, ca: input.tls.ca,
      rejectUnauthorized: true, minVersion: "TLSv1.3", servername: input.url.hostname,
      headers: { accept: "application/json, application/octet-stream", ...(body ? {
        "content-type": "application/octet-stream", "content-length": String(body.byteLength),
      } : { "content-length": "0" }), ...(input.headers ?? {}) },
    };
    const request = httpsRequest(input.url, options, (response) => {
      const chunks: Buffer[] = []; let bytes = 0;
      response.on("data", (chunk: Buffer | string) => {
        const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); bytes += value.byteLength;
        if (bytes > maximum) { response.destroy(new Error("Steam access dependency response exceeded the limit")); return; }
        chunks.push(value);
      });
      response.once("error", reject);
      response.once("end", () => resolve(Object.freeze({ statusCode: response.statusCode ?? 503,
        headers: Object.freeze({ ...response.headers }), body: Buffer.concat(chunks) })));
    });
    request.setTimeout(input.timeoutMs, () => request.destroy(new Error("Steam access dependency timed out")));
    request.once("error", reject);
    request.end(body ? Buffer.from(body.buffer, body.byteOffset, body.byteLength) : undefined);
  });
}

async function jsonHealth(endpoint: URL, tls: TestKitArtifactBrokerTls, timeoutMs: number, http: TestKitArtifactBrokerHttp,
  schemaVersion: string, keyId?: string): Promise<void> {
  const response = await http({ url: route(endpoint, "/healthz"), method: "GET", body: "{}", tls, timeoutMs });
  const body = record(response.payload); exactKeys(body, keyId ? ["schemaVersion", "status", "keyId", "algorithm"] : ["schemaVersion", "status"]);
  if (response.statusCode !== 200 || body.schemaVersion !== schemaVersion || body.status !== "ok"
    || (keyId && (body.keyId !== keyId || body.algorithm !== "Ed25519"))) invalid("dependency health");
}
function signedAuthorization(value: unknown): SignedSteamPublishAuthorization {
  const body = record(value); exactKeys(body, ["keyId", "claims", "signature"]);
  if (typeof body.keyId !== "string" || !SAFE_ID.test(body.keyId) || typeof body.signature !== "string"
    || !body.signature || body.signature.length > 512) invalid("authorization");
  return Object.freeze({ keyId: body.keyId, signature: body.signature,
    claims: Object.freeze({ ...record(body.claims) }) as unknown as SteamPublishAuthorizationClaims });
}
function strictOrigin(value: string | URL): URL { const url = new URL(value); strictOriginRoot(url); if (url.pathname !== "/") invalid("dependency origin"); return url; }
function strictOriginRoot(url: URL): void { if (url.protocol !== "https:" || !url.hostname || url.username || url.password || url.search || url.hash) invalid("dependency URL"); }
function route(origin: URL, pathname: string): URL { const url = new URL(origin); url.pathname = pathname; return url; }
function validatedTls(value: TestKitArtifactBrokerTls): TestKitArtifactBrokerTls { validateTls(value); return Object.freeze({ ...value }); }
function validateTls(value: TestKitArtifactBrokerTls): void { if (![value.key, value.certificate, value.ca].every((entry) => Buffer.isBuffer(entry)
  && entry.byteLength >= 32 && entry.byteLength <= MAX_BINARY_RESPONSE)) invalid("dependency TLS"); }
function json(value: Buffer): Record<string, unknown> { try { return record(JSON.parse(value.toString("utf8")) as unknown); } catch { invalid("dependency JSON"); } }
function record(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) invalid("dependency response"); return value as Record<string, unknown>; }
function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void { const actual = Object.keys(value).sort(); const sorted = [...expected].sort();
  if (actual.length !== sorted.length || actual.some((key, index) => key !== sorted[index])) invalid("dependency response fields"); }
function singleHeader(headers: IncomingHttpHeaders, name: string): string | null { const value = headers[name]; return typeof value === "string" ? value : null; }
function requiredHeader(headers: IncomingHttpHeaders, name: string, pattern: RegExp): string { const value = singleHeader(headers, name); if (!value || !pattern.test(value)) invalid("dependency header"); return value; }
function listHeader(headers: IncomingHttpHeaders, name: string, pattern: RegExp): string[] { const raw = singleHeader(headers, name); if (!raw) invalid("dependency list");
  const values = raw.split(","); if (!values.length || values.length > 100 || new Set(values).size !== values.length || values.some((value) => !pattern.test(value))
    || JSON.stringify([...values].sort()) !== JSON.stringify(values)) invalid("dependency list"); return values; }
function requiredIso(value: unknown): string { if (typeof value !== "string") invalid("dependency timestamp"); const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) invalid("dependency timestamp"); return value; }
function integer(value: number, minimum: number, maximum: number): number { if (!Number.isSafeInteger(value) || value < minimum || value > maximum) invalid("dependency bound"); return value; }
function invalid(label: string): never { throw new Error(`Steam access ${label} is invalid`); }
