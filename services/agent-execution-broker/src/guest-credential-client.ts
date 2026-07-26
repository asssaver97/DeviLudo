import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { request as httpsRequest, type RequestOptions } from "node:https";
import { isAbsolute, resolve } from "node:path";
import { canonicalJson } from "../../runner-control/src/canonical";
import type { NativeMicrovmAgentRequest } from "./native-microvm-contracts";

const SHA256 = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const MAX_IMAGE_BYTES = 64 * 1024 * 1024;

export interface GuestCredentialImageIssuer {
  issue(request: NativeMicrovmAgentRequest, attestationKeyId: string): Promise<Readonly<{
    image: Buffer;
    digest: string;
    expiresAt: string;
  }>>;
  probe(): Promise<void>;
}

export type GuestCredentialHttp = (url: URL, input: Readonly<{
  method: "GET" | "POST";
  headers: Readonly<Record<string, string>>;
  body?: string;
  timeoutMs: number;
  tls: Readonly<{ key: Buffer; certificate: Buffer; ca: Buffer }>;
}>) => Promise<Readonly<{ statusCode: number; headers: Readonly<Record<string, string | undefined>>; payload: Buffer }>>;

/** Fetches one attempt-bound, read-only ext4 credential drive over TLS 1.3 mTLS. */
export class MtlsGuestCredentialImageIssuer implements GuestCredentialImageIssuer {
  readonly #origin: URL;
  readonly #tls: Readonly<{ key: Buffer; certificate: Buffer; ca: Buffer }>;
  readonly #timeoutMs: number;
  readonly #http: GuestCredentialHttp;

  constructor(options: Readonly<{ endpoint: string | URL; tls: Readonly<{ key: Buffer; certificate: Buffer; ca: Buffer }>;
    timeoutMs?: number; http?: GuestCredentialHttp }>) {
    this.#origin = origin(options.endpoint); validateTls(options.tls); this.#tls = Object.freeze({ ...options.tls });
    this.#timeoutMs = integer(options.timeoutMs ?? 30_000, 1_000, 60_000); this.#http = options.http ?? requestImage;
  }

  async issue(request: NativeMicrovmAgentRequest, attestationKeyId: string) {
    if (!UUID.test(request.runId) || !UUID.test(request.attemptId)
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]{2,159}$/.test(attestationKeyId)) invalid();
    const expiresAt = request.inferenceAuthorizationExpiresAt;
    if (!canonicalTimestamp(expiresAt) || Date.parse(expiresAt) <= Date.now()) invalid();
    const body = canonicalJson({ schemaVersion: "deviludo.agent-microvm-credential-image-request.v1",
      tenantId: request.tenantId, projectId: request.projectId, runId: request.runId, attemptId: request.attemptId,
      profileRevisionId: request.profileRevisionId, installationId: request.installationId, agent: request.agent,
      exactAgentVersion: request.exactAgentVersion, adapterVersion: request.adapterVersion,
      workerImageDigest: request.imageDigest, providerRevisionId: request.providerRevisionId,
      credentialVersionId: request.credentialVersionId, attestationKeyId, expiresAt });
    const response = await this.#http(route(this.#origin, "/v1/agent-microvm-credentials:issue"), {
      method: "POST", timeoutMs: this.#timeoutMs, tls: this.#tls,
      headers: Object.freeze({ accept: "application/octet-stream", "content-type": "application/json",
        "content-length": String(Buffer.byteLength(body)), "x-deviludo-run-id": request.runId,
        "x-deviludo-attempt-id": request.attemptId }), body,
    });
    const digest = response.headers["x-deviludo-content-sha256"];
    if (response.statusCode !== 200 || !Buffer.isBuffer(response.payload) || response.payload.length < 128 * 1024
      || response.payload.length > MAX_IMAGE_BYTES || typeof digest !== "string" || !SHA256.test(digest)
      || createHash("sha256").update(response.payload).digest("hex") !== digest
      || response.headers["x-deviludo-run-id"] !== request.runId
      || response.headers["x-deviludo-attempt-id"] !== request.attemptId
      || response.headers["x-deviludo-expires-at"] !== expiresAt
      || response.payload.readUInt16LE(1024 + 56) !== 0xef53) invalid();
    return Object.freeze({ image: Buffer.from(response.payload), digest, expiresAt });
  }

  async probe(): Promise<void> {
    const response = await this.#http(route(this.#origin, "/healthz"), { method: "GET", timeoutMs: this.#timeoutMs,
      tls: this.#tls, headers: Object.freeze({ accept: "application/json" }) });
    let body: unknown;
    try { body = JSON.parse(response.payload.toString("utf8")); } catch { invalid(); }
    if (response.statusCode !== 200 || !body || typeof body !== "object" || Array.isArray(body)
      || (body as Record<string, unknown>).status !== "ok"
      || (body as Record<string, unknown>).service !== "deviludo-agent-microvm-credential-issuer") invalid();
  }
}

