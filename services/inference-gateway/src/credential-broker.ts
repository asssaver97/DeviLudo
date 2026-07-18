import { randomUUID } from "node:crypto";
import { request as httpsRequest, type RequestOptions } from "node:https";
import type { GatewayCredentialLease, GatewayCredentialResolver } from "./production-connector";

const MAX_RESPONSE_BYTES = 128 * 1024;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;

export interface CredentialBrokerTlsMaterial {
  readonly key: Buffer;
  readonly certificate: Buffer;
  readonly ca: Buffer;
}

export interface CredentialBrokerHttpRequest {
  readonly method: "GET" | "POST";
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly timeoutMs: number;
  readonly tls: CredentialBrokerTlsMaterial;
}

export interface CredentialBrokerHttpResponse {
  readonly statusCode: number;
  readonly payload: unknown;
}

export type CredentialBrokerHttp = (
  url: URL,
  request: CredentialBrokerHttpRequest,
) => Promise<CredentialBrokerHttpResponse>;

export interface GatewayProviderProbeCredentialResolver {
  resolveProviderProbe(input: Readonly<{
    providerRevisionId: string;
    credentialVersionId: string;
  }>): Promise<GatewayCredentialLease>;
}

/** Resolves one immutable, run-bound key over a fixed mTLS workload boundary. */
export class MtlsGatewayCredentialResolver implements GatewayCredentialResolver, GatewayProviderProbeCredentialResolver {
  readonly #endpoint: URL;
  readonly #tls: CredentialBrokerTlsMaterial;
  readonly #timeoutMs: number;
  readonly #http: CredentialBrokerHttp;
  readonly #now: () => number;

  constructor(options: Readonly<{
    endpoint: string | URL;
    tls: CredentialBrokerTlsMaterial;
    timeoutMs?: number;
    http?: CredentialBrokerHttp;
    now?: () => number;
  }>) {
    this.#endpoint = strictEndpoint(options.endpoint);
    validateTls(options.tls);
    this.#tls = Object.freeze({ ...options.tls });
    this.#timeoutMs = boundedInteger(options.timeoutMs ?? 10_000, 1_000, 60_000);
    this.#http = options.http ?? credentialBrokerHttpsJson;
    this.#now = options.now ?? Date.now;
  }

  async resolve(input: Parameters<GatewayCredentialResolver["resolve"]>[0]): Promise<GatewayCredentialLease> {
    validateBinding(input);
    const requestId = randomUUID();
    const body = JSON.stringify({
      schemaVersion: "deviludo.inference-credential-request.v1",
      requestId,
      tenantId: input.tenantId,
      projectId: input.projectId,
      runId: input.runId,
      providerRevisionId: input.providerRevisionId,
      credentialVersionId: input.credentialVersionId,
    });
    const response = await this.#http(this.#endpoint, {
      method: "POST",
      timeoutMs: this.#timeoutMs,
      tls: this.#tls,
      headers: Object.freeze({
        accept: "application/json",
        "content-type": "application/json",
        "idempotency-key": requestId,
      }),
      body,
    });
    if (response.statusCode !== 200) throw new Error("Inference credential Broker rejected the bound lease request");
    return parseLease(response.payload, input, requestId, validNow(this.#now()));
  }

  async resolveProviderProbe(input: Parameters<GatewayProviderProbeCredentialResolver["resolveProviderProbe"]>[0]): Promise<GatewayCredentialLease> {
    if (!SAFE_ID.test(input.providerRevisionId) || !SAFE_ID.test(input.credentialVersionId)) invalidResponse();
    const requestId = randomUUID();
    const body = JSON.stringify({
      schemaVersion: "deviludo.inference-provider-probe-credential-request.v1",
      requestId,
      providerRevisionId: input.providerRevisionId,
      credentialVersionId: input.credentialVersionId,
    });
    const response = await this.#http(this.#endpoint, {
      method: "POST",
      timeoutMs: this.#timeoutMs,
      tls: this.#tls,
      headers: Object.freeze({
        accept: "application/json",
        "content-type": "application/json",
        "idempotency-key": requestId,
      }),
      body,
    });
    if (response.statusCode !== 200) throw new Error("Inference credential Broker rejected the Provider probe lease request");
    return parseProbeLease(response.payload, input, requestId, validNow(this.#now()));
  }

  async probe(): Promise<void> {
    const endpoint = new URL(this.#endpoint.href);
    endpoint.pathname = "/healthz";
    const response = await this.#http(endpoint, {
      method: "GET",
      timeoutMs: this.#timeoutMs,
      tls: this.#tls,
      headers: Object.freeze({ accept: "application/json" }),
    });
    const body = record(response.payload);
    if (response.statusCode !== 200 || body.status !== "ok" || body.service !== "deviludo-inference-credential-broker") {
      throw new Error("Inference credential Broker readiness probe failed");
    }
  }
}

