import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { request as httpsRequest, type RequestOptions } from "node:https";
import { isAbsolute, resolve } from "node:path";
import type {
  GitHubAuthorizationSecretStore,
  GitHubClientSecretLease,
  GitHubClientSecretResolver,
} from "./github-auth-contracts";

const SECRET_REF = /^vault:\/\/[A-Za-z0-9._~:/-]{1,500}$/;
const PKCE = /^[A-Za-z0-9_-]{43}$/;
const MAX_RESPONSE_BYTES = 64 * 1024;

export interface GitHubSecretBrokerHttpResponse {
  readonly statusCode: number;
  readonly contentType: string;
  readonly payload: Buffer;
}

export type GitHubSecretBrokerHttp = (url: URL, input: Readonly<{
  method: "GET" | "POST";
  headers: Readonly<Record<string, string>>;
  body?: Buffer;
  timeoutMs: number;
  tls: Readonly<{ key: Buffer; certificate: Buffer; ca: Buffer }>;
}>) => Promise<GitHubSecretBrokerHttpResponse>;

/** mTLS-only Vault/KMS facade for one-time PKCE and leased static secrets. */
export class MtlsGitHubAuthorizationSecretClient implements GitHubAuthorizationSecretStore, GitHubClientSecretResolver {
  readonly #origin: URL;
  readonly #tls: Readonly<{ key: Buffer; certificate: Buffer; ca: Buffer }>;
  readonly #timeoutMs: number;
  readonly #http: GitHubSecretBrokerHttp;

  constructor(options: Readonly<{
    endpoint: string | URL;
    tls: Readonly<{ key: Buffer; certificate: Buffer; ca: Buffer }>;
    timeoutMs?: number;
    http?: GitHubSecretBrokerHttp;
  }>) {
    this.#origin = strictOrigin(options.endpoint);
    validateTls(options.tls);
    this.#tls = Object.freeze({ ...options.tls });
    this.#timeoutMs = integer(options.timeoutMs ?? 10_000, 1_000, 60_000);
    this.#http = options.http ?? requestSecretBroker;
  }

  async put(value: string, expiresAt: string): Promise<string> {
    if (!PKCE.test(value) || !futureIso(expiresAt)) invalid();
    const bytes = Buffer.from(value, "utf8");
    try {
      const response = await this.#http(route(this.#origin, "/v1/github-authorization-secrets"), {
        method: "POST",
        headers: Object.freeze({
          accept: "application/json",
          "content-type": "application/octet-stream",
          "x-deviludo-secret-purpose": "github-pkce-v1",
          "x-deviludo-expires-at": expiresAt,
        }),
        body: bytes,
        timeoutMs: this.#timeoutMs,
        tls: this.#tls,
      });
      const body = json(response, 201);
      exactKeys(body, ["expiresAt", "schemaVersion", "secretRef"]);
      if (body.schemaVersion !== "deviludo.github-authorization-secret.v1"
        || body.expiresAt !== expiresAt || typeof body.secretRef !== "string" || !SECRET_REF.test(body.secretRef)) invalid();
      return body.secretRef;
    } finally { bytes.fill(0); }
  }

  async take(secretRef: string): Promise<string | null> {
    validateSecretRef(secretRef);
    const requestBody = Buffer.from(JSON.stringify({
      schemaVersion: "deviludo.github-authorization-secret-take.v1",
      secretRef,
    }));
    const response = await this.#http(route(this.#origin, "/v1/github-authorization-secrets:take"), {
      method: "POST",
      headers: Object.freeze({ accept: "application/octet-stream", "content-type": "application/json" }),
      body: requestBody,
      timeoutMs: this.#timeoutMs,
      tls: this.#tls,
    });
    requestBody.fill(0);
    if (response.statusCode === 404) {
      response.payload.fill(0);
      return null;
    }
    if (response.statusCode !== 200 || response.contentType !== "application/octet-stream"
      || response.payload.byteLength !== 43) {
      response.payload.fill(0);
      invalid();
    }
    try {
      const value = response.payload.toString("utf8");
      if (!PKCE.test(value)) invalid();
      return value;
    } finally { response.payload.fill(0); }
  }

  async delete(secretRef: string): Promise<void> {
    validateSecretRef(secretRef);
    const requestBody = Buffer.from(JSON.stringify({
      schemaVersion: "deviludo.github-authorization-secret-revoke.v1",
      secretRef,
    }));
    try {
      const response = await this.#http(route(this.#origin, "/v1/github-authorization-secrets:revoke"), {
        method: "POST",
        headers: Object.freeze({ accept: "application/json", "content-type": "application/json" }),
        body: requestBody,
        timeoutMs: this.#timeoutMs,
        tls: this.#tls,
      });
      response.payload.fill(0);
      if (response.statusCode !== 204) invalid();
    } finally { requestBody.fill(0); }
  }

  async resolve(secretRef: string): Promise<GitHubClientSecretLease> {
    validateSecretRef(secretRef);
    const requestBody = Buffer.from(JSON.stringify({
      schemaVersion: "deviludo.static-secret-lease.v1",
      secretRef,
      purpose: "github-oauth-client-secret",
    }));
    let response: GitHubSecretBrokerHttpResponse;
    try {
      response = await this.#http(route(this.#origin, "/v1/static-secret-leases:resolve"), {
        method: "POST",
        headers: Object.freeze({ accept: "application/octet-stream", "content-type": "application/json" }),
        body: requestBody,
        timeoutMs: this.#timeoutMs,
        tls: this.#tls,
      });
    } finally { requestBody.fill(0); }
    if (response.statusCode !== 200 || response.contentType !== "application/octet-stream"
      || response.payload.byteLength < 8 || response.payload.byteLength > 1_024
      || /[\u0000-\u0020]/.test(response.payload.toString("utf8"))) {
      response.payload.fill(0);
      invalid();
    }
    return new BufferBackedGitHubClientSecretLease(response.payload);
  }

  async probe(): Promise<void> {
    const response = await this.#http(route(this.#origin, "/healthz"), {
      method: "GET",
      headers: Object.freeze({ accept: "application/json" }),
      timeoutMs: this.#timeoutMs,
      tls: this.#tls,
    });
    const body = json(response, 200);
    exactKeys(body, ["service", "status"]);
    if (body.status !== "ok" || body.service !== "deviludo-secret-broker") invalid();
  }
}

