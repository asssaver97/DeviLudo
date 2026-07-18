import type { TestKitArtifactBrokerHttp, TestKitArtifactBrokerTls } from "../../runner-control/src/testkit-artifact-client";
import { testKitArtifactBrokerHttpsJson } from "../../runner-control/src/testkit-artifact-client";
import type { SteamEnrollmentView } from "./enrollment-contracts";
import type { ReleaseAuthorizationView } from "./release-authorization-contracts";
import { steamAccessBinaryHttps, type SteamAccessBinaryHttp } from "./steam-access-dependencies";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const LOCATOR = /^[a-f0-9-]{36}\.[A-Za-z0-9_-]{43}$/;
const RANDOM = /^[A-Za-z0-9_-]{43}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const MAX_JSON_BYTES = 512 * 1024;

export interface SteamSecureUiPrincipal {
  readonly tenantId: string;
  readonly userId: string;
  readonly sessionBinding: string;
  readonly displayName: string;
}

export interface SteamSecureUiBrowserSession {
  readonly sessionToken: string;
  readonly browserBinding: string;
}

export interface SteamReleaseWebAuthnOptions {
  readonly challengeId: string;
  readonly publicKey: Readonly<{
    challenge: string;
    rpId: string;
    timeout: number;
    userVerification: "required";
    allowCredentials: readonly Readonly<{
      id: string;
      type: "public-key";
      transports: readonly ("usb" | "nfc" | "ble" | "internal" | "hybrid")[];
    }>[];
  }>;
}

export function steamSecureUiBrowserSession(cookieHeader: string | undefined): SteamSecureUiBrowserSession {
  if (!cookieHeader || cookieHeader.length > 8_192 || /[\r\n\0]/.test(cookieHeader)) invalid("browser cookies");
  const cookies = new Map<string, string>();
  for (const entry of cookieHeader.split(";")) {
    const separator = entry.indexOf("=");
    if (separator < 1) continue;
    const name = entry.slice(0, separator).trim();
    const value = entry.slice(separator + 1).trim();
    if (cookies.has(name)) invalid("duplicate browser cookie");
    cookies.set(name, value);
  }
  const sessionToken = cookies.get("__Host-deviludo-session");
  const browserBinding = cookies.get("__Host-deviludo-browser");
  if (!sessionToken || !LOCATOR.test(sessionToken) || !browserBinding || !RANDOM.test(browserBinding)) invalid("browser session");
  return Object.freeze({ sessionToken, browserBinding });
}

export class MtlsSteamSecureUiIdentityClient {
  readonly #origin: URL;
  readonly #tls: TestKitArtifactBrokerTls;
  readonly #timeoutMs: number;
  readonly #http: TestKitArtifactBrokerHttp;

  constructor(options: Readonly<{
    endpoint: string | URL;
    tls: TestKitArtifactBrokerTls;
    timeoutMs?: number;
    http?: TestKitArtifactBrokerHttp;
  }>) {
    this.#origin = strictOrigin(options.endpoint);
    this.#tls = tls(options.tls);
    this.#timeoutMs = integer(options.timeoutMs ?? 15_000, 1_000, 60_000);
    this.#http = options.http ?? testKitArtifactBrokerHttpsJson;
  }

  async assert(session: SteamSecureUiBrowserSession, pathname: string, method: "GET" | "POST"): Promise<SteamSecureUiPrincipal> {
    if (!LOCATOR.test(session.sessionToken) || !RANDOM.test(session.browserBinding)
      || !/^\/api\/steam-access-ui\/[A-Za-z0-9/_-]{1,500}$/.test(pathname)) invalid("identity assertion request");
    const response = await this.#http({
      url: route(this.#origin, "/v1/sessions/assert"),
      body: JSON.stringify({ sessionToken: session.sessionToken, browserBinding: session.browserBinding, method, pathname }),
      tls: this.#tls,
      timeoutMs: this.#timeoutMs,
    });
    const body = record(response.payload);
    exact(body, ["tenantId", "tenantSlug", "tenantName", "userId", "membershipId", "role", "githubUserId", "githubNodeId",
      "githubLogin", "displayName", "avatarUrl", "sessionBinding", "issuedAt", "signature"]);
    if (response.statusCode !== 200 || typeof body.tenantId !== "string" || !UUID.test(body.tenantId)
      || typeof body.userId !== "string" || !UUID.test(body.userId)
      || typeof body.sessionBinding !== "string" || !RANDOM.test(body.sessionBinding)
      || typeof body.displayName !== "string" || !body.displayName || body.displayName.length > 160
      || /[\u0000-\u001f\u007f]/.test(body.displayName)) invalid("identity assertion receipt");
    return Object.freeze({ tenantId: body.tenantId, userId: body.userId,
      sessionBinding: body.sessionBinding, displayName: body.displayName });
  }

  async probe(): Promise<void> {
    const response = await this.#http({ url: route(this.#origin, "/healthz"), method: "GET", body: "{}",
      tls: this.#tls, timeoutMs: this.#timeoutMs });
    const body = record(response.payload); exact(body, ["status", "service"]);
    if (response.statusCode !== 200 || body.status !== "ok" || body.service !== "deviludo-identity-broker") invalid("identity health");
  }
}

