import { randomUUID, type KeyObject } from "node:crypto";
import { steamCanonicalDigest, verifySteamPublishAuthorization, verifySteamRcArtifact } from "./artifacts";
import type {
  SignedSteamPublishAuthorization,
  SignedSteamRcArtifact,
  SteamBuildSession,
  SteamCleanInstallDispatcher,
  SteamInstallEvidenceGate,
  SteamPipeConnector,
  SteamPrivateBetaReceipt,
  SteamPublishOperationStore,
  SteamReleaseEvidenceGate,
  SteamReleaseReadyReceipt,
  SteamTargetPlatform,
} from "./contracts";

const SHA1 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const NUMERIC_ID = /^\d{1,20}$/;
const BETA_BRANCH = /^[a-z0-9][a-z0-9_-]{2,39}$/;
const CLAIM_MS = 5 * 60_000;

export class SteamReleaseCoordinator {
  readonly #rcKeys: ReadonlyMap<string, KeyObject>;
  readonly #authorizationKeys: ReadonlyMap<string, KeyObject>;
  readonly #releaseEvidence: SteamReleaseEvidenceGate;
  readonly #connector: SteamPipeConnector;
  readonly #installs: SteamCleanInstallDispatcher;
  readonly #installEvidence: SteamInstallEvidenceGate;
  readonly #operations: SteamPublishOperationStore;
  readonly #now: () => Date;

  constructor(options: {
    readonly rcKeys: ReadonlyMap<string, KeyObject>;
    readonly authorizationKeys: ReadonlyMap<string, KeyObject>;
    readonly releaseEvidence: SteamReleaseEvidenceGate;
    readonly connector: SteamPipeConnector;
    readonly installs: SteamCleanInstallDispatcher;
    readonly installEvidence: SteamInstallEvidenceGate;
    readonly operations: SteamPublishOperationStore;
    readonly now?: () => Date;
  }) {
    this.#rcKeys = options.rcKeys;
    this.#authorizationKeys = options.authorizationKeys;
    this.#releaseEvidence = options.releaseEvidence;
    this.#connector = options.connector;
    this.#installs = options.installs;
    this.#installEvidence = options.installEvidence;
    this.#operations = options.operations;
    this.#now = options.now ?? (() => new Date());
  }

