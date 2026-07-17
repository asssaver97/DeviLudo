export type SecretBackend = "vault" | "kms-envelope";

/** Business data stores only this pointer and safe metadata, never plaintext. */
export interface SecretRef {
  readonly backend: SecretBackend;
  readonly path: string;
  readonly version: string;
}

export interface CredentialVersionMetadata {
  readonly credentialVersionId: string;
  readonly secretRef: SecretRef;
  readonly fingerprint: `sha256:${string}`;
  readonly maskedFingerprint: string;
  readonly createdAt: string;
  readonly rotatedAt?: string;
  readonly lastUsedAt?: string;
  readonly status: "ACTIVE" | "PREVIOUS" | "REVOKED";
}

export interface CredentialRotation {
  readonly active: CredentialVersionMetadata;
  readonly previous: CredentialVersionMetadata;
}

/**
 * Fingerprint mutable bytes supplied by a secret-ingress component. The caller
 * remains responsible for zeroing its buffer immediately after this function.
 */
export async function fingerprintSecret(
  bytes: Uint8Array,
): Promise<`sha256:${string}`> {
  if (bytes.byteLength < 8) {
    throw new Error("Credential is too short");
  }
  const digest = await crypto.subtle.digest("SHA-256", ownedBytes(bytes));
  return `sha256:${toHex(new Uint8Array(digest))}`;
}

export function maskFingerprint(fingerprint: `sha256:${string}`): string {
  const digest = fingerprint.slice("sha256:".length);
  return `sha256:${digest.slice(0, 8)}…${digest.slice(-6)}`;
}

export function rotateCredential(
  current: CredentialVersionMetadata,
  replacement: CredentialVersionMetadata,
  now = new Date().toISOString(),
): CredentialRotation {
  if (current.status !== "ACTIVE" || replacement.status !== "ACTIVE") {
    throw new Error("Rotation requires an active current and replacement version");
  }
  if (current.credentialVersionId === replacement.credentialVersionId) {
    throw new Error("Replacement credential version must be new");
  }
  if (
    current.fingerprint === replacement.fingerprint ||
    (current.secretRef.backend === replacement.secretRef.backend &&
      current.secretRef.path === replacement.secretRef.path &&
      current.secretRef.version === replacement.secretRef.version)
  ) {
    throw new Error("Replacement credential must reference new secret material");
  }
  return Object.freeze({
    active: Object.freeze({ ...replacement, rotatedAt: now }),
    previous: Object.freeze({ ...current, status: "PREVIOUS", rotatedAt: now }),
  });
}

export function revokeCredential(
  credential: CredentialVersionMetadata,
  now = new Date().toISOString(),
): CredentialVersionMetadata {
  return Object.freeze({
    ...credential,
    status: "REVOKED",
    rotatedAt: now,
  });
}

export interface RunTokenBudget {
  readonly maxCostUsd: number;
  readonly maxInputTokens?: number;
  readonly maxOutputTokens?: number;
}

export interface RunTokenClaims {
  readonly iss: "deviludo-control-plane";
  readonly aud: "deviludo-inference-gateway";
  readonly tenantId: string;
  readonly projectId: string;
  readonly runId: string;
  readonly profileRevisionId: string;
  readonly credentialVersionId: string;
  readonly providerRevisionId: string;
  readonly models: readonly string[];
  readonly budget: RunTokenBudget;
  readonly iat: number;
  readonly exp: number;
  readonly nonce: string;
}

export interface RunTokenBinding {
  readonly tenantId: string;
  readonly projectId: string;
  readonly runId: string;
  readonly profileRevisionId: string;
}

const MAX_RUN_TOKEN_TTL_SECONDS = 15 * 60;

/** HMAC token for the internal gateway; this is not an upstream API key. */
export async function issueRunToken(
  signingKey: Uint8Array,
  claims: RunTokenClaims,
): Promise<string> {
  assertRunTokenClaims(claims);
  const header = { alg: "HS256", typ: "DLRT", kid: "inference-gateway-v1" } as const;
  const encodedHeader = base64UrlEncode(new TextEncoder().encode(JSON.stringify(header)));
  const encodedClaims = base64UrlEncode(new TextEncoder().encode(JSON.stringify(claims)));
  const unsigned = `${encodedHeader}.${encodedClaims}`;
  const signature = await sign(signingKey, new TextEncoder().encode(unsigned));
  return `${unsigned}.${base64UrlEncode(signature)}`;
}

