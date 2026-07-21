import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const MAX_ASSERTION_AGE_MS = 30_000;
const MAX_FUTURE_SKEW_MS = 5_000;
const MAX_TRACKED_NONCES = 10_000;
const NONCE = /^[A-Za-z0-9_-]{24}$/;
const SIGNATURE = /^[A-Za-z0-9_-]{43}$/;
const SHA256 = /^[a-f0-9]{64}$/;

type Environment = Readonly<Record<string, string | undefined>>;
type HeaderValues = Readonly<Record<string, string | readonly string[] | undefined>>;

export class LocalAgentRuntimeAuthenticationError extends Error {}

export interface LocalAgentRuntimeAssertion {
  readonly method: "POST";
  readonly path: "/v1/preflight" | "/v1/runs";
  readonly body: string | Uint8Array;
}

export function localAgentRuntimeKeyFromEnvironment(env: Environment = process.env): Uint8Array {
  const encoded = env.DEVILUDO_LOCAL_AGENT_RUNTIME_HMAC_KEY?.trim();
  if (!encoded || !/^[A-Za-z0-9_-]{43,86}$/.test(encoded)) invalid();
  const key = Buffer.from(encoded, "base64url");
  if (key.byteLength < 32 || key.byteLength > 64 || key.toString("base64url") !== encoded) invalid();
  return new Uint8Array(key);
}

export function createLocalAgentRuntimeHeaders(
  assertion: LocalAgentRuntimeAssertion,
  options: Readonly<{ key?: Uint8Array; now?: Date; nonce?: string }> = {},
): Readonly<Record<string, string>> {
  validateAssertion(assertion);
  const key = options.key ?? localAgentRuntimeKeyFromEnvironment();
  validateKey(key);
  const now = options.now ?? new Date();
  if (!Number.isFinite(now.getTime())) invalid();
  const issuedAt = now.toISOString();
  const nonce = options.nonce ?? randomBytes(18).toString("base64url");
  if (!NONCE.test(nonce)) invalid();
  const bodyDigest = digest(assertion.body);
  const signature = sign(assertion.method, assertion.path, bodyDigest, issuedAt, nonce, key);
  return Object.freeze({
    "x-deviludo-local-agent-runtime": "v1",
    "x-deviludo-local-agent-issued-at": issuedAt,
    "x-deviludo-local-agent-nonce": nonce,
    "x-deviludo-local-agent-body-sha256": bodyDigest,
    "x-deviludo-local-agent-signature": signature,
  });
}

export class LocalAgentRuntimeRequestVerifier {
  readonly #key: Uint8Array;
  readonly #usedNonces = new Map<string, number>();

  constructor(key: Uint8Array) {
    validateKey(key);
    this.#key = new Uint8Array(key);
  }

  verify(
    assertion: LocalAgentRuntimeAssertion & Readonly<{ headers: HeaderValues }>,
    now: Date = new Date(),
  ): void {
    validateAssertion(assertion);
    const nowMs = now.getTime();
    if (!Number.isFinite(nowMs)) unauthorized();
    const version = header(assertion.headers, "x-deviludo-local-agent-runtime");
    const issuedAt = header(assertion.headers, "x-deviludo-local-agent-issued-at");
    const nonce = header(assertion.headers, "x-deviludo-local-agent-nonce");
    const claimedDigest = header(assertion.headers, "x-deviludo-local-agent-body-sha256");
    const suppliedSignature = header(assertion.headers, "x-deviludo-local-agent-signature");
    if (version !== "v1" || !issuedAt || !nonce || !NONCE.test(nonce)
      || !claimedDigest || !SHA256.test(claimedDigest)
      || !suppliedSignature || !SIGNATURE.test(suppliedSignature)) unauthorized();
    const issuedAtMs = Date.parse(issuedAt);
    if (!Number.isFinite(issuedAtMs)
      || issuedAtMs < nowMs - MAX_ASSERTION_AGE_MS
      || issuedAtMs > nowMs + MAX_FUTURE_SKEW_MS) unauthorized();
    const actualDigest = digest(assertion.body);
    if (claimedDigest !== actualDigest) unauthorized();
    const expected = sign(assertion.method, assertion.path, actualDigest, issuedAt, nonce, this.#key);
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

function validateAssertion(value: LocalAgentRuntimeAssertion): void {
  if (value.method !== "POST" || (value.path !== "/v1/preflight" && value.path !== "/v1/runs")) invalid();
}

function validateKey(value: Uint8Array): void {
  if (!(value instanceof Uint8Array) || value.byteLength < 32 || value.byteLength > 64) invalid();
}

function header(headers: HeaderValues, name: string): string | undefined {
  const value = headers[name];
  return typeof value === "string" ? value : undefined;
}

function digest(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function sign(method: string, path: string, bodyDigest: string, issuedAt: string, nonce: string, key: Uint8Array): string {
  return createHmac("sha256", key)
    .update(["deviludo.local-agent-runtime.v1", method, path, bodyDigest, issuedAt, nonce].join("\n"))
    .digest("base64url");
}

function invalid(): never {
  throw new LocalAgentRuntimeAuthenticationError("Local Agent runtime authentication configuration is invalid");
}

function unauthorized(): never {
  throw new LocalAgentRuntimeAuthenticationError("Local Agent runtime request authentication failed");
}
