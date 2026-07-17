import { createHash, randomUUID } from "node:crypto";
import type {
  SteamAuthenticatedLogin,
  SteamConfigVault,
  SteamEnrollmentPrincipal,
  SteamEnrollmentRecord,
  SteamEnrollmentStore,
  SteamEnrollmentView,
  SteamInteractiveLoginConnector,
} from "./enrollment-contracts";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const NUMERIC_ID = /^\d{1,20}$/;
const SECRET_REF = /^vault:\/\/[A-Za-z0-9._~:/?=&%-]{1,500}$/;
const ENROLLMENT_TTL_MS = 15 * 60_000;

export class SteamEnrollmentCoordinator {
  readonly #store: SteamEnrollmentStore;
  readonly #connector: SteamInteractiveLoginConnector;
  readonly #vault: SteamConfigVault;
  readonly #publicOrigin: URL;
  readonly #now: () => Date;

  constructor(options: {
    readonly store: SteamEnrollmentStore;
    readonly connector: SteamInteractiveLoginConnector;
    readonly vault: SteamConfigVault;
    readonly publicOrigin: string;
    readonly now?: () => Date;
  }) {
    this.#store = options.store;
    this.#connector = options.connector;
    this.#vault = options.vault;
    this.#publicOrigin = requireRootHttpsOrigin(options.publicOrigin);
    this.#now = options.now ?? (() => new Date());
  }

