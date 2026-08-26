import type {
  AgentModelOverrides,
  AgentRuntimeKind,
  ConversationReplyOption,
  E2eGoal,
  E2eGoalDelta,
  ProjectAgentRole,
  ProjectDiscoveryReport,
  ProjectDocumentContent,
} from "@/lib/product/contracts";

/**
 * Conversation data contracts shared by the API and the persistent Project
 * Runtime adapter. This module intentionally contains no Provider client: all
 * reasoning is executed by a role session inside the project's container.
 */
export type ConversationAgentProjectContext = Readonly<{
  name: string;
  concept: string;
  workflowState: string;
  specification: Readonly<Record<string, unknown>>;
  document: ProjectDocumentContent;
  analysisStatus: "READY" | "PENDING" | "ANALYZING" | "NEEDS_INPUT" | "FAILED";
  discovery: ProjectDiscoveryReport | null;
  e2eGoals?: readonly E2eGoal[];
  workflowStatus?: Readonly<Record<string, unknown>>;
}>;

export type ConversationAgentSettings = Readonly<{
  agentRuntime: AgentRuntimeKind;
  baseUrl: string;
  primaryModel: string;
  modelOverrides: AgentModelOverrides;
  revision: number;
}>;

export type ProductConversationAgentReply = Readonly<{
  content: string;
  options: readonly ConversationReplyOption[];
  applyToDraft: boolean;
  readyForDevelopment: boolean;
  projectDocument: ProjectDocumentContent | null;
  projectDocumentPatch: Readonly<Record<string, unknown>> | null;
  runtime: AgentRuntimeKind;
  model: string;
  settingsRevision: number;
  e2eGoalDelta: E2eGoalDelta;
}>;

export type ProductConversationGroupReply = ProductConversationAgentReply & Readonly<{
  agentRole: ProjectAgentRole;
}>;

export type ProductConversationStreamCallbacks = Readonly<{
  onStart: (role: ProjectAgentRole) => void;
  onDelta: (role: ProjectAgentRole, delta: string) => void;
  onComplete: (role: ProjectAgentRole) => void;
}>;

export type ConversationImageInput = Readonly<{
  contentType: "image/png" | "image/jpeg" | "image/webp";
  dataBase64: string;
}>;