  async uploadPrivateBeta(input: {
    readonly rc: SignedSteamRcArtifact;
    readonly authorization: SignedSteamPublishAuthorization;
    readonly session: SteamBuildSession;
    readonly betaBranch: string;
    readonly branchPasswordSecretRef: string;
    readonly idempotencyKey: string;
  }): Promise<SteamPrivateBetaReceipt> {
    const at = this.#now().toISOString();
    validateEnvelope(input.rc, this.#rcKeys, verifySteamRcArtifact, "RC");
    validateEnvelope(input.authorization, this.#authorizationKeys, verifySteamPublishAuthorization, "publish authorization");
    validateRc(input.rc.claims, at);
    validateAuthorization(input.authorization.claims, at);
    assertAuthorizationBinding(input.rc, input.authorization);
    validateSession(input.session, input.rc.claims.tenantId, input.rc.claims.steamAppId, at);
    validateBetaBranch(input.betaBranch);
    validateSecretRef(input.branchPasswordSecretRef, "branch password");
    if (!ID.test(input.idempotencyKey)) throw new Error("Steam publish idempotency key is invalid");

    await this.#releaseEvidence.assertPassed({
      tenantId: input.rc.claims.tenantId,
      projectId: input.rc.claims.projectId,
      mainCommitSha: input.rc.claims.mainCommitSha,
      sourceDigest: input.rc.claims.sourceDigest,
      specDigest: input.rc.claims.specDigest,
      testPlanDigest: input.rc.claims.testPlanDigest,
      evidenceBundleDigest: input.rc.claims.evidenceBundleDigest,
      targetMatrix: input.rc.claims.targetMatrix,
    });

    const operationKey = `steam-private-beta:${input.rc.claims.tenantId}:${input.rc.claims.releaseId}:${input.idempotencyKey}`;
    const requestDigest = steamCanonicalDigest({
      operationKey,
      rc: input.rc,
      authorization: input.authorization,
      sessionId: input.session.id,
      credentialVersionId: input.session.credentialVersionId,
      betaBranch: input.betaBranch,
      branchPasswordSecretRef: input.branchPasswordSecretRef,
    });
    const claimToken = randomUUID();
    const claim = await this.#operations.acquire({
      key: operationKey,
      requestDigest,
      claimToken,
      claimExpiresAt: new Date(Date.parse(at) + CLAIM_MS).toISOString(),
      authorizedAt: at,
    });
    if (claim.kind === "COMPLETED") return claim.response;
    if (claim.kind === "BUSY") throw new Error("Steam private Beta upload is already claimed; retry through the workflow");

    const upload = await this.#connector.uploadPrivateBeta({
      operationKey,
      requestDigest,
      rc: input.rc.claims,
      session: input.session,
      betaBranch: input.betaBranch,
      branchPasswordSecretRef: input.branchPasswordSecretRef,
    });
    validateUploadReceipt(upload, input.rc, input.betaBranch);
    const installAttempts = await this.#installs.schedule({
      tenantId: input.rc.claims.tenantId,
      projectId: input.rc.claims.projectId,
      releaseId: input.rc.claims.releaseId,
      steamAppId: input.rc.claims.steamAppId,
      buildId: upload.buildId,
      betaBranch: input.betaBranch,
      branchPasswordSecretRef: input.branchPasswordSecretRef,
      mainCommitSha: input.rc.claims.mainCommitSha,
      sourceDigest: input.rc.claims.sourceDigest,
      specDigest: input.rc.claims.specDigest,
      testPlanDigest: input.rc.claims.testPlanDigest,
      targetMatrix: input.rc.claims.targetMatrix,
    });
    validateInstallAttempts(installAttempts, input.rc.claims.targetMatrix);
    const response: SteamPrivateBetaReceipt = Object.freeze({
      tenantId: input.rc.claims.tenantId,
      projectId: input.rc.claims.projectId,
      releaseId: input.rc.claims.releaseId,
      steamAppId: input.rc.claims.steamAppId,
      mainCommitSha: input.rc.claims.mainCommitSha,
      sourceDigest: input.rc.claims.sourceDigest,
      evidenceBundleDigest: input.rc.claims.evidenceBundleDigest,
      buildId: upload.buildId,
      betaBranch: upload.betaBranch,
      depotManifestIds: Object.freeze({ ...upload.depotManifestIds }),
      installAttempts: Object.freeze({ ...installAttempts }),
      state: "INSTALL_TESTING",
      uploadedAt: upload.uploadedAt,
    });
    await this.#operations.complete({ key: operationKey, requestDigest, claimToken, response, completedAt: at });
    return response;
  }

  async completeCleanInstall(input: {
    readonly rc: SignedSteamRcArtifact;
    readonly beta: SteamPrivateBetaReceipt;
  }): Promise<SteamReleaseReadyReceipt> {
    const at = this.#now().toISOString();
    validateEnvelope(input.rc, this.#rcKeys, verifySteamRcArtifact, "RC");
    validateRc(input.rc.claims, at, true);
    validateBetaReceiptBinding(input.beta, input.rc);
    const install = await this.#installEvidence.assertPassed({
      tenantId: input.beta.tenantId,
      projectId: input.beta.projectId,
      releaseId: input.beta.releaseId,
      steamAppId: input.beta.steamAppId,
      buildId: input.beta.buildId,
      betaBranch: input.beta.betaBranch,
      mainCommitSha: input.beta.mainCommitSha,
      sourceDigest: input.beta.sourceDigest,
      specDigest: input.rc.claims.specDigest,
      testPlanDigest: input.rc.claims.testPlanDigest,
      targetMatrix: input.rc.claims.targetMatrix,
      attempts: input.beta.installAttempts,
    });
    if (!SHA256.test(install.evidenceBundleDigest)) throw new Error("Steam install evidence digest is invalid");
    return Object.freeze({
      ...input.beta,
      steamInstallEvidenceBundleDigest: install.evidenceBundleDigest,
      state: "EXTERNAL_APPROVAL_REQUIRED",
      externalGates: Object.freeze(["VALVE_REVIEW", "FIRST_RELEASE", "DEFAULT_BRANCH_CONFIRMATION"] as const),
    });
  }
}

type SignedEnvelope<T> = { keyId: string; claims: T; signature: string };

function validateEnvelope<T>(
  envelope: SignedEnvelope<T>,
  keys: ReadonlyMap<string, KeyObject>,
  verifier: (key: KeyObject, envelope: never) => boolean,
  label: string,
): void {
  if (!ID.test(envelope.keyId) || !envelope.signature || envelope.signature.length > 512) throw new Error(`Steam ${label} envelope is invalid`);
  const key = keys.get(envelope.keyId);
  if (!key || !verifier(key, envelope as never)) throw new Error(`Steam ${label} signature is invalid`);
}

