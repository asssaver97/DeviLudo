import type { LocalAgentExecutionReceipt } from "@/services/local-agent-runtime/src/contracts";
import { isAdapterVersionAttested, isBuiltInAdapterVersion } from "@/lib/agent/adapter-registry";

const SAFE_ATTESTATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const SHA256_DIGEST = /^sha256:[a-f0-9]{64}$/;

export type LocalDeliveryStage =
  | "AWAITING_SPEC_APPROVAL"
  | "AGENT_QUEUED"
  | "AGENT_RUNNING"
  | "WAITING_PROVIDER"
  | "CANDIDATE_READY"
  | "E2E_RUNNING"
  | "AWAITING_ACCEPTANCE"
  | "MERGING"
  | "MAIN_GATE_RUNNING"
  | "MFA_REQUIRED"
  | "STEAM_BETA_UPLOADING"
  | "STEAM_REINSTALL_E2E"
  | "EXTERNAL_APPROVAL_REQUIRED"
  | "CANCELLED"
  | "RELEASED";

export type LocalPlatformStatus = "QUEUED" | "RUNNING" | "PASSED" | "INVALIDATED";
export type LocalTargetPlatform = "linux" | "windows" | "macos";
export type LocalTargetResults = Partial<Record<LocalTargetPlatform, LocalPlatformStatus>>;
export type LocalExternalApprovalGate = "VALVE_REVIEW" | "FIRST_RELEASE" | "DEFAULT_BRANCH_CONFIRMATION";

export type LocalDeliveryEvent = {
  id: string;
  type: string;
  message: string;
  at: string;
};

export type LocalValidationSnapshot = {
  schemaVersion: number;
  evidenceId: string;
  status: "TESTS_PASSED" | "WAITING_DEPENDENCY" | "FAILED";
  releaseGate: "WAITING_EXPORT_TEMPLATES" | "LOCAL_VALIDATION_PASSED" | "TESTS_FAILED";
  candidateSha: string;
  sourceDigest: string;
  bundleDigest: string;
  godotVersion: string;
  targetMatrix: readonly LocalTargetPlatform[];
  platform: "macos";
  fixtureOnly: true;
  buildArtifact: {
    fileName: "DeviLudoLocal.zip";
    platform: "macos";
    contentType: "application/zip";
    sha256: string;
    sizeBytes: number;
  } | null;
  checks: Array<{ name: string; status: "PASSED" | "FAILED" | "WAITING_DEPENDENCY"; durationMs: number; detail: string }>;
  createdAt: string;
  valid: boolean;
};

export type LocalMainValidationSnapshot = {
  schemaVersion: number;
  evidenceId: string;
  status: "TESTS_PASSED" | "WAITING_DEPENDENCY" | "FAILED";
  releaseGate: "WAITING_EXPORT_TEMPLATES" | "MAIN_VALIDATION_PASSED" | "TESTS_FAILED";
  candidateEvidenceId: string;
  candidateBundleDigest: string;
  candidateSha: string;
  sourceDigest: string;
  mainSha: string;
  mainSourceDigest: string;
  bundleDigest: string;
  godotVersion: string;
  targetMatrix: readonly LocalTargetPlatform[];
  platform: "macos";
  fixtureOnly: true;
  buildArtifact: {
    fileName: "DeviLudoMain.zip";
    platform: "macos";
    contentType: "application/zip";
    sha256: string;
    sizeBytes: number;
  } | null;
  checks: Array<{ name: string; status: "PASSED" | "FAILED" | "WAITING_DEPENDENCY"; durationMs: number; detail: string }>;
  createdAt: string;
  valid: boolean;
};

export type LocalSteamReinstallSnapshot = {
  schemaVersion: 1;
  evidenceId: string;
  bundleDigest: string;
  status: "TESTS_PASSED" | "FAILED";
  releaseGate: "LOCAL_STEAM_REINSTALL_PASSED" | "TESTS_FAILED";
  localOnly: true;
  branch: "local-password-beta";
  buildId: string;
  mainEvidenceId: string;
  mainBundleDigest: string;
  mainSha: string;
  mainSourceDigest: string;
  mainArtifactSha256: string;
  mfaApprovalId: string;
  targetMatrix: readonly ["macos"];
  platform: "macos";
  checks: Array<{
    name: "beta-package-integrity" | "clean-reinstall-boot";
    status: "PASSED" | "FAILED";
    durationMs: number;
    detail: string;
  }>;
  betaArtifact: {
    fileName: "DeviLudoLocalBeta.zip";
    platform: "macos";
    contentType: "application/zip";
    sha256: string;
    sizeBytes: number;
  } | null;
  createdAt: string;
  valid: boolean;
};

export type LocalExternalApprovalEvidenceSnapshot = {
  schemaVersion: 1;
  phase: "LOCAL_EXTERNAL_APPROVAL";
  localOnly: true;
  evidenceId: string;
  bundleDigest: string;
  projectId: string;
  runId: string;
  specRevisionId: string;
  targetMatrix: readonly ["macos"];
  mainSha: string;
  steamBuildId: string;
  steamReinstallEvidenceId: string;
  steamReinstallBundleDigest: string;
  gate: LocalExternalApprovalGate;
  sequence: 1 | 2 | 3;
  previousApprovalEvidenceId: string | null;
  approvalId: string;
  observedState: "LOCAL_VALVE_REVIEW_CONFIRMED" | "LOCAL_FIRST_RELEASE_CONFIRMED" | "LOCAL_DEFAULT_BRANCH_CONFIRMED";
  status: "APPROVED";
  checks: readonly [{ name: "authority-binding"; status: "PASSED"; durationMs: number; detail: string }];
  createdAt: string;
  valid: boolean;
};

export type LocalAgentExecutionSnapshot = LocalAgentExecutionReceipt & { readonly valid: boolean };

export type LocalAgentVersionAttestation = {
  validationReceiptId: string;
  validationReceiptDigest: string;
  supplyChainEvidenceDigest: string;
  validatedAdapterVersion: string;
  adapterCompatibility: Readonly<{ min: string; maxExclusive: string }>;
};

export type LocalLockedAgentProfile = {
  agent: "claude-code" | "codex-cli";
  profileRevisionId: string;
  configurationSource: `project:${string}` | `tenant:${string}` | "platform";
  installationId: string;
  imageDigest: `sha256:${string}`;
  exactAgentVersion: string;
  adapterVersion: string;
  /** Null only when rendering a localhost snapshot created before this proof was locked. */
  agentVersionAttestation: LocalAgentVersionAttestation | null;
  providerRevisionId: string;
  providerProtocol: "anthropic-messages" | "openai-responses";
  credentialVersionId: string;
  model: string;
  modelRoles: {
    primaryModel: string;
    planningModel: string;
    smallFastModel: string;
    subagentModel: string;
  };
  testPlanRevisionId: string;
  budget: {
    maxTurns: number;
    maxCostUsd: number;
    maxInputTokens: number;
    maxOutputTokens: number;
  };
  timeoutSeconds: number;
};

export type LocalPostMergeFailure = {
  readonly reason: "MAIN_GATE_FAILURE" | "STEAM_INSTALL_FAILURE";
  readonly attempt: 1;
  readonly evidenceId: string;
  readonly repairPromptId: string;
  readonly baselineMainSha: string;
  readonly previousRunId: string;
  readonly revokedAuthorities: readonly (
    | "MAIN_SHA"
    | "MFA"
    | "STEAM_BUILD"
    | "STEAM_RELEASE"
    | "EXTERNAL_APPROVALS"
  )[];
};

