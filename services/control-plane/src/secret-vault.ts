import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { request as httpsRequest, type RequestOptions } from "node:https";
import { isAbsolute, resolve } from "node:path";
import { Injectable } from "@nestjs/common";

export interface SecretWriteResult {
  readonly secretRef: string;
  readonly maskedFingerprint: string;
}

/**
 * The control-plane sees a secret only at ingress and receives a SecretRef
 * back. Production uses the isolated mTLS Secret Broker implementation; no
 * read method is exposed to API code, which prevents accidental plaintext
 * responses.
 */
export abstract class SecretVault {
  abstract write(path: string, plaintext: Uint8Array): Promise<SecretWriteResult>;
  abstract revoke(secretRef: string): Promise<void>;
}

export class ProcessIsolatedSecretVault extends SecretVault {
  readonly #handles = new Set<string>();

  async write(path: string, plaintext: Uint8Array): Promise<SecretWriteResult> {
    if (plaintext.byteLength < 8) throw new Error("Credential must contain at least 8 bytes");
    const digest = createHash("sha256").update(plaintext).digest("hex");
    const handle = `vault://kv/data/deviludo/${encodeURIComponent(path)}?version=${randomUUID()}`;
    this.#handles.add(handle);
    return {
      secretRef: handle,
      maskedFingerprint: `sha256:${digest.slice(0, 8)}…${digest.slice(-6)}`,
    };
  }

  async revoke(secretRef: string): Promise<void> {
    this.#handles.delete(secretRef);
  }
}

Injectable()(ProcessIsolatedSecretVault);

export class VaultIngressSecretVault extends SecretVault {
  readonly #origin: URL;
  readonly #tls: Readonly<{ key: Buffer; certificate: Buffer; ca: Buffer }>;
  readonly #http: VaultIngressHttp;

  constructor(options: Readonly<{
    endpoint: string | URL;
    tls: Readonly<{ key: Buffer; certificate: Buffer; ca: Buffer }>;
    http?: VaultIngressHttp;
  }>) {
    super();
    const endpoint = new URL(options.endpoint.toString());
    if (endpoint.protocol !== "https:" || !endpoint.hostname || endpoint.username || endpoint.password
      || endpoint.search || endpoint.hash || (endpoint.pathname !== "/" && endpoint.pathname !== "")) {
      throw new Error("Vault ingress URL must be credential-free HTTPS");
    }
    for (const value of [options.tls.key, options.tls.certificate, options.tls.ca]) {
      if (!Buffer.isBuffer(value) || value.byteLength < 32 || value.byteLength > 1024 * 1024) {
        throw new Error("Vault ingress mTLS material is invalid");
      }
    }
    endpoint.pathname = "/";
    this.#origin = endpoint;
    this.#tls = Object.freeze({ ...options.tls });
    this.#http = options.http ?? vaultIngressRequest;
  }

  async write(path: string, plaintext: Uint8Array): Promise<SecretWriteResult> {
    if (!/^credential-[a-f0-9-]{36}\/[1-9][0-9]{0,8}$/.test(path)
      || plaintext.byteLength < 8 || plaintext.byteLength > 64 * 1024) throw new Error("Credential write is invalid");
    const body = Buffer.from(plaintext);
    let response: VaultIngressHttpResponse | undefined;
    try {
      response = await this.#http(route(this.#origin, "/secrets:write"), {
        method: "POST", tls: this.#tls, body, headers: {
          accept: "application/json",
          "content-type": "application/octet-stream",
          "x-deviludo-secret-path": encodeURIComponent(path),
          "idempotency-key": createHash("sha256").update(`provider-credential\0${path}`).digest("hex"),
        }, timeoutMs: 30_000,
      });
      if (response.statusCode !== 200 && response.statusCode !== 201) throw new Error("Vault ingress rejected the credential write");
      const raw: unknown = JSON.parse(response.payload.toString("utf8"));
      if (!isSecretWriteResult(raw)) throw new Error("Vault ingress returned invalid secret metadata");
      return raw;
    } finally { body.fill(0); response?.payload.fill(0); }
  }

  async revoke(secretRef: string): Promise<void> {
    if (!/^vault:\/\/kv\/deviludo\/records\/[a-f0-9-]{36}$/.test(secretRef)) throw new Error("Vault SecretRef is invalid");
    const body = Buffer.from(JSON.stringify({ secretRef }));
    let response: VaultIngressHttpResponse | undefined;
    try {
      response = await this.#http(route(this.#origin, "/secrets:revoke"), {
        method: "POST", tls: this.#tls, body,
        headers: { accept: "application/json", "content-type": "application/json",
          "idempotency-key": createHash("sha256").update(`revoke\0${secretRef}`).digest("hex") },
        timeoutMs: 30_000,
      });
      if (response.statusCode !== 204) throw new Error("Vault ingress rejected the credential revocation");
    } finally { body.fill(0); response?.payload.fill(0); }
  }
}