export class MtlsSteamReleaseWebAuthnClient {
  readonly #origin: URL;
  readonly #tls: TestKitArtifactBrokerTls;
  readonly #timeoutMs: number;
  readonly #http: TestKitArtifactBrokerHttp;
  constructor(options: Readonly<{ endpoint: string | URL; tls: TestKitArtifactBrokerTls; timeoutMs?: number; http?: TestKitArtifactBrokerHttp }>) {
    this.#origin = strictOrigin(options.endpoint); this.#tls = tls(options.tls);
    this.#timeoutMs = integer(options.timeoutMs ?? 15_000, 1_000, 60_000); this.#http = options.http ?? testKitArtifactBrokerHttpsJson;
  }
  async begin(input: Readonly<{ approvalId: string; tenantId: string; userId: string }>): Promise<SteamReleaseWebAuthnOptions> {
    if (!ID.test(input.approvalId) || !UUID.test(input.tenantId) || !UUID.test(input.userId)) invalid("WebAuthn challenge request");
    const response = await this.#http({ url: route(this.#origin, "/v1/steam-release-mfa/challenges"),
      body: JSON.stringify({ schemaVersion: "deviludo.steam-release-webauthn-challenge-request.v1", ...input }),
      tls: this.#tls, timeoutMs: this.#timeoutMs });
    const body = record(response.payload); exact(body, ["schemaVersion", "approvalId", "challengeId", "publicKey"]);
    if (response.statusCode !== 201 || body.schemaVersion !== "deviludo.steam-release-webauthn-challenge.v1"
      || body.approvalId !== input.approvalId || typeof body.challengeId !== "string" || !ID.test(body.challengeId)) invalid("WebAuthn challenge receipt");
    return Object.freeze({ challengeId: body.challengeId, publicKey: publicKeyOptions(body.publicKey) });
  }
  async probe(): Promise<void> {
    const response = await this.#http({ url: route(this.#origin, "/healthz"), method: "GET", body: "{}", tls: this.#tls, timeoutMs: this.#timeoutMs });
    const body = record(response.payload); exact(body, ["schemaVersion", "status"]);
    if (response.statusCode !== 200 || body.schemaVersion !== "deviludo.steam-release-mfa-verifier-health.v1" || body.status !== "ok") invalid("WebAuthn health");
  }
}