export type LocalDeliverySnapshot = {
  projectId: string;
  revision: number;
  specRevisionId: string;
  runId: string | null;
  stage: LocalDeliveryStage;
  resumeStage: LocalDeliveryStage | null;
  lockedProfile: LocalLockedAgentProfile;
  candidatePr: number | null;
  candidateSha: string | null;
  mainSha: string | null;
  evidenceValid: boolean;
  targetMatrix: readonly LocalTargetPlatform[];
  targetResults: LocalTargetResults;
  steamBranch: "local-password-beta" | null;
  mfaApprovalId: string | null;
  steamBuildId: string | null;
  steamReleaseId: string | null;
  externalGate: LocalExternalApprovalGate | null;
  externalApprovals: readonly string[];
  externalApprovalEvidence: readonly LocalExternalApprovalEvidenceSnapshot[];
  repairHandoff: LocalPostMergeFailure | null;
  agentExecution: LocalAgentExecutionSnapshot | null;
  localValidation: LocalValidationSnapshot | null;
  mainValidation: LocalMainValidationSnapshot | null;
  steamReinstall: LocalSteamReinstallSnapshot | null;
  events: LocalDeliveryEvent[];
  updatedAt: string;
};

export type LocalDeliveryAction =
  | "advance"
  | "provider-fail"
  | "provider-resume"
  | "accept"
  | "confirm-mfa"
  | "main-gate-fail"
  | "steam-reinstall-fail"
  | "cancel"
  | "reset";

export class LocalDeliveryGateError extends Error {
  constructor(readonly code: "LOCAL_EXPORT_TEMPLATES_REQUIRED" | "LOCAL_VALIDATION_FAILED" | "LOCAL_VALIDATION_INVALIDATED" | "LOCAL_MAIN_GATE_REQUIRED" | "LOCAL_STEAM_REINSTALL_REQUIRED", message: string) {
    super(message);
  }
}

const profile = {
  agent: "claude-code" as const,
  profileRevisionId: "profile-claude-platform-r5" as const,
  configurationSource: "platform" as const,
  installationId: "claude-installation-214" as const,
  imageDigest: `sha256:${"a".repeat(64)}` as const,
  exactAgentVersion: "2.1.14" as const,
  adapterVersion: "1.3.0" as const,
  agentVersionAttestation: {
    validationReceiptId: "local-validation-claude-code-2.1.14",
    validationReceiptDigest: `sha256:${"b".repeat(64)}`,
    supplyChainEvidenceDigest: `sha256:${"c".repeat(64)}`,
    validatedAdapterVersion: "1.3.0",
    adapterCompatibility: { min: "1.3.0", maxExclusive: "1.3.1" },
  },
  providerRevisionId: "provider-platform-claude-r1" as const,
  providerProtocol: "anthropic-messages" as const,
  credentialVersionId: "credential-platform-claude-v1" as const,
  model: "claude-sonnet-4-6-20250514" as const,
  modelRoles: {
    primaryModel: "claude-sonnet-4-6-20250514" as const,
    planningModel: "claude-sonnet-4-6-20250514" as const,
    smallFastModel: "claude-sonnet-4-6-20250514" as const,
    subagentModel: "claude-sonnet-4-6-20250514" as const,
  },
  testPlanRevisionId: "godot-testkit-1.0.0" as const,
  budget: {
    maxTurns: 64 as const,
    maxCostUsd: 25 as const,
    maxInputTokens: 200000 as const,
    maxOutputTokens: 50000 as const,
  },
  timeoutSeconds: 7200 as const,
} satisfies LocalLockedAgentProfile;

const DEFAULT_TARGET_MATRIX = Object.freeze(["linux", "windows", "macos"] as const);
const TARGET_PLATFORM_ORDER = Object.freeze(["linux", "windows", "macos"] as const);
const EXTERNAL_APPROVAL_GATES = Object.freeze(["VALVE_REVIEW", "FIRST_RELEASE", "DEFAULT_BRANCH_CONFIRMATION"] as const);
const EXTERNAL_APPROVAL_STATES = Object.freeze([
  "LOCAL_VALVE_REVIEW_CONFIRMED",
  "LOCAL_FIRST_RELEASE_CONFIRMED",
  "LOCAL_DEFAULT_BRANCH_CONFIRMED",
] as const);

