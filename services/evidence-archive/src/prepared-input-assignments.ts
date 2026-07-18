import { createPublicKey, sign, verify, type KeyObject } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { canonicalJson } from "../../runner-control/src/canonical";
import type { EvidenceArchiveWorkloadIdentity } from "./contracts";
import type { PreparedInputTenantAuthorizer } from "./prepared-inputs";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,159}$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_VALIDITY_MS = 15 * 60_000;
const CLOCK_SKEW_MS = 30_000;

export interface PreparedInputAssignmentClaims {
  readonly kind: "deviludo-prepared-input-assignments";
  readonly version: 1;
  readonly revision: number;
  readonly spiffeId: string;
  readonly certificateFingerprint: string;
  readonly tenantIds: readonly string[];
  readonly issuedAt: string;
  readonly expiresAt: string;
}

export interface SignedPreparedInputAssignments {
  readonly keyId: string;
  readonly claims: PreparedInputAssignmentClaims;
  readonly signature: string;
}

export interface PreparedInputAssignmentEnvelopeLoader {
  load(): Promise<unknown>;
}

export function signPreparedInputAssignments(
  keyId: string,
  privateKey: KeyObject,
  claims: PreparedInputAssignmentClaims,
): SignedPreparedInputAssignments {
  if (!SAFE_ID.test(keyId) || privateKey.type !== "private"
    || createPublicKey(privateKey).asymmetricKeyType !== "ed25519") invalid("signer");
  validateClaims(claims, new Date(claims.issuedAt));
  return deepFreeze({
    keyId,
    claims: { ...claims, tenantIds: [...claims.tenantIds] },
    signature: sign(null, Buffer.from(canonicalJson(claims), "utf8"), privateKey).toString("base64"),
  });
}

/** Reads an atomically replaced assignment envelope without following a symlink. */
export class FilePreparedInputAssignmentEnvelopeLoader implements PreparedInputAssignmentEnvelopeLoader {
  readonly #path: string;

  constructor(path: string) {
    if (!isAbsolute(path) || resolve(path) !== path || path.length > 4_096 || /\0/.test(path)) invalid("manifest path");
    this.#path = path;
  }

  async load(): Promise<unknown> {
    const file = await open(this.#path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const metadata = await file.stat();
      if (!metadata.isFile() || metadata.size < 2 || metadata.size > MAX_MANIFEST_BYTES) invalid("manifest file");
      return JSON.parse(await file.readFile({ encoding: "utf8" })) as unknown;
    } finally { await file.close(); }
  }
}

/** Verifies a fresh control-plane assignment before every prepared-input operation. */
export class SignedPreparedInputTenantAuthorizer implements PreparedInputTenantAuthorizer {
  readonly #loader: PreparedInputAssignmentEnvelopeLoader;
  readonly #publicKeys: ReadonlyMap<string, KeyObject>;
  readonly #spiffeId: string;
  readonly #now: () => Date;

  constructor(options: {
    readonly loader: PreparedInputAssignmentEnvelopeLoader;
    readonly publicKeys: ReadonlyMap<string, KeyObject>;
    readonly spiffeId: string;
    readonly now?: () => Date;
  }) {
    validateSpiffeId(options.spiffeId);
    if (options.publicKeys.size < 1 || options.publicKeys.size > 10) invalid("key set");
    for (const [keyId, key] of options.publicKeys) {
      if (!SAFE_ID.test(keyId) || key.type !== "public" || key.asymmetricKeyType !== "ed25519") invalid("key set");
    }
    this.#loader = options.loader;
    this.#publicKeys = new Map(options.publicKeys);
    this.#spiffeId = options.spiffeId;
    this.#now = options.now ?? (() => new Date());
  }

