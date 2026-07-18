import { createHash, randomUUID } from "node:crypto";
import {
  SecretBrokerConflictError,
  SecretBrokerUnavailableError,
  SecretBrokerValidationError,
  type BrokerSecretPurpose,
  type InferenceCredentialAuthority,
  type SecretBackend,
  type SecretBrokerStore,
} from "./contracts";
import { backendPathFromStaticSecretRef } from "./vault-backend";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const PROVIDER_PATH = /^credential-[a-f0-9-]{36}\/[1-9][0-9]{0,8}$/;
const RECORD_REF = /^vault:\/\/kv\/deviludo\/records\/[a-f0-9-]{36}$/;
const PKCE = /^[A-Za-z0-9_-]{43}$/;
const EXPIRY_SWEEPER_SPIFFE_ID = "spiffe://deviludo.internal/secret-broker/expiry-sweeper";

export class SecretBrokerService {
  readonly #store: SecretBrokerStore;
  readonly #backend: SecretBackend;
  readonly #authority: InferenceCredentialAuthority;
  readonly #staticGitHubSecretRefs: ReadonlySet<string>;
  readonly #now: () => Date;

  constructor(options: Readonly<{
    store: SecretBrokerStore;
    backend: SecretBackend;
    authority: InferenceCredentialAuthority;
    staticGitHubSecretRefs?: ReadonlySet<string>;
    now?: () => Date;
  }>) {
    this.#store = options.store;
    this.#backend = options.backend;
    this.#authority = options.authority;
    this.#staticGitHubSecretRefs = new Set(options.staticGitHubSecretRefs ?? []);
    this.#now = options.now ?? (() => new Date());
  }

