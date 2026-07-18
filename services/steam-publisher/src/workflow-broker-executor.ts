import type {
  SignedSteamPublishAuthorization,
  SignedSteamRcArtifact,
  SteamBuildSession,
  SteamPrivateBetaReceipt,
  SteamTargetPlatform,
} from "./contracts";
import { steamCanonicalDigest } from "./artifacts";
import type { SteamReleaseCoordinator } from "./coordinator";
import type {
  SteamDefaultBranchWorkflowReceipt,
  SteamPrivateBetaWorkflowReceipt,
} from "./workflow-handler";
import type {
  SteamDefaultBranchOperationRequest,
  SteamPrivateBetaOperationRequest,
  SteamWorkflowOperationRequest,
} from "./workflow-broker-http";
import type { SteamWorkflowOperationExecutor } from "./workflow-broker-operations";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const BUILD_ID = /^[1-9][0-9]{0,19}$/;

export interface SteamPrivateBetaExecutionAuthority {
  readonly state: "AUTHORIZED";
  readonly runId: string;
  readonly mainEvidenceBundleId: string;
  readonly mfaApprovalId: string;
  readonly targetMatrix: readonly SteamTargetPlatform[];
  readonly rc: SignedSteamRcArtifact;
  readonly authorization: SignedSteamPublishAuthorization;
  readonly session: SteamBuildSession;
  readonly betaBranch: string;
  readonly branchPasswordSecretRef: string;
}

export interface SteamDefaultBranchExecutionAuthority {
  readonly state: "READY_TO_PUBLISH";
  readonly tenantId: string;
  readonly projectId: string;
  readonly releaseId: string;
  readonly runId: string;
  readonly steamAppId: string;
  readonly betaBuildId: string;
  readonly buildReceiptId: string;
  readonly steamInstallEvidenceBundleDigest: string;
  readonly session: SteamBuildSession;
  readonly externalApprovals: readonly [
    Readonly<{ gate: "VALVE_REVIEW"; approvalId: string }>,
    Readonly<{ gate: "FIRST_RELEASE"; approvalId: string }>,
    Readonly<{ gate: "DEFAULT_BRANCH_CONFIRMATION"; approvalId: string }>,
  ];
}

export interface SteamWorkflowExecutionAuthority {
  resolvePrivateBeta(request: SteamPrivateBetaOperationRequest): Promise<SteamPrivateBetaExecutionAuthority>;
  resolveDefaultBranch(request: SteamDefaultBranchOperationRequest): Promise<SteamDefaultBranchExecutionAuthority>;
  probe(): Promise<void>;
}

export interface SteamPrivateBetaRcPreparer {
  ensure(request: SteamPrivateBetaOperationRequest): Promise<SignedSteamRcArtifact>;
  probe(): Promise<void>;
}

export interface SteamPrivateBetaReleasePreparer {
  prepare(request: SteamPrivateBetaOperationRequest): Promise<void>;
  probe(): Promise<void>;
}

export interface SteamPrivateBetaExecutor extends Pick<SteamReleaseCoordinator, "uploadPrivateBeta"> {
  probe(): Promise<void>;
}

export interface SteamBuildReceiptArchive {
  persist(input: Readonly<{
    operationKey: string;
    requestDigest: string;
    receipt: SteamPrivateBetaReceipt;
  }>): Promise<Readonly<{ receiptId: string }>>;
  probe(): Promise<void>;
}

export interface SteamDefaultBranchConnector {
  promote(input: Readonly<{
    operationKey: string;
    requestDigest: string;
    tenantId: string;
    projectId: string;
    releaseId: string;
    steamAppId: string;
    betaBuildId: string;
    buildReceiptId: string;
    steamInstallEvidenceBundleDigest: string;
    session: SteamBuildSession;
    externalApprovalIds: readonly string[];
  }>): Promise<Readonly<{
    releaseId: string;
    steamAppId: string;
    betaBuildId: string;
    defaultBranchBuildId: string;
    publishedAt: string;
  }>>;
  probe(): Promise<void>;
}

export interface SteamDefaultBranchReceiptArchive {
  persist(input: Readonly<{
    operationKey: string;
    requestDigest: string;
    tenantId: string;
    projectId: string;
    releaseId: string;
    runId: string;
    steamAppId: string;
    buildReceiptId: string;
    betaBuildId: string;
    defaultBranchBuildId: string;
    steamInstallEvidenceBundleDigest: string;
    externalApprovalIds: readonly string[];
    publishedAt: string;
  }>): Promise<Readonly<{ receiptId: string }>>;
  probe(): Promise<void>;
}

