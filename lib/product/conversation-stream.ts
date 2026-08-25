import type {
  ConversationIntentDecision,
  ConversationWorkflowAction,
  ImplementationChangeRequest,
  ProductConversation,
  ProductConversationMessage,
  ProductProjectDetail,
  ProjectAgentRole,
  WorkspaceSummary,
} from "./contracts";

export type ConversationStreamResult = Readonly<{
  workspace: WorkspaceSummary;
  project: ProductProjectDetail;
  conversation: ProductConversation;
  intentDecision: ConversationIntentDecision;
  changeRequest?: ImplementationChangeRequest;
  workflowAction: ConversationWorkflowAction;
}>;

export type ConversationImageDraft = Readonly<{
  id: string;
  filename: string;
  contentType: "image/png" | "image/jpeg" | "image/webp";
  sizeBytes: number;
  dataBase64: string;
  previewUrl: string;
}>;

export type StreamingConversationReply = Readonly<{
  content: string;
  phase: "THINKING" | "TYPING" | "COMPLETE";
}>;

export type StreamingConversationReplies = Readonly<Partial<Record<ProjectAgentRole, StreamingConversationReply>>>;

export type ConversationStreamCallbacks = Readonly<{
  onAgentStart: (agentRole: ProjectAgentRole) => void;
  onAgentDelta: (agentRole: ProjectAgentRole, delta: string) => void;
  onAgentComplete: (agentRole: ProjectAgentRole) => void;
  onProjectDocument?: (project: ProductProjectDetail) => void;
}>;

export class ConversationStreamError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ConversationStreamError";
    this.code = code;
  }
}

export async function sendConversationMessageStream(
  body: Readonly<{
    content: string;
    conversationId?: string;
    projectId?: string | null;
    responseLanguage?: "en" | "zh";
    attachments?: readonly Pick<ConversationImageDraft, "filename" | "contentType" | "dataBase64">[];
  }>,
  idempotencyKey: string,
  callbacks: ConversationStreamCallbacks,
): Promise<ConversationStreamResult> {
  const response = await fetch("/api/conversations/messages/stream", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": idempotencyKey,
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const failure = await response.json().catch(() => ({})) as { code?: string; message?: string };
    throw new ConversationStreamError(failure.code ?? "CONVERSATION_FAILED", failure.message ?? `消息发送失败 (${response.status})`);
  }
  if (!response.body) throw new ConversationStreamError("EMPTY_STREAM", "对话服务未返回数据流");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result: ConversationStreamResult | null = null;
  const consume = (line: string) => {
    if (!line.trim()) return;
    let event: Record<string, unknown>;
    try {
      const value: unknown = JSON.parse(line);
      if (!value || typeof value !== "object" || Array.isArray(value)) return;
      event = value as Record<string, unknown>;
    } catch {
      throw new ConversationStreamError("INVALID_STREAM", "对话服务返回了无效数据");
    }
    if (event.type === "agent_start" && isProjectAgentRole(event.agentRole)) {
      callbacks.onAgentStart(event.agentRole);
      return;
    }
    if (event.type === "agent_delta" && typeof event.delta === "string"
      && isProjectAgentRole(event.agentRole)) {
      callbacks.onAgentDelta(event.agentRole, event.delta);
      return;
    }
    if (event.type === "agent_complete" && isProjectAgentRole(event.agentRole)) {
      callbacks.onAgentComplete(event.agentRole);
      return;
    }
    if (event.type === "project_document" && event.project) {
      callbacks.onProjectDocument?.(event.project as ProductProjectDetail);
      return;
    }
    if (event.type === "error") {
      throw new ConversationStreamError(
        typeof event.code === "string" ? event.code : "CONVERSATION_FAILED",
        typeof event.message === "string" ? event.message : "消息发送失败",
      );
    }
    if (event.type === "complete" && event.workspace && event.project && event.conversation) {
      result = {
        workspace: event.workspace as WorkspaceSummary,
        project: event.project as ProductProjectDetail,
        conversation: event.conversation as ProductConversation,
        intentDecision: event.intentDecision as ConversationIntentDecision,
        ...(event.changeRequest ? { changeRequest: event.changeRequest as ImplementationChangeRequest } : {}),
        workflowAction: event.workflowAction as ConversationWorkflowAction,
      };
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) consume(line);
    if (done) break;
  }
  if (buffer.trim()) consume(buffer);
  if (!result) throw new ConversationStreamError("INCOMPLETE_STREAM", "对话尚未完成，请重试");
  return result;
}