export async function guestCredentialImageIssuerFromEnv(env: Readonly<Record<string, string | undefined>> = process.env) {
  const [key, certificate, ca] = await Promise.all([read(env, "DEVILUDO_AGENT_MICROVM_CREDENTIAL_ISSUER_TLS_KEY_FILE"),
    read(env, "DEVILUDO_AGENT_MICROVM_CREDENTIAL_ISSUER_TLS_CERT_FILE"),
    read(env, "DEVILUDO_AGENT_MICROVM_CREDENTIAL_ISSUER_CA_FILE")]);
  return new MtlsGuestCredentialImageIssuer({ endpoint: required(env, "DEVILUDO_AGENT_MICROVM_CREDENTIAL_ISSUER_URL"),
    tls: { key, certificate, ca }, timeoutMs: integerString(env.DEVILUDO_AGENT_MICROVM_CREDENTIAL_ISSUER_TIMEOUT_MS, 30_000, 1_000, 60_000) });
}

function requestImage(url: URL, input: Parameters<GuestCredentialHttp>[1]): Promise<Awaited<ReturnType<GuestCredentialHttp>>> {
  return new Promise((accept, reject) => { const headers = { ...input.headers };
    const options: RequestOptions = { method: input.method, headers, key: input.tls.key, cert: input.tls.certificate,
      ca: input.tls.ca, rejectUnauthorized: true, minVersion: "TLSv1.3", servername: url.hostname };
    const request = httpsRequest(url, options, (response) => { const chunks: Buffer[] = []; let bytes = 0;
      response.on("data", (chunk: Buffer | string) => { const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); bytes += value.length;
        if (bytes > MAX_IMAGE_BYTES) response.destroy(new Error("credential image too large")); else chunks.push(value); });
      response.once("error", reject); response.once("end", () => accept(Object.freeze({ statusCode: response.statusCode ?? 503,
        headers: Object.freeze({ "x-deviludo-content-sha256": single(response.headers["x-deviludo-content-sha256"]),
          "x-deviludo-run-id": single(response.headers["x-deviludo-run-id"]),
          "x-deviludo-attempt-id": single(response.headers["x-deviludo-attempt-id"]),
          "x-deviludo-expires-at": single(response.headers["x-deviludo-expires-at"]) }), payload: Buffer.concat(chunks) }))); });
    request.setTimeout(input.timeoutMs, () => request.destroy(new Error("credential issuer timed out")));
    request.once("error", reject); request.end(input.body);
  });
}
function origin(value: string | URL): URL { const url = new URL(value.toString()); if (url.protocol !== "https:" || url.username || url.password
  || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) invalid(); url.pathname = "/"; return url; }
function route(base: URL, path: string): URL { const url = new URL(base.href); url.pathname = path; return url; }
function validateTls(value: Readonly<{ key: Buffer; certificate: Buffer; ca: Buffer }>): void { if ([value.key, value.certificate, value.ca]
  .some((item) => !Buffer.isBuffer(item) || item.byteLength < 32 || item.byteLength > 1024 * 1024)) invalid(); }
async function read(env: Readonly<Record<string, string | undefined>>, name: string): Promise<Buffer> { const path = required(env, name);
  if (!isAbsolute(path) || resolve(path) !== path || path.length > 4096 || path.includes("\0")) invalid();
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); try { const metadata = await file.stat();
    if (!metadata.isFile() || metadata.size < 32 || metadata.size > 1024 * 1024 || (metadata.mode & 0o022) !== 0) invalid();
    return await file.readFile(); } finally { await file.close(); } }
function single(value: string | string[] | undefined): string | undefined { return Array.isArray(value) ? undefined : value; }
function canonicalTimestamp(value: unknown): value is string { return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value; }
function required(env: Readonly<Record<string, string | undefined>>, name: string): string { const value = env[name]?.trim(); if (!value) throw new Error(`${name} is required`); return value; }
function integer(value: number, minimum: number, maximum: number): number { if (!Number.isSafeInteger(value) || value < minimum || value > maximum) invalid(); return value; }
function integerString(value: string | undefined, fallback: number, min: number, max: number): number { if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10); if (String(parsed) !== value) invalid(); return integer(parsed, min, max); }
function invalid(): never { throw new Error("Agent microVM credential image contract is invalid"); }