/** Resolves server authority immediately before each irreversible Steam action. */
export class AuthoritativeSteamWorkflowExecutor implements SteamWorkflowOperationExecutor {
  constructor(
    private readonly releasePreparer: SteamPrivateBetaReleasePreparer,
    private readonly rcPreparer: SteamPrivateBetaRcPreparer,
    private readonly authority: SteamWorkflowExecutionAuthority,
    private readonly privateBeta: SteamPrivateBetaExecutor,
    private readonly builds: SteamBuildReceiptArchive,
    private readonly defaultBranch: SteamDefaultBranchConnector,
    private readonly publications: SteamDefaultBranchReceiptArchive,
  ) {}

  async execute(
    request: SteamWorkflowOperationRequest,
    context: Readonly<{ heartbeat: () => Promise<void> }>,
  ): Promise<SteamPrivateBetaWorkflowReceipt | SteamDefaultBranchWorkflowReceipt> {
    await context.heartbeat();
    return request.kind === "PRIVATE_BETA_UPLOAD"
      ? await this.#upload(request, context)
      : await this.#publish(request, context);
  }

  async probe(): Promise<void> {
    await Promise.all([
      this.releasePreparer.probe(), this.rcPreparer.probe(), this.authority.probe(), this.builds.probe(),
      this.privateBeta.probe(), this.defaultBranch.probe(), this.publications.probe(),
    ]);
  }

  async #upload(
    request: SteamPrivateBetaOperationRequest,
    context: Readonly<{ heartbeat: () => Promise<void> }>,
  ): Promise<SteamPrivateBetaWorkflowReceipt> {
    await this.releasePreparer.prepare(request);
    await context.heartbeat();
    const preparedRc = await this.rcPreparer.ensure(request);
    await context.heartbeat();
    const authority = await this.authority.resolvePrivateBeta(request);
    validatePrivateBetaAuthority(authority, request);
    if (steamCanonicalDigest(preparedRc) !== steamCanonicalDigest(authority.rc)) invalid();
    await context.heartbeat();
    const receipt = await this.privateBeta.uploadPrivateBeta({
      rc: authority.rc,
      authorization: authority.authorization,
      session: authority.session,
      betaBranch: authority.betaBranch,
      branchPasswordSecretRef: authority.branchPasswordSecretRef,
      idempotencyKey: request.operationKey,
    });
    validatePrivateBetaDomainReceipt(receipt, authority, request);
    await context.heartbeat();
    const archived = await this.builds.persist({
      operationKey: request.operationKey,
      requestDigest: request.requestDigest,
      receipt,
    });
    if (!UUID.test(archived.receiptId)) invalid();
    return Object.freeze({
      receiptId: archived.receiptId,
      runId: request.runId,
      mainCommitSha: request.mainCommitSha,
      mainEvidenceBundleId: request.mainEvidenceBundleId,
      mfaApprovalId: request.mfaApprovalId,
      targetMatrix: Object.freeze([...request.targetMatrix]),
      buildId: receipt.buildId,
    });
  }

  async #publish(
    request: SteamDefaultBranchOperationRequest,
    context: Readonly<{ heartbeat: () => Promise<void> }>,
  ): Promise<SteamDefaultBranchWorkflowReceipt> {
    const authority = await this.authority.resolveDefaultBranch(request);
    validateDefaultBranchAuthority(authority, request);
    await context.heartbeat();
    const promoted = await this.defaultBranch.promote({
      operationKey: request.operationKey,
      requestDigest: request.requestDigest,
      tenantId: request.tenantId,
      projectId: request.projectId,
      releaseId: authority.releaseId,
      steamAppId: authority.steamAppId,
      betaBuildId: request.betaBuildId,
      buildReceiptId: authority.buildReceiptId,
      steamInstallEvidenceBundleDigest: authority.steamInstallEvidenceBundleDigest,
      session: authority.session,
      externalApprovalIds: request.externalApprovalIds,
    });
    validatePromotion(promoted, authority, request);
    await context.heartbeat();
    const archived = await this.publications.persist({
      operationKey: request.operationKey,
      requestDigest: request.requestDigest,
      tenantId: request.tenantId,
      projectId: request.projectId,
      releaseId: authority.releaseId,
      runId: request.runId,
      steamAppId: authority.steamAppId,
      buildReceiptId: authority.buildReceiptId,
      betaBuildId: request.betaBuildId,
      defaultBranchBuildId: promoted.defaultBranchBuildId,
      steamInstallEvidenceBundleDigest: authority.steamInstallEvidenceBundleDigest,
      externalApprovalIds: request.externalApprovalIds,
      publishedAt: promoted.publishedAt,
    });
    if (!UUID.test(archived.receiptId)) invalid();
    return Object.freeze({
      receiptId: archived.receiptId,
      releaseId: authority.releaseId,
      runId: request.runId,
      betaBuildId: request.betaBuildId,
      defaultBranchBuildId: promoted.defaultBranchBuildId,
      externalApprovalIds: Object.freeze([...request.externalApprovalIds]),
    });
  }
}