  async begin(principal: SteamEnrollmentPrincipal, idempotencyKey: string): Promise<SteamEnrollmentView> {
    validatePrincipal(principal);
    if (!ID.test(idempotencyKey)) throw new Error("Steam enrollment idempotency key is invalid");
    const createdAt = validNow(this.#now()).toISOString();
    const sessionBindingDigest = digest(principal.sessionBinding);
    const requestDigest = digest(canonicalJson({
      tenantId: principal.tenantId,
      userId: principal.userId,
      sessionBindingDigest,
    }));
    const record = await this.#store.create({
      id: randomUUID(),
      tenantId: principal.tenantId,
      userId: principal.userId,
      sessionBindingDigest,
      idempotencyKey,
      requestDigest,
      createdAt,
      expiresAt: new Date(Date.parse(createdAt) + ENROLLMENT_TTL_MS).toISOString(),
    });
    return this.#view(record);
  }

  async submitCredentials(input: {
    readonly principal: SteamEnrollmentPrincipal;
    readonly enrollmentId: string;
    readonly accountName: string;
    readonly password: Uint8Array;
  }): Promise<SteamEnrollmentView> {
    validatePrincipal(input.principal);
    validateEnrollmentId(input.enrollmentId);
    if (!/^[A-Za-z0-9_-]{3,64}$/.test(input.accountName)) throw new Error("Steam account name is invalid");
    requireSensitiveBuffer(input.password, "password", 8, 1024);
    try {
      const record = await this.#findActive(input.principal, input.enrollmentId);
      if (record.state !== "WAITING_CREDENTIALS") throw new Error("Steam enrollment is not waiting for credentials");
      const result = await this.#connector.begin({
        enrollmentId: record.id,
        accountName: input.accountName,
        password: input.password,
      });
      if (result.kind === "GUARD_REQUIRED") {
        validateSecretRef(result.challengeSecretRef, "Guard challenge");
        const challenged = await this.#store.saveChallenge({
          tenantId: record.tenantId,
          enrollmentId: record.id,
          challengeSecretRef: result.challengeSecretRef,
          at: validNow(this.#now()).toISOString(),
        });
        return this.#view(challenged);
      }
      return this.#complete(record, result);
    } finally {
      input.password.fill(0);
    }
  }

  async submitGuardCode(input: {
    readonly principal: SteamEnrollmentPrincipal;
    readonly enrollmentId: string;
    readonly guardCode: Uint8Array;
  }): Promise<SteamEnrollmentView> {
    validatePrincipal(input.principal);
    validateEnrollmentId(input.enrollmentId);
    requireSensitiveBuffer(input.guardCode, "Guard code", 4, 32);
    try {
      const record = await this.#findActive(input.principal, input.enrollmentId);
      if (record.state !== "WAITING_STEAM_GUARD" || !record.challengeSecretRef) {
        throw new Error("Steam enrollment is not waiting for a Guard code");
      }
      const result = await this.#connector.completeGuard({
        enrollmentId: record.id,
        challengeSecretRef: record.challengeSecretRef,
        guardCode: input.guardCode,
      });
      return this.#complete(record, result);
    } finally {
      input.guardCode.fill(0);
    }
  }

  async #findActive(principal: SteamEnrollmentPrincipal, enrollmentId: string): Promise<SteamEnrollmentRecord> {
    const record = await this.#store.find({
      tenantId: principal.tenantId,
      enrollmentId,
      userId: principal.userId,
      sessionBindingDigest: digest(principal.sessionBinding),
    });
    if (record.state === "FAILED" || record.state === "EXPIRED" || Date.parse(record.expiresAt) <= validNow(this.#now()).getTime()) {
      throw new Error("Steam enrollment is expired or unavailable");
    }
    return record;
  }

  async #complete(record: SteamEnrollmentRecord, result: SteamAuthenticatedLogin): Promise<SteamEnrollmentView> {
    validateAuthenticatedLogin(result, validNow(this.#now()));
    let secretRef: string | null = null;
    try {
      const credentialVersionId = randomUUID();
      const written = await this.#vault.write({
        path: `steam/config-vdf/${record.tenantId}/${credentialVersionId}`,
        plaintext: result.configVdf,
      });
      validateSecretRef(written.secretRef, "config.vdf");
      if (!/^sha256:[a-f0-9]{8}…[a-f0-9]{6}$/i.test(written.maskedFingerprint)) {
        throw new Error("Steam Vault fingerprint is invalid");
      }
      secretRef = written.secretRef;
      const at = validNow(this.#now()).toISOString();
      const completed = await this.#store.complete({
        tenantId: record.tenantId,
        enrollmentId: record.id,
        credentialBindingId: randomUUID(),
        fingerprint: digest(`${record.tenantId}:${written.maskedFingerprint}`),
        maskedValue: written.maskedFingerprint,
        at,
        session: Object.freeze({
          id: randomUUID(),
          tenantId: record.tenantId,
          accountId: result.accountId,
          accountName: result.accountName,
          configVdfSecretRef: written.secretRef,
          credentialVersionId,
          allowedAppIds: Object.freeze([...result.allowedAppIds]),
          permissions: Object.freeze([...result.permissions]),
          state: "ACTIVE",
          verifiedAt: at,
          expiresAt: new Date(result.expiresAt).toISOString(),
        }),
      });
      secretRef = null;
      return this.#view(completed);
    } catch (error) {
      if (secretRef) {
        try { await this.#vault.revoke(secretRef); } catch { /* preserve the primary failure */ }
      }
      throw error;
    } finally {
      result.configVdf.fill(0);
    }
  }

  #view(record: SteamEnrollmentRecord): SteamEnrollmentView {
    if (!["WAITING_CREDENTIALS", "WAITING_STEAM_GUARD", "READY"].includes(record.state)) {
      throw new Error("Steam enrollment is unavailable");
    }
    return Object.freeze({
      enrollmentId: record.id,
      state: record.state as SteamEnrollmentView["state"],
      enrollmentUrl: record.state === "READY"
        ? null
        : new URL(`/enrollments/${encodeURIComponent(record.id)}`, this.#publicOrigin).href,
      expiresAt: record.expiresAt,
    });
  }
}

type MutableEnrollment = {
  -readonly [Key in keyof SteamEnrollmentRecord]: SteamEnrollmentRecord[Key];
};

/** Contract-test/local store. Production uses the PostgreSQL RLS adapter. */
export class InMemorySteamEnrollmentStore implements SteamEnrollmentStore {
  readonly #records = new Map<string, MutableEnrollment>();

