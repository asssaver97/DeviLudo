import { randomUUID } from "node:crypto";
import { steamCanonicalDigest } from "./artifacts";
import type {
  SignedSteamRcArtifact,
  SteamRcArtifactClaims,
  SteamRcDepot,
  SteamTargetPlatform,
} from "./contracts";
import {
  validateFinalizedSteamDepot,
  type SteamDepotFinalizer,
  type SteamDepotFinalizationInput,
} from "./depot-finalization";
import type { SteamPrivateBetaOperationRequest } from "./workflow-broker-http";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const SHA1 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const NUMERIC_ID = /^[1-9][0-9]{0,19}$/;
const SIGNATURE = /^[A-Za-z0-9_-]{80,128}$/;
const RC_TTL_MS = 60 * 60_000;

export interface SteamRcIssuanceDepotInput {
  readonly platform: SteamTargetPlatform;
  readonly depotId: string;
  readonly objectKey: string;
  readonly artifactDigest: string;
}

export interface SteamRcIssuanceSnapshot {
  readonly tenantId: string;
  readonly projectId: string;
  readonly runId: string;
  readonly releaseId: string;
  readonly mainEvidenceBundleId: string;
  readonly mainCommitSha: string;
  readonly sourceDigest: string;
  readonly specRevisionId: string;
  readonly specDigest: string;
  readonly testPlanDigest: string;
  readonly evidenceBundleDigest: string;
  readonly steamAppId: string;
  readonly targetMatrix: readonly SteamTargetPlatform[];
  readonly depotConfigurationId: string;
  readonly depotConfigurationDigest: string;
  readonly depots: readonly SteamRcIssuanceDepotInput[];
}

export interface SteamRcIssuanceAuthority {
  resolve(request: SteamPrivateBetaOperationRequest): Promise<SteamRcIssuanceSnapshot>;
  probe(): Promise<void>;
}

export interface SteamRcObjectInspector {
  inspect(input: Readonly<{
    tenantId: string;
    projectId: string;
    releaseId: string;
    platform: SteamTargetPlatform;
    objectKey: string;
    artifactDigest: string;
  }>): Promise<Readonly<{ objectRef: string; sizeBytes: number }>>;
  probe(): Promise<void>;
}

/** Production implementations sign through Vault/KMS; private keys stay outside this process. */
export interface SteamRcArtifactSigner {
  sign(claims: SteamRcArtifactClaims): Promise<SignedSteamRcArtifact>;
  probe(): Promise<void>;
}

export interface SteamRcArtifactArchive {
  find(input: Readonly<{ tenantId: string; releaseId: string }>): Promise<SteamRcArchivedArtifact | null>;
  persist(input: Readonly<{
    artifactId: string;
    snapshot: SteamRcIssuanceSnapshot;
    artifactDigest: string;
    artifact: SignedSteamRcArtifact;
    createdAt: string;
  }>): Promise<SteamRcArchivedArtifact>;
  probe(): Promise<void>;
}

export interface SteamRcArchivedArtifact {
  readonly artifact: SignedSteamRcArtifact;
  readonly artifactDigest: string;
  readonly depotConfigurationId: string;
  readonly depotConfigurationDigest: string;
}

/** Builds one exact, signed and append-only RC from the passed main evidence. */
export class SteamRcIssuer {
  readonly #now: () => Date;
  readonly #artifactId: () => string;

  constructor(
    private readonly authority: SteamRcIssuanceAuthority,
    private readonly finalizer: SteamDepotFinalizer,
    private readonly objects: SteamRcObjectInspector,
    private readonly signer: SteamRcArtifactSigner,
    private readonly archive: SteamRcArtifactArchive,
    options: Readonly<{ now?: () => Date; artifactId?: () => string }> = {},
  ) {
    this.#now = options.now ?? (() => new Date());
    this.#artifactId = options.artifactId ?? randomUUID;
  }

