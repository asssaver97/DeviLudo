export type WorkspaceSummary = Readonly<{
  id: string;
  name: string;
  createdAt: string;
}>;

export type LocalInstance = Readonly<{
  mode: "SELF_HOSTED" | "MANAGED";
  workspace: WorkspaceSummary;
  capabilities: readonly string[];
}>;

export type TelemetryStatus = Readonly<{
  endpointConfigured: boolean;
  installationIdMask: string;
  lastReportedAt: string | null;
  collectedFields: readonly ["installationId", "activeDay", "releaseVersion", "operatingSystem", "architecture"];
}>;

export const WORKFLOW_PROFILES = ["VALIDATE", "RELEASE"] as const;
export type WorkflowProfile = typeof WORKFLOW_PROFILES[number];

export type ObjectReference = Readonly<{
  bucket: string;
  key: string;
  sha256: string;
  sizeBytes: number;
}>;

export type ArtifactRecord = Readonly<{
  id: string;
  workspaceId: string;
  projectId: string;
  workflowId: string;
  kind: "SPECIFICATION" | "PROJECT_DOCUMENT" | "BUILD" | "E2E_REPORT" | "E2E_REGRESSION" | "SIGNED_BUILD" | "PUBLISH_RECEIPT" | "CLEAN_INSTALL_REPORT";
  targetPlatform: "linux" | "windows" | "macos" | null;
  object: ObjectReference;
  e2eEvidence?: Readonly<{
    schema: "deviludo.e2e-evidence";
    result: "PASSED" | "FAILED";
    headlessCheckCount: number;
    interactiveJourneyCount: number;
    deterministicInputCount: number;
    realInputCount: number;
    keyboardMouseInputCount: number;
    gamepadInputCount: number;
    adaptiveRolloutCount: number;
    adaptiveSuccessCount: number;
    adaptiveDecisionCount: number;
    coveredPlayerRequirementCount: number;
    playerRequirementCount: number;
    plannedAssetPlacementCount: number;
    verifiedAssetPlacementCount: number;
    screenshotCount: number;
    visualBaselineCount: number;
    videoCount: number;
    hasVisualDiff: boolean;
    frameRateSampleCount: number;
    minimumFps: number | null;
    p10Fps: number | null;
    medianFps: number | null;
    inputResponseSampleCount: number;
    p95InputResponseMs: number | null;
    maxInputResponseMs: number | null;
    performancePassed: boolean;
    regressionTraceDigest: string | null;
    regressionInputProfile: "KEYBOARD_MOUSE" | "GAMEPAD" | null;
    regressionEstimatedDurationMs: number | null;
    packageLaunchMode: "MACOS_LAUNCH_SERVICES" | "WINDOWS_FINAL_EXE" | "LINUX_RELEASE_EXECUTABLE" | null;
  }>;
  createdAt: string;
}>;

export const AGENT_RUNTIME_KINDS = ["CLAUDE_CODE", "CODEX_CLI"] as const;
export const CODEX_ACCOUNT_DEFAULT_MODEL = "account-default" as const;
export type AgentRuntimeKind = typeof AGENT_RUNTIME_KINDS[number];

export const IMAGE_GENERATION_BACKENDS = ["HTTP_IMAGES", "CODEX_IMAGEGEN"] as const;
export type ImageGenerationBackend = typeof IMAGE_GENERATION_BACKENDS[number];

export type AgentRuntimeAvailability = Readonly<{
  kind: AgentRuntimeKind;
  installed: boolean;
  version: string | null;
  scope: "LOCAL_HOST" | "CORE_RUNTIME";
  authentication: "CHATGPT" | "API_KEY" | "SIGNED_OUT" | null;
}>;

export const PROJECT_AGENT_ROLES = ["DESIGN", "DEVELOPMENT", "TEST"] as const;
export type ProjectAgentRole = typeof PROJECT_AGENT_ROLES[number];

const LEGACY_MANUAL_CONVERSATION_REPLY_LABELS = new Set([
  "自己输入意见",
  "Enter my own answer",
]);

export type ConversationReplyOption = Readonly<{
  label: string;
  description: string;
}>;