/** Add newly locked fields when reading an older localhost JSON snapshot. */
export function normalizeLocalDeliverySnapshot(snapshot: LocalDeliverySnapshot): LocalDeliverySnapshot {
  const lockedProfile: LocalLockedAgentProfile = {
    ...profile,
    ...snapshot.lockedProfile,
    // Never infer a supply-chain proof for a snapshot that predates it.
    agentVersionAttestation: snapshot.lockedProfile?.agentVersionAttestation ?? null,
    modelRoles: { ...profile.modelRoles, ...snapshot.lockedProfile?.modelRoles },
    budget: { ...profile.budget, ...snapshot.lockedProfile?.budget },
  };
  const historicalExecution = snapshot.agentExecution as (LocalAgentExecutionSnapshot & {
    modelRoles?: LocalLockedAgentProfile["modelRoles"];
  }) | null | undefined;
  const agentExecution = historicalExecution
    ? {
      ...historicalExecution,
      // Old localhost evidence did not bind every model role. Keep it readable,
      // but fail it closed so it can never satisfy a current delivery gate.
      modelRoles: historicalExecution.modelRoles ?? lockedProfile.modelRoles,
      valid: historicalExecution.modelRoles ? historicalExecution.valid : false,
    }
    : null;
  const targetMatrix = normalizeTargetMatrix(snapshot.targetMatrix ?? Object.keys(snapshot.targetResults ?? {}));
  const targetResults = normalizeTargetResults(snapshot.targetResults, targetMatrix);
  const historicalValidation = snapshot.localValidation as (LocalValidationSnapshot & {
    schemaVersion?: number;
    targetMatrix?: readonly LocalTargetPlatform[];
    platform?: "macos";
    fixtureOnly?: true;
    buildArtifact?: LocalValidationSnapshot["buildArtifact"];
  }) | null | undefined;
  const validationMatrix = historicalValidation?.targetMatrix
    ? normalizeTargetMatrix(historicalValidation.targetMatrix)
    : null;
  const localValidation = historicalValidation
    ? {
      ...historicalValidation,
      schemaVersion: historicalValidation.schemaVersion ?? 0,
      targetMatrix: validationMatrix ?? targetMatrix,
      platform: historicalValidation.platform ?? "macos" as const,
      fixtureOnly: historicalValidation.fixtureOnly ?? true as const,
      buildArtifact: historicalValidation.buildArtifact ?? null,
      // Evidence created before target-matrix binding remains readable but can
      // never satisfy a current selected-platform gate.
      valid: historicalValidation.schemaVersion === 4
        && validationMatrix !== null
        && sameTargetMatrix(validationMatrix, targetMatrix)
        && historicalValidation.platform === "macos"
        && historicalValidation.fixtureOnly === true
        && (historicalValidation.releaseGate === "LOCAL_VALIDATION_PASSED"
          ? validLocalBuildArtifact(historicalValidation.buildArtifact) && hasPassedExportBoot(historicalValidation.checks)
          : historicalValidation.buildArtifact == null)
        && historicalValidation.valid,
      status: historicalValidation.releaseGate === "WAITING_EXPORT_TEMPLATES"
        ? "WAITING_DEPENDENCY" as const
        : historicalValidation.status,
    }
    : null;
  const historicalMainValidation = snapshot.mainValidation as (LocalMainValidationSnapshot & {
    schemaVersion?: number;
    buildArtifact?: LocalMainValidationSnapshot["buildArtifact"];
  }) | null | undefined;
  const mainValidation = historicalMainValidation
    ? {
      ...historicalMainValidation,
      schemaVersion: historicalMainValidation.schemaVersion ?? 0,
      buildArtifact: historicalMainValidation.buildArtifact ?? null,
      valid: historicalMainValidation.schemaVersion === 1
        && historicalMainValidation.releaseGate === "MAIN_VALIDATION_PASSED"
        && historicalMainValidation.status === "TESTS_PASSED"
        && historicalMainValidation.candidateEvidenceId === localValidation?.evidenceId
        && historicalMainValidation.candidateBundleDigest === localValidation?.bundleDigest
        && historicalMainValidation.candidateSha === localValidation?.candidateSha
        && historicalMainValidation.sourceDigest === localValidation?.sourceDigest
        && historicalMainValidation.mainSha === historicalMainValidation.candidateSha
        && historicalMainValidation.mainSourceDigest === historicalMainValidation.sourceDigest
        && historicalMainValidation.platform === "macos"
        && historicalMainValidation.fixtureOnly === true
        && sameTargetMatrix(historicalMainValidation.targetMatrix, targetMatrix)
        && validLocalMainBuildArtifact(historicalMainValidation.buildArtifact)
        && hasPassedExportBoot(historicalMainValidation.checks)
        && historicalMainValidation.valid,
    }
    : null;
  const historicalSteamReinstall = snapshot.steamReinstall as (LocalSteamReinstallSnapshot & {
    schemaVersion?: number;
  }) | null | undefined;
  const steamReinstall = historicalSteamReinstall
    ? {
      ...historicalSteamReinstall,
      schemaVersion: historicalSteamReinstall.schemaVersion ?? 0,
      valid: historicalSteamReinstall.schemaVersion === 1
        && historicalSteamReinstall.status === "TESTS_PASSED"
        && historicalSteamReinstall.releaseGate === "LOCAL_STEAM_REINSTALL_PASSED"
        && historicalSteamReinstall.localOnly === true
        && historicalSteamReinstall.branch === "local-password-beta"
        && historicalSteamReinstall.mainEvidenceId === mainValidation?.evidenceId
        && historicalSteamReinstall.mainBundleDigest === mainValidation?.bundleDigest
        && historicalSteamReinstall.mainSha === mainValidation?.mainSha
        && historicalSteamReinstall.mainSourceDigest === mainValidation?.mainSourceDigest
        && historicalSteamReinstall.mainArtifactSha256 === mainValidation?.buildArtifact?.sha256
        && historicalSteamReinstall.mfaApprovalId === snapshot.mfaApprovalId
        && historicalSteamReinstall.platform === "macos"
        && sameTargetMatrix(historicalSteamReinstall.targetMatrix, ["macos"])
        && validLocalBetaArtifact(historicalSteamReinstall.betaArtifact)
        && hasPassedSteamReinstallBoot(historicalSteamReinstall.checks)
        && historicalSteamReinstall.valid,
    }
    : null;
  const stalePassedBuildEvidence = historicalValidation?.valid === true
    && historicalValidation.releaseGate === "LOCAL_VALIDATION_PASSED"
    && localValidation?.valid === false;
  const rewindForBuildEvidence = stalePassedBuildEvidence
    && !["AWAITING_SPEC_APPROVAL", "AGENT_QUEUED", "AGENT_RUNNING", "CANCELLED", "RELEASED"].includes(snapshot.stage);
  const rewindForMainEvidence = !rewindForBuildEvidence
    && localValidation?.valid === true
    && targetMatrix.length === 1
    && targetMatrix[0] === "macos"
    && snapshot.mainSha !== null
    && (mainValidation === null
      || (mainValidation.releaseGate === "MAIN_VALIDATION_PASSED" && mainValidation.valid !== true))
    && !["AWAITING_SPEC_APPROVAL", "AGENT_QUEUED", "AGENT_RUNNING", "CANDIDATE_READY", "E2E_RUNNING", "AWAITING_ACCEPTANCE", "MERGING", "CANCELLED"].includes(snapshot.stage);
  const rewindReleaseAuthority = rewindForBuildEvidence || rewindForMainEvidence;
  const rewindForSteamEvidence = !rewindReleaseAuthority
    && ["EXTERNAL_APPROVAL_REQUIRED", "RELEASED"].includes(snapshot.stage)
    && steamReinstall?.valid !== true;
  const historicalApprovalEvidence = snapshot.externalApprovalEvidence ?? [];
  const normalizedApprovalEvidence: LocalExternalApprovalEvidenceSnapshot[] = [];
  let previousApprovalEvidenceId: string | null = null;
  for (let index = 0; index < Math.min(historicalApprovalEvidence.length, 3); index += 1) {
    const historical = historicalApprovalEvidence[index]!;
    const valid = !rewindReleaseAuthority && !rewindForSteamEvidence
      && historical.valid === true
      && historical.schemaVersion === 1
      && historical.phase === "LOCAL_EXTERNAL_APPROVAL"
      && historical.localOnly === true
      && historical.projectId === snapshot.projectId
      && historical.runId === snapshot.runId
      && historical.specRevisionId === snapshot.specRevisionId
      && sameTargetMatrix(historical.targetMatrix, ["macos"])
      && historical.mainSha === snapshot.mainSha
      && historical.steamBuildId === snapshot.steamBuildId
      && historical.steamReinstallEvidenceId === steamReinstall?.evidenceId
      && historical.steamReinstallBundleDigest === steamReinstall?.bundleDigest
      && historical.gate === EXTERNAL_APPROVAL_GATES[index]
      && historical.sequence === index + 1
      && historical.previousApprovalEvidenceId === previousApprovalEvidenceId
      && historical.approvalId === snapshot.externalApprovals?.[index]
      && historical.observedState === EXTERNAL_APPROVAL_STATES[index]
      && historical.status === "APPROVED"
      && /^EV-APPROVAL-[A-F0-9]{12}$/.test(historical.evidenceId)
      && /^[a-f0-9]{64}$/.test(historical.bundleDigest)
      && /^APPROVAL-LOCAL-[A-F0-9]{12}$/.test(historical.approvalId)
      && historical.checks.length === 1
      && historical.checks[0]?.name === "authority-binding"
      && historical.checks[0]?.status === "PASSED";
    normalizedApprovalEvidence.push({ ...historical, valid });
    if (!valid) break;
    previousApprovalEvidenceId = historical.evidenceId;
  }
  const validApprovalEvidence = normalizedApprovalEvidence.filter((evidence) => evidence.valid);
  const inExternalReleaseStages = ["EXTERNAL_APPROVAL_REQUIRED", "RELEASED"].includes(snapshot.stage);
  const derivedExternalStage: LocalDeliveryStage = validApprovalEvidence.length === 3 ? "RELEASED" : "EXTERNAL_APPROVAL_REQUIRED";
  const derivedExternalGate = EXTERNAL_APPROVAL_GATES[validApprovalEvidence.length] ?? null;

  return {
    ...snapshot,
    targetMatrix,
    targetResults: rewindForBuildEvidence ? createTargetResults(targetMatrix, "QUEUED") : targetResults,
    stage: rewindForBuildEvidence ? "CANDIDATE_READY"
      : rewindForMainEvidence ? "MERGING"
        : rewindForSteamEvidence ? "STEAM_BETA_UPLOADING"
          : inExternalReleaseStages ? derivedExternalStage : snapshot.stage,
    evidenceValid: rewindForBuildEvidence ? false : snapshot.evidenceValid,
    mainSha: rewindReleaseAuthority ? null : snapshot.mainSha,
    steamBranch: rewindReleaseAuthority ? null : snapshot.steamBranch,
    agentExecution,
    repairHandoff: snapshot.repairHandoff ?? null,
    mfaApprovalId: rewindReleaseAuthority ? null : snapshot.mfaApprovalId ?? null,
    steamBuildId: rewindReleaseAuthority || rewindForSteamEvidence ? null : snapshot.steamBuildId ?? null,
    steamReleaseId: rewindReleaseAuthority ? null : snapshot.steamReleaseId ?? null,
    externalApprovals: rewindReleaseAuthority || rewindForSteamEvidence ? []
      : inExternalReleaseStages ? validApprovalEvidence.map((evidence) => evidence.approvalId) : snapshot.externalApprovals ?? [],
    externalApprovalEvidence: rewindReleaseAuthority || rewindForSteamEvidence ? []
      : inExternalReleaseStages ? validApprovalEvidence : normalizedApprovalEvidence,
    externalGate: rewindReleaseAuthority || rewindForSteamEvidence ? null
      : inExternalReleaseStages ? derivedExternalGate : snapshot.externalGate ?? null,
    localValidation,
    mainValidation: rewindForBuildEvidence ? null : mainValidation,
    steamReinstall: rewindReleaseAuthority ? null : steamReinstall,
    lockedProfile,
  };
}