  async authorize(identity: EvidenceArchiveWorkloadIdentity, tenantId: string): Promise<void> {
    validateIdentity(identity, this.#now());
    if (identity.spiffeId !== this.#spiffeId || !UUID.test(tenantId)) invalid("authorization");
    const claims = await this.#verifiedClaims();
    if (claims.spiffeId !== identity.spiffeId || claims.certificateFingerprint !== identity.certificateFingerprint
      || !claims.tenantIds.includes(tenantId)) invalid("authorization");
  }

  async probe(): Promise<void> {
    await this.#verifiedClaims();
  }

  async #verifiedClaims(): Promise<PreparedInputAssignmentClaims> {
    const envelope = parseEnvelope(await this.#loader.load());
    const key = this.#publicKeys.get(envelope.keyId);
    if (!key || !verify(
      null,
      Buffer.from(canonicalJson(envelope.claims), "utf8"),
      key,
      Buffer.from(envelope.signature, "base64"),
    )) invalid("signature");
    validateClaims(envelope.claims, this.#now());
    if (envelope.claims.spiffeId !== this.#spiffeId) invalid("workload");
    return envelope.claims;
  }
}

export function preparedInputTenantAuthorizerFromFiles(options: {
  readonly manifestPath: string;
  readonly keyId: string;
  readonly publicKeyPem: Buffer;
  readonly spiffeId: string;
  readonly now?: () => Date;
}): SignedPreparedInputTenantAuthorizer {
  if (!SAFE_ID.test(options.keyId)) invalid("key ID");
  const key = createPublicKey(options.publicKeyPem);
  if (key.asymmetricKeyType !== "ed25519") invalid("public key");
  return new SignedPreparedInputTenantAuthorizer({
    loader: new FilePreparedInputAssignmentEnvelopeLoader(options.manifestPath),
    publicKeys: new Map([[options.keyId, key]]),
    spiffeId: options.spiffeId,
    ...(options.now ? { now: options.now } : {}),
  });
}

function parseEnvelope(value: unknown): SignedPreparedInputAssignments {
  const envelope = record(value);
  exactKeys(envelope, ["keyId", "claims", "signature"]);
  if (typeof envelope.keyId !== "string" || !SAFE_ID.test(envelope.keyId)
    || typeof envelope.signature !== "string" || envelope.signature.length < 40
    || envelope.signature.length > 512 || !BASE64.test(envelope.signature)) invalid("envelope");
  const claims = record(envelope.claims);
  exactKeys(claims, [
    "kind", "version", "revision", "spiffeId", "certificateFingerprint", "tenantIds", "issuedAt", "expiresAt",
  ]);
  return { keyId: envelope.keyId, claims: claims as unknown as PreparedInputAssignmentClaims, signature: envelope.signature };
}

function validateClaims(claims: PreparedInputAssignmentClaims, now: Date): void {
  if (typeof claims.issuedAt !== "string" || typeof claims.expiresAt !== "string"
    || typeof claims.certificateFingerprint !== "string") invalid("claims");
  const issuedAt = Date.parse(claims.issuedAt);
  const expiresAt = Date.parse(claims.expiresAt);
  validateSpiffeId(claims.spiffeId);
  if (claims.kind !== "deviludo-prepared-input-assignments" || claims.version !== 1
    || !Number.isSafeInteger(claims.revision) || claims.revision < 1
    || !SHA256.test(claims.certificateFingerprint)
    || !Number.isFinite(now.getTime()) || !Number.isFinite(issuedAt) || !Number.isFinite(expiresAt)
    || issuedAt > now.getTime() + CLOCK_SKEW_MS || expiresAt <= now.getTime()
    || expiresAt <= issuedAt || expiresAt - issuedAt > MAX_VALIDITY_MS
    || !Array.isArray(claims.tenantIds) || claims.tenantIds.length < 1 || claims.tenantIds.length > 10_000) invalid("claims");
  if (claims.tenantIds.some((tenantId) => typeof tenantId !== "string" || !UUID.test(tenantId))
    || new Set(claims.tenantIds).size !== claims.tenantIds.length
    || JSON.stringify([...claims.tenantIds].sort()) !== JSON.stringify(claims.tenantIds)) invalid("tenant set");
}

function validateIdentity(identity: EvidenceArchiveWorkloadIdentity, now: Date): void {
  const certificateNotAfter = Date.parse(identity.certificateNotAfter);
  validateSpiffeId(identity.spiffeId);
  if (!SHA256.test(identity.certificateFingerprint) || typeof identity.certificateSerial !== "string"
    || !/^[a-f0-9]{1,128}$/.test(identity.certificateSerial) || !Number.isFinite(certificateNotAfter)
    || certificateNotAfter <= now.getTime()) invalid("identity");
}

function validateSpiffeId(value: unknown): asserts value is string {
  if (typeof value !== "string") invalid("SPIFFE ID");
  let url: URL;
  try { url = new URL(value); }
  catch { invalid("SPIFFE ID"); }
  if (url.protocol !== "spiffe:" || !url.hostname || url.username || url.password || url.search || url.hash
    || url.toString() !== value) invalid("SPIFFE ID");
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("object");
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  if (actual.length !== sorted.length || actual.some((key, index) => key !== sorted[index])) invalid("fields");
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function invalid(label: string): never {
  throw new Error(`Evidence archive prepared input assignment ${label} is invalid`);
}
