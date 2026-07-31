export type WorkspaceSummary = Readonly<{
  id: string;
  name: string;
  createdAt: string;
}>;

export const WORKSPACE_ROLES = ["OWNER", "ADMIN", "MEMBER"] as const;
export type WorkspaceRole = typeof WORKSPACE_ROLES[number];

export type UserRecord = Readonly<{
  id: string;
  username: string;
  instanceAdmin: boolean;
  createdAt: string;
}>;

export type ProductSession = Readonly<{
  user: UserRecord;
  authenticated: true;
  authMode: "STANDALONE" | "PLATFORM";
  canLogout: boolean;
  selectedWorkspace: WorkspaceSummary;
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
  kind: "SPECIFICATION" | "PROJECT_DOCUMENT" | "BUILD" | "E2E_REPORT" | "SIGNED_BUILD" | "PUBLISH_RECEIPT" | "CLEAN_INSTALL_REPORT";
  targetPlatform: "linux" | "windows" | "macos" | null;
  object: ObjectReference;
  createdAt: string;
}>;

export const AGENT_RUNTIME_KINDS = ["CLAUDE_CODE", "CODEX_CLI"] as const;
export type AgentRuntimeKind = typeof AGENT_RUNTIME_KINDS[number];

export type AgentRuntimeAvailability = Readonly<{
  kind: AgentRuntimeKind;
  installed: boolean;
  version: string | null;
  scope: "LOCAL_HOST" | "CORE_RUNTIME";
}>;

export type AgentModelConfiguration = Readonly<{
  primary: string;
  opus: string;
  sonnet: string;
  haiku: string;
  subagent: string;
}>;

export type InstanceAgentSettings = Readonly<{
  agentRuntime: AgentRuntimeKind;
  baseUrl: string;
  models: AgentModelConfiguration | null;
  apiKeyConfigured: boolean;
  apiKeyMasked: string | null;
  apiKeyFingerprint: string | null;
  revision: number;
  updatedAt: string | null;
}>;

export type ProductProjectSummary = Readonly<{
  id: string;
  name: string;
  createdAt: string;
  workflowId: string;
  workflowState: string;
  workflowUpdatedAt: string;
  workflowProfile: WorkflowProfile;
  targetPlatforms: readonly ("linux" | "windows" | "macos")[];
  concept: string;
  specification: Readonly<Record<string, unknown>>;
  source: ProjectSourceRevision | null;
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

export type ProductProjectDetail = ProductProjectSummary & Readonly<{
  document: ProjectDocument;
  jobs: readonly ProductJob[];
  events: readonly ProductEvent[];
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
  metadata: Readonly<Record<string, unknown>>;
  createdAt: string;
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
  createdAt: string;
  updatedAt: string;
}>;

export const AGENT_PROGRESS_EVENT_KINDS = [
  "PHASE",
  "AGENT_OUTPUT",
  "GUIDANCE_ACCEPTED",
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
  AGENT_RUNNING: "Agent 生成中",
  ARTIFACT_BUILDING: "制品构建中",
  E2E_TESTING: "跨平台测试中",
  SIGNING: "平台签名中",
  STEAM_PUBLISHING: "Steam 发布中",
  CLEAN_INSTALL_VERIFYING: "干净回装验证中",
  SUCCEEDED: "交付完成",
  FAILED: "流程失败",
  CANCELLED: "已取消",
});