function now() {
  return new Date().toISOString();
}

function event(snapshot: LocalDeliverySnapshot, type: string, message: string): LocalDeliverySnapshot {
  const at = now();
  return {
    ...snapshot,
    revision: snapshot.revision + 1,
    updatedAt: at,
    events: [
      { id: `LOCAL-EVT-${String(snapshot.revision + 1).padStart(4, "0")}`, type, message, at },
      ...snapshot.events,
    ].slice(0, 40),
  };
}

export function createLocalDelivery(projectId: string, specRevisionId = "SPEC-001"): LocalDeliverySnapshot {
  const at = now();
  return {
    projectId,
    revision: 1,
    specRevisionId,
    runId: null,
    stage: "AWAITING_SPEC_APPROVAL",
    resumeStage: null,
    lockedProfile: profile,
    candidatePr: null,
    candidateSha: null,
    mainSha: null,
    evidenceValid: false,
    targetMatrix: DEFAULT_TARGET_MATRIX,
    targetResults: createTargetResults(DEFAULT_TARGET_MATRIX, "QUEUED"),
    steamBranch: null,
    mfaApprovalId: null,
    steamBuildId: null,
    steamReleaseId: null,
    externalGate: null,
    externalApprovals: [],
    externalApprovalEvidence: [],
    repairHandoff: null,
    agentExecution: null,
    localValidation: null,
    mainValidation: null,
    steamReinstall: null,
    events: [{ id: "LOCAL-EVT-0001", type: "PROJECT_CREATED", message: "本地项目已创建，等待批准规格。", at }],
    updatedAt: at,
  };
}

export function approveLocalSpec(
  current: LocalDeliverySnapshot,
  specRevisionId: string,
  runId: string,
  lockedProfile: LocalLockedAgentProfile = current.lockedProfile,
  targetMatrix: readonly LocalTargetPlatform[] = DEFAULT_TARGET_MATRIX,
): LocalDeliverySnapshot {
  const lockedTargetMatrix = normalizeTargetMatrix(targetMatrix);
  const started = event(
    {
      ...current,
      specRevisionId,
      runId,
      lockedProfile: cloneLockedProfile(lockedProfile),
      stage: "AGENT_QUEUED",
      resumeStage: null,
      candidatePr: null,
      candidateSha: null,
      mainSha: null,
      evidenceValid: false,
      targetMatrix: lockedTargetMatrix,
      targetResults: createTargetResults(lockedTargetMatrix, "QUEUED"),
      steamBranch: null,
      mfaApprovalId: null,
      steamBuildId: null,
      steamReleaseId: null,
      externalGate: null,
      externalApprovals: [],
      externalApprovalEvidence: [],
      repairHandoff: null,
      agentExecution: null,
      localValidation: null,
      mainValidation: null,
      steamReinstall: null,
    },
    "SPEC_APPROVED",
    `${specRevisionId} 已冻结；${agentLabel(lockedProfile.agent)} Profile、配置来源与 ${lockedTargetMatrix.join(" / ")} 目标矩阵已锁定。`,
  );
  return started;
}

function cloneLockedProfile(value: LocalLockedAgentProfile): LocalLockedAgentProfile {
  return {
    ...value,
    agentVersionAttestation: value.agentVersionAttestation ? {
      ...value.agentVersionAttestation,
      adapterCompatibility: { ...value.agentVersionAttestation.adapterCompatibility },
    } : null,
    modelRoles: { ...value.modelRoles },
    budget: { ...value.budget },
  };
}

function agentLabel(agent: LocalLockedAgentProfile["agent"]): string {
  return agent === "claude-code" ? "Claude Code" : "Codex CLI";
}

export function invalidateLocalDelivery(
  current: LocalDeliverySnapshot,
  nextSpecRevisionId: string,
): LocalDeliverySnapshot {
  if (!canCreateLocalFeedback(current)) {
    throw new Error("只有等待用户验收的候选版本或失败后的人工修复接管可以创建反馈修订");
  }
  return event(
    {
      ...current,
      specRevisionId: nextSpecRevisionId,
      stage: "AWAITING_SPEC_APPROVAL",
      resumeStage: null,
      runId: null,
      candidatePr: null,
      candidateSha: null,
      mainSha: null,
      evidenceValid: false,
      targetResults: createTargetResults(current.targetMatrix, "INVALIDATED"),
      steamBranch: null,
      mfaApprovalId: null,
      steamBuildId: null,
      steamReleaseId: null,
      externalGate: null,
      externalApprovals: [],
      externalApprovalEvidence: current.externalApprovalEvidence.map((evidence) => ({ ...evidence, valid: false })),
      repairHandoff: null,
      localValidation: current.localValidation ? { ...current.localValidation, valid: false } : null,
      mainValidation: current.mainValidation ? { ...current.mainValidation, valid: false } : null,
      steamReinstall: current.steamReinstall ? { ...current.steamReinstall, valid: false } : null,
      agentExecution: current.agentExecution ? { ...current.agentExecution, valid: false } : null,
    },
    "FEEDBACK_CREATED",
    "用户反馈已创建新规格修订，旧候选证据立即失效。",
  );
}

export function canCreateLocalFeedback(current: LocalDeliverySnapshot): boolean {
  return current.stage === "AWAITING_ACCEPTANCE"
    || (current.stage === "AWAITING_SPEC_APPROVAL" && current.repairHandoff !== null);
}

export function recordLocalAgentExecution(
  current: LocalDeliverySnapshot,
  receipt: LocalAgentExecutionReceipt,
): LocalDeliverySnapshot {
  if (!current.runId || !["AGENT_QUEUED", "AGENT_RUNNING"].includes(current.stage)) {
    throw new Error("当前交付阶段不能接收 Agent 运行回执");
  }
  const locked = current.lockedProfile;
  if (!isLocalAgentProfileAttested(locked)
    || receipt.tenantId !== "tenant-local"
    || receipt.projectId !== current.projectId
    || receipt.runId !== current.runId
    || receipt.specRevisionId !== current.specRevisionId
    || receipt.testPlanRevisionId !== locked.testPlanRevisionId
    || receipt.profileRevisionId !== locked.profileRevisionId
    || receipt.installationId !== locked.installationId
    || receipt.imageDigest !== locked.imageDigest
    || receipt.adapterVersion !== locked.adapterVersion
    || receipt.providerRevisionId !== locked.providerRevisionId
    || receipt.credentialVersionId !== locked.credentialVersionId
    || receipt.model !== locked.model
    || !sameModelRoles(receipt.modelRoles, locked.modelRoles)
    || receipt.agent !== locked.agent) {
    throw new Error("Agent 运行回执与不可变任务锁不一致");
  }
  if (receipt.timeoutSeconds !== locked.timeoutSeconds
    || receipt.budget.maxTurns !== locked.budget.maxTurns
    || receipt.budget.maxCostUsd !== locked.budget.maxCostUsd
    || receipt.budget.maxInputTokens !== locked.budget.maxInputTokens
    || receipt.budget.maxOutputTokens !== locked.budget.maxOutputTokens) {
    throw new Error("Agent 运行回执预算与不可变任务锁不一致");
  }
  return event(
    {
      ...current,
      stage: "CANDIDATE_READY",
      candidatePr: receipt.candidate.draftPullRequest,
      candidateSha: receipt.candidate.commitSha,
      evidenceValid: false,
      agentExecution: { ...receipt, valid: true },
      localValidation: null,
      mainValidation: null,
      steamReinstall: null,
      targetResults: createTargetResults(current.targetMatrix, "QUEUED"),
    },
    "AGENT_CANDIDATE_RECORDED",
    `${receipt.agent} 已完成；SCM 代理冻结候选提交 ${receipt.candidate.commitSha.slice(0, 7)}，等待 E2E。`,
  );
}