function validateRc(rc: SignedSteamRcArtifact["claims"], at: string, allowExpired = false): void {
  for (const id of [rc.tenantId, rc.projectId, rc.releaseId, rc.specRevisionId]) if (!ID.test(id)) throw new Error("Steam RC identity is invalid");
  if (rc.kind !== "deviludo-steam-rc" || rc.version !== 1 || !SHA1.test(rc.mainCommitSha)
    || ![rc.sourceDigest, rc.specDigest, rc.testPlanDigest, rc.evidenceBundleDigest].every((value) => SHA256.test(value))
    || !NUMERIC_ID.test(rc.steamAppId) || rc.steamAppId === "0") throw new Error("Steam RC binding is invalid");
  validateTimeWindow(rc.issuedAt, rc.expiresAt, at, 60 * 60_000, allowExpired);
  validateMatrix(rc.targetMatrix);
  if (rc.depots.length !== rc.targetMatrix.length) throw new Error("Steam RC must have exactly one depot per target platform");
  const platforms = new Set<SteamTargetPlatform>();
  const depots = new Set<string>();
  for (const depot of rc.depots) {
    if (!NUMERIC_ID.test(depot.depotId) || depot.depotId === "0" || depots.has(depot.depotId)
      || !rc.targetMatrix.includes(depot.platform) || platforms.has(depot.platform)
      || !/^s3:\/\/[A-Za-z0-9][A-Za-z0-9._/-]{1,1000}$/.test(depot.objectRef)
      || !SHA256.test(depot.artifactDigest) || !Number.isSafeInteger(depot.sizeBytes) || depot.sizeBytes <= 0) {
      throw new Error("Steam RC depot binding is invalid");
    }
    depots.add(depot.depotId);
    platforms.add(depot.platform);
  }
}

function validateAuthorization(auth: SignedSteamPublishAuthorization["claims"], at: string): void {
  for (const id of [auth.tenantId, auth.projectId, auth.releaseId, auth.acceptedBy, auth.mfaAssertionId, auth.nonce]) {
    if (!ID.test(id)) throw new Error("Steam publish authorization identity is invalid");
  }
  if (auth.kind !== "deviludo-steam-publish-authorization" || auth.version !== 1 || auth.operation !== "PRIVATE_BETA_UPLOAD"
    || !SHA1.test(auth.mainCommitSha) || !SHA256.test(auth.evidenceBundleDigest)) throw new Error("Steam publish authorization binding is invalid");
  validateTimeWindow(auth.issuedAt, auth.expiresAt, at, 10 * 60_000, false);
}

function assertAuthorizationBinding(rc: SignedSteamRcArtifact, auth: SignedSteamPublishAuthorization): void {
  const left = rc.claims;
  const right = auth.claims;
  if (left.tenantId !== right.tenantId || left.projectId !== right.projectId || left.releaseId !== right.releaseId
    || left.mainCommitSha !== right.mainCommitSha || left.evidenceBundleDigest !== right.evidenceBundleDigest) {
    throw new Error("Steam publish authorization does not bind the exact RC");
  }
}

function validateSession(session: SteamBuildSession, tenantId: string, appId: string, at: string): void {
  for (const id of [session.id, session.tenantId, session.accountId, session.credentialVersionId]) if (!ID.test(id)) throw new Error("Steam build session identity is invalid");
  if (session.tenantId !== tenantId || !/^[A-Za-z0-9_-]{3,64}$/.test(session.accountName)
    || session.state !== "ACTIVE" || Date.parse(session.expiresAt) <= Date.parse(at)
    || !session.allowedAppIds.includes(appId) || !session.permissions.includes("EditAppMetadata")
    || !session.permissions.includes("PublishAppChanges")) throw new Error("Steam build session is not authorized for the App");
  validateSecretRef(session.configVdfSecretRef, "config.vdf session");
  if (!Number.isFinite(Date.parse(session.verifiedAt))) throw new Error("Steam build session verification time is invalid");
}

function validateUploadReceipt(receipt: Awaited<ReturnType<SteamPipeConnector["uploadPrivateBeta"]>>, rc: SignedSteamRcArtifact, betaBranch: string): void {
  if (receipt.steamAppId !== rc.claims.steamAppId || receipt.betaBranch !== betaBranch || receipt.passwordProtected !== true
    || !NUMERIC_ID.test(receipt.buildId) || receipt.buildId === "0" || !Number.isFinite(Date.parse(receipt.uploadedAt))) {
    throw new Error("SteamPipe upload receipt is invalid");
  }
  const expected = new Set(rc.claims.depots.map((depot) => depot.depotId));
  if (Object.keys(receipt.depotManifestIds).length !== expected.size) throw new Error("SteamPipe receipt depot matrix is incomplete");
  for (const [depotId, manifestId] of Object.entries(receipt.depotManifestIds)) {
    if (!expected.has(depotId) || !NUMERIC_ID.test(manifestId) || manifestId === "0") throw new Error("SteamPipe depot manifest receipt is invalid");
  }
}

