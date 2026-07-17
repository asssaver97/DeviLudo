import { createHash, randomUUID } from "node:crypto";
import { Injectable } from "@nestjs/common";

export interface SecretWriteResult {
  readonly secretRef: string;
  readonly maskedFingerprint: string;
}

/**
 * The control-plane sees a secret only at ingress and receives a SecretRef
 * back. Production replaces this provider with Vault/KMS; no read method is
 * exposed to API code, which prevents accidental plaintext responses.
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
  readonly #endpoint: string;

  constructor(rawEndpoint: string) {
    super();
    const endpoint = new URL(rawEndpoint);
    if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
      throw new Error("Vault ingress URL must be credential-free HTTPS");
    }
    this.#endpoint = endpoint.toString().replace(/\/$/, "");
  }

  async write(path: string, plaintext: Uint8Array): Promise<SecretWriteResult> {
    if (plaintext.byteLength < 8) throw new Error("Credential must contain at least 8 bytes");
    const response = await fetch(`${this.#endpoint}/secrets:write`, {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "x-deviludo-secret-path": encodeURIComponent(path),
      },
      body: plaintext as BodyInit,
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error("Vault ingress rejected the credential write");
    const raw: unknown = await response.json();
    if (!isSecretWriteResult(raw)) throw new Error("Vault ingress returned invalid secret metadata");
    return raw;
  }

  async revoke(secretRef: string): Promise<void> {
    const response = await fetch(`${this.#endpoint}/secrets:revoke`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secretRef }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error("Vault ingress rejected the credential revocation");
  }
}

export function createSecretVault(): SecretVault {
  const endpoint = process.env.DEVILUDO_VAULT_INGRESS_URL;
  if (endpoint) return new VaultIngressSecretVault(endpoint);
  if (process.env.NODE_ENV === "production") {
    throw new Error("DEVILUDO_VAULT_INGRESS_URL is required in production");
  }
  return new ProcessIsolatedSecretVault();
}

function isSecretWriteResult(value: unknown): value is SecretWriteResult {
  if (!value || typeof value !== "object") return false;
  const result = value as Record<string, unknown>;
  return (
    typeof result.secretRef === "string" &&
    /^vault:\/\//.test(result.secretRef) &&
    typeof result.maskedFingerprint === "string" &&
    /^sha256:[a-f0-9]{8}…[a-f0-9]{6}$/i.test(result.maskedFingerprint)
  );
}