export function isLocalAgentProfileAttested(locked: LocalLockedAgentProfile): boolean {
  const attestation = locked.agentVersionAttestation;
  return !!attestation
    && SAFE_ATTESTATION_ID.test(attestation.validationReceiptId)
    && SHA256_DIGEST.test(attestation.validationReceiptDigest)
    && SHA256_DIGEST.test(attestation.supplyChainEvidenceDigest)
    && isBuiltInAdapterVersion(locked.agent, locked.adapterVersion)
    && isAdapterVersionAttested(
      locked.adapterVersion,
      attestation.validatedAdapterVersion,
      attestation.adapterCompatibility,
    );
}

function sameModelRoles(
  left: LocalLockedAgentProfile["modelRoles"] | null | undefined,
  right: LocalLockedAgentProfile["modelRoles"],
): boolean {
  if (!left) return false;
  return left.primaryModel === right.primaryModel
    && left.planningModel === right.planningModel
    && left.smallFastModel === right.smallFastModel
    && left.subagentModel === right.subagentModel;
}

export function recordLocalValidation(
  current: LocalDeliverySnapshot,
  validation: Omit<LocalValidationSnapshot, "valid">,
): LocalDeliverySnapshot {
  if (!current.runId) throw new Error("本地验证缺少锁定运行");
  if (!["AGENT_QUEUED", "AGENT_RUNNING", "CANDIDATE_READY", "E2E_RUNNING", "AWAITING_ACCEPTANCE"].includes(current.stage)) {
    throw new Error("当前交付阶段不能写入本地验证证据");
  }
  const gatePassed = validation.status === "TESTS_PASSED" && validation.releaseGate === "LOCAL_VALIDATION_PASSED";
  const waitingForTemplates = validation.status === "WAITING_DEPENDENCY"
    && validation.releaseGate === "WAITING_EXPORT_TEMPLATES";
  const failed = validation.status === "FAILED" && validation.releaseGate === "TESTS_FAILED";
  if (!gatePassed && !waitingForTemplates && !failed) throw new Error("本机验证状态与发布门禁不一致");
  if (validation.schemaVersion !== 4) throw new Error("本机验证证据版本不是当前受支持的 v4");
  if (!sameTargetMatrix(validation.targetMatrix, current.targetMatrix)) {
    throw new Error("本机验证证据与锁定目标矩阵不一致");
  }
  if (validation.platform !== "macos" || validation.fixtureOnly !== true) {
    throw new Error("本机验证证据缺少真实执行平台绑定");
  }
  if (gatePassed && !validLocalBuildArtifact(validation.buildArtifact)) {
    throw new Error("本机验证通过但缺少绑定的 macOS 构建物");
  }
  if (gatePassed && !hasPassedExportBoot(validation.checks)) {
    throw new Error("本机验证通过但缺少导出交付包的启动与退出证据");
  }
  if (!gatePassed && validation.buildArtifact !== null) {
    throw new Error("未通过的本机验证不能授权构建物");
  }
  const targetResults = gatePassed
    ? current.targetResults
    : createTargetResults(current.targetMatrix, "INVALIDATED");
  return event(
    {
      ...current,
      stage: "CANDIDATE_READY",
      candidateSha: validation.candidateSha,
      evidenceValid: gatePassed ? current.evidenceValid : false,
      targetResults,
      mainValidation: null,
      steamReinstall: null,
      localValidation: {
        ...validation,
        targetMatrix: Object.freeze([...validation.targetMatrix]),
        valid: true,
      },
    },
    gatePassed ? "LOCAL_GODOT_EVIDENCE_CREATED"
      : waitingForTemplates ? "LOCAL_GODOT_DEPENDENCY_WAIT"
        : "LOCAL_GODOT_VALIDATION_FAILED",
    failed
      ? "本机 Git 候选提交已生成，但 Godot 验证失败；交付阶段保持阻塞。"
      : gatePassed
      ? "本机 Git 候选提交与 macOS Godot 测试、导出证据已生成。"
      : "本机 Git 候选提交与 macOS Godot 测试证据已生成；生产导出等待模板，目标矩阵保持阻塞。",
  );
}

export function recordLocalMainValidation(
  current: LocalDeliverySnapshot,
  validation: Omit<LocalMainValidationSnapshot, "valid">,
): LocalDeliverySnapshot {
  if (current.stage !== "MERGING" && current.stage !== "MAIN_GATE_RUNNING") {
    throw new Error("当前交付阶段不能写入 main SHA 门禁证据");
  }
  if (!current.runId || !current.localValidation?.valid
    || current.localValidation.status !== "TESTS_PASSED"
    || current.localValidation.releaseGate !== "LOCAL_VALIDATION_PASSED") {
    throw new Error("main SHA 门禁缺少已接受的候选证据");
  }
  if (current.targetMatrix.length !== 1 || current.targetMatrix[0] !== "macos") {
    throw new Error("本地主门禁只能证明 macOS-only 目标矩阵");
  }
  const passed = validation.status === "TESTS_PASSED" && validation.releaseGate === "MAIN_VALIDATION_PASSED";
  const waiting = validation.status === "WAITING_DEPENDENCY" && validation.releaseGate === "WAITING_EXPORT_TEMPLATES";
  const failed = validation.status === "FAILED" && validation.releaseGate === "TESTS_FAILED";
  if (!passed && !waiting && !failed) throw new Error("main SHA 门禁状态与证据不一致");
  if (validation.schemaVersion !== 1
    || validation.candidateEvidenceId !== current.localValidation.evidenceId
    || validation.candidateBundleDigest !== current.localValidation.bundleDigest
    || validation.candidateSha !== current.localValidation.candidateSha
    || validation.sourceDigest !== current.localValidation.sourceDigest
    || validation.mainSha !== validation.candidateSha
    || validation.mainSourceDigest !== validation.sourceDigest
    || !/^[a-f0-9]{40}$/.test(validation.mainSha)
    || !/^[a-f0-9]{64}$/.test(validation.bundleDigest)
    || validation.platform !== "macos"
    || validation.fixtureOnly !== true
    || !sameTargetMatrix(validation.targetMatrix, current.targetMatrix)) {
    throw new Error("main SHA 门禁证据与已接受候选绑定不一致");
  }
  if (passed && (!validLocalMainBuildArtifact(validation.buildArtifact) || !hasPassedExportBoot(validation.checks))) {
    throw new Error("main SHA 门禁缺少重新导出的可启动构建物");
  }
  if (!passed && validation.buildArtifact !== null) throw new Error("未通过的 main SHA 门禁不能授权构建物");
  const mainValidation: LocalMainValidationSnapshot = {
    ...validation,
    targetMatrix: Object.freeze([...validation.targetMatrix]),
    valid: true,
  };
  if (failed) {
    return handoffLocalPostMergeFailure(
      { ...current, stage: "MAIN_GATE_RUNNING", mainSha: validation.mainSha, mainValidation },
      "MAIN_GATE_FAILURE",
      validation.evidenceId,
    );
  }
  if (waiting) {
    return event({
      ...current,
      stage: "MAIN_GATE_RUNNING",
      mainSha: validation.mainSha,
      mainValidation,
    }, "MAIN_GATE_DEPENDENCY_WAIT", "候选已合并到实际 main；发布级重新导出正在等待固定模板。 ");
  }
  return event({
    ...current,
    stage: "MFA_REQUIRED",
    mainSha: validation.mainSha,
    mainValidation,
    steamReleaseId: `RELEASE-LOCAL-${String(current.revision + 1).padStart(4, "0")}`,
  }, "MAIN_GATE_PASSED", "实际 main SHA 已重新导出、启动并通过完整门禁，等待 MFA。 ");
}

