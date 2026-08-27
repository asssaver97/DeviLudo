import type {
  ConversationIntentDecision,
  ConversationWorkflowAction,
  ImplementationChangeRequest,
  ProductConversation,
  ProductConversationMessage,
  ProductProjectDetail,
  ProjectRuntimeRole,
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
  processEvents: readonly string[];
  phase: "THINKING" | "TYPING" | "COMPLETE";
  activity: string | null;
  developmentLogs: readonly string[];
}>;

export type StreamingConversationReplies = Readonly<Partial<Record<ProjectRuntimeRole, StreamingConversationReply>>>;

export type ConversationStreamCallbacks = Readonly<{
  onAgentStart: (agentRole: ProjectRuntimeRole) => void;
  onAgentProcess: (agentRole: ProjectRuntimeRole, event: string) => void;
  onAgentDelta: (agentRole: ProjectRuntimeRole, delta: string) => void;
  onAgentReplace: (agentRole: ProjectRuntimeRole, content: string) => void;
  onAgentActivity: (agentRole: ProjectRuntimeRole, activity: string) => void;
  onAgentDevelopmentLog: (agentRole: ProjectRuntimeRole, line: string) => void;
  onAgentComplete: (agentRole: ProjectRuntimeRole) => void;
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
    if (event.type === "agent_start" && isProjectRuntimeRole(event.agentRole)) {
      callbacks.onAgentStart(event.agentRole);
      return;
    }
    if (event.type === "agent_process" && typeof event.event === "string"
      && isProjectRuntimeRole(event.agentRole)) {
      callbacks.onAgentProcess(event.agentRole, event.event);
      return;
    }
    if (event.type === "agent_delta" && typeof event.delta === "string"
      && isProjectRuntimeRole(event.agentRole)) {
      callbacks.onAgentDelta(event.agentRole, event.delta);
      return;
    }
    if (event.type === "agent_replace" && typeof event.content === "string"
      && isProjectRuntimeRole(event.agentRole)) {
      callbacks.onAgentReplace(event.agentRole, event.content);
      return;
    }
    if (event.type === "agent_activity" && typeof event.activity === "string"
      && isProjectRuntimeRole(event.agentRole)) {
      callbacks.onAgentActivity(event.agentRole, event.activity);
      return;
    }
    if (event.type === "agent_log" && typeof event.line === "string"
      && event.agentRole === "DEVELOPMENT") {
      callbacks.onAgentDevelopmentLog(event.agentRole, event.line);
      return;
    }
    if (event.type === "agent_complete" && isProjectRuntimeRole(event.agentRole)) {
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
  return Object.freeze({});
}

export function startStreamingConversationReply(
  current: StreamingConversationReplies,
  agentRole: ProjectRuntimeRole,
): StreamingConversationReplies {
  return Object.freeze({
    ...current,
    [agentRole]: Object.freeze({
      content: current[agentRole]?.content ?? "",
      processEvents: current[agentRole]?.processEvents ?? Object.freeze([]),
      phase: "THINKING",
      activity: null,
      developmentLogs: current[agentRole]?.developmentLogs ?? Object.freeze([]),
    }),
  });
}

export function appendStreamingConversationProcess(
  current: StreamingConversationReplies,
  agentRole: ProjectRuntimeRole,
  event: string,
): StreamingConversationReplies {
  const reply = current[agentRole];
  if (!event) return current;
  const existing = reply?.processEvents ?? [];
  const processEvents = Object.freeze([...existing, event]);
  return Object.freeze({
    ...current,
    [agentRole]: Object.freeze({
      content: reply?.content ?? "",
      processEvents,
      phase: "TYPING",
      activity: reply?.activity ?? null,
      developmentLogs: reply?.developmentLogs ?? Object.freeze([]),
    }),
  });
}

export function appendStreamingConversationReply(
  current: StreamingConversationReplies,
  agentRole: ProjectRuntimeRole,
  delta: string,
): StreamingConversationReplies {
  const reply = current[agentRole];
  return Object.freeze({
    ...current,
    [agentRole]: Object.freeze({
      content: `${reply?.content ?? ""}${delta}`,
      processEvents: reply?.processEvents ?? Object.freeze([]),
      phase: "TYPING",
      activity: null,
      developmentLogs: reply?.developmentLogs ?? Object.freeze([]),
    }),
  });
}

export function replaceStreamingConversationReply(
  current: StreamingConversationReplies,
  agentRole: ProjectRuntimeRole,
  content: string,
): StreamingConversationReplies {
  const reply = current[agentRole];
  return Object.freeze({
    ...current,
    [agentRole]: Object.freeze({
      content,
      processEvents: Object.freeze([]),
      phase: "TYPING",
      activity: null,
      developmentLogs: reply?.developmentLogs ?? Object.freeze([]),
    }),
  });
}

export function updateStreamingConversationActivity(
  current: StreamingConversationReplies,
  agentRole: ProjectRuntimeRole,
  activity: string,
): StreamingConversationReplies {
  const reply = current[agentRole];
  const normalizedActivity = activity.trim() || null;
  return Object.freeze({
    ...current,
    [agentRole]: Object.freeze({
      content: reply?.content ?? "",
      processEvents: reply?.processEvents ?? Object.freeze([]),
      phase: normalizedActivity || reply?.content ? "TYPING" : "THINKING",
      activity: normalizedActivity,
      developmentLogs: reply?.developmentLogs ?? Object.freeze([]),
    }),
  });
}

export function appendStreamingDevelopmentLog(
  current: StreamingConversationReplies,
  agentRole: ProjectRuntimeRole,
  line: string,
): StreamingConversationReplies {
  const reply = current[agentRole];
  const logs = agentRole === "DEVELOPMENT"
    ? [...(reply?.developmentLogs ?? []), line].slice(-40)
    : reply?.developmentLogs ?? [];
  return Object.freeze({
    ...current,
    [agentRole]: Object.freeze({
      content: reply?.content ?? "",
      processEvents: reply?.processEvents ?? Object.freeze([]),
      phase: "TYPING",
      activity: reply?.activity ?? null,
      developmentLogs: Object.freeze(logs),
    }),
  });
}

export function completeStreamingConversationReply(
  current: StreamingConversationReplies,
  agentRole: ProjectRuntimeRole,
): StreamingConversationReplies {
  const reply = current[agentRole];
  if (!reply) return current;
  return Object.freeze({
    ...current,
    [agentRole]: Object.freeze({ ...reply, phase: "COMPLETE", activity: null }),
  });
}

export function streamingConversationReplyIsActive(reply: StreamingConversationReply): boolean {
  return reply.phase !== "COMPLETE";
}

function isProjectRuntimeRole(value: unknown): value is ProjectRuntimeRole {
  return value === "INTENT" || value === "ANALYSIS" || value === "DESIGN"
    || value === "DEVELOPMENT" || value === "TEST";
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