function validatePrivateBetaAuthority(
  value: SteamPrivateBetaExecutionAuthority,
  request: SteamPrivateBetaOperationRequest,
): void {
  if (value.state !== "AUTHORIZED" || value.runId !== request.runId
    || value.mainEvidenceBundleId !== request.mainEvidenceBundleId || value.mfaApprovalId !== request.mfaApprovalId
    || JSON.stringify(value.targetMatrix) !== JSON.stringify(request.targetMatrix)
    || value.rc.claims.tenantId !== request.tenantId || value.rc.claims.projectId !== request.projectId
    || value.rc.claims.mainCommitSha !== request.mainCommitSha
    || JSON.stringify(value.rc.claims.targetMatrix) !== JSON.stringify(request.targetMatrix)
    || value.authorization.claims.tenantId !== request.tenantId
    || value.authorization.claims.projectId !== request.projectId
    || value.authorization.claims.releaseId !== value.rc.claims.releaseId
    || value.authorization.claims.mainCommitSha !== request.mainCommitSha
    || value.authorization.claims.nonce !== request.mfaApprovalId
    || value.authorization.claims.evidenceBundleDigest !== value.rc.claims.evidenceBundleDigest
    || value.session.tenantId !== request.tenantId) invalid();
}

function validatePrivateBetaDomainReceipt(
  receipt: SteamPrivateBetaReceipt,
  authority: SteamPrivateBetaExecutionAuthority,
  request: SteamPrivateBetaOperationRequest,
): void {
  if (receipt.tenantId !== request.tenantId || receipt.projectId !== request.projectId
    || receipt.releaseId !== authority.rc.claims.releaseId || receipt.steamAppId !== authority.rc.claims.steamAppId
    || receipt.mainCommitSha !== request.mainCommitSha || receipt.sourceDigest !== authority.rc.claims.sourceDigest
    || receipt.evidenceBundleDigest !== authority.rc.claims.evidenceBundleDigest
    || !BUILD_ID.test(receipt.buildId) || receipt.betaBranch !== authority.betaBranch
    || receipt.state !== "INSTALL_TESTING" || !Number.isFinite(Date.parse(receipt.uploadedAt))) invalid();
}

function validateDefaultBranchAuthority(
  value: SteamDefaultBranchExecutionAuthority,
  request: SteamDefaultBranchOperationRequest,
): void {
  if (value.state !== "READY_TO_PUBLISH" || value.tenantId !== request.tenantId
    || value.projectId !== request.projectId || value.runId !== request.runId
    || !UUID.test(value.releaseId) || !UUID.test(value.buildReceiptId)
    || value.betaBuildId !== request.betaBuildId || !BUILD_ID.test(value.steamAppId)
    || !SHA256.test(value.steamInstallEvidenceBundleDigest) || value.session.tenantId !== request.tenantId
    || value.externalApprovals[0]?.gate !== "VALVE_REVIEW"
    || value.externalApprovals[1]?.gate !== "FIRST_RELEASE"
    || value.externalApprovals[2]?.gate !== "DEFAULT_BRANCH_CONFIRMATION"
    || JSON.stringify(value.externalApprovals.map((entry) => entry.approvalId)) !== JSON.stringify(request.externalApprovalIds)) invalid();
  validateSession(value.session, request.tenantId, value.steamAppId);
}

function validatePromotion(
  value: Awaited<ReturnType<SteamDefaultBranchConnector["promote"]>>,
  authority: SteamDefaultBranchExecutionAuthority,
  request: SteamDefaultBranchOperationRequest,
): void {
  if (value.releaseId !== authority.releaseId || value.steamAppId !== authority.steamAppId
    || value.betaBuildId !== request.betaBuildId || value.defaultBranchBuildId !== request.betaBuildId
    || !Number.isFinite(Date.parse(value.publishedAt))) invalid();
}

function validateSession(session: SteamBuildSession, tenantId: string, steamAppId: string): void {
  if (!SAFE_ID.test(session.id) || session.tenantId !== tenantId || session.state !== "ACTIVE"
    || !session.allowedAppIds.includes(steamAppId)
    || !session.permissions.includes("EditAppMetadata") || !session.permissions.includes("PublishAppChanges")
    || !Number.isFinite(Date.parse(session.expiresAt))) invalid();
}

function invalid(): never { throw new Error("Authoritative Steam workflow execution is invalid"); }