  async create(input: Omit<SteamEnrollmentRecord, "state" | "challengeSecretRef" | "buildSession" | "completedAt">): Promise<SteamEnrollmentRecord> {
    const existing = [...this.#records.values()].find((entry) => entry.tenantId === input.tenantId && entry.idempotencyKey === input.idempotencyKey);
    if (existing) {
      if (existing.requestDigest !== input.requestDigest) throw new Error("Steam enrollment idempotency key conflicts with another request");
      return freezeRecord(existing);
    }
    const record: MutableEnrollment = { ...input, state: "WAITING_CREDENTIALS", challengeSecretRef: null, buildSession: null, completedAt: null };
    this.#records.set(record.id, record);
    return freezeRecord(record);
  }

  async find(input: Parameters<SteamEnrollmentStore["find"]>[0]): Promise<SteamEnrollmentRecord> {
    const record = this.#records.get(input.enrollmentId);
    if (!record || record.tenantId !== input.tenantId || record.userId !== input.userId || record.sessionBindingDigest !== input.sessionBindingDigest) {
      throw new Error("Steam enrollment principal does not match");
    }
    return freezeRecord(record);
  }

  async saveChallenge(input: Parameters<SteamEnrollmentStore["saveChallenge"]>[0]): Promise<SteamEnrollmentRecord> {
    const record = this.#records.get(input.enrollmentId);
    if (!record || record.tenantId !== input.tenantId || record.state !== "WAITING_CREDENTIALS") throw new Error("Steam enrollment transition was rejected");
    record.state = "WAITING_STEAM_GUARD";
    record.challengeSecretRef = input.challengeSecretRef;
    return freezeRecord(record);
  }

  async complete(input: Parameters<SteamEnrollmentStore["complete"]>[0]): Promise<SteamEnrollmentRecord> {
    const record = this.#records.get(input.enrollmentId);
    if (!record || record.tenantId !== input.tenantId || !["WAITING_CREDENTIALS", "WAITING_STEAM_GUARD"].includes(record.state)) {
      throw new Error("Steam enrollment completion was rejected");
    }
    record.state = "READY";
    record.challengeSecretRef = null;
    record.buildSession = input.session;
    record.completedAt = input.at;
    return freezeRecord(record);
  }
}

function validatePrincipal(principal: SteamEnrollmentPrincipal): void {
  if (!ID.test(principal.tenantId) || !ID.test(principal.userId)
    || principal.sessionBinding.length < 32 || principal.sessionBinding.length > 512
    || /[\u0000-\u001f\u007f]/.test(principal.sessionBinding)) {
    throw new Error("Steam enrollment principal is invalid");
  }
}

function validateEnrollmentId(value: string): void {
  if (!/^[a-f0-9-]{36}$/.test(value)) throw new Error("Steam enrollment ID is invalid");
}

function validateAuthenticatedLogin(result: SteamAuthenticatedLogin, now: Date): void {
  if (result.kind !== "AUTHENTICATED" || !ID.test(result.accountId)
    || !/^[A-Za-z0-9_-]{3,64}$/.test(result.accountName)
    || result.configVdf.byteLength < 8 || result.configVdf.byteLength > 1024 * 1024
    || !result.allowedAppIds.length || result.allowedAppIds.some((appId) => !NUMERIC_ID.test(appId) || appId === "0")
    || new Set(result.allowedAppIds).size !== result.allowedAppIds.length
    || !result.permissions.includes("EditAppMetadata") || !result.permissions.includes("PublishAppChanges")) {
    throw new Error("Steam authenticated login result is invalid");
  }
  const expires = Date.parse(result.expiresAt);
  if (!Number.isFinite(expires) || expires <= now.getTime() || expires > now.getTime() + 180 * 24 * 60 * 60_000) {
    throw new Error("Steam authenticated session expiry is invalid");
  }
}

function requireSensitiveBuffer(value: Uint8Array, label: string, min: number, max: number): void {
  if (!(value instanceof Uint8Array) || value.byteLength < min || value.byteLength > max) throw new Error(`Steam ${label} is invalid`);
}

function validateSecretRef(value: string, label: string): void {
  if (!SECRET_REF.test(value)) throw new Error(`Steam ${label} SecretRef is invalid`);
}

function requireRootHttpsOrigin(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Steam enrollment public origin is invalid");
  }
  return url;
}

function validNow(now: Date): Date {
  if (!Number.isFinite(now.getTime())) throw new Error("Steam enrollment clock is invalid");
  return now;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: Readonly<Record<string, string>>): string {
  return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => `${JSON.stringify(key)}:${JSON.stringify(entry)}`).join(",")}}`;
}

function freezeRecord(record: MutableEnrollment): SteamEnrollmentRecord {
  return Object.freeze({
    ...record,
    buildSession: record.buildSession ? Object.freeze({ ...record.buildSession }) : null,
  });
}