class BufferBackedGitHubClientSecretLease implements GitHubClientSecretLease {
  #buffer: Buffer | null;
  constructor(buffer: Buffer) { this.#buffer = buffer; }
  get value(): string {
    if (!this.#buffer) throw new Error("GitHub client secret lease was destroyed");
    return this.#buffer.toString("utf8");
  }
  destroy(): void {
    this.#buffer?.fill(0);
    this.#buffer = null;
  }
}

export async function githubAuthorizationSecretClientFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<MtlsGitHubAuthorizationSecretClient> {
  const [key, certificate, ca] = await Promise.all([
    readSecretFile(env, "DEVILUDO_GITHUB_AUTH_SECRET_TLS_KEY_FILE"),
    readSecretFile(env, "DEVILUDO_GITHUB_AUTH_SECRET_TLS_CERT_FILE"),
    readSecretFile(env, "DEVILUDO_GITHUB_AUTH_SECRET_CA_FILE"),
  ]);
  return new MtlsGitHubAuthorizationSecretClient({
    endpoint: required(env, "DEVILUDO_GITHUB_AUTH_SECRET_BROKER_URL"),
    tls: { key, certificate, ca },
    timeoutMs: integerString(env.DEVILUDO_GITHUB_AUTH_SECRET_TIMEOUT_MS, 10_000, 1_000, 60_000),
  });
}

async function requestSecretBroker(url: URL, input: Parameters<GitHubSecretBrokerHttp>[1]): Promise<GitHubSecretBrokerHttpResponse> {
  return new Promise((resolveRequest, reject) => {
    const headers = { ...input.headers };
    if (input.body) headers["content-length"] = String(input.body.byteLength);
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
      let total = 0;
      response.on("data", (chunk: Buffer | string) => {
        const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        total += value.byteLength;
        if (total > MAX_RESPONSE_BYTES) response.destroy(new Error("GitHub secret Broker response is too large"));
        else chunks.push(value);
      });
      response.once("error", reject);
      response.once("end", () => resolveRequest(Object.freeze({
        statusCode: response.statusCode ?? 503,
        contentType: String(response.headers["content-type"] ?? "").split(";", 1)[0]!.trim().toLowerCase(),
        payload: Buffer.concat(chunks),
      })));
    });
    request.setTimeout(input.timeoutMs, () => request.destroy(new Error("GitHub secret Broker timed out")));
    request.once("error", reject);
    request.end(input.body);
  });
}

function strictOrigin(value: string | URL): URL {
  const url = new URL(value.toString());
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password || url.search || url.hash
    || (url.pathname !== "/" && url.pathname !== "")) invalid();
  url.pathname = "/";
  return url;
}
function route(origin: URL, pathname: string): URL { const url = new URL(origin); url.pathname = pathname; return url; }
function validateTls(tls: Readonly<{ key: Buffer; certificate: Buffer; ca: Buffer }>): void {
  if ([tls.key, tls.certificate, tls.ca].some((value) => !Buffer.isBuffer(value) || value.byteLength < 32 || value.byteLength > 1024 * 1024)) invalid();
}
function validateSecretRef(value: string): void { if (!SECRET_REF.test(value) || value.includes("?") || value.includes("#")) invalid(); }
function futureIso(value: string): boolean { const timestamp = Date.parse(value); return Number.isFinite(timestamp) && timestamp > Date.now(); }
function json(response: GitHubSecretBrokerHttpResponse, status: number): Record<string, unknown> {
  if (response.statusCode !== status || response.contentType !== "application/json") { response.payload.fill(0); invalid(); }
  try { return record(JSON.parse(response.payload.toString("utf8")) as unknown); }
  catch { invalid(); }
  finally { response.payload.fill(0); }
}
function record(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) invalid(); return value as Record<string, unknown>; }
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) invalid();
}
async function readSecretFile(env: Readonly<Record<string, string | undefined>>, name: string): Promise<Buffer> {
  const path = required(env, name);
  if (!isAbsolute(path) || resolve(path) !== path || path.length > 4096 || path.includes("\0")) throw new Error(`${name} path is invalid`);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.size < 32 || metadata.size > 1024 * 1024) throw new Error(`${name} file is invalid`);
    return await file.readFile();
  } finally { await file.close(); }
}
function required(env: Readonly<Record<string, string | undefined>>, name: string): string { const value = env[name]?.trim(); if (!value) throw new Error(`${name} is required`); return value; }
function integer(value: number, minimum: number, maximum: number): number { if (!Number.isSafeInteger(value) || value < minimum || value > maximum) invalid(); return value; }
function integerString(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || String(parsed) !== value) invalid();
  return integer(parsed, minimum, maximum);
}
function invalid(): never { throw new Error("GitHub authorization secret Broker contract is invalid"); }