function validateInstallAttempts(attempts: Readonly<Record<SteamTargetPlatform, string>>, matrix: readonly SteamTargetPlatform[]): void {
  if (Object.keys(attempts).length !== matrix.length) throw new Error("Steam install attempt matrix is incomplete");
  for (const platform of matrix) if (!ID.test(attempts[platform])) throw new Error("Steam install attempt identity is invalid");
}

function validateBetaReceiptBinding(beta: SteamPrivateBetaReceipt, rc: SignedSteamRcArtifact): void {
  const claims = rc.claims;
  if (beta.tenantId !== claims.tenantId || beta.projectId !== claims.projectId || beta.releaseId !== claims.releaseId
    || beta.steamAppId !== claims.steamAppId || beta.mainCommitSha !== claims.mainCommitSha
    || beta.sourceDigest !== claims.sourceDigest || beta.evidenceBundleDigest !== claims.evidenceBundleDigest
    || beta.state !== "INSTALL_TESTING") throw new Error("Steam private Beta receipt does not bind the exact RC");
  validateBetaBranch(beta.betaBranch);
  validateInstallAttempts(beta.installAttempts, claims.targetMatrix);
}

function validateMatrix(matrix: readonly SteamTargetPlatform[]): void {
  if (!matrix.length || matrix.length > 3 || new Set(matrix).size !== matrix.length
    || matrix.some((value) => !["windows", "linux", "macos"].includes(value))) throw new Error("Steam target matrix is invalid");
  const order = ["windows", "linux", "macos"];
  if ([...matrix].sort((a, b) => order.indexOf(a) - order.indexOf(b)).join() !== matrix.join()) throw new Error("Steam target matrix must be canonical");
}

function validateTimeWindow(issuedAt: string, expiresAt: string, at: string, maxLifetimeMs: number, allowExpired: boolean): void {
  const issued = Date.parse(issuedAt);
  const expires = Date.parse(expiresAt);
  const current = Date.parse(at);
  if (![issued, expires, current].every(Number.isFinite) || issued > current + 30_000 || expires <= issued
    || expires - issued > maxLifetimeMs || (!allowExpired && expires <= current)) throw new Error("Steam signed artifact time window is invalid");
}

function validateBetaBranch(value: string): void {
  if (!BETA_BRANCH.test(value) || value === "default" || value === "public") throw new Error("Steam Beta branch must be a fixed non-default private branch");
}

function validateSecretRef(value: string, label: string): void {
  if (!/^vault:\/\/[A-Za-z0-9._~:/-]{1,500}$/.test(value)) throw new Error(`Steam ${label} SecretRef is invalid`);
}

type StoredOperation = {
  requestDigest: string;
  claimToken: string;
  claimExpiresAt: string;
  response?: SteamPrivateBetaReceipt;
};

export class InMemorySteamPublishOperationStore implements SteamPublishOperationStore {
  readonly #operations = new Map<string, StoredOperation>();
  readonly #now: () => Date;

  constructor(now: () => Date = () => new Date()) {
    this.#now = now;
  }

  async acquire(input: Parameters<SteamPublishOperationStore["acquire"]>[0]) {
    const current = this.#operations.get(input.key);
    if (current?.requestDigest !== undefined && current.requestDigest !== input.requestDigest) throw new Error("Steam idempotency key was reused with another request");
    if (current?.response) return { kind: "COMPLETED" as const, response: current.response };
    if (current && Date.parse(current.claimExpiresAt) > this.#now().getTime()) return { kind: "BUSY" as const };
    this.#operations.set(input.key, { requestDigest: input.requestDigest, claimToken: input.claimToken, claimExpiresAt: input.claimExpiresAt });
    return { kind: "ACQUIRED" as const };
  }

  async complete(input: Parameters<SteamPublishOperationStore["complete"]>[0]): Promise<void> {
    const current = this.#operations.get(input.key);
    if (!current || current.requestDigest !== input.requestDigest || current.claimToken !== input.claimToken || current.response) {
      throw new Error("Steam publish claim was lost before completion");
    }
    this.#operations.set(input.key, { ...current, response: input.response });
  }
}
