import { randomUUID } from "node:crypto";
import { request as httpsRequest, type RequestOptions } from "node:https";
import type { SpecModelCredentialLease, SpecModelCredentialResolver, SpecModelProviderBinding } from "./contracts";

const MAX_RESPONSE_BYTES = 128 * 1024;

export interface SpecCredentialBrokerTls {
  readonly key: Buffer;
  readonly certificate: Buffer;
  readonly ca: Buffer;
}
export interface SpecCredentialBrokerHttpRequest {
  readonly method: "GET" | "POST";
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly timeoutMs: number;
  readonly tls: SpecCredentialBrokerTls;
}
export interface SpecCredentialBrokerHttpResponse { readonly statusCode: number; readonly payload: unknown }
export type SpecCredentialBrokerHttp = (
  url: URL,
  request: SpecCredentialBrokerHttpRequest,
) => Promise<SpecCredentialBrokerHttpResponse>;

/** Resolves only the exact platform Profile binding selected by server policy. */
export class MtlsSpecModelCredentialResolver implements SpecModelCredentialResolver {
  readonly #endpoint: URL;
  readonly #tls: SpecCredentialBrokerTls;
  readonly #timeoutMs: number;
  readonly #http: SpecCredentialBrokerHttp;
  readonly #now: () => number;

  constructor(options: Readonly<{
    endpoint: string | URL;
    tls: SpecCredentialBrokerTls;
    timeoutMs?: number;
    http?: SpecCredentialBrokerHttp;
    now?: () => number;
  }>) {
    this.#endpoint = endpoint(options.endpoint);
    validateTls(options.tls);
    this.#tls = Object.freeze({ ...options.tls });
    this.#timeoutMs = integer(options.timeoutMs ?? 10_000, 1_000, 60_000);
    this.#http = options.http ?? specCredentialBrokerHttpsJson;
    this.#now = options.now ?? Date.now;
  }

  async resolve(binding: SpecModelProviderBinding): Promise<SpecModelCredentialLease> {
    const requestId = randomUUID();
    const body = JSON.stringify({
      schemaVersion: "deviludo.spec-model-credential-request.v1",
      requestId,
      profileRevisionId: binding.profileRevisionId,
      providerRevisionId: binding.providerRevisionId,
      credentialVersionId: binding.credentialVersionId,
      protocol: binding.protocol,
      model: binding.model,
    });
    const response = await this.#http(this.#endpoint, {
      method: "POST",
      headers: Object.freeze({
        accept: "application/json",
        "content-type": "application/json",
        "idempotency-key": requestId,
      }),
      body,
      timeoutMs: this.#timeoutMs,
      tls: this.#tls,
    });
    if (response.statusCode !== 200) throw new Error("Specification credential Broker rejected the request");
    return parseLease(response.payload, requestId, binding, this.#now());
  }

  async probe(): Promise<void> {
    const url = new URL(this.#endpoint);
    url.pathname = "/healthz";
    const response = await this.#http(url, {
      method: "GET", headers: Object.freeze({ accept: "application/json" }),
      timeoutMs: this.#timeoutMs, tls: this.#tls,
    });
    const body = record(response.payload);
    if (response.statusCode !== 200 || body.status !== "ok" || body.service !== "deviludo-secret-broker") {
      throw new Error("Specification credential Broker readiness probe failed");
    }
  }
}

export function specCredentialBrokerHttpsJson(
  url: URL,
  input: SpecCredentialBrokerHttpRequest,
): Promise<SpecCredentialBrokerHttpResponse> {
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
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer | string) => {
        const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += value.byteLength;
        if (size > MAX_RESPONSE_BYTES) {
          for (const item of chunks) item.fill(0);
          value.fill(0);
          response.destroy(new Error("Specification credential Broker response exceeded its bound"));
          return;
        }
        chunks.push(value);
      });
      response.once("error", reject);
      response.once("end", () => {
        let payload: Buffer | undefined;
        try {
          payload = Buffer.concat(chunks);
          resolve(Object.freeze({
            statusCode: response.statusCode ?? 503,
            payload: JSON.parse(payload.toString("utf8")) as unknown,
          }));
        } catch { reject(new Error("Specification credential Broker returned invalid JSON")); }
        finally { payload?.fill(0); for (const item of chunks) item.fill(0); }
      });
    });
    request.setTimeout(input.timeoutMs, () => request.destroy(new Error("Specification credential Broker timed out")));
    request.once("error", reject);
    request.end(input.body);
  });
}

function parseLease(
  value: unknown,
  requestId: string,
  expected: SpecModelProviderBinding,
  now: number,
): SpecModelCredentialLease {
  const body = record(value);
  exactKeys(body, [
    "credentialVersionId", "encoding", "expiresAt", "model", "profileRevisionId",
    "protocol", "providerRevisionId", "requestId", "schemaVersion", "value",
  ]);
  if (body.schemaVersion !== "deviludo.spec-model-credential-lease.v1" || body.requestId !== requestId
    || body.profileRevisionId !== expected.profileRevisionId
    || body.providerRevisionId !== expected.providerRevisionId
    || body.credentialVersionId !== expected.credentialVersionId
    || body.protocol !== expected.protocol || body.model !== expected.model || body.encoding !== "base64") invalid();
  const expiresAt = Date.parse(String(body.expiresAt ?? ""));
  if (!Number.isFinite(now) || !Number.isFinite(expiresAt) || expiresAt <= now || expiresAt > now + 5 * 60_000) invalid();
  if (typeof body.value !== "string" || body.value.length < 12 || body.value.length > 96 * 1024
    || Buffer.from(body.value, "base64").toString("base64") !== body.value) invalid();
  const secret = Buffer.from(body.value, "base64");
  if (secret.byteLength < 8 || secret.byteLength > 64 * 1024) { secret.fill(0); invalid(); }
  let destroyed = false;
  return Object.freeze({
    value: secret,
    destroy() { if (!destroyed) secret.fill(0); destroyed = true; },
  });
}

function endpoint(value: string | URL): URL {
  const url = new URL(value.toString());
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash
    || url.pathname.replace(/\/$/, "") !== "/v1/spec-model-credentials/resolve") {
    throw new Error("Specification credential Broker endpoint is invalid");
  }
  url.pathname = "/v1/spec-model-credentials/resolve";
  return url;
}
function validateTls(value: SpecCredentialBrokerTls): void {
  for (const item of [value.key, value.certificate, value.ca]) {
    if (!Buffer.isBuffer(item) || item.byteLength < 32 || item.byteLength > 1024 * 1024) {
      throw new Error("Specification credential Broker TLS material is invalid");
    }
  }
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) invalid();
}
function integer(value: number, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error("Specification credential timeout is invalid");
  return value;
}
function invalid(): never { throw new Error("Specification credential Broker response is invalid"); }