export class MtlsSteamSecureUiAccessClient {
  readonly #origin: URL;
  readonly #tls: TestKitArtifactBrokerTls;
  readonly #timeoutMs: number;
  readonly #http: SteamAccessBinaryHttp;
  constructor(options: Readonly<{ endpoint: string | URL; tls: TestKitArtifactBrokerTls; timeoutMs?: number; http?: SteamAccessBinaryHttp }>) {
    this.#origin = strictOrigin(options.endpoint); this.#tls = tls(options.tls);
    this.#timeoutMs = integer(options.timeoutMs ?? 30_000, 1_000, 120_000); this.#http = options.http ?? steamAccessBinaryHttps;
  }
  submitCredentials(input: Readonly<{ enrollmentId: string; accountName: string; password: Uint8Array; uiSession: string }>): Promise<SteamEnrollmentView> {
    if (!/^[A-Za-z0-9_-]{3,64}$/.test(input.accountName) || !(input.password instanceof Uint8Array)
      || input.password.byteLength < 8 || input.password.byteLength > 1024) invalid("Steam credentials");
    return this.#enrollment(input.enrollmentId, "credentials", input.password, input.uiSession,
      { "x-steam-account-name": input.accountName });
  }
  submitGuard(input: Readonly<{ enrollmentId: string; guardCode: Uint8Array; uiSession: string }>): Promise<SteamEnrollmentView> {
    if (!(input.guardCode instanceof Uint8Array) || input.guardCode.byteLength < 4 || input.guardCode.byteLength > 32) invalid("Steam Guard code");
    return this.#enrollment(input.enrollmentId, "guard", input.guardCode, input.uiSession, {});
  }
  async completeApproval(input: Readonly<{ approvalId: string; assertion: unknown; uiSession: string }>): Promise<ReleaseAuthorizationView> {
    requireId(input.approvalId); requireToken(input.uiSession);
    if (!input.assertion || typeof input.assertion !== "object" || Array.isArray(input.assertion)) invalid("MFA assertion");
    const requestBody = Buffer.from(JSON.stringify({ assertion: input.assertion }), "utf8");
    if (requestBody.byteLength > 128 * 1024) { requestBody.fill(0); invalid("MFA assertion size"); }
    try {
      const response = await this.#http({
        url: route(this.#origin, `/v1/mfa/approvals/${encodeURIComponent(input.approvalId)}/complete`),
        method: "POST",
        headers: { "content-type": "application/json", "x-deviludo-steam-ui-session": input.uiSession },
        body: requestBody,
        tls: this.#tls,
        timeoutMs: this.#timeoutMs,
        maxResponseBytes: 64 * 1024,
      });
      if (response.statusCode !== 200) invalid("MFA completion response");
      return releaseView(json(response.body), input.approvalId);
    } finally { requestBody.fill(0); }
  }
  async probe(): Promise<void> {
    const response = await this.#http({ url: route(this.#origin, "/healthz"), method: "GET", tls: this.#tls,
      timeoutMs: this.#timeoutMs, maxResponseBytes: 8 * 1024 });
    const body = json(response.body); exact(body, ["schemaVersion", "status"]);
    if (response.statusCode !== 200 || body.schemaVersion !== "deviludo.steam-access-health.v1" || body.status !== "ok") invalid("access health");
  }
  async #enrollment(enrollmentId: string, action: "credentials" | "guard", secret: Uint8Array, uiSession: string,
    headers: Readonly<Record<string, string>>): Promise<SteamEnrollmentView> {
    requireEnrollmentId(enrollmentId); requireToken(uiSession);
    if (!(secret instanceof Uint8Array)) invalid("binary secret");
    const response = await this.#http({
      url: route(this.#origin, `/v1/steam/enrollments/${encodeURIComponent(enrollmentId)}/${action}`),
      method: "POST", headers: { ...headers, "x-deviludo-steam-ui-session": uiSession }, body: secret,
      tls: this.#tls, timeoutMs: this.#timeoutMs, maxResponseBytes: 64 * 1024,
    });
    if (response.statusCode !== 200 && response.statusCode !== 202) invalid("enrollment response");
    return enrollmentView(json(response.body), enrollmentId);
  }
}

function publicKeyOptions(value: unknown): SteamReleaseWebAuthnOptions["publicKey"] {
  const body = record(value); exact(body, ["challenge", "rpId", "timeout", "userVerification", "allowCredentials"]);
  if (typeof body.challenge !== "string" || !BASE64URL.test(body.challenge) || body.challenge.length < 43 || body.challenge.length > 256
    || typeof body.rpId !== "string" || !/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(body.rpId) || body.rpId.includes("..")
    || !Number.isSafeInteger(body.timeout) || (body.timeout as number) < 30_000 || (body.timeout as number) > 300_000
    || body.userVerification !== "required" || !Array.isArray(body.allowCredentials) || body.allowCredentials.length > 20) invalid("WebAuthn public key options");
  const allowCredentials = body.allowCredentials.map((entry) => {
    const descriptor = record(entry); exact(descriptor, ["id", "type", "transports"]);
    if (typeof descriptor.id !== "string" || !BASE64URL.test(descriptor.id) || descriptor.id.length > 1_024
      || descriptor.type !== "public-key" || !Array.isArray(descriptor.transports) || descriptor.transports.length > 5
      || new Set(descriptor.transports).size !== descriptor.transports.length
      || descriptor.transports.some((transport) => !["usb", "nfc", "ble", "internal", "hybrid"].includes(String(transport)))) invalid("WebAuthn credential descriptor");
    return Object.freeze({ id: descriptor.id, type: "public-key" as const,
      transports: Object.freeze([...(descriptor.transports as SteamReleaseWebAuthnOptions["publicKey"]["allowCredentials"][number]["transports"])]) });
  });
  return Object.freeze({ challenge: body.challenge, rpId: body.rpId, timeout: body.timeout as number,
    userVerification: "required", allowCredentials: Object.freeze(allowCredentials) });
}