export function normalizeConversationReplyOptions(
  value: unknown,
): readonly ConversationReplyOption[] {
  if (!Array.isArray(value)) return Object.freeze([]);
  const seen = new Set<string>();
  const options: ConversationReplyOption[] = [];
  for (const candidate of value) {
    const option = conversationReplyOption(candidate);
    if (!option || seen.has(option.label)) continue;
    seen.add(option.label);
    // Retire the old manual-answer button even for historical Runtime turns.
    // Free-form composer text is now the sole custom-answer path.
    if (LEGACY_MANUAL_CONVERSATION_REPLY_LABELS.has(option.label)) continue;
    options.push(option);
    if (options.length === 4) break;
  }
  return Object.freeze(options);
}

function conversationReplyOption(value: unknown): ConversationReplyOption | null {
  const record = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
  const rawLabel = typeof value === "string" ? value : record?.label;
  if (typeof rawLabel !== "string") return null;
  const label = rawLabel.trim().slice(0, 160).trim();
  if (!label) return null;
  const description = typeof record?.description === "string"
    ? record.description.trim().slice(0, 300).trim()
    : "";
  return Object.freeze({ label, description });
}

/**
 * Runtime roles are deliberately separate from the three members rendered in
 * the project group chat. Intent is a transient router and Analysis owns the
 * import report; neither is presented as a permanent chat participant.
 */
export const PROJECT_RUNTIME_ROLES = ["INTENT", "ANALYSIS", ...PROJECT_AGENT_ROLES] as const;
export type ProjectRuntimeRole = typeof PROJECT_RUNTIME_ROLES[number];

export const PROJECT_RUNTIME_STATES = ["CREATING", "RUNNING", "PAUSING", "PAUSED", "COMPACTING", "DESTROYED", "STOPPED", "FAILED"] as const;
export type ProjectRuntimeState = typeof PROJECT_RUNTIME_STATES[number];

export const CONVERSATION_INTENTS = ["QUESTION", "CHANGE_REQUEST", "CONFIRM_CHANGE", "REJECT_CHANGE", "STOP", "CONTINUE"] as const;
export type ConversationIntent = typeof CONVERSATION_INTENTS[number];

export type ConversationIntentDecision = Readonly<{
  intent: ConversationIntent;
  explicitExecution: boolean;
  actionable: boolean;
  targetRole: ProjectAgentRole;
  summary: string;
}>;

export type E2eGoal = Readonly<{
  id: string;
  description: string;
  source: "CORE_LOOP" | "ACCEPTANCE";
}>;

export type E2eGoalDelta = Readonly<{
  add: readonly Omit<E2eGoal, "id">[];
  replace: readonly Readonly<{ id: string; description: string; source: E2eGoal["source"] }>[];
  retire: readonly string[];
}>;

export const IMPLEMENTATION_CHANGE_STATES = ["PENDING", "WAITING_FOR_ANALYSIS", "APPLIED", "REJECTED", "SUPERSEDED"] as const;
export type ImplementationChangeState = typeof IMPLEMENTATION_CHANGE_STATES[number];

export type ImplementationChangeRequest = Readonly<{
  id: string;
  projectId: string;
  conversationId: string;
  state: ImplementationChangeState;
  summary: string;
  implementationBrief: string;
  baseDocumentRevision: number;
  documentPatch: Readonly<Record<string, unknown>>;
  e2eGoalDelta: E2eGoalDelta;
  explicitExecution: boolean;
  createdAt: string;
}>;

export type ConversationWorkflowAction = "NONE" | "AWAITING_CONFIRMATION" | "AGENT_STARTED"
  | "AGENT_RERUN_STARTED" | "NEW_ITERATION_STARTED" | "WAITING_FOR_ANALYSIS";

export const AGENT_MODEL_OVERRIDE_ROLES = ["intent", "analysis", "design", "development", "test"] as const;
export type AgentModelOverrideRole = typeof AGENT_MODEL_OVERRIDE_ROLES[number];

/** A null text-Agent override inherits the instance's primary model. */
export type AgentModelOverrides = Readonly<{
  intent: string | null;
  analysis: string | null;
  design: string | null;
  development: string | null;
  test: string | null;
}>;

