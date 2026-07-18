import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { request as httpsRequest, type RequestOptions } from "node:https";
import { isAbsolute, resolve } from "node:path";
import type { SecretResolver } from "../../agent-worker/src/contracts";
import type { EphemeralRunTokenSecretStore } from "./token-broker";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SECRET_REF = /^(?:vault|kms|secret):\/\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]{1,1024}$/;
const MAX_RESPONSE_BYTES = 64 * 1024;

export interface EphemeralSecretHttpResponse { readonly statusCode: number; readonly payload: unknown }
export type EphemeralSecretHttp = (url: URL, input: Readonly<{ method: "GET" | "POST";
  headers: Readonly<Record<string, string>>; body?: Buffer | string; timeoutMs: number;
  tls: Readonly<{ key: Buffer; certificate: Buffer; ca: Buffer }> }>) => Promise<EphemeralSecretHttpResponse>;

/** mTLS-only DLRT deposit. No token value is serialized into JSON or process environment. */
export class MtlsEphemeralRunTokenSecretStore implements EphemeralRunTokenSecretStore {
  readonly #origin: URL;
  readonly #tls: Readonly<{ key: Buffer; certificate: Buffer; ca: Buffer }>;
  readonly #timeoutMs: number;
  readonly #http: EphemeralSecretHttp;

  constructor(options: Readonly<{ endpoint: string | URL; tls: Readonly<{ key: Buffer; certificate: Buffer; ca: Buffer }>;
    timeoutMs?: number; http?: EphemeralSecretHttp }>) {
    this.#origin = origin(options.endpoint); validateTls(options.tls); this.#tls = Object.freeze({ ...options.tls });
    this.#timeoutMs = integer(options.timeoutMs ?? 30_000, 1_000, 60_000); this.#http = options.http ?? httpsSecret;
  }

  async replace(input: Parameters<EphemeralRunTokenSecretStore["replace"]>[0]): Promise<Readonly<{ secretRef: string }>> {
    if (!UUID.test(input.runId) || !UUID.test(input.attemptId) || !SECRET_REF.test(input.secretRef)
      || input.secretRef.includes("?") || input.secretRef.includes("#") || !Number.isFinite(Date.parse(input.expiresAt))
      || !(input.value instanceof Uint8Array) || input.value.byteLength < 32 || input.value.byteLength > 64 * 1024) invalid();
    const response = await this.#http(route(this.#origin, "/v1/ephemeral-run-tokens:replace"), {
      method: "POST", timeoutMs: this.#timeoutMs, tls: this.#tls,
      headers: Object.freeze({ accept: "application/json", "content-type": "application/octet-stream",
        "x-deviludo-run-id": input.runId, "x-deviludo-attempt-id": input.attemptId,
        "x-deviludo-secret-ref": input.secretRef, "x-deviludo-expires-at": input.expiresAt }),
      body: Buffer.from(input.value.buffer, input.value.byteOffset, input.value.byteLength),
    });
    if (response.statusCode !== 200) throw new Error(`Ephemeral secret Broker rejected replacement with status ${response.statusCode}`);
    const body = record(response.payload);
    exactKeys(body, ["schemaVersion", "runId", "attemptId", "expiresAt", "secretRef"]);
    if (body.schemaVersion !== "deviludo.ephemeral-run-token-replacement.v1" || body.runId !== input.runId
      || body.attemptId !== input.attemptId || body.expiresAt !== input.expiresAt || body.secretRef !== input.secretRef) invalid();
    return Object.freeze({ secretRef: input.secretRef });
  }

  async put(input: Parameters<EphemeralRunTokenSecretStore["put"]>[0]): Promise<Readonly<{ secretRef: string }>> {
    if (!UUID.test(input.runId) || !UUID.test(input.attemptId) || !Number.isFinite(Date.parse(input.expiresAt))
      || !(input.value instanceof Uint8Array) || input.value.byteLength < 32 || input.value.byteLength > 64 * 1024) invalid();
    const url = route(this.#origin, "/v1/ephemeral-run-tokens");
    const response = await this.#http(url, { method: "POST", timeoutMs: this.#timeoutMs, tls: this.#tls,
      headers: Object.freeze({ accept: "application/json", "content-type": "application/octet-stream",
        "x-deviludo-run-id": input.runId, "x-deviludo-attempt-id": input.attemptId,
        "x-deviludo-expires-at": input.expiresAt }), body: Buffer.from(input.value.buffer, input.value.byteOffset, input.value.byteLength) });
    if (response.statusCode !== 201) throw new Error(`Ephemeral secret Broker rejected deposit with status ${response.statusCode}`);
    const body = record(response.payload);
    exactKeys(body, ["schemaVersion", "runId", "attemptId", "expiresAt", "secretRef"]);
    if (body.schemaVersion !== "deviludo.ephemeral-run-token-receipt.v1" || body.runId !== input.runId
      || body.attemptId !== input.attemptId || body.expiresAt !== input.expiresAt
      || typeof body.secretRef !== "string" || !SECRET_REF.test(body.secretRef)
      || body.secretRef.includes("?") || body.secretRef.includes("#")) invalid();
    return Object.freeze({ secretRef: body.secretRef });
  }

  async revoke(secretRef: string): Promise<void> {
    if (!SECRET_REF.test(secretRef) || secretRef.includes("?") || secretRef.includes("#")) invalid();
    const response = await this.#http(route(this.#origin, "/v1/ephemeral-run-tokens:revoke"), {
      method: "POST", timeoutMs: this.#timeoutMs, tls: this.#tls,
      headers: Object.freeze({ accept: "application/json", "content-type": "application/json" }),
      body: JSON.stringify({ schemaVersion: "deviludo.ephemeral-run-token-revoke.v1", secretRef }),
    });
    if (response.statusCode !== 204) throw new Error(`Ephemeral secret Broker rejected revocation with status ${response.statusCode}`);
  }

  async probe(): Promise<void> {
    const response = await this.#http(route(this.#origin, "/healthz"), { method: "GET", timeoutMs: this.#timeoutMs,
      tls: this.#tls, headers: Object.freeze({ accept: "application/json" }) });
    const body = record(response.payload);
    if (response.statusCode !== 200 || body.status !== "ok" || body.service !== "deviludo-ephemeral-secret-broker") invalid();
  }
}