function enrollmentView(body: Record<string, unknown>, expectedId: string): SteamEnrollmentView {
  exact(body, ["enrollmentId", "state", "enrollmentUrl", "expiresAt"]);
  if (body.enrollmentId !== expectedId || !["WAITING_CREDENTIALS", "WAITING_STEAM_GUARD", "READY"].includes(String(body.state))
    || (body.enrollmentUrl !== null && typeof body.enrollmentUrl !== "string")) invalid("enrollment receipt");
  return Object.freeze({ enrollmentId: expectedId, state: body.state as SteamEnrollmentView["state"],
    enrollmentUrl: body.enrollmentUrl as string | null, expiresAt: iso(body.expiresAt) });
}
function releaseView(body: Record<string, unknown>, approvalId: string): ReleaseAuthorizationView {
  exact(body, ["releaseId", "state", "approvalId", "authorizationUrl", "workflowId", "expiresAt"]);
  if (body.approvalId !== approvalId || body.state !== "DISPATCHED" || typeof body.releaseId !== "string" || !ID.test(body.releaseId)
    || body.authorizationUrl !== null || typeof body.workflowId !== "string" || !ID.test(body.workflowId)) invalid("release authorization receipt");
  return Object.freeze({ releaseId: body.releaseId, state: "DISPATCHED", approvalId, authorizationUrl: null,
    workflowId: body.workflowId, expiresAt: iso(body.expiresAt) });
}
function strictOrigin(value: string | URL): URL { const result = new URL(value); if (result.protocol !== "https:" || !result.hostname
  || result.username || result.password || result.pathname !== "/" || result.search || result.hash) invalid("origin"); return result; }
function route(origin: URL, pathname: string): URL { const result = new URL(origin); result.pathname = pathname; return result; }
function tls(value: TestKitArtifactBrokerTls): TestKitArtifactBrokerTls { if (![value.key, value.certificate, value.ca].every((entry) => Buffer.isBuffer(entry)
  && entry.byteLength >= 32 && entry.byteLength <= 1024 * 1024)) invalid("TLS"); return Object.freeze({ ...value }); }
function record(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) invalid("response"); return value as Record<string, unknown>; }
function exact(body: Record<string, unknown>, keys: readonly string[]): void { if (JSON.stringify(Object.keys(body).sort()) !== JSON.stringify([...keys].sort())) invalid("response fields"); }
function json(value: Buffer): Record<string, unknown> { if (value.byteLength < 2 || value.byteLength > MAX_JSON_BYTES) invalid("JSON size"); try { return record(JSON.parse(value.toString("utf8")) as unknown); } catch { invalid("JSON"); } }
function iso(value: unknown): string { if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) invalid("timestamp"); const result = new Date(value).toISOString(); if (result !== value) invalid("timestamp"); return result; }
function requireId(value: string): void { if (!ID.test(value)) invalid("ID"); }
function requireEnrollmentId(value: string): void { if (!/^[a-f0-9-]{36}$/.test(value)) invalid("enrollment ID"); }
function requireToken(value: string): void { if (typeof value !== "string" || value.length < 100 || value.length > 4_096 || !/^[A-Za-z0-9_.-]+$/.test(value)) invalid("UI session"); }
function integer(value: number, min: number, max: number): number { if (!Number.isSafeInteger(value) || value < min || value > max) invalid("bound"); return value; }
function invalid(label: string): never { throw new Error(`Steam Secure UI ${label} is invalid`); }