export type InstanceAgentSettings = Readonly<{
  agentRuntime: AgentRuntimeKind;
  baseUrl: string;
  primaryModel: string;
  modelOverrides: AgentModelOverrides;
  /** Image generation is disabled when this explicit model is null. */
  imageModel: string | null;
  /** Derived from the selected runtime; it is never configured separately. */
  imageGenerationBackend: ImageGenerationBackend | null;
  imageGenerationReady: boolean;
  apiKeyConfigured: boolean;
  apiKeyMasked: string | null;
  apiKeyFingerprint: string | null;
  revision: number;
  testPolicyReady: boolean;
  updatedAt: string | null;
}>;

/** A sanitized connection discovered from a Runtime's host-side default config. */
export type AgentRuntimeLocalDefault = Readonly<{
  agentRuntime: AgentRuntimeKind;
  baseUrl: string;
  primaryModel: string;
  apiKeyConfigured: boolean;
  apiKeyMasked: string | null;
  source: string;
}>;

export type ProductProjectSummary = Readonly<{
  id: string;
  name: string;
  createdAt: string;
  workflowId: string;
  iterationNumber: number;
  workflowState: string;
  workflowUpdatedAt: string;
  workflowProfile: WorkflowProfile;
  targetPlatforms: readonly ("linux" | "windows" | "macos")[];
  concept: string;
  specification: Readonly<Record<string, unknown>>;
  source: ProjectSourceRevision | null;
  analysisStatus: "READY" | "PENDING" | "ANALYZING" | "NEEDS_INPUT" | "FAILED";
  analysisError: string | null;
  discovery: ProjectDiscoveryReport | null;
}>;

/**
 * Source-backed projects must be understood before implementation starts. The
 * report is deliberately product-facing: it records what the game is and
 * where development actually stands. Product decisions belong to the Design
 * Agent stage that follows this source analysis.
 */
export type ProjectDiscoveryReport = Readonly<{
  gameContent: string;
  currentDevelopmentState: string;
  completedWork: readonly string[];
  remainingWork: readonly string[];
  startupFlow: string;
  startupIssues: readonly string[];
  risks: readonly string[];
}>;

export type ProjectSourceRevision = Readonly<{
  revision: number;
  digest: string;
  relativePath: string;
  fileCount: number;
  totalBytes: number;
  createdAt: string;
}>;

export type ProductJob = Readonly<{
  id: string;
  kind: string;
  agentRole?: ProjectRuntimeRole | null;
  agentPurpose?: string | null;
  poolKind: string;
  targetOperatingSystem: string | null;
  state: string;
  attempt: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}>;

export type ProductEvent = Readonly<{
  id: string;
  kind: string;
  data: Readonly<Record<string, unknown>>;
  createdAt: string;
}>;

export type ProductWorkflowIterationSummary = Readonly<{
  workflowId: string;
  iterationNumber: number;
  parentWorkflowId: string | null;
  state: string;
  profile: WorkflowProfile;
  targetPlatforms: readonly ("linux" | "windows" | "macos")[];
  baseSourceRevision: number | null;
  outputSourceRevision: number | null;
  baseDocumentRevision: number;
  approvedDocumentRevision: number | null;
  createdAt: string;
  updatedAt: string;
  current: boolean;
}>;

export type ProductWorkflowIterationDetail = ProductWorkflowIterationSummary & Readonly<{
  concept: string;
  specification: Readonly<Record<string, unknown>>;
  jobs: readonly ProductJob[];
  events: readonly ProductEvent[];
  artifacts: readonly ArtifactRecord[];
}>;

export type ProductProjectDetail = ProductProjectSummary & Readonly<{
  localDirectory: Readonly<{
    bindingId: string;
    sourceKind: "LOCAL_DIRECTORY" | "GIT";
    repositoryUrl: string | null;
    initialGitBranch: string | null;
  }> | null;
  document: ProjectDocument;
  jobs: readonly ProductJob[];
  events: readonly ProductEvent[];
  pendingImplementationChange: ImplementationChangeRequest | null;
  e2eGoalRevision: number;
  e2eGoals: readonly E2eGoal[];
}>;

export type ProjectDocumentContent = Readonly<{
  introduction: string;
  gameplay: string;
  categories: readonly string[];
  features: readonly string[];
}>;

