import { createHash, randomUUID } from "node:crypto";
import type { SignedSteamPublishAuthorization } from "./contracts";
import type {
  AuthoritativeReleaseSnapshot,
  FreshMfaVerification,
  ReleaseAuthorizationPrincipal,
  ReleaseAuthorizationRecord,
  ReleaseAuthorizationStore,
  ReleaseAuthorizationView,
  ReleaseMfaChallengeIssuer,
  ReleaseMfaVerifier,
  ReleaseMfaWorkflowSignal,
  ReleaseSnapshotResolver,
  SteamPublishAuthorizationArchive,
  SteamPublishAuthorizationSigner,
} from "./release-authorization-contracts";
import { steamCanonicalDigest } from "./artifacts";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const SHA1 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const CHALLENGE_TTL_MS = 5 * 60_000;
const AUTHORIZATION_TTL_MS = 10 * 60_000;

export class ReleaseAuthorizationCoordinator {
  readonly #snapshots: ReleaseSnapshotResolver;
  readonly #store: ReleaseAuthorizationStore;
  readonly #challenges: ReleaseMfaChallengeIssuer;
  readonly #verifier: ReleaseMfaVerifier;
  readonly #signer: SteamPublishAuthorizationSigner;
  readonly #archive: SteamPublishAuthorizationArchive;
  readonly #workflow: ReleaseMfaWorkflowSignal;
  readonly #publicOrigin: URL;
  readonly #now: () => Date;

  constructor(options: {
    readonly snapshots: ReleaseSnapshotResolver;
    readonly store: ReleaseAuthorizationStore;
    readonly challenges: ReleaseMfaChallengeIssuer;
    readonly verifier: ReleaseMfaVerifier;
    readonly signer: SteamPublishAuthorizationSigner;
    readonly archive: SteamPublishAuthorizationArchive;
    readonly workflow: ReleaseMfaWorkflowSignal;
    readonly publicOrigin: string;
    readonly now?: () => Date;
  }) {
    this.#snapshots = options.snapshots;
    this.#store = options.store;
    this.#challenges = options.challenges;
    this.#verifier = options.verifier;
    this.#signer = options.signer;
    this.#archive = options.archive;
    this.#workflow = options.workflow;
    this.#publicOrigin = requireRootHttpsOrigin(options.publicOrigin);
    this.#now = options.now ?? (() => new Date());
  }

  async begin(
    principal: ReleaseAuthorizationPrincipal,
    releaseId: string,
    idempotencyKey: string,
  ): Promise<ReleaseAuthorizationView> {
    validatePrincipal(principal);
    if (!ID.test(releaseId) || !ID.test(idempotencyKey)) throw new Error("Release authorization identity is invalid");
    const snapshot = await this.#snapshots.resolveForMfa({
      tenantId: principal.tenantId,
      releaseId,
      requestedBy: principal.userId,
    });
    validateSnapshot(snapshot, principal.tenantId, releaseId, principal.userId);
    const createdAt = validNow(this.#now()).toISOString();
    const sessionBindingDigest = digest(principal.sessionBinding);
    const requestDigest = steamCanonicalDigest({
      tenantId: principal.tenantId,
      userId: principal.userId,
      sessionBindingDigest,
      snapshot,
    });
    const reserved = await this.#store.reserve({
      approvalId: randomUUID(),
      tenantId: principal.tenantId,
      userId: principal.userId,
      sessionBindingDigest,
      idempotencyKey,
      requestDigest,
      snapshot,
      createdAt,
      expiresAt: new Date(Date.parse(createdAt) + CHALLENGE_TTL_MS).toISOString(),
    });
    if (reserved.kind === "EXISTING") return view(reserved.record);
    try {
      const challenge = await this.#challenges.begin({
        approvalId: reserved.record.approvalId,
        tenantId: reserved.record.tenantId,
        userId: reserved.record.userId,
        sessionBindingDigest: reserved.record.sessionBindingDigest,
        releaseId: reserved.record.snapshot.releaseId,
        expiresAt: reserved.record.expiresAt,
      });
      const authorizationUrl = validateAuthorizationUrl(
        challenge.authorizationUrl,
        this.#publicOrigin,
        reserved.record.approvalId,
      );
      return view(await this.#store.activate({
        tenantId: reserved.record.tenantId,
        approvalId: reserved.record.approvalId,
        authorizationUrl,
      }));
    } catch (error) {
      await this.#store.fail({ tenantId: reserved.record.tenantId, approvalId: reserved.record.approvalId });
      throw error;
    }
  }

  async complete(input: {
    readonly tenantId: string;
    readonly userId: string;
    readonly approvalId: string;
    readonly assertion: unknown;
  }): Promise<ReleaseAuthorizationView> {
    if (!ID.test(input.tenantId) || !ID.test(input.userId) || !ID.test(input.approvalId)) throw new Error("Release approval identity is invalid");
    let record = await this.#store.find({ tenantId: input.tenantId, approvalId: input.approvalId });
    if (record.userId !== input.userId) throw new Error("Release approval user binding is invalid");
    if (record.state === "DISPATCHED") return view(record);
    const now = validNow(this.#now());
    if (!["MFA_REQUIRED", "VERIFIED"].includes(record.state)
      || (record.state === "MFA_REQUIRED" && Date.parse(record.expiresAt) <= now.getTime())) {
      throw new Error("Release authorization is not waiting for MFA");
    }
    let authorization = record.signedAuthorization;
    if (record.state === "MFA_REQUIRED") {
      const verification = await this.#verifier.verify(input);
      validateVerification(verification, record, now);
      const issuedAt = now.toISOString();
      authorization = await this.#signer.sign(Object.freeze({
        kind: "deviludo-steam-publish-authorization",
        version: 1,
        operation: "PRIVATE_BETA_UPLOAD",
        tenantId: record.tenantId,
        projectId: record.snapshot.projectId,
        releaseId: record.snapshot.releaseId,
        mainCommitSha: record.snapshot.mainCommitSha,
        evidenceBundleDigest: record.snapshot.evidenceBundleDigest,
        acceptedBy: record.userId,
        mfaAssertionId: verification.assertionId,
        nonce: record.approvalId,
        issuedAt,
        expiresAt: new Date(now.getTime() + AUTHORIZATION_TTL_MS).toISOString(),
      }));
      validateSignedAuthorization(authorization, record, verification.assertionId, now);
      record = await this.#store.markVerified({
        tenantId: record.tenantId,
        approvalId: record.approvalId,
        mfaAssertionId: verification.assertionId,
        authorization,
        verifiedAt: verification.verifiedAt,
      });
    }
    if (!authorization || !record.mfaAssertionId) throw new Error("Verified release authorization artifact is missing");
    validateSignedAuthorization(authorization, record, record.mfaAssertionId, now);
    await this.#archive.persist({
      approvalId: record.approvalId,
      tenantId: record.tenantId,
      releaseId: record.snapshot.releaseId,
      authorization,
    });
    await this.#workflow.signal({
      workflowId: record.snapshot.workflowId,
      signalId: `mfa:${record.approvalId}`,
      approvalId: record.approvalId,
    });
    return view(await this.#store.markDispatched({
      tenantId: record.tenantId,
      approvalId: record.approvalId,
      dispatchedAt: validNow(this.#now()).toISOString(),
    }));
  }
}