export function recordLocalSteamReinstall(
  current: LocalDeliverySnapshot,
  validation: Omit<LocalSteamReinstallSnapshot, "valid">,
): LocalDeliverySnapshot {
  const main = current.mainValidation;
  if (current.stage !== "STEAM_REINSTALL_E2E") {
    throw new Error("当前交付阶段不能写入本地 Beta 回装证据");
  }
  if (!current.runId || !current.mainSha || !main?.valid
    || main.status !== "TESTS_PASSED" || main.releaseGate !== "MAIN_VALIDATION_PASSED"
    || !main.buildArtifact || !current.mfaApprovalId || current.steamBranch !== "local-password-beta") {
    throw new Error("本地 Beta 回装缺少有效 main、构建物或 MFA 权限");
  }
  const passed = validation.status === "TESTS_PASSED"
    && validation.releaseGate === "LOCAL_STEAM_REINSTALL_PASSED";
  const failed = validation.status === "FAILED" && validation.releaseGate === "TESTS_FAILED";
  if (!passed && !failed) throw new Error("本地 Beta 回装状态与证据不一致");
  if (validation.schemaVersion !== 1
    || !/^EV-STEAM-[A-F0-9]{12}$/.test(validation.evidenceId)
    || !/^[a-f0-9]{64}$/.test(validation.bundleDigest)
    || validation.localOnly !== true
    || validation.branch !== "local-password-beta"
    || !/^BUILD-LOCAL-[A-F0-9]{12}$/.test(validation.buildId)
    || validation.mainEvidenceId !== main.evidenceId
    || validation.mainBundleDigest !== main.bundleDigest
    || validation.mainSha !== current.mainSha
    || validation.mainSourceDigest !== main.mainSourceDigest
    || validation.mainArtifactSha256 !== main.buildArtifact.sha256
    || validation.mfaApprovalId !== current.mfaApprovalId
    || validation.platform !== "macos"
    || !sameTargetMatrix(validation.targetMatrix, ["macos"])
    || !Array.isArray(validation.checks)
    || validation.checks.length !== 2) {
    throw new Error("本地 Beta 回装证据与 main、构建物或 MFA 绑定不一致");
  }
  if (passed && (!validLocalBetaArtifact(validation.betaArtifact)
    || validation.betaArtifact.sha256 !== main.buildArtifact.sha256
    || !hasPassedSteamReinstallBoot(validation.checks))) {
    throw new Error("本地 Beta 回装缺少摘要一致且可启动的干净安装包");
  }
  if (failed && (validation.betaArtifact !== null
    || !validation.checks.some((check) => check.status === "FAILED"))) {
    throw new Error("失败的本地 Beta 回装不能授权安装包");
  }
  const steamReinstall: LocalSteamReinstallSnapshot = {
    ...validation,
    targetMatrix: Object.freeze(["macos"] as const),
    valid: true,
  };
  if (failed) {
    return handoffLocalPostMergeFailure(
      { ...current, steamReinstall },
      "STEAM_INSTALL_FAILURE",
      validation.evidenceId,
    );
  }
  return event({
    ...current,
    stage: "EXTERNAL_APPROVAL_REQUIRED",
    steamBuildId: validation.buildId,
    externalGate: "VALVE_REVIEW",
    externalApprovals: [],
    externalApprovalEvidence: [],
    steamReinstall,
  }, "STEAM_REINSTALL_PASSED", "本地 Beta 包已完成摘要复核、隔离回装与实际启动；未连接 Steam，继续等待外部批准演练。 ");
}

export function recordLocalExternalApproval(
  current: LocalDeliverySnapshot,
  evidence: Omit<LocalExternalApprovalEvidenceSnapshot, "valid">,
): LocalDeliverySnapshot {
  const sequence = current.externalApprovalEvidence.length + 1;
  const expectedGate = EXTERNAL_APPROVAL_GATES[sequence - 1];
  const expectedState = EXTERNAL_APPROVAL_STATES[sequence - 1];
  const previousEvidenceId = current.externalApprovalEvidence.at(-1)?.evidenceId ?? null;
  if (current.stage !== "EXTERNAL_APPROVAL_REQUIRED" || !current.externalGate || !expectedGate
    || !current.runId || !current.mainSha || !current.steamBuildId
    || current.externalGate !== expectedGate
    || !current.steamReinstall?.valid
    || current.steamReinstall.releaseGate !== "LOCAL_STEAM_REINSTALL_PASSED"
    || current.steamBuildId !== current.steamReinstall.buildId) {
    throw new Error("当前没有可由权威回执确认的外部发布门禁");
  }
  if (evidence.schemaVersion !== 1 || evidence.phase !== "LOCAL_EXTERNAL_APPROVAL" || evidence.localOnly !== true
    || evidence.projectId !== current.projectId || evidence.runId !== current.runId
    || evidence.specRevisionId !== current.specRevisionId || !sameTargetMatrix(evidence.targetMatrix, ["macos"])
    || evidence.mainSha !== current.mainSha || evidence.steamBuildId !== current.steamBuildId
    || evidence.steamReinstallEvidenceId !== current.steamReinstall.evidenceId
    || evidence.steamReinstallBundleDigest !== current.steamReinstall.bundleDigest
    || evidence.gate !== expectedGate || evidence.sequence !== sequence
    || evidence.previousApprovalEvidenceId !== previousEvidenceId
    || evidence.observedState !== expectedState || evidence.status !== "APPROVED"
    || !/^EV-APPROVAL-[A-F0-9]{12}$/.test(evidence.evidenceId)
    || !/^[a-f0-9]{64}$/.test(evidence.bundleDigest)
    || !/^APPROVAL-LOCAL-[A-F0-9]{12}$/.test(evidence.approvalId)
    || evidence.checks.length !== 1 || evidence.checks[0]?.name !== "authority-binding"
    || evidence.checks[0]?.status !== "PASSED") {
    throw new Error("本地外部批准回执与 main、BuildID、回装证据或前序回执不一致");
  }
  const nextGate: LocalExternalApprovalGate | null = sequence === 1
    ? "FIRST_RELEASE"
    : sequence === 2 ? "DEFAULT_BRANCH_CONFIRMATION" : null;
  const snapshotEvidence: LocalExternalApprovalEvidenceSnapshot = {
    ...evidence,
    targetMatrix: Object.freeze(["macos"] as const),
    valid: true,
  };
  return event({
    ...current,
    stage: nextGate ? "EXTERNAL_APPROVAL_REQUIRED" : "RELEASED",
    externalGate: nextGate,
    externalApprovals: [...current.externalApprovals, evidence.approvalId],
    externalApprovalEvidence: [...current.externalApprovalEvidence, snapshotEvidence],
  }, `${expectedGate}_APPROVED`, nextGate
    ? `本地权威回执已确认 ${expectedGate}；继续等待 ${nextGate}。`
    : "三道本地外部批准回执已形成完整证据链；未调用真实 Steam 发布接口。");
}