  async writeProviderCredential(input: Readonly<{
    path: string;
    plaintext: Uint8Array;
    workloadSpiffeId: string;
  }>) {
    if (!PROVIDER_PATH.test(input.path) || !(input.plaintext instanceof Uint8Array)
      || input.plaintext.byteLength < 8 || input.plaintext.byteLength > 64 * 1024) invalid();
    return this.#write({
      purpose: "provider-credential",
      writeKey: sha256(`provider-credential\0${input.path}`),
      plaintext: input.plaintext,
      expiresAt: null,
      workloadSpiffeId: input.workloadSpiffeId,
      binding: { purpose: "provider-credential", path: input.path },
    });
  }

  async putPkce(input: Readonly<{
    value: Uint8Array;
    expiresAt: string;
    workloadSpiffeId: string;
  }>) {
    const now = this.#validNow();
    const expires = Date.parse(input.expiresAt);
    const value = Buffer.from(input.value);
    try {
      if (value.byteLength !== 43 || !PKCE.test(value.toString("utf8"))
        || !Number.isFinite(expires) || expires <= now.getTime() || expires > now.getTime() + 15 * 60_000) invalid();
      const result = await this.#write({
        purpose: "github-pkce-v1",
        writeKey: sha256(Buffer.concat([Buffer.from("github-pkce-v1\0"), value, Buffer.from(`\0${input.expiresAt}`)])),
        plaintext: value,
        expiresAt: new Date(expires).toISOString(),
        workloadSpiffeId: input.workloadSpiffeId,
        binding: { purpose: "github-pkce-v1", expiresAt: new Date(expires).toISOString() },
      });
      return result;
    } finally { value.fill(0); }
  }

  async takePkce(input: Readonly<{ secretRef: string; workloadSpiffeId: string }>): Promise<Buffer | null> {
    validateRecordRef(input.secretRef);
    const now = this.#validNow();
    const claimToken = randomUUID();
    const reservation = await this.#store.claimTake({
      secretRef: input.secretRef,
      claimToken,
      claimExpiresAt: new Date(now.getTime() + 30_000).toISOString(),
      at: now.toISOString(),
    });
    if (!reservation) return null;
    let secret: Buffer | null = null;
    try {
      secret = await this.#backend.read(reservation.record.backendPath);
      if (!secret || sha256(secret) !== reservation.record.plaintextDigest
        || secret.byteLength !== 43 || !PKCE.test(secret.toString("utf8"))) throw new SecretBrokerUnavailableError("One-time secret is unavailable");
      const bindingDigest = digestBinding({ operation: "take", secretRef: input.secretRef });
      await this.#store.consume({ secretRef: input.secretRef, claimToken,
        workloadSpiffeId: input.workloadSpiffeId, bindingDigest, at: now.toISOString() });
      await this.#backend.destroy(reservation.record.backendPath);
      return secret;
    } catch (error) {
      if (secret) secret.fill(0);
      await this.#store.releaseTake(input.secretRef, claimToken).catch(() => undefined);
      throw error;
    }
  }

  async revoke(input: Readonly<{ secretRef: string; workloadSpiffeId: string }>): Promise<void> {
    validateRecordRef(input.secretRef);
    const at = this.#validNow().toISOString();
    const bindingDigest = digestBinding({ operation: "revoke", secretRef: input.secretRef });
    const record = await this.#store.revoke({ secretRef: input.secretRef,
      workloadSpiffeId: input.workloadSpiffeId, bindingDigest, at });
    if (!record) return;
    await this.#backend.destroy(record.backendPath);
  }

  async resolveStaticGitHubSecret(input: Readonly<{
    secretRef: string;
    purpose: "github-oauth-client-secret";
    workloadSpiffeId: string;
  }>): Promise<Buffer> {
    if (!this.#staticGitHubSecretRefs.has(input.secretRef)) {
      throw new SecretBrokerConflictError("Static secret is not approved for GitHub OAuth");
    }
    const path = backendPathFromStaticSecretRef(input.secretRef);
    const secret = await this.#backend.read(path);
    if (!secret || secret.byteLength < 8 || secret.byteLength > 1_024
      || /[\u0000-\u0020]/.test(secret.toString("utf8"))) {
      secret?.fill(0); throw new SecretBrokerUnavailableError("Static secret is unavailable");
    }
    await this.#store.recordLease({ secretRef: input.secretRef, purpose: input.purpose,
      workloadSpiffeId: input.workloadSpiffeId,
      bindingDigest: digestBinding({ operation: "static-lease", secretRef: input.secretRef, purpose: input.purpose }),
      at: this.#validNow().toISOString() });
    return secret;
  }

  async resolveInference(input: Readonly<{
    requestId: string;
    tenantId: string;
    projectId: string;
    runId: string;
    providerRevisionId: string;
    credentialVersionId: string;
    workloadSpiffeId: string;
  }>) {
    if (!UUID.test(input.requestId) || !UUID.test(input.tenantId) || !UUID.test(input.projectId) || !UUID.test(input.runId)
      || !SAFE_ID.test(input.providerRevisionId) || !SAFE_ID.test(input.credentialVersionId)) invalid();
    const secretRef = await this.#authority.resolveRun(input);
    return this.#inferenceLease(secretRef, input, "deviludo.inference-credential-lease.v1");
  }

  async resolveInferenceProbe(input: Readonly<{
    requestId: string;
    providerRevisionId: string;
    credentialVersionId: string;
    workloadSpiffeId: string;
  }>) {
    if (!UUID.test(input.requestId) || !SAFE_ID.test(input.providerRevisionId) || !SAFE_ID.test(input.credentialVersionId)) invalid();
    const secretRef = await this.#authority.resolveProbe(input);
    return this.#inferenceLease(secretRef, input, "deviludo.inference-provider-probe-credential-lease.v1");
  }

  async purgeExpiredPkce(limit = 100): Promise<number> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) invalid();
    const now = this.#validNow();
    const claimToken = randomUUID();
    const records = await this.#store.claimExpiredPkce({
      claimToken, at: now.toISOString(), limit,
      claimExpiresAt: new Date(now.getTime() + 30_000).toISOString(),
    });
    let completed = 0;
    for (const record of records) {
      try {
        await this.#backend.destroy(record.backendPath);
        await this.#store.completeExpiredPkce({ secretRef: record.secretRef, claimToken,
          workloadSpiffeId: EXPIRY_SWEEPER_SPIFFE_ID,
          bindingDigest: digestBinding({ operation: "expire", secretRef: record.secretRef, expiresAt: record.expiresAt }),
          at: now.toISOString() });
        completed += 1;
      } catch (error) {
        await this.#store.releaseTake(record.secretRef, claimToken).catch(() => undefined);
        throw error;
      }
    }
    return completed;
  }

  async probe(): Promise<void> { await Promise.all([this.#store.probe(), this.#backend.probe(), this.#authority.probe()]); }

  async #write(input: Readonly<{
    purpose: BrokerSecretPurpose;
    writeKey: string;
    plaintext: Uint8Array;
    expiresAt: string | null;
    workloadSpiffeId: string;
    binding: Readonly<Record<string, unknown>>;
  }>) {
    const now = this.#validNow();
    const claimToken = randomUUID();
    const plaintextDigest = sha256(input.plaintext);
    const reservation = await this.#store.reserveWrite({
      id: randomUUID(), writeKey: input.writeKey, purpose: input.purpose,
      plaintextDigest, expiresAt: input.expiresAt, claimToken,
      claimExpiresAt: new Date(now.getTime() + 30_000).toISOString(), at: now.toISOString(),
    });
    if (reservation.kind === "REPLAY") return metadata(reservation.record.secretRef, plaintextDigest, input.expiresAt, true);
    try {
      const existing = await this.#backend.read(reservation.record.backendPath);
      if (existing) {
        const existingDigest = sha256(existing); existing.fill(0);
        if (existingDigest !== plaintextDigest) throw new SecretBrokerConflictError("Vault value conflicts with the immutable reservation");
      } else await this.#backend.create(reservation.record.backendPath, input.plaintext);
      const record = await this.#store.activate({ secretRef: reservation.record.secretRef, claimToken,
        workloadSpiffeId: input.workloadSpiffeId, bindingDigest: digestBinding(input.binding), at: now.toISOString() });
      return metadata(record.secretRef, plaintextDigest, input.expiresAt, false);
    } catch (error) {
      await this.#store.releaseWrite(reservation.record.secretRef, claimToken).catch(() => undefined);
      throw error;
    }
  }

  async #inferenceLease(secretRef: string, binding: Readonly<Record<string, unknown>>, schemaVersion: string) {
    validateRecordRef(secretRef);
    const now = this.#validNow();
    const record = await this.#store.active(secretRef, now.toISOString());
    if (!record || record.purpose !== "provider-credential") throw new SecretBrokerConflictError("Credential version is not active");
    const secret = await this.#backend.read(record.backendPath);
    if (!secret || secret.byteLength < 8 || secret.byteLength > 64 * 1024 || sha256(secret) !== record.plaintextDigest) {
      secret?.fill(0); throw new SecretBrokerUnavailableError("Credential material is unavailable");
    }
    try {
      const publicBinding = Object.fromEntries(
        Object.entries(binding).filter(([key]) => key !== "workloadSpiffeId"),
      );
      await this.#store.recordLease({ secretRef, purpose: "provider-credential",
        workloadSpiffeId: String(binding.workloadSpiffeId), bindingDigest: digestBinding(binding), at: now.toISOString() });
      return Object.freeze({
        schemaVersion,
        ...publicBinding,
        encoding: "base64",
        value: secret.toString("base64"),
        expiresAt: new Date(now.getTime() + 5 * 60_000).toISOString(),
      });
    } finally { secret.fill(0); }
  }

  #validNow(): Date { const value = this.#now(); if (!(value instanceof Date) || !Number.isFinite(value.getTime())) invalid(); return value; }
}

function metadata(secretRef: string, digest: string, expiresAt: string | null, replayed: boolean) {
  return Object.freeze({ secretRef, maskedFingerprint: `sha256:${digest.slice(0, 8)}…${digest.slice(-6)}`,
    expiresAt, replayed });
}
function validateRecordRef(value: string): void { if (!RECORD_REF.test(value)) invalid(); }
function digestBinding(value: Readonly<Record<string, unknown>>): string { return sha256(canonical(value)); }
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
}
function sha256(value: string | Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }
function invalid(): never { throw new SecretBrokerValidationError("Secret Broker request is invalid"); }
