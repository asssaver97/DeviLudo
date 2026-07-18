import { request as httpsRequest, type RequestOptions } from "node:https";
import type { SecretBackend } from "./contracts";

const SAFE_MOUNT = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const SAFE_PATH = /^(?:records\/[a-f0-9-]{36}|static\/[A-Za-z0-9][A-Za-z0-9._-]{0,159})$/;
const MAX_RESPONSE_BYTES = 128 * 1024;
const MAX_SECRET_BYTES = 64 * 1024;

export interface VaultBackendTls {
  readonly ca: Buffer;
  readonly key?: Buffer;
  readonly certificate?: Buffer;
}

export interface VaultHttpResponse {
  readonly statusCode: number;
  readonly payload: Buffer;
}

export type VaultHttp = (url: URL, input: Readonly<{
  method: "GET" | "POST" | "DELETE";
  token: Buffer;
  tls: VaultBackendTls;
  body?: Buffer;
  timeoutMs: number;
}>) => Promise<VaultHttpResponse>;

export class VaultKvV2SecretBackend implements SecretBackend {
  readonly #origin: URL;
  readonly #mount: string;
  readonly #token: Buffer;
  readonly #tls: VaultBackendTls;
  readonly #timeoutMs: number;
  readonly #http: VaultHttp;

  constructor(options: Readonly<{
    endpoint: string | URL;
    mount: string;
    token: Buffer;
    tls: VaultBackendTls;
    timeoutMs?: number;
    http?: VaultHttp;
  }>) {
    this.#origin = strictOrigin(options.endpoint);
    if (!SAFE_MOUNT.test(options.mount)) throw new Error("Vault KV mount is invalid");
    if (!Buffer.isBuffer(options.token) || options.token.byteLength < 8 || options.token.byteLength > 4_096
      || /[\u0000-\u0020]/.test(options.token.toString("utf8"))) throw new Error("Vault token is invalid");
    validateTls(options.tls);
    this.#mount = options.mount;
    this.#token = Buffer.from(options.token);
    this.#tls = Object.freeze({ ...options.tls });
    this.#timeoutMs = integer(options.timeoutMs ?? 10_000, 1_000, 60_000);
    this.#http = options.http ?? vaultHttps;
  }

  async create(path: string, plaintext: Uint8Array): Promise<void> {
    validatePath(path);
    if (!(plaintext instanceof Uint8Array) || plaintext.byteLength < 8 || plaintext.byteLength > MAX_SECRET_BYTES) {
      throw new Error("Vault secret bytes are invalid");
    }
    const body = Buffer.from(JSON.stringify({
      options: { cas: 0 },
      data: { encoding: "base64", value: Buffer.from(plaintext).toString("base64") },
    }));
    try {
      const response = await this.#request("POST", dataPath(this.#origin, this.#mount, path), body);
      response.payload.fill(0);
      if (response.statusCode !== 200 && response.statusCode !== 204) throw new Error("Vault rejected the immutable secret create");
    } finally { body.fill(0); }
  }

  async read(path: string): Promise<Buffer | null> {
    validatePath(path);
    const response = await this.#request("GET", dataPath(this.#origin, this.#mount, path));
    if (response.statusCode === 404) { response.payload.fill(0); return null; }
    if (response.statusCode !== 200) { response.payload.fill(0); throw new Error("Vault rejected the secret read"); }
    try {
      const body = record(JSON.parse(response.payload.toString("utf8")) as unknown);
      const envelope = record(body.data);
      const data = record(envelope.data);
      if (data.encoding !== "base64" || typeof data.value !== "string" || !canonicalBase64(data.value)) invalidVault();
      const secret = Buffer.from(data.value, "base64");
      if (secret.byteLength < 8 || secret.byteLength > MAX_SECRET_BYTES) { secret.fill(0); invalidVault(); }
      return secret;
    } catch { throw new Error("Vault returned an invalid secret envelope"); }
    finally { response.payload.fill(0); }
  }

  async destroy(path: string): Promise<void> {
    validatePath(path);
    const response = await this.#request("DELETE", metadataPath(this.#origin, this.#mount, path));
    response.payload.fill(0);
    if (![200, 204, 404].includes(response.statusCode)) throw new Error("Vault rejected the secret destruction");
  }