function validLocalBuildArtifact(value: LocalValidationSnapshot["buildArtifact"] | undefined): value is NonNullable<LocalValidationSnapshot["buildArtifact"]> {
  return !!value
    && value.fileName === "DeviLudoLocal.zip"
    && value.platform === "macos"
    && value.contentType === "application/zip"
    && /^[a-f0-9]{64}$/.test(value.sha256)
    && Number.isSafeInteger(value.sizeBytes)
    && value.sizeBytes > 0
    && value.sizeBytes <= 512 * 1024 * 1024;
}

function validLocalMainBuildArtifact(value: LocalMainValidationSnapshot["buildArtifact"] | undefined): value is NonNullable<LocalMainValidationSnapshot["buildArtifact"]> {
  return !!value
    && value.fileName === "DeviLudoMain.zip"
    && value.platform === "macos"
    && value.contentType === "application/zip"
    && /^[a-f0-9]{64}$/.test(value.sha256)
    && Number.isSafeInteger(value.sizeBytes)
    && value.sizeBytes > 0
    && value.sizeBytes <= 512 * 1024 * 1024;
}

function validLocalBetaArtifact(value: LocalSteamReinstallSnapshot["betaArtifact"] | undefined): value is NonNullable<LocalSteamReinstallSnapshot["betaArtifact"]> {
  return !!value
    && value.fileName === "DeviLudoLocalBeta.zip"
    && value.platform === "macos"
    && value.contentType === "application/zip"
    && /^[a-f0-9]{64}$/.test(value.sha256)
    && Number.isSafeInteger(value.sizeBytes)
    && value.sizeBytes > 0
    && value.sizeBytes <= 512 * 1024 * 1024;
}

function hasPassedExportBoot(checks: LocalValidationSnapshot["checks"]): boolean {
  return checks.some((check) => check.name === "macos-export-boot" && check.status === "PASSED");
}

function hasPassedSteamReinstallBoot(checks: LocalSteamReinstallSnapshot["checks"]): boolean {
  return checks.some((check) => check.name === "beta-package-integrity" && check.status === "PASSED")
    && checks.some((check) => check.name === "clean-reinstall-boot" && check.status === "PASSED");
}

export function applyLocalDeliveryAction(
  current: LocalDeliverySnapshot,
  action: LocalDeliveryAction,
): LocalDeliverySnapshot {
  if (action === "reset") {
    const fresh = createLocalDelivery(current.projectId, current.specRevisionId);
    return event(
      { ...fresh, revision: current.revision, events: current.events },
      "DELIVERY_RESET",
      "本地交付运行已重置；历史事件和证据文件保留用于审计。",
    );
  }

  if (action === "cancel") {
    if (current.stage === "RELEASED" || current.stage === "CANCELLED") {
      throw new Error("当前交付已越过可取消边界");
    }
    return event(
      {
        ...current,
        stage: "CANCELLED",
        resumeStage: null,
        evidenceValid: false,
        targetResults: createTargetResults(current.targetMatrix, "INVALIDATED"),
        steamBranch: null,
        mfaApprovalId: null,
        steamBuildId: null,
        steamReleaseId: null,
        externalGate: null,
        externalApprovals: [],
        externalApprovalEvidence: current.externalApprovalEvidence.map((evidence) => ({ ...evidence, valid: false })),
        localValidation: current.localValidation ? { ...current.localValidation, valid: false } : null,
        mainValidation: current.mainValidation ? { ...current.mainValidation, valid: false } : null,
        steamReinstall: current.steamReinstall ? { ...current.steamReinstall, valid: false } : null,
        agentExecution: current.agentExecution ? { ...current.agentExecution, valid: false } : null,
      },
      "DELIVERY_CANCELLED",
      "项目所有者已取消交付；本地 Agent、Runner、证据与 Steam 权限均视为撤销。",
    );
  }

  if (action === "provider-fail") {
    if (!['AGENT_QUEUED', 'AGENT_RUNNING'].includes(current.stage)) {
      throw new Error("Provider 只能在 Agent 排队或运行期间进入等待状态");
    }
    return event(
      { ...current, resumeStage: current.stage, stage: "WAITING_PROVIDER" },
      "PROVIDER_UNAVAILABLE",
      "Provider 探针失败；任务保持原 Profile 锁并暂停，没有切换 Agent。",
    );
  }

  if (action === "provider-resume") {
    if (current.stage !== "WAITING_PROVIDER" || !current.resumeStage) {
      throw new Error("当前任务不在 WAITING_PROVIDER");
    }
    return event(
      { ...current, stage: current.resumeStage, resumeStage: null },
      "PROVIDER_RESUMED",
      "Provider 已恢复，任务继续使用原有锁定配置。",
    );
  }

  if (action === "accept") {
    if (current.stage !== "AWAITING_ACCEPTANCE"
      || current.evidenceValid !== true
      || !Number.isSafeInteger(current.candidatePr) || (current.candidatePr ?? 0) < 1
      || !current.candidateSha
      || current.targetMatrix.some((platform) => current.targetResults[platform] !== "PASSED")) {
      throw new Error("当前候选版本缺少可验收的提交、PR 或完整目标矩阵证据");
    }
    return event({ ...current, stage: "MERGING" }, "CANDIDATE_ACCEPTED", "用户已接受候选版本，开始合并 Draft PR。 ");
  }

  if (action === "confirm-mfa") {
    if (current.stage !== "MFA_REQUIRED") throw new Error("当前不需要 MFA 确认");
    return event(
      {
        ...current,
        stage: "STEAM_BETA_UPLOADING",
        steamBranch: "local-password-beta",
        mfaApprovalId: `MFA-LOCAL-${String(current.revision + 1).padStart(4, "0")}`,
      },
      "MFA_CONFIRMED",
      "本地测试 MFA 已确认；开始生成绑定 main SHA 的本地密码保护 Beta 演练包。",
    );
  }

  if (action === "main-gate-fail") {
    return handoffLocalPostMergeFailure(current, "MAIN_GATE_FAILURE");
  }

  if (action === "steam-reinstall-fail") {
    return handoffLocalPostMergeFailure(current, "STEAM_INSTALL_FAILURE");
  }

  if (action !== "advance") throw new Error("不支持的本地交付动作");

  switch (current.stage) {
    case "AGENT_QUEUED":
      return event({ ...current, stage: "AGENT_RUNNING" }, "AGENT_STARTED", "隔离 Worker 已领取锁定任务。 ");
    case "AGENT_RUNNING":
      return event(
        { ...current, stage: "CANDIDATE_READY", candidatePr: 18, candidateSha: "8b7e4a2" },
        "CANDIDATE_READY",
        "Fixture Executor 产出候选提交与 Draft PR；未调用真实第三方 Agent。",
      );
    case "CANDIDATE_READY":
      if (current.localValidation?.valid
        && (current.localValidation.status !== "TESTS_PASSED"
          || current.localValidation.releaseGate !== "LOCAL_VALIDATION_PASSED")) {
        if (current.localValidation.releaseGate === "WAITING_EXPORT_TEMPLATES") {
          throw new LocalDeliveryGateError("LOCAL_EXPORT_TEMPLATES_REQUIRED", "Godot 导出模板尚未安装，不能启动目标矩阵 E2E");
        }
        if (current.localValidation.status === "FAILED") {
          throw new LocalDeliveryGateError("LOCAL_VALIDATION_FAILED", "本机 Godot 验证失败，修复后才能启动目标矩阵 E2E");
        }
        throw new LocalDeliveryGateError("LOCAL_VALIDATION_INVALIDATED", "本机验证证据已失效，不能启动目标矩阵 E2E");
      }
      return event(
        {
          ...current,
          stage: "E2E_RUNNING",
          targetResults: startTargetMatrix(current.targetMatrix),
        },
        "E2E_STARTED",
        "已冻结同一提交、规格与 TestKit，开始目标矩阵测试。",
      );
    case "E2E_RUNNING": {
      const targets = { ...current.targetResults };
      let message = "";
      let stage: LocalDeliveryStage = current.stage;
      const runningIndex = current.targetMatrix.findIndex((platform) => targets[platform] === "RUNNING");
      if (runningIndex < 0) throw new Error("E2E 状态缺少正在运行的平台");
      const completed = current.targetMatrix[runningIndex]!;
      targets[completed] = "PASSED";
      const next = current.targetMatrix[runningIndex + 1];
      if (next) {
        targets[next] = "RUNNING";
        message = `${platformLabel(completed)} 证据通过；${platformLabel(next)} Runner 开始执行。`;
      } else {
        stage = "AWAITING_ACCEPTANCE";
        message = `所选 ${current.targetMatrix.length} 个目标全部通过，候选证据包已冻结。`;
      }
      return event(
        { ...current, stage, targetResults: targets, evidenceValid: stage === "AWAITING_ACCEPTANCE" },
        stage === "AWAITING_ACCEPTANCE" ? "E2E_PASSED" : "E2E_PLATFORM_PASSED",
        message,
      );
    }
    case "MERGING":
    case "MAIN_GATE_RUNNING":
      throw new LocalDeliveryGateError("LOCAL_MAIN_GATE_REQUIRED", "main SHA 必须由本机执行服务完成真实合并、重新导出和启动门禁");
    case "STEAM_BETA_UPLOADING":
      return event(
        {
          ...current,
          stage: "STEAM_REINSTALL_E2E",
        },
        "LOCAL_BETA_REINSTALL_STARTED",
        "本地 Beta 演练任务已锁定；开始摘要复核、独立目录回装与实际应用启动。",
      );
    case "STEAM_REINSTALL_E2E":
      throw new LocalDeliveryGateError("LOCAL_STEAM_REINSTALL_REQUIRED", "本地 Beta 必须由本机执行服务完成摘要复核、干净回装和实际启动");
    case "AWAITING_SPEC_APPROVAL":
      throw new Error("请先批准当前规格修订");
    case "AWAITING_ACCEPTANCE":
      throw new Error("请使用接受候选版本动作");
    case "MFA_REQUIRED":
      throw new Error("请先完成 MFA 确认");
    case "EXTERNAL_APPROVAL_REQUIRED":
      throw new Error("请使用本地模拟外部批准动作");
    case "WAITING_PROVIDER":
      throw new Error("Provider 未恢复，任务不会静默切换 Agent");
    case "RELEASED":
      throw new Error("本地交付链路已经完成");
    case "CANCELLED":
      throw new Error("本地交付链路已取消");
    default:
      throw new Error(`没有可用的下一步：${current.stage satisfies never}`);
  }
}

