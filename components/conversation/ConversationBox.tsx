"use client";

import Image from "next/image";
import {
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import {
  CONVERSATION_ATTACHMENT_CONTENT_TYPES,
  MAX_CONVERSATION_ATTACHMENTS,
  MAX_CONVERSATION_ATTACHMENT_BYTES,
  MAX_CONVERSATION_ATTACHMENT_TOTAL_BYTES,
  normalizeConversationReplyOptions,
  PROJECT_AGENT_ROLES,
  PROJECT_RUNTIME_ROLES,
  type AgentProgressEvent,
  type ConversationAttachmentContentType,
  type ConversationReplyOption,
  type ProductConversationMessage,
  type ProjectRuntimeRole,
} from "@/lib/product/contracts";
import {
  streamingConversationReplyIsActive,
  type ConversationStreamPhase,
  type ConversationAttachmentDraft,
  type StreamingConversationReplies,
} from "@/lib/product/conversation-stream";
import { agentProgressDisplayRows, localizedAgentProgressContent } from "@/lib/product/agent-progress";
import { CloseIcon, PlusIcon, SendIcon } from "../console/Icons";
import { TypingDots } from "../console/TypingDots";
import { localeTag, useLanguage } from "../i18n/LanguageProvider";

type ConversationBoxProps = Readonly<{
  conversationKey: string | null;
  messages: readonly ProductConversationMessage[];
  sending: boolean;
  streamPhase?: ConversationStreamPhase | null;
  streamingReplies: StreamingConversationReplies;
  agentProgress?: Readonly<{
    running: boolean;
    state: "RUNNING" | "RETRY" | "FAILED";
    role: ConversationDisplayAgentRole;
    events: readonly AgentProgressEvent[];
    error: string | null;
  }>;
  showSendingReply?: boolean;
  value: string;
  attachments: readonly ConversationAttachmentDraft[];
  onAttachmentsChange: (attachments: readonly ConversationAttachmentDraft[]) => void;
  onValueChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onOptionSelect?: (option: string) => void;
  placeholder: string;
  textareaLabel: string;
  sendButtonLabel: string;
  showMessages?: boolean;
  autoFocus?: boolean;
  disabled?: boolean;
  focusKey?: string | number;
  composerPrefix?: ReactNode;
  primaryAction?: ReactNode;
  intro?: ReactNode;
  emptyTitle?: string;
  emptyDescription?: string;
  className?: string;
}>;

export function ConversationBox({
  conversationKey,
  messages,
  sending,
  streamPhase = null,
  streamingReplies,
  agentProgress,
  showSendingReply = true,
  value,
  attachments,
  onAttachmentsChange,
  onValueChange,
  onSubmit,
  onOptionSelect,
  placeholder,
  textareaLabel,
  sendButtonLabel,
  showMessages = true,
  autoFocus = false,
  disabled = false,
  focusKey,
  composerPrefix,
  primaryAction,
  intro,
  emptyTitle,
  emptyDescription,
  className = "",
}: ConversationBoxProps) {
  const { errorText, locale, text } = useLanguage();
  const messageViewport = useRef<HTMLDivElement | null>(null);
  const composer = useRef<HTMLFormElement | null>(null);
  const textarea = useRef<HTMLTextAreaElement | null>(null);
  const attachmentInput = useRef<HTMLInputElement | null>(null);
  const attachmentDragDepth = useRef(0);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [attachmentDropActive, setAttachmentDropActive] = useState(false);
  const sendingStatus = streamPhase === "NAMING"
    ? text("正在创建项目", "Creating project")
    : streamPhase === "RESPONDING"
      ? text("正在启动 Agent", "Starting Agent")
      : streamPhase === "SAVING"
        ? text("正在保存回复", "Saving reply")
        : text("正在准备会话", "Preparing conversation");
  const followLatestMessage = useRef(true);
  const hasPrimaryAction = primaryAction !== null && primaryAction !== undefined;
  const previousHasPrimaryAction = useRef(hasPrimaryAction);
  const latestProgressSequence = agentProgress?.events.at(-1)?.sequence ?? null;
  const latestOptionMessageId = useMemo(() => {
    if (sending || agentProgress?.running) return null;
    const latestMessage = messages.at(-1);
    return latestMessage?.role === "ASSISTANT" && conversationOptions(latestMessage.metadata).length > 0
      ? latestMessage.id : null;
  }, [agentProgress?.running, messages, sending]);

  useLayoutEffect(() => {
    followLatestMessage.current = true;
    const viewport = messageViewport.current;
    if (viewport) viewport.scrollTop = viewport.scrollHeight;
  }, [conversationKey]);

  useLayoutEffect(() => {
    const viewport = messageViewport.current;
    if (!showMessages || !viewport || !followLatestMessage.current) return;
    viewport.scrollTop = viewport.scrollHeight;
  }, [agentProgress?.running, latestProgressSequence, messages, sending, showMessages, streamingReplies]);

  useLayoutEffect(() => {
    if (focusKey === undefined || disabled) return;
    textarea.current?.focus();
  }, [disabled, focusKey]);

  useLayoutEffect(() => {
    const appeared = hasPrimaryAction && !previousHasPrimaryAction.current;
    previousHasPrimaryAction.current = hasPrimaryAction;
    if (!appeared) return;
    composer.current?.scrollIntoView({ block: "nearest" });
  }, [hasPrimaryAction]);

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  }

  async function addAttachments(files: readonly File[]) {
    if (!files.length) return;
    if (attachments.length + files.length > MAX_CONVERSATION_ATTACHMENTS) {
      setAttachmentError(text(`最多发送 ${MAX_CONVERSATION_ATTACHMENTS} 个附件`, `Attach up to ${MAX_CONVERSATION_ATTACHMENTS} files`));
      return;
    }
    if (files.some(file => !conversationFileContentType(file) || file.size < 1 || file.size > MAX_CONVERSATION_ATTACHMENT_BYTES)) {
      const limitMiB = MAX_CONVERSATION_ATTACHMENT_BYTES / 1024 / 1024;
      setAttachmentError(text(
        `支持 ${limitMiB} MB 以内的 PDF、PNG、JPEG、WebP、GIF、TIFF、AVIF、HEIC/HEIF`,
        `Use PDF, PNG, JPEG, WebP, GIF, TIFF, AVIF, HEIC, or HEIF files up to ${limitMiB} MB each`,
      ));
      return;
    }
    if (attachments.reduce((total, item) => total + item.sizeBytes, 0)
      + files.reduce((total, item) => total + item.size, 0) > MAX_CONVERSATION_ATTACHMENT_TOTAL_BYTES) {
      setAttachmentError(text("附件总大小不能超过 32 MB", "Attachments may total up to 32 MB"));
      return;
    }
    try {
      const drafts = await Promise.all(files.map(readConversationAttachment));
      onAttachmentsChange(Object.freeze([...attachments, ...drafts]));
      setAttachmentError(null);
    } catch {
      setAttachmentError(text("附件读取失败，请重新选择", "Unable to read the attachment. Select it again."));
    }
  }

  function handleAttachments(event: ChangeEvent<HTMLInputElement>) {
    const files = [...(event.target.files ?? [])];
    event.target.value = "";
    void addAttachments(files);
  }

  function handleImageDragEnter(event: DragEvent<HTMLFormElement>) {
    if (!hasDraggedFiles(event) || sending || disabled) return;
    event.preventDefault();
    attachmentDragDepth.current += 1;
    setAttachmentDropActive(true);
  }

  function handleImageDragOver(event: DragEvent<HTMLFormElement>) {
    if (!hasDraggedFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }

  function handleImageDragLeave(event: DragEvent<HTMLFormElement>) {
    if (!hasDraggedFiles(event)) return;
    event.preventDefault();
    attachmentDragDepth.current = Math.max(0, attachmentDragDepth.current - 1);
    if (attachmentDragDepth.current === 0) setAttachmentDropActive(false);
  }

  function handleImageDrop(event: DragEvent<HTMLFormElement>) {
    if (!hasDraggedFiles(event)) return;
    event.preventDefault();
    attachmentDragDepth.current = 0;
    setAttachmentDropActive(false);
    if (sending || disabled) return;
    void addAttachments([...event.dataTransfer.files]);
  }

  return (
    <div className={`conversation-box ${showMessages ? "has-messages" : "is-composer-only"} ${className}`.trim()}>
      {showMessages ? (
        <div
          aria-live="polite"
          className="conversation-box-messages"
          onScroll={event => {
            const viewport = event.currentTarget;
            followLatestMessage.current = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= 48;
          }}
          ref={messageViewport}
        >
          <div className="conversation-agent-roster" role="list" aria-label={text("群聊成员", "Group chat members")}>
            {PROJECT_AGENT_ROLES.map(role => {
              const member = agentIdentity(role, text);
              return <span className={`agent-member role-${role.toLowerCase()}`} key={role} role="listitem"><i>{member.avatar}</i><b>{member.shortName}</b><small>{member.responsibility}</small></span>;
            })}
          </div>
          {intro}
          {messages.length ? messages.map(message => {
            const failed = message.role === "USER" && message.metadata.failed === true;
            const identity = message.role === "ASSISTANT" ? agentIdentity(messageAgentRole(message), text) : null;
            const options = message.id === latestOptionMessageId && message.role === "ASSISTANT"
              ? conversationOptions(message.metadata)
              : Object.freeze([]);
            return (
            <article className={`conversation-box-message ${message.role === "USER" ? "user" : `assistant role-${messageAgentRole(message).toLowerCase()}`}${failed ? " is-failed" : ""}`} key={message.id}>
              {identity ? <span className="message-avatar">{identity.avatar}</span> : null}
              <div>
                <header>
                  <b>{identity?.name ?? text("你", "You")}</b>
                  {identity && typeof message.metadata.model === "string"
                    ? <span className="conversation-agent-model">{message.metadata.model}</span>
                    : null}
                  {message.role === "ASSISTANT" && message.metadata.appliedToDraft === true
                    ? <span className="conversation-box-applied">{text("已同步项目", "PROJECT SYNCED")}</span>
                    : null}
                  {message.role === "ASSISTANT" && conversationIntent(message.metadata)
                    ? <span className="conversation-box-applied">{conversationIntent(message.metadata)}</span>
                    : null}
                  {failed ? (
                    <span
                      className="conversation-box-failed"
                      title={typeof message.metadata.failureMessage === "string"
                        ? errorText(message.metadata.failureMessage, "消息未保存", "Message was not saved")
                        : undefined}
                    >
                      {text("未保存 · 可重试", "NOT SAVED · RETRY")}
                    </span>
                  ) : null}
                </header>
                {(message.attachments ?? []).length ? (
                  <div className="conversation-message-images conversation-message-attachments">
                    {(message.attachments ?? []).map(attachment => {
                      const url = conversationAttachmentUrl(conversationKey, message.id, attachment.id, attachment.previewUrl);
                      return isBrowserPreviewableImage(attachment.contentType) ? (
                        <a href={url} key={attachment.id} rel="noreferrer" target="_blank">
                          <Image alt={attachment.filename} height={360} src={url} unoptimized width={480} />
                        </a>
                      ) : (
                        <a className="conversation-file-attachment" href={url} key={attachment.id} rel="noreferrer" target="_blank">
                          <span>{attachment.contentType === "application/pdf" ? "PDF" : imageFormatLabel(attachment.contentType)}</span>
                          <b>{attachment.filename}</b>
                          <small>{formatAttachmentBytes(attachment.sizeBytes)}</small>
                        </a>
                      );
                    })}
                  </div>
                ) : null}
                <p>{message.content}</p>
                {message.completedAt ? (
                  <time
                    className="conversation-message-completed-at"
                    dateTime={message.completedAt}
                    title={formatMessageCompletedAt(message.completedAt, locale, true)}
                  >
                    {formatMessageCompletedAt(message.completedAt, locale)}
                  </time>
                ) : null}
                {failed && typeof message.metadata.failureMessage === "string" ? (
                  <small className="conversation-box-failure-detail">{errorText(message.metadata.failureMessage, "消息未保存，请重试", "Message was not saved. Please retry.")}</small>
                ) : null}
                {options.length && onOptionSelect ? (
                  <div aria-label={text("可选回复", "Suggested replies")} className="conversation-box-options" role="group">
                    {options.map(option => (
                      <button
                        disabled={sending || disabled}
                        key={option.label}
                        aria-label={option.label}
                        onClick={() => onOptionSelect(option.label)}
                        type="button"
                      >
                        <span>
                          <b>{option.label}</b>
                          {option.description ? <small>{option.description}</small> : null}
                        </span>
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            </article>
          );
          }) : !agentProgress ? (
            <div className="conversation-box-empty">
              <PlusIcon />
              <b>{emptyTitle ?? text("开始新的项目会话", "START A PROJECT CONVERSATION")}</b>
              <p>{emptyDescription ?? text("讨论玩法，或告诉 DeviLudo 下一步要做什么。", "Discuss the gameplay or tell DeviLudo what to build next.")}</p>
            </div>
          ) : null}
          {agentProgress ? <AgentProgressPanel progress={agentProgress} /> : null}
          {sending && showSendingReply && !PROJECT_RUNTIME_ROLES.some(role => Boolean(streamingReplies[role])) ? (
            <article className="conversation-box-message assistant is-thinking role-system">
              <span className="message-avatar">DL</span>
              <div>
                <header>
                  <b>DeviLudo</b>
                  <span className="conversation-agent-working">{sendingStatus}</span>
                </header>
                <p><TypingDots /></p>
              </div>
            </article>
          ) : null}
          {sending && showSendingReply ? (
            PROJECT_RUNTIME_ROLES.filter(role => Boolean(streamingReplies[role])).map(role => {
                const identity = agentIdentity(role, text);
                const reply = streamingReplies[role];
                if (!reply) return null;
                const status = reply.phase === "THINKING"
                  ? text("正在思考", "Thinking")
                  : reply.phase === "TYPING"
                    ? text("对方正在输入中", "The other person is typing")
                    : null;
                return (
                  <article className={`conversation-box-message assistant is-${reply.phase.toLowerCase()} role-${role.toLowerCase()}`} key={`stream-${role}`}>
                    <span className="message-avatar">{identity.avatar}</span>
                    <div>
                      <header><b>{identity.name}</b>{status ? <span className="conversation-agent-working">{status}</span> : null}</header>
                      <p>
                        {reply.processEvents.length ? (
                          <span className="conversation-agent-process">
                            {reply.processEvents.join("")}
                          </span>
                        ) : null}
                        {reply.content}
                        {!reply.content && !reply.processEvents.length && reply.activity ? (
                          <span className="conversation-agent-activity">{reply.activity}</span>
                        ) : null}
                        {streamingConversationReplyIsActive(reply) ? <TypingDots /> : null}
                      </p>
                      {role === "DEVELOPMENT" && reply.developmentLogs.length ? (
                        <div className="conversation-development-logs">
                          <b>{text("开发日志", "Development log")}</b>
                          {reply.developmentLogs.map((line, index) => <small key={`${index}:${line}`}>{line}</small>)}
                        </div>
                      ) : null}
                    </div>
                  </article>
                );
              })
          ) : null}
        </div>
      ) : null}

      <form
        className={`conversation-box-composer${attachmentDropActive ? " is-image-dragover" : ""}`}
        onDragEnter={handleImageDragEnter}
        onDragLeave={handleImageDragLeave}
        onDragOver={handleImageDragOver}
        onDrop={handleImageDrop}
        onSubmit={event => {
          followLatestMessage.current = true;
          onSubmit(event);
        }}
        ref={composer}
      >
        <span aria-hidden={!attachmentDropActive} className="conversation-image-drop-hint">
          {text("松开以添加 PDF 或图片", "Drop to attach a PDF or image")}
        </span>
        {composerPrefix}
        <textarea
          aria-label={textareaLabel}
          autoFocus={autoFocus}
          disabled={sending || disabled}
          maxLength={4000}
          onChange={event => onValueChange(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          rows={3}
          ref={textarea}
          value={value}
        />
        {attachments.length ? (
          <div className="conversation-composer-images conversation-composer-attachments" aria-label={text("待发送附件", "Attachments to send")}>
            {attachments.map(attachment => (
              <figure className={attachment.previewUrl ? "" : "is-file"} key={attachment.id}>
                {attachment.previewUrl
                  ? <Image alt={attachment.filename} height={144} src={attachment.previewUrl} unoptimized width={192} />
                  : <span className="conversation-file-badge">{attachment.contentType === "application/pdf" ? "PDF" : imageFormatLabel(attachment.contentType)}</span>}
                <figcaption>{attachment.filename}</figcaption>
                <button
                  aria-label={text(`移除 ${attachment.filename}`, `Remove ${attachment.filename}`)}
                  disabled={sending || disabled}
                  onClick={() => onAttachmentsChange(Object.freeze(attachments.filter(candidate => candidate.id !== attachment.id)))}
                  type="button"
                ><CloseIcon /></button>
              </figure>
            ))}
          </div>
        ) : null}
        {attachmentError ? <p className="conversation-image-error" role="alert">{attachmentError}</p> : null}
        <footer>
          <input
            accept=".pdf,.png,.jpg,.jpeg,.webp,.gif,.tif,.tiff,.avif,.heic,.heif,application/pdf,image/png,image/jpeg,image/webp,image/gif,image/tiff,image/avif,image/heic,image/heif"
            aria-label={text("选择会话附件", "Choose conversation attachments")}
            disabled={sending || disabled}
            hidden
            multiple
            onChange={handleAttachments}
            ref={attachmentInput}
            type="file"
          />
          <button
            aria-label={text("添加 PDF 或图片", "Attach a PDF or image")}
            className="conversation-image-button"
            disabled={sending || disabled || attachments.length >= MAX_CONVERSATION_ATTACHMENTS}
            onClick={() => attachmentInput.current?.click()}
            type="button"
          ><PlusIcon /></button>
          <span className="conversation-box-shortcut"><kbd>⌘</kbd><kbd>↵</kbd> {text("发送 · Enter 换行", "SEND · ENTER FOR NEW LINE")}</span>
          <span className="conversation-box-count">{value.length}/4000</span>
          {disabled ? null : primaryAction}
          <button aria-label={sendButtonLabel} className="button button-acid" disabled={(value.trim().length < 2 && attachments.length === 0) || sending || disabled} type="submit">
            {sending ? <TypingDots /> : <>{text("发送", "SEND")}<SendIcon /></>}
          </button>
        </footer>
      </form>
    </div>
  );
}

function formatMessageCompletedAt(timestamp: string, locale: "zh" | "en", full = false): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(localeTag(locale), full
    ? { dateStyle: "medium", timeStyle: "medium" }
    : { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(date);
}

function AgentProgressPanel({
  progress,
}: Readonly<{ progress: Readonly<{
  running: boolean;
  state: "RUNNING" | "RETRY" | "FAILED";
  role: ConversationDisplayAgentRole;
  events: readonly AgentProgressEvent[];
  error: string | null;
}> }>) {
  const { locale, text } = useLanguage();
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const followLatest = useRef(true);
  const rows = useMemo(() => agentProgressDisplayRows(progress.events), [progress.events]);
  const jobId = progress.events.at(-1)?.jobId ?? null;
  const identity = agentIdentity(progress.role, text);

  useLayoutEffect(() => {
    followLatest.current = true;
    const viewport = viewportRef.current;
    if (viewport) viewport.scrollTop = viewport.scrollHeight;
  }, [jobId]);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || !followLatest.current) return;
    viewport.scrollTop = viewport.scrollHeight;
  }, [progress.running, rows]);

  return (
    <article aria-live="polite" className={`conversation-box-message assistant agent-generation-progress role-${progress.role.toLowerCase()}`}>
      <span className="message-avatar">{identity.avatar}</span>
      <div>
        <header>
          <b>{identity.name}</b>
          <span className="conversation-agent-working">{progress.state === "FAILED"
            ? text("执行失败", "Failed")
            : progress.state === "RETRY" ? text("等待重试", "Retrying") : text("正在工作", "Working")}</span>
        </header>
        <div
          className="agent-generation-progress-events"
          onScroll={event => {
            const viewport = event.currentTarget;
            followLatest.current = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= 24;
          }}
          ref={viewportRef}
        >
          {rows.map(row => (
            <p className={`progress-${row.kind.toLowerCase()}`} key={row.sequence}>{localizedAgentProgressContent(row, locale)}</p>
          ))}
          {progress.state === "FAILED" && progress.error ? <p className="progress-failed">{progress.error}</p> : null}
          {progress.running ? <TypingDots /> : null}
        </div>
      </div>
    </article>
  );
}

function isConversationAttachmentType(value: string): value is ConversationAttachmentContentType {
  return CONVERSATION_ATTACHMENT_CONTENT_TYPES.includes(value as ConversationAttachmentContentType);
}

function hasDraggedFiles(event: DragEvent<HTMLElement>): boolean {
  return [...event.dataTransfer.types].includes("Files");
}

function conversationFileContentType(file: File): ConversationAttachmentContentType | null {
  const browserType = file.type === "image/x-tiff" ? "image/tiff" : file.type;
  if (isConversationAttachmentType(browserType)) return browserType;
  const extension = file.name.split(".").at(-1)?.toLowerCase();
  const inferred: Record<string, ConversationAttachmentContentType> = {
    pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
    webp: "image/webp", gif: "image/gif", tif: "image/tiff", tiff: "image/tiff",
    avif: "image/avif", heic: "image/heic", heif: "image/heif",
  };
  return extension ? inferred[extension] ?? null : null;
}

function readConversationAttachment(file: File): Promise<ConversationAttachmentDraft> {
  return new Promise((resolve, reject) => {
    const contentType = conversationFileContentType(file);
    if (!contentType) return reject(new Error("Attachment read failed"));
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Attachment read failed"));
    reader.onload = () => {
      if (typeof reader.result !== "string") return reject(new Error("Attachment read failed"));
      const marker = reader.result.indexOf(",");
      if (marker < 0) return reject(new Error("Attachment read failed"));
      resolve(Object.freeze({
        id: crypto.randomUUID(),
        filename: file.name,
        contentType,
        sizeBytes: file.size,
        dataBase64: reader.result.slice(marker + 1),
        previewUrl: isBrowserPreviewableImage(contentType) ? reader.result : null,
      }));
    };
    reader.readAsDataURL(file);
  });
}

function conversationAttachmentUrl(conversationId: string | null, messageId: string, attachmentId: string, previewUrl?: string | null): string {
  if (previewUrl) return previewUrl;
  if (!conversationId) return "";
  return `/api/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`;
}

function isBrowserPreviewableImage(contentType: ConversationAttachmentContentType): boolean {
  return ["image/png", "image/jpeg", "image/webp", "image/gif", "image/avif"].includes(contentType);
}

function imageFormatLabel(contentType: ConversationAttachmentContentType): string {
  return contentType.split("/").at(-1)?.toUpperCase() ?? "FILE";
}

function formatAttachmentBytes(sizeBytes: number): string {
  return sizeBytes >= 1024 * 1024
    ? `${(sizeBytes / 1024 / 1024).toFixed(1)} MB`
    : `${Math.max(1, Math.ceil(sizeBytes / 1024))} KB`;
}

function conversationIntent(metadata: Readonly<Record<string, unknown>>): string | null {
  const decision = metadata.intentDecision;
  if (!decision || typeof decision !== "object" || Array.isArray(decision)) return null;
  const intent = (decision as Record<string, unknown>).intent;
  return ["QUESTION", "CHANGE_REQUEST", "CONFIRM_CHANGE", "REJECT_CHANGE"].includes(String(intent))
    ? String(intent) : null;
}

type ConversationDisplayAgentRole = ProjectRuntimeRole;

function messageAgentRole(message: ProductConversationMessage): ConversationDisplayAgentRole {
  const role = message.metadata.agentRole;
  if (role === "ANALYSIS" || message.metadata.source === "PROJECT_IMPORT_AGENT") return "ANALYSIS";
  return role === "UI_DESIGN" || role === "DEVELOPMENT" || role === "TEST" || role === "DESIGN" ? role : "DESIGN";
}

function agentIdentity(
  role: ConversationDisplayAgentRole,
  text: (chinese: string, english: string) => string,
): Readonly<{ avatar: string; name: string; shortName: string; responsibility: string }> {
  if (role === "INTENT") return Object.freeze({
    avatar: "IN",
    name: text("DeviLudo 意图 Agent", "DeviLudo Intent Agent"),
    shortName: text("意图", "INTENT"),
    responsibility: text("轻量路由", "Lightweight routing"),
  });
  if (role === "ANALYSIS") return Object.freeze({
    avatar: "AN",
    name: text("DeviLudo 分析 Agent", "DeviLudo Analysis Agent"),
    shortName: text("分析", "ANALYSIS"),
    responsibility: text("源码与现状分析", "Source analysis"),
  });
  if (role === "DEVELOPMENT") return Object.freeze({
    avatar: "DV",
    name: text("DeviLudo 开发 Agent", "DeviLudo Development Agent"),
    shortName: text("开发", "DEV"),
    responsibility: text("实现与工程", "Implementation"),
  });
  if (role === "UI_DESIGN") return Object.freeze({
    avatar: "UI",
    name: text("DeviLudo UI 设计 Agent", "DeviLudo UI Design Agent"),
    shortName: text("UI 设计", "UI DESIGN"),
    responsibility: text("界面与交互规格", "Interface design"),
  });
  if (role === "TEST") return Object.freeze({
    avatar: "QA",
    name: text("DeviLudo 测试 Agent", "DeviLudo Test Agent"),
    shortName: text("测试", "TEST"),
    responsibility: text("验收与回归", "Acceptance"),
  });
  return Object.freeze({
    avatar: "DS",
    name: text("DeviLudo 设计 Agent", "DeviLudo Design Agent"),
    shortName: text("设计", "DESIGN"),
    responsibility: text("玩法与规格", "Game design"),
  });
}

function conversationOptions(metadata: Readonly<Record<string, unknown>>): readonly ConversationReplyOption[] {
  return normalizeConversationReplyOptions(metadata.options);
}