/** Guest-only resolver. It exchanges an opaque reference for DLRT bytes over mTLS. */
export class MtlsEphemeralRunTokenSecretResolver implements SecretResolver {
  readonly #origin: URL;
  readonly #tls: Readonly<{ key: Buffer; certificate: Buffer; ca: Buffer }>;
  readonly #timeoutMs: number;
  readonly #http: EphemeralSecretHttp;

  constructor(options: Readonly<{ endpoint: string | URL; tls: Readonly<{ key: Buffer; certificate: Buffer; ca: Buffer }>;
    timeoutMs?: number; http?: EphemeralSecretHttp }>) {
    this.#origin = origin(options.endpoint); validateTls(options.tls); this.#tls = Object.freeze({ ...options.tls });
    this.#timeoutMs = integer(options.timeoutMs ?? 30_000, 1_000, 60_000); this.#http = options.http ?? httpsSecret;
  }

  async resolve(secretRef: string, context: Parameters<SecretResolver["resolve"]>[1]): Promise<string> {
    if (!SECRET_REF.test(secretRef) || secretRef.includes("?") || secretRef.includes("#")
      || !UUID.test(context.runId) || !UUID.test(context.attemptId)
      || (context.environmentVariable !== "ANTHROPIC_API_KEY" && context.environmentVariable !== "DEVILUDO_RUN_TOKEN")) invalid();
    const body = JSON.stringify({ schemaVersion: "deviludo.ephemeral-run-token-resolution.v1", secretRef,
      runId: context.runId, attemptId: context.attemptId, environmentVariable: context.environmentVariable });
    const response = await this.#http(route(this.#origin, "/v1/ephemeral-run-tokens:resolve"), {
      method: "POST", timeoutMs: this.#timeoutMs, tls: this.#tls,
      headers: Object.freeze({ accept: "application/octet-stream", "content-type": "application/json",
        "x-deviludo-run-id": context.runId, "x-deviludo-attempt-id": context.attemptId }), body,
    });
    if (response.statusCode !== 200) throw new Error(`Ephemeral secret Broker rejected resolution with status ${response.statusCode}`);
    if (!Buffer.isBuffer(response.payload) || response.payload.byteLength < 32 || response.payload.byteLength > 16_384) invalid();
    const token = response.payload.toString("utf8");
    if (!token || Buffer.from(token).byteLength !== response.payload.byteLength || /[\0\r\n]/.test(token)) invalid();
    return token;
  }

  async probe(): Promise<void> {
    const response = await this.#http(route(this.#origin, "/healthz"), { method: "GET", timeoutMs: this.#timeoutMs,
      tls: this.#tls, headers: Object.freeze({ accept: "application/json" }) });
    const body = record(response.payload);
    if (response.statusCode !== 200 || body.status !== "ok" || body.service !== "deviludo-ephemeral-secret-broker") invalid();
  }
}