function handoffLocalPostMergeFailure(
  current: LocalDeliverySnapshot,
  reason: LocalPostMergeFailure["reason"],
  evidenceId?: string,
): LocalDeliverySnapshot {
  const expectedStage = reason === "MAIN_GATE_FAILURE" ? "MAIN_GATE_RUNNING" : "STEAM_REINSTALL_E2E";
  if (current.stage !== expectedStage || !current.mainSha || !current.runId) {
    throw new Error(reason === "MAIN_GATE_FAILURE"
      ? "只能在 main SHA 发布门禁运行时模拟失败"
      : "只能在 Steam 回装 E2E 运行时模拟失败");
  }
  const sequence = String(current.revision + 1).padStart(4, "0");
  const label = reason === "MAIN_GATE_FAILURE" ? "main SHA 发布门禁" : "Steam 干净回装 E2E";
  const repairHandoff: LocalPostMergeFailure = Object.freeze({
    reason,
    attempt: 1,
    evidenceId: evidenceId ?? `EV-LOCAL-FAILED-${sequence}`,
    repairPromptId: `repair:local-post-merge-${sequence}`,
    baselineMainSha: current.mainSha,
    previousRunId: current.runId,
    revokedAuthorities: Object.freeze([
      "MAIN_SHA", "MFA", "STEAM_BUILD", "STEAM_RELEASE", "EXTERNAL_APPROVALS",
    ] as const),
  });
  return event(
    {
      ...current,
      stage: "AWAITING_SPEC_APPROVAL",
      resumeStage: null,
      runId: null,
      candidatePr: null,
      candidateSha: null,
      mainSha: null,
      evidenceValid: false,
      targetResults: createTargetResults(current.targetMatrix, "INVALIDATED"),
      steamBranch: null,
      mfaApprovalId: null,
      steamBuildId: null,
      steamReleaseId: null,
      externalGate: null,
      externalApprovals: [],
      externalApprovalEvidence: current.externalApprovalEvidence.map((evidence) => ({ ...evidence, valid: false })),
      repairHandoff,
      agentExecution: current.agentExecution ? { ...current.agentExecution, valid: false } : null,
      localValidation: current.localValidation ? { ...current.localValidation, valid: false } : null,
      mainValidation: current.mainValidation ? { ...current.mainValidation, valid: false } : null,
      steamReinstall: current.steamReinstall ? { ...current.steamReinstall, valid: false } : null,
    },
    reason === "MAIN_GATE_FAILURE" ? "MAIN_GATE_FAILED" : "STEAM_REINSTALL_FAILED",
    `${label} 的失败证据已冻结；旧发布权限已撤销，等待用户创建并批准新规格。`,
  );
}

function normalizeTargetMatrix(value: readonly unknown[]): readonly LocalTargetPlatform[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > TARGET_PLATFORM_ORDER.length) {
    throw new Error("本地目标矩阵无效");
  }
  const matrix = value.map((platform) => {
    if (platform !== "linux" && platform !== "windows" && platform !== "macos") {
      throw new Error("本地目标矩阵包含不支持的平台");
    }
    return platform;
  });
  if (new Set(matrix).size !== matrix.length) throw new Error("本地目标矩阵不能包含重复平台");
  return Object.freeze(matrix);
}

function normalizeTargetResults(
  value: LocalTargetResults | null | undefined,
  targetMatrix: readonly LocalTargetPlatform[],
): LocalTargetResults {
  const results: LocalTargetResults = {};
  for (const platform of TARGET_PLATFORM_ORDER) {
    if (!targetMatrix.includes(platform)) continue;
    const status = value?.[platform];
    results[platform] = status === "QUEUED" || status === "RUNNING" || status === "PASSED" || status === "INVALIDATED"
      ? status
      : "INVALIDATED";
  }
  return Object.freeze(results);
}

function createTargetResults(
  targetMatrix: readonly LocalTargetPlatform[],
  status: LocalPlatformStatus,
): LocalTargetResults {
  const results: LocalTargetResults = {};
  for (const platform of TARGET_PLATFORM_ORDER) {
    if (targetMatrix.includes(platform)) results[platform] = status;
  }
  return results;
}

function startTargetMatrix(targetMatrix: readonly LocalTargetPlatform[]): LocalTargetResults {
  const results = createTargetResults(targetMatrix, "QUEUED");
  results[targetMatrix[0]!] = "RUNNING";
  return results;
}

function sameTargetMatrix(left: readonly LocalTargetPlatform[], right: readonly LocalTargetPlatform[]): boolean {
  return left.length === right.length && left.every((platform, index) => platform === right[index]);
}

function platformLabel(platform: LocalTargetPlatform): string {
  return platform === "linux" ? "Linux" : platform === "windows" ? "Windows" : "macOS";
}
