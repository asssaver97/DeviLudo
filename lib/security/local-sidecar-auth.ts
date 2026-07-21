import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const MAX_ASSERTION_AGE_MS = 30_000;
const MAX_FUTURE_SKEW_MS = 5_000;
const MAX_TRACKED_NONCES = 10_000;
const AUDIENCE = /^[a-z][a-z0-9-]{2,63}$/;
const ENVIRONMENT_VARIABLE = /^DEVILUDO_[A-Z0-9_]+$/;
const NONCE = /^[A-Za-z0-9_-]{24}$/;
const SIGNATURE = /^[A-Za-z0-9_-]{43}$/;
const SHA256 = /^[a-f0-9]{64}$/;

type Environment = Readonly<Record<string, string | undefined>>;
type HeaderValues = Readonly<Record<string, string | readonly string[] | undefined>>;

export interface LocalSidecarProtocol {
  readonly audience: string;
  readonly keyEnvironmentVariable: string;
}

export interface LocalSidecarAssertion {
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly body: string | Uint8Array;
}

export class LocalSidecarAuthenticationError extends Error {}

export function localSidecarKeyFromEnvironment(
  protocol: LocalSidecarProtocol,
  env: Environment,
): Uint8Array {
  validateProtocol(protocol);
  const encoded = env[protocol.keyEnvironmentVariable]?.trim();
  if (!encoded || !/^[A-Za-z0-9_-]{43,86}$/.test(encoded)) invalid();
  const key = Buffer.from(encoded, "base64url");
  if (key.byteLength < 32 || key.byteLength > 64 || key.toString("base64url") !== encoded) invalid();
  return new Uint8Array(key);
}

export function createLocalSidecarHeaders(
  protocol: LocalSidecarProtocol,
  assertion: LocalSidecarAssertion,
  options: Readonly<{ key: Uint8Array; now?: Date; nonce?: string }>,
): Readonly<Record<string, string>> {
  validateProtocol(protocol);
  validateAssertion(assertion);
  validateKey(options.key);
  const now = options.now ?? new Date();
  if (!Number.isFinite(now.getTime())) invalid();
  const issuedAt = now.toISOString();
  const nonce = options.nonce ?? randomBytes(18).toString("base64url");
  if (!NONCE.test(nonce)) invalid();
  const bodyDigest = digest(assertion.body);
  const signature = sign(protocol.audience, assertion.method, assertion.path, bodyDigest, issuedAt, nonce, options.key);
  return Object.freeze({
    "x-deviludo-local-sidecar": "v1",
    "x-deviludo-local-sidecar-audience": protocol.audience,
    "x-deviludo-local-sidecar-issued-at": issuedAt,
    "x-deviludo-local-sidecar-nonce": nonce,
    "x-deviludo-local-sidecar-body-sha256": bodyDigest,
    "x-deviludo-local-sidecar-signature": signature,
  });
}

export class LocalSidecarRequestVerifier {
  readonly #protocol: LocalSidecarProtocol;
  readonly #key: Uint8Array;
  readonly #usedNonces = new Map<string, number>();

  constructor(protocol: LocalSidecarProtocol, key: Uint8Array) {
    validateProtocol(protocol);
    validateKey(key);
    this.#protocol = Object.freeze({ ...protocol });
    this.#key = new Uint8Array(key);
  }

  verify(
    assertion: LocalSidecarAssertion & Readonly<{ headers: HeaderValues }>,
    now: Date = new Date(),
  ): void {
    validateAssertion(assertion);
    const nowMs = now.getTime();
    if (!Number.isFinite(nowMs)) unauthorized();
    const version = header(assertion.headers, "x-deviludo-local-sidecar");
    const audience = header(assertion.headers, "x-deviludo-local-sidecar-audience");
    const issuedAt = header(assertion.headers, "x-deviludo-local-sidecar-issued-at");
    const nonce = header(assertion.headers, "x-deviludo-local-sidecar-nonce");
    const claimedDigest = header(assertion.headers, "x-deviludo-local-sidecar-body-sha256");
    const suppliedSignature = header(assertion.headers, "x-deviludo-local-sidecar-signature");
    if (version !== "v1" || audience !== this.#protocol.audience || !issuedAt || !nonce || !NONCE.test(nonce)
      || !claimedDigest || !SHA256.test(claimedDigest)
      || !suppliedSignature || !SIGNATURE.test(suppliedSignature)) unauthorized();
    const issuedAtMs = Date.parse(issuedAt);
    if (!Number.isFinite(issuedAtMs)
      || issuedAtMs < nowMs - MAX_ASSERTION_AGE_MS
      || issuedAtMs > nowMs + MAX_FUTURE_SKEW_MS) unauthorized();
    const actualDigest = digest(assertion.body);
    if (claimedDigest !== actualDigest) unauthorized();
    const expected = sign(audience, assertion.method, assertion.path, actualDigest, issuedAt, nonce, this.#key);
    const suppliedBytes = Buffer.from(suppliedSignature, "base64url");
    const expectedBytes = Buffer.from(expected, "base64url");
    if (suppliedBytes.byteLength !== expectedBytes.byteLength
      || !timingSafeEqual(suppliedBytes, expectedBytes)) unauthorized();
    this.#prune(nowMs);
    if (this.#usedNonces.has(nonce) || this.#usedNonces.size >= MAX_TRACKED_NONCES) unauthorized();
    this.#usedNonces.set(nonce, issuedAtMs + MAX_ASSERTION_AGE_MS + MAX_FUTURE_SKEW_MS);
  }

  #prune(nowMs: number): void {
    for (const [nonce, expiresAt] of this.#usedNonces) {
      if (expiresAt < nowMs) this.#usedNonces.delete(nonce);
    }
  }
}

function validateProtocol(value: LocalSidecarProtocol): void {
  if (!AUDIENCE.test(value.audience) || !ENVIRONMENT_VARIABLE.test(value.keyEnvironmentVariable)) invalid();
}

function validateAssertion(value: LocalSidecarAssertion): void {
  if ((value.method !== "GET" && value.method !== "POST")
    || typeof value.path !== "string" || value.path.length < 2 || value.path.length > 2_048
    || !value.path.startsWith("/") || /[?#\0\r\n]/.test(value.path)
    || (value.method === "GET" && byteLength(value.body) !== 0)) invalid();
}

function validateKey(value: Uint8Array): void {
  if (!(value instanceof Uint8Array) || value.byteLength < 32 || value.byteLength > 64) invalid();
}

function header(headers: HeaderValues, name: string): string | undefined {
  const value = headers[name];
  return typeof value === "string" ? value : undefined;
}

function byteLength(value: string | Uint8Array): number {
  return typeof value === "string" ? Buffer.byteLength(value) : value.byteLength;
}

function digest(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function sign(
  audience: string,
  method: string,
  path: string,
  bodyDigest: string,
  issuedAt: string,
  nonce: string,
  key: Uint8Array,
): string {
  return createHmac("sha256", key)
    .update(["deviludo.local-sidecar.v1", audience, method, path, bodyDigest, issuedAt, nonce].join("\n"))
    .digest("base64url");
}

function invalid(): never {
  throw new LocalSidecarAuthenticationError("Local sidecar authentication configuration is invalid");
}

function unauthorized(): never {
  throw new LocalSidecarAuthenticationError("Local sidecar request authentication failed");
}