type MutableRecord = { -readonly [Key in keyof ReleaseAuthorizationRecord]: ReleaseAuthorizationRecord[Key] };

export class InMemoryReleaseAuthorizationStore implements ReleaseAuthorizationStore {
  readonly #records = new Map<string, MutableRecord>();

  async reserve(input: Parameters<ReleaseAuthorizationStore["reserve"]>[0]) {
    const existing = [...this.#records.values()].find((entry) => entry.tenantId === input.tenantId && entry.idempotencyKey === input.idempotencyKey);
    if (existing) {
      if (existing.requestDigest !== input.requestDigest) throw new Error("Release authorization idempotency key conflicts with another request");
      if (existing.state === "CREATING") throw new Error("Release authorization challenge is being created");
      return { kind: "EXISTING" as const, record: freezeRecord(existing) };
    }
    const record: MutableRecord = {
      ...input,
      state: "CREATING",
      authorizationUrl: null,
      mfaAssertionId: null,
      signedAuthorization: null,
      verifiedAt: null,
      dispatchedAt: null,
    };
    this.#records.set(record.approvalId, record);
    return { kind: "CREATED" as const, record: freezeRecord(record) };
  }

  async activate(input: Parameters<ReleaseAuthorizationStore["activate"]>[0]) {
    const record = this.#require(input.tenantId, input.approvalId);
    if (record.state !== "CREATING") throw new Error("Release authorization activation was rejected");
    record.state = "MFA_REQUIRED";
    record.authorizationUrl = input.authorizationUrl;
    return freezeRecord(record);
  }

  async find(input: Parameters<ReleaseAuthorizationStore["find"]>[0]) {
    const record = this.#records.get(input.approvalId);
    if (!record || record.tenantId !== input.tenantId) throw new Error("Release authorization was not found");
    return freezeRecord(record);
  }

  async markVerified(input: Parameters<ReleaseAuthorizationStore["markVerified"]>[0]) {
    const record = this.#require(input.tenantId, input.approvalId);
    if (record.state !== "MFA_REQUIRED") throw new Error("Release authorization verification was rejected");
    record.state = "VERIFIED";
    record.mfaAssertionId = input.mfaAssertionId;
    record.signedAuthorization = input.authorization;
    record.verifiedAt = input.verifiedAt;
    return freezeRecord(record);
  }

  async markDispatched(input: Parameters<ReleaseAuthorizationStore["markDispatched"]>[0]) {
    const record = this.#require(input.tenantId, input.approvalId);
    if (record.state !== "VERIFIED") throw new Error("Release authorization dispatch was rejected");
    record.state = "DISPATCHED";
    record.dispatchedAt = input.dispatchedAt;
    return freezeRecord(record);
  }

  async fail(input: Parameters<ReleaseAuthorizationStore["fail"]>[0]) {
    const record = this.#require(input.tenantId, input.approvalId);
    if (record.state === "CREATING") record.state = "FAILED";
  }

  #require(tenantId: string, approvalId: string): MutableRecord {
    const record = this.#records.get(approvalId);
    if (!record || record.tenantId !== tenantId) throw new Error("Release authorization tenant binding is invalid");
    return record;
  }
}

