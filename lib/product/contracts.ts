export type ProductSession = Readonly<{
  tenantId: string;
  tenantName: string;
  displayName: string;
  role: string;
}>;

export type ProductProjectSummary = Readonly<{
  id: string;
  name: string;
  createdAt: string;
  workflowId: string;
  workflowState: string;
  workflowUpdatedAt: string;
  concept: string;
  specification: Readonly<Record<string, unknown>>;
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
  jobs: readonly ProductJob[];
  events: readonly ProductEvent[];
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
  projectId: string | null;
  mode: "NEW_GAME" | "PROJECT_FEEDBACK";
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: readonly ProductConversationMessage[];
}>;

export const WORKFLOW_LABELS: Readonly<Record<string, string>> = Object.freeze({
  DRAFT: "规格确认中",
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