  async ensure(request: SteamPrivateBetaOperationRequest): Promise<SignedSteamRcArtifact> {
    const snapshot = validateSnapshot(await this.authority.resolve(request), request);
    const existing = await this.archive.find({ tenantId: request.tenantId, releaseId: snapshot.releaseId });
    if (existing) {
      validateArchived(existing, snapshot);
      return existing.artifact;
    }
    const depots = await Promise.all(snapshot.depots.map(async (depot): Promise<SteamRcDepot> => {
      const finalizationInput: SteamDepotFinalizationInput = Object.freeze({
        tenantId: snapshot.tenantId,
        projectId: snapshot.projectId,
        releaseId: snapshot.releaseId,
        mainCommitSha: snapshot.mainCommitSha,
        evidenceBundleDigest: snapshot.evidenceBundleDigest,
        platform: depot.platform,
        sourceObjectKey: depot.objectKey,
        sourceArtifactDigest: depot.artifactDigest,
      });
      const finalized = validateFinalizedSteamDepot(
        await this.finalizer.finalize(finalizationInput), finalizationInput,
      );
      const inspected = await this.objects.inspect({
        tenantId: snapshot.tenantId,
        projectId: snapshot.projectId,
        releaseId: snapshot.releaseId,
        platform: depot.platform,
        objectKey: finalized.artifactObjectKey,
        artifactDigest: finalized.artifactDigest,
      });
      validateObject(inspected, finalized.artifactObjectKey);
      const signingEvidence = await this.objects.inspect({
        tenantId: snapshot.tenantId,
        projectId: snapshot.projectId,
        releaseId: snapshot.releaseId,
        platform: depot.platform,
        objectKey: finalized.signingEvidenceObjectKey,
        artifactDigest: finalized.signingEvidenceDigest,
      });
      validateObject(signingEvidence, finalized.signingEvidenceObjectKey);
      let notarizationEvidence: Readonly<{ objectRef: string; sizeBytes: number }> | null = null;
      if (finalized.notarizationEvidenceObjectKey && finalized.notarizationEvidenceDigest) {
        notarizationEvidence = await this.objects.inspect({
          tenantId: snapshot.tenantId,
          projectId: snapshot.projectId,
          releaseId: snapshot.releaseId,
          platform: depot.platform,
          objectKey: finalized.notarizationEvidenceObjectKey,
          artifactDigest: finalized.notarizationEvidenceDigest,
        });
        validateObject(notarizationEvidence, finalized.notarizationEvidenceObjectKey);
      }
      return Object.freeze({
        depotId: depot.depotId,
        platform: depot.platform,
        objectRef: inspected.objectRef,
        sourceArtifactDigest: finalized.sourceArtifactDigest,
        artifactDigest: finalized.artifactDigest,
        sizeBytes: inspected.sizeBytes,
        signingScheme: finalized.signingScheme,
        signingIdentityDigest: finalized.signingIdentityDigest,
        signingEvidenceRef: signingEvidence.objectRef,
        signingEvidenceDigest: finalized.signingEvidenceDigest,
        notarizationEvidenceRef: notarizationEvidence?.objectRef ?? null,
        notarizationEvidenceDigest: finalized.notarizationEvidenceDigest,
      });
    }));
    const issuedAt = validNow(this.#now()).toISOString();
    const claims: SteamRcArtifactClaims = deepFreeze({
      kind: "deviludo-steam-rc" as const,
      version: 2 as const,
      tenantId: snapshot.tenantId,
      projectId: snapshot.projectId,
      releaseId: snapshot.releaseId,
      mainCommitSha: snapshot.mainCommitSha,
      sourceDigest: snapshot.sourceDigest,
      specRevisionId: snapshot.specRevisionId,
      specDigest: snapshot.specDigest,
      testPlanDigest: snapshot.testPlanDigest,
      evidenceBundleDigest: snapshot.evidenceBundleDigest,
      steamAppId: snapshot.steamAppId,
      targetMatrix: Object.freeze([...snapshot.targetMatrix]),
      depots: Object.freeze(depots),
      issuedAt,
      expiresAt: new Date(Date.parse(issuedAt) + RC_TTL_MS).toISOString(),
    });
    const artifact = deepFreeze(await this.signer.sign(claims));
    validateArtifact(artifact, snapshot, claims);
    const artifactId = this.#artifactId();
    if (!UUID.test(artifactId)) invalid();
    const archived = await this.archive.persist({
      artifactId,
      snapshot,
      artifactDigest: steamCanonicalDigest(artifact),
      artifact,
      createdAt: issuedAt,
    });
    validateArchived(archived, snapshot);
    return archived.artifact;
  }

  async probe(): Promise<void> {
    await Promise.all([
      this.authority.probe(), this.finalizer.probe(), this.objects.probe(), this.signer.probe(), this.archive.probe(),
    ]);
  }
}

function validateArchived(value: SteamRcArchivedArtifact, snapshot: SteamRcIssuanceSnapshot): void {
  if (!UUID.test(value.depotConfigurationId) || !SHA256.test(value.depotConfigurationDigest)
    || value.depotConfigurationId !== snapshot.depotConfigurationId
    || value.depotConfigurationDigest !== snapshot.depotConfigurationDigest
    || !SHA256.test(value.artifactDigest)) invalid();
  validateArtifact(value.artifact, snapshot);
  if (steamCanonicalDigest(value.artifact) !== value.artifactDigest) invalid();
  const expectedDepots = snapshot.depots.map((entry) => ({
    platform: entry.platform, depotId: entry.depotId, sourceArtifactDigest: entry.artifactDigest,
  }));
  const actualDepots = value.artifact.claims.depots.map((entry) => ({
    platform: entry.platform, depotId: entry.depotId, sourceArtifactDigest: entry.sourceArtifactDigest,
  }));
  if (steamCanonicalDigest(actualDepots) !== steamCanonicalDigest(expectedDepots)) invalid();
}

export function validateSignedSteamRcArtifact(value: unknown): SignedSteamRcArtifact {
  const body = record(value);
  exactKeys(body, ["keyId", "claims", "signature"]);
  if (typeof body.keyId !== "string" || !SAFE_ID.test(body.keyId)
    || typeof body.signature !== "string" || !SIGNATURE.test(body.signature)) invalid();
  const claims = record(body.claims);
  exactKeys(claims, ["kind", "version", "tenantId", "projectId", "releaseId", "mainCommitSha", "sourceDigest",
    "specRevisionId", "specDigest", "testPlanDigest", "evidenceBundleDigest", "steamAppId", "targetMatrix", "depots",
    "issuedAt", "expiresAt"]);
  const matrix = matrixValue(claims.targetMatrix);
  if (claims.kind !== "deviludo-steam-rc" || claims.version !== 2
    || typeof claims.tenantId !== "string" || !UUID.test(claims.tenantId)
    || typeof claims.projectId !== "string" || !UUID.test(claims.projectId)
    || typeof claims.releaseId !== "string" || !UUID.test(claims.releaseId)
    || typeof claims.mainCommitSha !== "string" || !SHA1.test(claims.mainCommitSha)
    || typeof claims.sourceDigest !== "string" || !SHA256.test(claims.sourceDigest)
    || typeof claims.specRevisionId !== "string" || !SAFE_ID.test(claims.specRevisionId)
    || typeof claims.specDigest !== "string" || !SHA256.test(claims.specDigest)
    || typeof claims.testPlanDigest !== "string" || !SHA256.test(claims.testPlanDigest)
    || typeof claims.evidenceBundleDigest !== "string" || !SHA256.test(claims.evidenceBundleDigest)
    || typeof claims.steamAppId !== "string" || !NUMERIC_ID.test(claims.steamAppId)
    || typeof claims.issuedAt !== "string" || typeof claims.expiresAt !== "string"
    || !validWindow(claims.issuedAt, claims.expiresAt)) invalid();
  if (!Array.isArray(claims.depots) || claims.depots.length !== matrix.length) invalid();
  const depots = claims.depots.map((value) => depotValue(value));
  if (JSON.stringify(depots.map((entry) => entry.platform)) !== JSON.stringify(matrix)
    || new Set(depots.map((entry) => entry.depotId)).size !== depots.length) invalid();
  return deepFreeze({
    keyId: body.keyId,
    signature: body.signature,
    claims: {
      kind: "deviludo-steam-rc",
      version: 2,
      tenantId: claims.tenantId,
      projectId: claims.projectId,
      releaseId: claims.releaseId,
      mainCommitSha: claims.mainCommitSha,
      sourceDigest: claims.sourceDigest,
      specRevisionId: claims.specRevisionId,
      specDigest: claims.specDigest,
      testPlanDigest: claims.testPlanDigest,
      evidenceBundleDigest: claims.evidenceBundleDigest,
      steamAppId: claims.steamAppId,
      targetMatrix: matrix,
      depots,
      issuedAt: claims.issuedAt,
      expiresAt: claims.expiresAt,
    },
  });
}

function validateSnapshot(value: SteamRcIssuanceSnapshot, request: SteamPrivateBetaOperationRequest): SteamRcIssuanceSnapshot {
  if (!UUID.test(value.tenantId) || !UUID.test(value.projectId) || !UUID.test(value.runId)
    || !UUID.test(value.releaseId) || !UUID.test(value.mainEvidenceBundleId)
    || value.tenantId !== request.tenantId || value.projectId !== request.projectId || value.runId !== request.runId
    || value.mainEvidenceBundleId !== request.mainEvidenceBundleId || value.mainCommitSha !== request.mainCommitSha
    || !SHA1.test(value.mainCommitSha) || !SHA256.test(value.sourceDigest)
    || !SAFE_ID.test(value.specRevisionId) || !SHA256.test(value.specDigest) || !SHA256.test(value.testPlanDigest)
    || !SHA256.test(value.evidenceBundleDigest) || !NUMERIC_ID.test(value.steamAppId)
    || !UUID.test(value.depotConfigurationId) || !SHA256.test(value.depotConfigurationDigest)
    || JSON.stringify(matrixValue(value.targetMatrix)) !== JSON.stringify(request.targetMatrix)
    || value.depots.length !== value.targetMatrix.length) invalid();
  const depots = value.depots.map((depot) => {
    if (!value.targetMatrix.includes(depot.platform) || !NUMERIC_ID.test(depot.depotId)
      || !safeObjectKey(depot.objectKey) || !SHA256.test(depot.artifactDigest)) invalid();
    return Object.freeze({ ...depot });
  });
  if (JSON.stringify(depots.map((entry) => entry.platform)) !== JSON.stringify(value.targetMatrix)
    || new Set(depots.map((entry) => entry.depotId)).size !== depots.length) invalid();
  return deepFreeze({ ...value, targetMatrix: Object.freeze([...value.targetMatrix]), depots });
}

function validateArtifact(
  value: SignedSteamRcArtifact,
  snapshot: SteamRcIssuanceSnapshot,
  expectedClaims?: SteamRcArtifactClaims,
): void {
  const artifact = validateSignedSteamRcArtifact(value);
  const claims = artifact.claims;
  if (claims.tenantId !== snapshot.tenantId || claims.projectId !== snapshot.projectId
    || claims.releaseId !== snapshot.releaseId || claims.mainCommitSha !== snapshot.mainCommitSha
    || claims.sourceDigest !== snapshot.sourceDigest || claims.specRevisionId !== snapshot.specRevisionId
    || claims.specDigest !== snapshot.specDigest || claims.testPlanDigest !== snapshot.testPlanDigest
    || claims.evidenceBundleDigest !== snapshot.evidenceBundleDigest || claims.steamAppId !== snapshot.steamAppId
    || JSON.stringify(claims.targetMatrix) !== JSON.stringify(snapshot.targetMatrix)
    || expectedClaims && steamCanonicalDigest(claims) !== steamCanonicalDigest(expectedClaims)) invalid();
}

function validateObject(value: Readonly<{ objectRef: string; sizeBytes: number }>, objectKey: string): void {
  if (typeof value.objectRef !== "string" || !/^s3:\/\/[A-Za-z0-9][A-Za-z0-9._/-]{1,1000}$/.test(value.objectRef)
    || !value.objectRef.endsWith(`/${objectKey}`) || value.objectRef.includes("..")
    || !Number.isSafeInteger(value.sizeBytes) || value.sizeBytes < 1 || value.sizeBytes > 8 * 1024 * 1024 * 1024) invalid();
}

function depotValue(value: unknown): SteamRcDepot {
  const body = record(value);
  exactKeys(body, [
    "depotId", "platform", "objectRef", "sourceArtifactDigest", "artifactDigest", "sizeBytes",
    "signingScheme", "signingIdentityDigest", "signingEvidenceRef", "signingEvidenceDigest",
    "notarizationEvidenceRef", "notarizationEvidenceDigest",
  ]);
  if (typeof body.depotId !== "string" || !NUMERIC_ID.test(body.depotId)
    || !isPlatform(body.platform) || typeof body.objectRef !== "string"
    || !/^s3:\/\/[A-Za-z0-9][A-Za-z0-9._/-]{1,1000}$/.test(body.objectRef) || body.objectRef.includes("..")
    || typeof body.sourceArtifactDigest !== "string" || !SHA256.test(body.sourceArtifactDigest)
    || typeof body.artifactDigest !== "string" || !SHA256.test(body.artifactDigest)
    || typeof body.signingIdentityDigest !== "string" || !SHA256.test(body.signingIdentityDigest)
    || typeof body.signingEvidenceRef !== "string"
    || !/^s3:\/\/[A-Za-z0-9][A-Za-z0-9._/-]{1,1000}$/.test(body.signingEvidenceRef)
    || body.signingEvidenceRef.includes("..")
    || typeof body.signingEvidenceDigest !== "string" || !SHA256.test(body.signingEvidenceDigest)
    || !Number.isSafeInteger(body.sizeBytes) || (body.sizeBytes as number) < 1
    || (body.sizeBytes as number) > 8 * 1024 * 1024 * 1024) invalid();
  const expectedScheme = body.platform === "windows" ? "WINDOWS_AUTHENTICODE"
    : body.platform === "macos" ? "MACOS_DEVELOPER_ID" : "LINUX_SIGSTORE";
  if (body.signingScheme !== expectedScheme) invalid();
  if (body.platform === "macos") {
    if (typeof body.notarizationEvidenceRef !== "string"
      || !/^s3:\/\/[A-Za-z0-9][A-Za-z0-9._/-]{1,1000}$/.test(body.notarizationEvidenceRef)
      || body.notarizationEvidenceRef.includes("..")
      || typeof body.notarizationEvidenceDigest !== "string" || !SHA256.test(body.notarizationEvidenceDigest)) invalid();
  } else if (body.notarizationEvidenceRef !== null || body.notarizationEvidenceDigest !== null) invalid();
  return Object.freeze({
    depotId: body.depotId,
    platform: body.platform,
    objectRef: body.objectRef,
    sourceArtifactDigest: body.sourceArtifactDigest,
    artifactDigest: body.artifactDigest,
    sizeBytes: body.sizeBytes as number,
    signingScheme: expectedScheme,
    signingIdentityDigest: body.signingIdentityDigest,
    signingEvidenceRef: body.signingEvidenceRef,
    signingEvidenceDigest: body.signingEvidenceDigest,
    notarizationEvidenceRef: body.notarizationEvidenceRef as string | null,
    notarizationEvidenceDigest: body.notarizationEvidenceDigest as string | null,
  });
}

function matrixValue(value: unknown): readonly SteamTargetPlatform[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 3
    || value.some((entry) => !isPlatform(entry)) || new Set(value).size !== value.length
    || JSON.stringify([...value].sort()) !== JSON.stringify(value)) invalid();
  return Object.freeze([...value]) as readonly SteamTargetPlatform[];
}

function validWindow(issuedAt: string, expiresAt: string): boolean {
  const start = Date.parse(issuedAt);
  const end = Date.parse(expiresAt);
  return Number.isFinite(start) && Number.isFinite(end) && new Date(start).toISOString() === issuedAt
    && new Date(end).toISOString() === expiresAt && end > start && end - start <= RC_TTL_MS;
}

function validNow(value: Date): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) invalid();
  return value;
}

function safeObjectKey(value: string): boolean {
  return typeof value === "string" && value.length >= 16 && value.length <= 1_024
    && !value.startsWith("/") && !value.endsWith("/") && !value.includes("..") && !/[\0\\]/.test(value);
}

function isPlatform(value: unknown): value is SteamTargetPlatform {
  return value === "windows" || value === "linux" || value === "macos";
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}

function exactKeys(body: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(body).sort();
  const sorted = [...expected].sort();
  if (actual.length !== sorted.length || actual.some((key, index) => key !== sorted[index])) invalid();
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function invalid(): never { throw new Error("Steam RC issuance is invalid"); }