function validatePrincipal(principal: ReleaseAuthorizationPrincipal): void {
  if (!ID.test(principal.tenantId) || !ID.test(principal.userId)
    || principal.sessionBinding.length < 32 || principal.sessionBinding.length > 512
    || /[\u0000-\u001f\u007f]/.test(principal.sessionBinding)) {
    throw new Error("Release authorization principal is invalid");
  }
}

function validateSnapshot(snapshot: AuthoritativeReleaseSnapshot, tenantId: string, releaseId: string, acceptedBy: string): void {
  if (snapshot.tenantId !== tenantId || snapshot.releaseId !== releaseId || snapshot.state !== "WAITING_MFA"
    || snapshot.acceptedBy !== acceptedBy || !ID.test(snapshot.acceptedBy)
    || !ID.test(snapshot.projectId) || !ID.test(snapshot.workflowId)
    || !SHA1.test(snapshot.mainCommitSha) || !SHA256.test(snapshot.evidenceBundleDigest)) {
    throw new Error("Authoritative release snapshot is invalid");
  }
}

function validateVerification(result: FreshMfaVerification, record: ReleaseAuthorizationRecord, now: Date): void {
  const verifiedAt = Date.parse(result.verifiedAt);
  if (result.approvalId !== record.approvalId || result.userId !== record.userId
    || !ID.test(result.assertionId) || result.assuranceLevel !== "AAL2"
    || !Number.isFinite(verifiedAt) || verifiedAt > now.getTime() + 30_000
    || verifiedAt < now.getTime() - CHALLENGE_TTL_MS) {
    throw new Error("Fresh MFA verification is invalid");
  }
}

function validateSignedAuthorization(
  authorization: SignedSteamPublishAuthorization,
  record: ReleaseAuthorizationRecord,
  assertionId: string,
  now: Date,
): void {
  const claims = authorization.claims;
  const issuedAt = Date.parse(claims.issuedAt);
  const expiresAt = Date.parse(claims.expiresAt);
  if (!ID.test(authorization.keyId) || !authorization.signature || authorization.signature.length > 512
    || claims.kind !== "deviludo-steam-publish-authorization" || claims.version !== 1
    || claims.operation !== "PRIVATE_BETA_UPLOAD"
    || claims.tenantId !== record.tenantId || claims.projectId !== record.snapshot.projectId
    || claims.releaseId !== record.snapshot.releaseId || claims.mainCommitSha !== record.snapshot.mainCommitSha
    || claims.evidenceBundleDigest !== record.snapshot.evidenceBundleDigest
    || claims.acceptedBy !== record.userId || claims.mfaAssertionId !== assertionId
    || claims.nonce !== record.approvalId || !Number.isFinite(issuedAt) || !Number.isFinite(expiresAt)
    || issuedAt > now.getTime() + 30_000 || expiresAt <= now.getTime()
    || expiresAt <= issuedAt || expiresAt - issuedAt > AUTHORIZATION_TTL_MS) {
    throw new Error("Signed Steam publish authorization is invalid");
  }
}

function view(record: ReleaseAuthorizationRecord): ReleaseAuthorizationView {
  if (record.state === "MFA_REQUIRED" && record.authorizationUrl) {
    return Object.freeze({
      releaseId: record.snapshot.releaseId,
      state: "MFA_REQUIRED",
      approvalId: record.approvalId,
      authorizationUrl: record.authorizationUrl,
      workflowId: null,
      expiresAt: record.expiresAt,
    });
  }
  if (record.state === "DISPATCHED") {
    return Object.freeze({
      releaseId: record.snapshot.releaseId,
      state: "DISPATCHED",
      approvalId: record.approvalId,
      authorizationUrl: null,
      workflowId: record.snapshot.workflowId,
      expiresAt: record.expiresAt,
    });
  }
  throw new Error("Release authorization is not externally visible");
}

function validateAuthorizationUrl(value: string, origin: URL, approvalId: string): string {
  const url = new URL(value);
  if (url.origin !== origin.origin || url.pathname !== `/approvals/${encodeURIComponent(approvalId)}`
    || url.username || url.password || url.search || url.hash) throw new Error("Release authorization URL is invalid");
  return url.href;
}

function requireRootHttpsOrigin(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Release authorization public origin is invalid");
  }
  return url;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function validNow(value: Date): Date {
  if (!Number.isFinite(value.getTime())) throw new Error("Release authorization clock is invalid");
  return value;
}

function freezeRecord(record: MutableRecord): ReleaseAuthorizationRecord {
  return Object.freeze({
    ...record,
    snapshot: Object.freeze({ ...record.snapshot }),
    signedAuthorization: record.signedAuthorization
      ? Object.freeze({ ...record.signedAuthorization, claims: Object.freeze({ ...record.signedAuthorization.claims }) })
      : null,
  });
}