  async probe(): Promise<void> {
    const url = new URL(this.#origin);
    url.pathname = "/v1/sys/health";
    const response = await this.#request("GET", url);
    response.payload.fill(0);
    if (![200, 429, 472, 473].includes(response.statusCode)) throw new Error("Vault readiness probe failed");
  }

  async #request(method: "GET" | "POST" | "DELETE", url: URL, body?: Buffer): Promise<VaultHttpResponse> {
    return this.#http(url, { method, token: this.#token, tls: this.#tls, timeoutMs: this.#timeoutMs, ...(body ? { body } : {}) });
  }
}

export class MemorySecretBackend implements SecretBackend {
  readonly values = new Map<string, Buffer>();
  async create(path: string, plaintext: Uint8Array): Promise<void> {
    validatePath(path);
    if (this.values.has(path)) throw new Error("secret already exists");
    this.values.set(path, Buffer.from(plaintext));
  }
  async read(path: string): Promise<Buffer | null> {
    validatePath(path);
    const value = this.values.get(path);
    return value ? Buffer.from(value) : null;
  }
  async destroy(path: string): Promise<void> { validatePath(path); this.values.get(path)?.fill(0); this.values.delete(path); }
  async probe(): Promise<void> {}
}

export async function vaultHttps(url: URL, input: Parameters<VaultHttp>[1]): Promise<VaultHttpResponse> {
  return new Promise((resolve, reject) => {
    const token = input.token.toString("utf8");
    const headers: Record<string, string> = { accept: "application/json", "x-vault-token": token };
    if (input.body) {
      headers["content-type"] = "application/json";
      headers["content-length"] = String(input.body.byteLength);
    }
    const options: RequestOptions = {
      method: input.method,
      headers,
      ca: input.tls.ca,
      ...(input.tls.key ? { key: input.tls.key } : {}),
      ...(input.tls.certificate ? { cert: input.tls.certificate } : {}),
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
          response.destroy(new Error("Vault response exceeded its bound"));
        }
        else chunks.push(value);
      });
      response.once("error", reject);
      response.once("end", () => {
        try { resolve(Object.freeze({ statusCode: response.statusCode ?? 503, payload: Buffer.concat(chunks) })); }
        finally { for (const item of chunks) item.fill(0); }
      });
    });
    request.setTimeout(input.timeoutMs, () => request.destroy(new Error("Vault request timed out")));
    request.once("error", reject);
    request.end(input.body);
  });
}

export function backendPathFromStaticSecretRef(secretRef: string): string {
  const match = /^vault:\/\/kv\/deviludo\/(static\/[A-Za-z0-9][A-Za-z0-9._-]{0,159})$/.exec(secretRef);
  if (!match) throw new Error("Static Vault SecretRef is invalid");
  return match[1]!;
}

function dataPath(origin: URL, mount: string, path: string): URL {
  const url = new URL(origin);
  url.pathname = `/v1/${mount}/data/deviludo/${path}`;
  return url;
}
function metadataPath(origin: URL, mount: string, path: string): URL {
  const url = new URL(origin);
  url.pathname = `/v1/${mount}/metadata/deviludo/${path}`;
  return url;
}
function strictOrigin(value: string | URL): URL {
  const url = new URL(value.toString());
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password || url.search || url.hash
    || (url.pathname !== "/" && url.pathname !== "")) throw new Error("Vault endpoint must be a credential-free HTTPS origin");
  url.pathname = "/";
  return url;
}
function validatePath(path: string): void { if (!SAFE_PATH.test(path)) throw new Error("Vault secret path is invalid"); }
function validateTls(tls: VaultBackendTls): void {
  if (!Buffer.isBuffer(tls.ca) || tls.ca.byteLength < 32 || tls.ca.byteLength > 1024 * 1024) throw new Error("Vault CA is invalid");
  if ((tls.key && (!Buffer.isBuffer(tls.key) || tls.key.byteLength < 32 || tls.key.byteLength > 1024 * 1024))
    || (tls.certificate && (!Buffer.isBuffer(tls.certificate) || tls.certificate.byteLength < 32 || tls.certificate.byteLength > 1024 * 1024))
    || Boolean(tls.key) !== Boolean(tls.certificate)) throw new Error("Vault client TLS material is invalid");
}
function canonicalBase64(value: string): boolean { try { return Buffer.from(value, "base64").toString("base64") === value; } catch { return false; } }
function record(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) invalidVault(); return value as Record<string, unknown>; }
function invalidVault(): never { throw new Error("Vault response is invalid"); }
function integer(value: number, minimum: number, maximum: number): number { if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error("Vault timeout is invalid"); return value; }