export async function ephemeralRunTokenSecretStoreFromEnv(env: Readonly<Record<string, string | undefined>> = process.env) {
  const [key, certificate, ca] = await Promise.all([read(env, "DEVILUDO_EPHEMERAL_SECRET_TLS_KEY_FILE"),
    read(env, "DEVILUDO_EPHEMERAL_SECRET_TLS_CERT_FILE"), read(env, "DEVILUDO_EPHEMERAL_SECRET_CA_FILE")]);
  return new MtlsEphemeralRunTokenSecretStore({ endpoint: required(env, "DEVILUDO_EPHEMERAL_SECRET_BROKER_URL"),
    tls: { key, certificate, ca }, timeoutMs: integerString(env.DEVILUDO_EPHEMERAL_SECRET_TIMEOUT_MS, 30_000, 1_000, 60_000) });
}

export async function ephemeralRunTokenSecretResolverFromEnv(env: Readonly<Record<string, string | undefined>> = process.env) {
  const [key, certificate, ca] = await Promise.all([read(env, "DEVILUDO_EPHEMERAL_SECRET_TLS_KEY_FILE"),
    read(env, "DEVILUDO_EPHEMERAL_SECRET_TLS_CERT_FILE"), read(env, "DEVILUDO_EPHEMERAL_SECRET_CA_FILE")]);
  return new MtlsEphemeralRunTokenSecretResolver({ endpoint: required(env, "DEVILUDO_EPHEMERAL_SECRET_BROKER_URL"),
    tls: { key, certificate, ca }, timeoutMs: integerString(env.DEVILUDO_EPHEMERAL_SECRET_TIMEOUT_MS, 30_000, 1_000, 60_000) });
}

async function httpsSecret(url: URL, input: Parameters<EphemeralSecretHttp>[1]): Promise<EphemeralSecretHttpResponse> {
  return new Promise((resolve, reject) => {
    const headers = { ...input.headers }; if (input.body !== undefined) headers["content-length"] = String(Buffer.byteLength(input.body));
    const options: RequestOptions = { method: input.method, headers, key: input.tls.key, cert: input.tls.certificate,
      ca: input.tls.ca, rejectUnauthorized: true, minVersion: "TLSv1.3", servername: url.hostname };
    const request = httpsRequest(url, options, (response) => { const chunks: Buffer[] = []; let bytes = 0;
      response.on("data", (chunk: Buffer | string) => { const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); bytes += value.length;
        if (bytes > MAX_RESPONSE_BYTES) response.destroy(new Error("response too large")); else chunks.push(value); });
      response.once("error", reject); response.once("end", () => { if ((response.statusCode ?? 503) === 204 && bytes === 0) {
        resolve({ statusCode: 204, payload: {} }); return; }
        if (String(response.headers["content-type"] ?? "").split(";", 1)[0]?.trim().toLowerCase() === "application/octet-stream") {
          resolve({ statusCode: response.statusCode ?? 503, payload: Buffer.concat(chunks) }); return;
        }
        try { resolve({ statusCode: response.statusCode ?? 503, payload: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown }); }
        catch { reject(new Error("Ephemeral secret Broker returned invalid JSON")); } }); });
    request.setTimeout(input.timeoutMs, () => request.destroy(new Error("Ephemeral secret Broker timed out")));
    request.once("error", reject); request.end(input.body);
  });
}
function origin(value: string | URL): URL { const url = new URL(value.toString()); if (url.protocol !== "https:" || url.username || url.password
  || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) invalid(); url.pathname = "/"; return url; }
function route(base: URL, path: string): URL { const url = new URL(base.href); url.pathname = path; return url; }
function validateTls(value: Readonly<{ key: Buffer; certificate: Buffer; ca: Buffer }>): void { if ([value.key, value.certificate, value.ca]
  .some((item) => !Buffer.isBuffer(item) || item.byteLength < 32 || item.byteLength > 1024 * 1024)) invalid(); }
async function read(env: Readonly<Record<string, string | undefined>>, name: string): Promise<Buffer> { const path = required(env, name);
  if (!isAbsolute(path) || resolve(path) !== path || path.length > 4_096 || path.includes("\0")) throw new Error(`${name} path is invalid`);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); try { const metadata = await file.stat();
    if (!metadata.isFile() || metadata.size < 32 || metadata.size > 1024 * 1024) throw new Error(`${name} is invalid`); return await file.readFile(); }
  finally { await file.close(); } }
function required(env: Readonly<Record<string, string | undefined>>, name: string): string { const value = env[name]?.trim(); if (!value) throw new Error(`${name} is required`); return value; }
function integer(value: number, min: number, max: number): number { if (!Number.isSafeInteger(value) || value < min || value > max) invalid(); return value; }
function integerString(value: string | undefined, fallback: number, min: number, max: number): number { if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10); if (String(parsed) !== value) invalid(); return integer(parsed, min, max); }
function record(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) invalid(); return value as Record<string, unknown>; }
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void { if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) invalid(); }
function invalid(): never { throw new Error("Ephemeral run-token secret Broker contract is invalid"); }