export type ProjectDocument = Readonly<{
  revision: number;
  content: ProjectDocumentContent;
  markdown: string;
  maintainedBy: "SYSTEM" | "USER" | "AGENT";
  lastAgentMaintainedAt: string | null;
  updatedAt: string;
  revisions: readonly Readonly<{
    revision: number;
    source: "PROJECT_CREATED" | "PROJECT_IMPORTED" | "USER_EDIT" | "AGENT_CONVERSATION" | "AGENT_IDLE_MAINTENANCE";
    authorUsername: string | null;
    createdAt: string;
  }>[];
}>;

export type ProductConversationMessage = Readonly<{
  id: string;
  role: "USER" | "ASSISTANT";
  content: string;
  attachments: readonly ConversationImageAttachment[];
  metadata: Readonly<Record<string, unknown>>;
  createdAt: string;
  /** Set only after the complete message has been accepted or has failed. */
  completedAt: string | null;
}>;

export const MAX_CONVERSATION_IMAGES = 4;
export const MAX_CONVERSATION_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_CONVERSATION_IMAGE_TOTAL_BYTES = 12 * 1024 * 1024;

export type ConversationImageAttachment = Readonly<{
  id: string;
  filename: string;
  contentType: "image/png" | "image/jpeg" | "image/webp";
  sizeBytes: number;
  /** Present only while an unsaved message is rendered optimistically. */
  previewUrl?: string;
}>;

export type ProductConversation = Readonly<{
  id: string;
  projectId: string;
  mode: "NEW_GAME" | "PROJECT_FEEDBACK";
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: readonly ProductConversationMessage[];
}>;

export type ProductConversationSummary = Readonly<{
  id: string;
  projectId: string;
  mode: "NEW_GAME" | "PROJECT_FEEDBACK";
  title: string;
  preview: string;
  messageCount: number;
  userMessageCount: number;
  systemGenerated: boolean;
  createdAt: string;
  updatedAt: string;
}>;

export type WorkspaceSteamSettings = Readonly<{
  builderUsername: string;
  credentialMask: string;
  revision: number;
  updatedAt: string;
}>;

export type ProjectSteamSettings = Readonly<{
  projectId: string;
  appId: string;
  depots: Readonly<Partial<Record<"linux" | "windows" | "macos", string>>>;
  testBranch: string;
  revision: number;
  updatedAt: string;
}>;

export type SteamRelease = Readonly<{
  id: string;
  projectId: string;
  workflowId: string;
  iterationNumber: number;
  version: string;
  releaseNumber: number;
  channel: "TEST" | "DEFAULT";
  targetBranch: string;
  state: "UPLOADING" | "FAILED" | "LIVE_TEST" | "AWAITING_DEFAULT_PROMOTION" | "LIVE_DEFAULT";
  steamBuildId: string | null;
  failureMessage: string | null;
  createdAt: string;
  uploadedAt: string | null;
  liveAt: string | null;
}>;

export const AGENT_PROGRESS_EVENT_KINDS = [
  "PHASE",
  "AGENT_OUTPUT",
  "SUPERSEDED",
  "COMPLETED",
  "FAILED",
] as const;
export type AgentProgressEventKind = typeof AGENT_PROGRESS_EVENT_KINDS[number];

export type AgentProgressEvent = Readonly<{
  sequence: number;
  jobId: string;
  kind: AgentProgressEventKind;
  content: string;
  createdAt: string;
}>;

export const WORKFLOW_LABELS: Readonly<Record<string, string>> = Object.freeze({
  DRAFT: "需求讨论中",
  ANALYZING: "项目分析中",
  DESIGNING: "游戏设计中",
  DEVELOPING: "游戏生成中",
  BUILDING: "制品构建中",
  TEST_PLANNING: "测试规划中",
  TESTING: "跨平台测试中",
  RELEASE_APPROVAL_PENDING: "等待发布批准",
  STEAM_PUBLISHING: "Steam 发布中",
  SUCCEEDED: "交付完成",
  BLOCKED: "等待配置",
  STOPPED: "已停止",
  FAILED: "流程失败",
  CANCELLED: "已取消",
});
