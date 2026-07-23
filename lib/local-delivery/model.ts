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
  checks: Array<{ name: string; status: "PASSED" | "FAILED" | "WAITING_DEPENDENCY"; durationMs: number; detail: string }>;
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
  repairHandoff: LocalPostMergeFailure | null;
  agentExecution: LocalAgentExecutionSnapshot | null;
  localValidation: LocalValidationSnapshot | null;
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
  | "external-approve"
  | "cancel"
  | "reset";

export class LocalDeliveryGateError extends Error {
  constructor(readonly code: "LOCAL_EXPORT_TEMPLATES_REQUIRED" | "LOCAL_VALIDATION_FAILED" | "LOCAL_VALIDATION_INVALIDATED", message: string) {
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
    targetMatrix?: readonly LocalTargetPlatform[];
    platform?: "macos";
    fixtureOnly?: true;
  }) | null | undefined;
  const validationMatrix = historicalValidation?.targetMatrix
    ? normalizeTargetMatrix(historicalValidation.targetMatrix)
    : null;
  const localValidation = historicalValidation
    ? {
      ...historicalValidation,
      targetMatrix: validationMatrix ?? targetMatrix,
      platform: historicalValidation.platform ?? "macos" as const,
      fixtureOnly: historicalValidation.fixtureOnly ?? true as const,
      // Evidence created before target-matrix binding remains readable but can
      // never satisfy a current selected-platform gate.
      valid: validationMatrix !== null
        && sameTargetMatrix(validationMatrix, targetMatrix)
        && historicalValidation.platform === "macos"
        && historicalValidation.fixtureOnly === true
        && historicalValidation.valid,
      status: historicalValidation.releaseGate === "WAITING_EXPORT_TEMPLATES"
        ? "WAITING_DEPENDENCY" as const
        : historicalValidation.status,
    }
    : null;

  return {
    ...snapshot,
    targetMatrix,
    targetResults,
    agentExecution,
    repairHandoff: snapshot.repairHandoff ?? null,
    mfaApprovalId: snapshot.mfaApprovalId ?? null,
    steamBuildId: snapshot.steamBuildId ?? null,
    steamReleaseId: snapshot.steamReleaseId ?? null,
    externalApprovals: snapshot.externalApprovals ?? [],
    externalGate: snapshot.externalGate ?? (snapshot.stage === "EXTERNAL_APPROVAL_REQUIRED"
      ? (["VALVE_REVIEW", "FIRST_RELEASE", "DEFAULT_BRANCH_CONFIRMATION"] as const)[Math.min(snapshot.externalApprovals?.length ?? 0, 2)]
      : null),
    localValidation,
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
    repairHandoff: null,
    agentExecution: null,
    localValidation: null,
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
      repairHandoff: null,
      agentExecution: null,
      localValidation: null,
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
      repairHandoff: null,
      localValidation: current.localValidation ? { ...current.localValidation, valid: false } : null,
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
  if (!sameTargetMatrix(validation.targetMatrix, current.targetMatrix)) {
    throw new Error("本机验证证据与锁定目标矩阵不一致");
  }
  if (validation.platform !== "macos" || validation.fixtureOnly !== true) {
    throw new Error("本机验证证据缺少真实执行平台绑定");
  }
  const targetResults = gatePassed
    ? current.targetResults
    : createTargetResults(current.targetMatrix, "INVALIDATED");
  return event(
    {
      ...current,
      stage: "CANDIDATE_READY",
      candidateSha: validation.candidateSha.slice(0, 7),
      evidenceValid: gatePassed ? current.evidenceValid : false,
      targetResults,
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
        localValidation: current.localValidation ? { ...current.localValidation, valid: false } : null,
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
      "本地测试 MFA 已确认；开始模拟上传密码保护 Beta。",
    );
  }

  if (action === "main-gate-fail") {
    return handoffLocalPostMergeFailure(current, "MAIN_GATE_FAILURE");
  }

  if (action === "steam-reinstall-fail") {
    return handoffLocalPostMergeFailure(current, "STEAM_INSTALL_FAILURE");
  }

  if (action === "external-approve") {
    if (current.stage !== "EXTERNAL_APPROVAL_REQUIRED" || !current.externalGate) {
      throw new Error("当前没有外部发布批准待处理");
    }
    const transition = {
      VALVE_REVIEW: {
        approvalId: "LOCAL_VALVE_REVIEW_APPROVED",
        nextGate: "FIRST_RELEASE" as const,
        eventType: "VALVE_REVIEW_APPROVED",
        message: "本地模拟 Valve 审核通过；继续等待首次发行操作。",
      },
      FIRST_RELEASE: {
        approvalId: "LOCAL_FIRST_RELEASE_COMPLETED",
        nextGate: "DEFAULT_BRANCH_CONFIRMATION" as const,
        eventType: "FIRST_RELEASE_COMPLETED",
        message: "本地模拟首次发行操作完成；继续等待默认分支手机／短信确认。",
      },
      DEFAULT_BRANCH_CONFIRMATION: {
        approvalId: "LOCAL_DEFAULT_BRANCH_CONFIRMED",
        nextGate: null,
        eventType: "DEFAULT_BRANCH_CONFIRMED",
        message: "本地模拟默认分支确认完成；未调用真实 Steam 发布接口。",
      },
    }[current.externalGate];
    return event({
      ...current,
      stage: transition.nextGate ? "EXTERNAL_APPROVAL_REQUIRED" : "RELEASED",
      externalGate: transition.nextGate,
      externalApprovals: [...current.externalApprovals, transition.approvalId],
    }, transition.eventType, transition.message);
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
      return event(
        { ...current, stage: "MAIN_GATE_RUNNING", mainSha: "f21c0de" },
        "MAIN_SHA_LOCKED",
        "Draft PR 已在本地 SCM 合并；发布门禁锁定实际 main SHA。",
      );
    case "MAIN_GATE_RUNNING":
      return event({
        ...current,
        stage: "MFA_REQUIRED",
        steamReleaseId: `RELEASE-LOCAL-${String(current.revision + 1).padStart(4, "0")}`,
      }, "MAIN_GATE_PASSED", "main SHA 完整门禁通过，等待 MFA。 ");
    case "STEAM_BETA_UPLOADING":
      return event(
        {
          ...current,
          stage: "STEAM_REINSTALL_E2E",
          steamBuildId: `BUILD-LOCAL-${String(current.revision + 1).padStart(4, "0")}`,
        },
        "STEAM_BETA_READY",
        "本地模拟 Beta 已激活；开始干净客户端回装测试。",
      );
    case "STEAM_REINSTALL_E2E":
      return event(
        { ...current, stage: "EXTERNAL_APPROVAL_REQUIRED", externalGate: "VALVE_REVIEW", externalApprovals: [] },
        "STEAM_REINSTALL_PASSED",
        "回装测试通过；按顺序等待 Valve 审核、首次发行与默认分支确认。",
      );
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
    evidenceId: `EV-LOCAL-FAILED-${sequence}`,
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
      repairHandoff,
      agentExecution: current.agentExecution ? { ...current.agentExecution, valid: false } : null,
      localValidation: current.localValidation ? { ...current.localValidation, valid: false } : null,
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
