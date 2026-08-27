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
  onProcess: (role: ProjectAgentRole, event: string) => void;
  onDelta: (role: ProjectAgentRole, delta: string) => void;
  onReplace: (role: ProjectAgentRole, content: string) => void;
  onActivity: (role: ProjectAgentRole, activity: string) => void;
  onDevelopmentLog: (role: ProjectAgentRole, line: string) => void;
  onComplete: (role: ProjectAgentRole) => void;
}>;

const VALIDATED_REPLY_CHUNK_CHARACTERS = 48;

export async function deliverValidatedConversationReply(input: Readonly<{
  stream?: ProductConversationStreamCallbacks;
  role: ProjectAgentRole;
  content: string;
  streamedContent: string;
  hasStreamedProcess?: boolean;
  signal?: AbortSignal;
}>): Promise<void> {
  if (!input.stream) return;
  if (input.streamedContent) {
    if (input.hasStreamedProcess || input.streamedContent !== input.content) {
      input.stream.onReplace(input.role, input.content);
    }
    return;
  }
  if (input.hasStreamedProcess) {
    input.stream.onReplace(input.role, input.content);
    return;
  }
  const characters = [...input.content];
  for (let offset = 0; offset < characters.length; offset += VALIDATED_REPLY_CHUNK_CHARACTERS) {
    if (input.signal?.aborted) return;
    input.stream.onDelta(input.role, characters.slice(offset, offset + VALIDATED_REPLY_CHUNK_CHARACTERS).join(""));
    if (offset + VALIDATED_REPLY_CHUNK_CHARACTERS < characters.length) {
      await new Promise(resolve => setTimeout(resolve, 12));
    }
  }
}

export type ConversationImageInput = Readonly<{
  contentType: "image/png" | "image/jpeg" | "image/webp";
  dataBase64: string;
}>;