export function initialStreamingConversationReplies(): StreamingConversationReplies {
  return Object.freeze({ DESIGN: Object.freeze({ content: "", phase: "THINKING" }) });
}

export function startStreamingConversationReply(
  current: StreamingConversationReplies,
  agentRole: ProjectAgentRole,
): StreamingConversationReplies {
  const next: Partial<Record<ProjectAgentRole, StreamingConversationReply>> = { ...current };
  const placeholder = next.DESIGN;
  if (agentRole !== "DESIGN" && placeholder?.phase === "THINKING" && !placeholder.content) delete next.DESIGN;
  next[agentRole] = Object.freeze({ content: next[agentRole]?.content ?? "", phase: "THINKING" });
  return Object.freeze(next);
}

export function appendStreamingConversationReply(
  current: StreamingConversationReplies,
  agentRole: ProjectAgentRole,
  delta: string,
): StreamingConversationReplies {
  const reply = current[agentRole];
  return Object.freeze({
    ...current,
    [agentRole]: Object.freeze({ content: `${reply?.content ?? ""}${delta}`, phase: "TYPING" }),
  });
}

export function completeStreamingConversationReply(
  current: StreamingConversationReplies,
  agentRole: ProjectAgentRole,
): StreamingConversationReplies {
  const reply = current[agentRole];
  if (!reply) return current;
  return Object.freeze({
    ...current,
    [agentRole]: Object.freeze({ ...reply, phase: "COMPLETE" }),
  });
}

function isProjectAgentRole(value: unknown): value is ProjectAgentRole {
  return value === "DESIGN" || value === "DEVELOPMENT" || value === "TEST";
}

export function optimisticConversation(
  current: ProductConversation | null,
  projectId: string,
  content: string,
  title = "新游戏构想",
  attachments: readonly ConversationImageDraft[] = Object.freeze([]),
): ProductConversation {
  const now = new Date().toISOString();
  const currentMessages = current?.messages ?? Object.freeze([]);
  const lastMessage = currentMessages.at(-1);
  const messages = lastMessage?.role === "USER"
      && lastMessage.content === content
      && lastMessage.metadata.failed === true
    ? currentMessages.slice(0, -1)
    : currentMessages;
  const userMessage: ProductConversationMessage = Object.freeze({
    id: `pending-${crypto.randomUUID()}`,
    role: "USER",
    content,
    attachments: Object.freeze(attachments.map(attachment => Object.freeze({
      id: attachment.id,
      filename: attachment.filename,
      contentType: attachment.contentType,
      sizeBytes: attachment.sizeBytes,
      previewUrl: attachment.previewUrl,
    }))),
    metadata: Object.freeze({ pending: true }),
    createdAt: now,
    completedAt: null,
  });
  if (current) {
    return Object.freeze({
      ...current,
      updatedAt: now,
      messages: Object.freeze([...messages, userMessage]),
    });
  }
  return Object.freeze({
    id: `pending-${crypto.randomUUID()}`,
    projectId,
    mode: projectId ? "PROJECT_FEEDBACK" : "NEW_GAME",
    title,
    createdAt: now,
    updatedAt: now,
    messages: Object.freeze([userMessage]),
  });
}

export function failedOptimisticConversation(
  current: ProductConversation,
  failureMessage: string,
): ProductConversation {
  const messages = [...current.messages];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "USER" || message.metadata.pending !== true) continue;
    messages[index] = Object.freeze({
      ...message,
      completedAt: new Date().toISOString(),
      metadata: Object.freeze({
        ...message.metadata,
        pending: false,
        failed: true,
        failureMessage,
      }),
    });
    break;
  }
  return Object.freeze({ ...current, messages: Object.freeze(messages) });
}

export function chronologicalMessages(
  messages: readonly ProductConversationMessage[],
): readonly ProductConversationMessage[] {
  return messages
    .map((message, index) => ({ message, index }))
    .sort((left, right) => {
      const leftTime = Date.parse(left.message.completedAt ?? left.message.createdAt);
      const rightTime = Date.parse(right.message.completedAt ?? right.message.createdAt);
      if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) return leftTime - rightTime;
      if (/^\d+$/.test(left.message.id) && /^\d+$/.test(right.message.id)) {
        const leftId = BigInt(left.message.id);
        const rightId = BigInt(right.message.id);
        if (leftId !== rightId) return leftId < rightId ? -1 : 1;
      }
      return left.index - right.index;
    })
    .map(item => item.message);
}