export async function credentialBrokerHttpsJson(
  url: URL,
  input: CredentialBrokerHttpRequest,
): Promise<CredentialBrokerHttpResponse> {
  return new Promise((resolve, reject) => {
    const headers = { ...input.headers };
    if (input.body !== undefined) headers["content-length"] = String(Buffer.byteLength(input.body));
    const options: RequestOptions = {
      method: input.method,
      headers,
      key: input.tls.key,
      cert: input.tls.certificate,
      ca: input.tls.ca,
      rejectUnauthorized: true,
      minVersion: "TLSv1.3",
      servername: url.hostname,
    };
    const request = httpsRequest(url, options, (response) => {
      const declaredLength = Number(response.headers["content-length"] ?? 0);
      if (declaredLength > MAX_RESPONSE_BYTES) {
        response.destroy();
        reject(new Error("Inference credential Broker response exceeded its bound"));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer | string) => {
        const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += value.byteLength;
        if (size > MAX_RESPONSE_BYTES) {
          response.destroy(new Error("Inference credential Broker response exceeded its bound"));
          return;
        }
        chunks.push(value);
      });
      response.once("error", reject);
      response.once("end", () => {
        try {
          resolve(Object.freeze({
            statusCode: response.statusCode ?? 503,
            payload: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown,
          }));
        } catch { reject(new Error("Inference credential Broker returned invalid JSON")); }
      });
    });
    request.setTimeout(input.timeoutMs, () => request.destroy(new Error("Inference credential Broker request timed out")));
    request.once("error", reject);
    request.end(input.body);
  });
}

function parseLease(
  value: unknown,
  expected: Parameters<GatewayCredentialResolver["resolve"]>[0],
  requestId: string,
  now: number,
): GatewayCredentialLease {
  const body = record(value);
  if (body.schemaVersion !== "deviludo.inference-credential-lease.v1"
    || body.requestId !== requestId
    || body.tenantId !== expected.tenantId
    || body.projectId !== expected.projectId
    || body.runId !== expected.runId
    || body.providerRevisionId !== expected.providerRevisionId
    || body.credentialVersionId !== expected.credentialVersionId
    || body.encoding !== "base64") invalidResponse();
  return secretLease(body, now);
}

function parseProbeLease(
  value: unknown,
  expected: Parameters<GatewayProviderProbeCredentialResolver["resolveProviderProbe"]>[0],
  requestId: string,
  now: number,
): GatewayCredentialLease {
  const body = record(value);
  if (body.schemaVersion !== "deviludo.inference-provider-probe-credential-lease.v1"
    || body.requestId !== requestId
    || body.providerRevisionId !== expected.providerRevisionId
    || body.credentialVersionId !== expected.credentialVersionId
    || body.encoding !== "base64") invalidResponse();
  return secretLease(body, now);
}

function secretLease(body: Record<string, unknown>, now: number): GatewayCredentialLease {
  const expiresAt = Date.parse(String(body.expiresAt ?? ""));
  if (!Number.isFinite(expiresAt) || expiresAt <= now || expiresAt > now + 5 * 60_000) invalidResponse();
  const encoded = body.value;
  if (typeof encoded !== "string" || encoded.length < 12 || encoded.length > 96 * 1024 || !canonicalBase64(encoded)) invalidResponse();
  const secret = Buffer.from(encoded, "base64");
  if (secret.byteLength < 8 || secret.byteLength > 64 * 1024) { secret.fill(0); invalidResponse(); }
  let destroyed = false;
  return Object.freeze({
    value: secret,
    destroy() {
      if (!destroyed) secret.fill(0);
      destroyed = true;
    },
  });
}

function strictEndpoint(value: string | URL): URL {
  const url = new URL(value.toString());
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash
    || url.pathname.replace(/\/$/, "") !== "/v1/inference-credentials/resolve") {
    throw new Error("Inference credential Broker endpoint must be credential-free HTTPS /v1/inference-credentials/resolve");
  }
  url.pathname = "/v1/inference-credentials/resolve";
  return url;
}

function validateBinding(value: Parameters<GatewayCredentialResolver["resolve"]>[0]): void {
  if (![value.tenantId, value.projectId, value.runId, value.providerRevisionId, value.credentialVersionId]
    .every((item) => SAFE_ID.test(item))) invalidResponse();
}

function validateTls(value: CredentialBrokerTlsMaterial): void {
  for (const item of [value.key, value.certificate, value.ca]) {
    if (!Buffer.isBuffer(item) || item.byteLength < 32 || item.byteLength > 1024 * 1024) {
      throw new Error("Inference credential Broker TLS material is invalid");
    }
  }
}

function canonicalBase64(value: string): boolean {
  try { return Buffer.from(value, "base64").toString("base64") === value; } catch { return false; }
}
function boundedInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error("Inference credential Broker timeout is invalid");
  return value;
}
function validNow(value: number): number { if (!Number.isFinite(value) || value < 0) invalidResponse(); return value; }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalidResponse();
  return value as Record<string, unknown>;
}
function invalidResponse(): never { throw new Error("Inference credential Broker returned an invalid bound lease"); }