export async function createSecretVault(): Promise<SecretVault> {
  const endpoint = process.env.DEVILUDO_VAULT_INGRESS_URL;
  if (endpoint) {
    const [key, certificate, ca] = await Promise.all([
      secretFile("DEVILUDO_VAULT_INGRESS_TLS_KEY_FILE"),
      secretFile("DEVILUDO_VAULT_INGRESS_TLS_CERT_FILE"),
      secretFile("DEVILUDO_VAULT_INGRESS_CA_FILE"),
    ]);
    return new VaultIngressSecretVault({ endpoint, tls: { key, certificate, ca } });
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error("DEVILUDO_VAULT_INGRESS_URL is required in production");
  }
  return new ProcessIsolatedSecretVault();
}

export interface VaultIngressHttpResponse { readonly statusCode: number; readonly payload: Buffer }
export type VaultIngressHttp = (url: URL, input: Readonly<{
  method: "POST";
  headers: Readonly<Record<string, string>>;
  body: Buffer;
  timeoutMs: number;
  tls: Readonly<{ key: Buffer; certificate: Buffer; ca: Buffer }>;
}>) => Promise<VaultIngressHttpResponse>;

async function vaultIngressRequest(url: URL, input: Parameters<VaultIngressHttp>[1]): Promise<VaultIngressHttpResponse> {
  return new Promise((resolveRequest, reject) => {
    const options: RequestOptions = { method: input.method,
      headers: { ...input.headers, "content-length": String(input.body.byteLength) },
      key: input.tls.key, cert: input.tls.certificate, ca: input.tls.ca,
      rejectUnauthorized: true, minVersion: "TLSv1.3", servername: url.hostname };
    const request = httpsRequest(url, options, (response) => {
      const chunks: Buffer[] = []; let size = 0;
      response.on("data", (chunk: Buffer | string) => {
        const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); size += value.byteLength;
        if (size > 64 * 1024) response.destroy(new Error("Vault ingress response exceeded its bound")); else chunks.push(value);
      });
      response.once("error", reject);
      response.once("end", () => resolveRequest({ statusCode: response.statusCode ?? 503, payload: Buffer.concat(chunks) }));
    });
    request.setTimeout(input.timeoutMs, () => request.destroy(new Error("Vault ingress timed out")));
    request.once("error", reject); request.end(input.body);
  });
}

async function secretFile(name: string): Promise<Buffer> {
  const path = process.env[name]?.trim();
  if (!path || !isAbsolute(path) || resolve(path) !== path || path.length > 4096 || path.includes("\0")) throw new Error(`${name} path is invalid`);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const metadata = await file.stat(); if (!metadata.isFile() || metadata.size < 32 || metadata.size > 1024 * 1024) throw new Error(`${name} file is invalid`); return await file.readFile(); }
  finally { await file.close(); }
}
function route(origin: URL, pathname: string): URL { const url = new URL(origin); url.pathname = pathname; return url; }

function isSecretWriteResult(value: unknown): value is SecretWriteResult {
  if (!value || typeof value !== "object") return false;
  const result = value as Record<string, unknown>;
  return (
    typeof result.secretRef === "string" &&
    /^vault:\/\/kv\/deviludo\/records\/[a-f0-9-]{36}$/.test(result.secretRef) &&
    typeof result.maskedFingerprint === "string" &&
    /^sha256:[a-f0-9]{8}…[a-f0-9]{6}$/i.test(result.maskedFingerprint)
  );
}