export async function verifyRunToken(
  signingKey: Uint8Array,
  token: string,
  binding: RunTokenBinding,
  nowEpochSeconds = Math.floor(Date.now() / 1000),
): Promise<RunTokenClaims> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Malformed run token");
  const [headerPart = "", claimsPart = "", signaturePart = ""] = parts;
  const header = parseJsonObject(base64UrlDecode(headerPart));
  if (header.alg !== "HS256" || header.typ !== "DLRT") {
    throw new Error("Unsupported run token header");
  }

  const key = await importHmacKey(signingKey, ["verify"]);
  const validSignature = await crypto.subtle.verify(
    "HMAC",
    key,
    ownedBytes(base64UrlDecode(signaturePart)),
    ownedBytes(new TextEncoder().encode(`${headerPart}.${claimsPart}`)),
  );
  if (!validSignature) throw new Error("Invalid run token signature");

  const raw = parseJsonObject(base64UrlDecode(claimsPart));
  const claims = raw as unknown as RunTokenClaims;
  assertRunTokenClaims(claims);
  if (claims.exp <= nowEpochSeconds || claims.iat > nowEpochSeconds + 30) {
    throw new Error("Run token is expired or not yet valid");
  }
  if (
    claims.tenantId !== binding.tenantId ||
    claims.projectId !== binding.projectId ||
    claims.runId !== binding.runId ||
    claims.profileRevisionId !== binding.profileRevisionId
  ) {
    throw new Error("Run token binding mismatch");
  }
  return Object.freeze(claims);
}

function assertRunTokenClaims(claims: RunTokenClaims): void {
  if (
    claims.iss !== "deviludo-control-plane" ||
    claims.aud !== "deviludo-inference-gateway"
  ) {
    throw new Error("Invalid run token issuer or audience");
  }
  for (const value of [
    claims.tenantId,
    claims.projectId,
    claims.runId,
    claims.profileRevisionId,
    claims.credentialVersionId,
    claims.providerRevisionId,
    claims.nonce,
  ]) {
    if (typeof value !== "string" || value.length === 0) {
      throw new Error("Run token is missing an immutable binding");
    }
  }
  if (
    !Array.isArray(claims.models) ||
    claims.models.length === 0 ||
    claims.models.some((model) => typeof model !== "string" || !model || /\s/.test(model))
  ) {
    throw new Error("Run token must carry a model allowlist");
  }
  if (!claims.budget || claims.budget.maxCostUsd <= 0) {
    throw new Error("Run token must carry a positive budget");
  }
  if (
    !Number.isInteger(claims.iat) ||
    !Number.isInteger(claims.exp) ||
    claims.exp <= claims.iat ||
    claims.exp - claims.iat > MAX_RUN_TOKEN_TTL_SECONDS
  ) {
    throw new Error("Run token lifetime exceeds the 15 minute maximum");
  }
}

function parseJsonObject(encoded: Uint8Array): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(encoded));
  } catch {
    throw new Error("Run token contains invalid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Run token JSON must be an object");
  }
  return parsed as Record<string, unknown>;
}

async function sign(keyBytes: Uint8Array, value: Uint8Array): Promise<Uint8Array> {
  const key = await importHmacKey(keyBytes, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, ownedBytes(value)));
}

async function importHmacKey(
  keyBytes: Uint8Array,
  usages: KeyUsage[],
): Promise<CryptoKey> {
  if (keyBytes.byteLength < 32) throw new Error("Run token signing key is too short");
  return crypto.subtle.importKey(
    "raw",
    ownedBytes(keyBytes),
    { name: "HMAC", hash: "SHA-256" },
    false,
    usages,
  );
}

function base64UrlEncode(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function base64UrlDecode(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) throw new Error("Invalid base64url value");
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(
    value.length + ((4 - (value.length % 4)) % 4),
    "=",
  );
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    throw new Error("Invalid base64url value");
  }
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function toHex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function ownedBytes(value: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(new ArrayBuffer(value.byteLength));
  copy.set(value);
  return copy;
}
