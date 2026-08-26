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
  MAX_CONVERSATION_IMAGES,
  MAX_CONVERSATION_IMAGE_BYTES,
  MAX_CONVERSATION_IMAGE_TOTAL_BYTES,
  PROJECT_AGENT_ROLES,
  type AgentProgressEvent,
  type ProductConversationMessage,
  type ProjectAgentRole,
} from "@/lib/product/contracts";
import {
  streamingConversationReplyIsActive,
  type ConversationImageDraft,
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
  streamingReplies: StreamingConversationReplies;
  agentProgress?: Readonly<{ running: boolean; events: readonly AgentProgressEvent[] }>;
  showSendingReply?: boolean;
  value: string;
  attachments: readonly ConversationImageDraft[];
  onAttachmentsChange: (attachments: readonly ConversationImageDraft[]) => void;
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
  const textarea = useRef<HTMLTextAreaElement | null>(null);
  const imageInput = useRef<HTMLInputElement | null>(null);
  const imageDragDepth = useRef(0);
  const [imageError, setImageError] = useState<string | null>(null);
  const [imageDropActive, setImageDropActive] = useState(false);
  const followLatestMessage = useRef(true);
  const latestProgressSequence = agentProgress?.events.at(-1)?.sequence ?? null;
  const latestOptionMessageId = useMemo(() => {
    if (sending) return null;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message.role === "ASSISTANT" && conversationOptions(message.metadata).length > 0) return message.id;
    }
    return null;
  }, [messages, sending]);

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

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  }

  async function addImages(files: readonly File[]) {
    if (!files.length) return;
    if (attachments.length + files.length > MAX_CONVERSATION_IMAGES) {
      setImageError(text(`最多发送 ${MAX_CONVERSATION_IMAGES} 张图片`, `Attach up to ${MAX_CONVERSATION_IMAGES} images`));
      return;
    }
    if (files.some(file => !isConversationImageType(file.type) || file.size < 1 || file.size > MAX_CONVERSATION_IMAGE_BYTES)) {
      const limitMiB = MAX_CONVERSATION_IMAGE_BYTES / 1024 / 1024;
      setImageError(text(
        `仅支持 ${limitMiB} MB 以内的 PNG、JPEG 或 WebP 图片`,
        `Use PNG, JPEG, or WebP images up to ${limitMiB} MB each`,
      ));
      return;
    }
    if (attachments.reduce((total, item) => total + item.sizeBytes, 0)
      + files.reduce((total, item) => total + item.size, 0) > MAX_CONVERSATION_IMAGE_TOTAL_BYTES) {
      setImageError(text("图片总大小不能超过 12 MB", "Images may total up to 12 MB"));
      return;
    }
    try {
      const drafts = await Promise.all(files.map(readConversationImage));
      onAttachmentsChange(Object.freeze([...attachments, ...drafts]));
      setImageError(null);
    } catch {
      setImageError(text("图片读取失败，请重新选择", "Unable to read the image. Select it again."));
    }
  }

  function handleImages(event: ChangeEvent<HTMLInputElement>) {
    const files = [...(event.target.files ?? [])];
    event.target.value = "";
    void addImages(files);
  }

  function handleImageDragEnter(event: DragEvent<HTMLFormElement>) {
    if (!hasDraggedFiles(event) || sending || disabled) return;
    event.preventDefault();
    imageDragDepth.current += 1;
    setImageDropActive(true);
  }

  function handleImageDragOver(event: DragEvent<HTMLFormElement>) {
    if (!hasDraggedFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }

  function handleImageDragLeave(event: DragEvent<HTMLFormElement>) {
    if (!hasDraggedFiles(event)) return;
    event.preventDefault();
    imageDragDepth.current = Math.max(0, imageDragDepth.current - 1);
    if (imageDragDepth.current === 0) setImageDropActive(false);
  }

  function handleImageDrop(event: DragEvent<HTMLFormElement>) {
    if (!hasDraggedFiles(event)) return;
    event.preventDefault();
    imageDragDepth.current = 0;
    setImageDropActive(false);
    if (sending || disabled) return;
    void addImages([...event.dataTransfer.files]);
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
                  <div className="conversation-message-images">
                    {(message.attachments ?? []).map(image => (
                      <a href={conversationImageUrl(conversationKey, message.id, image.id, image.previewUrl)} key={image.id} rel="noreferrer" target="_blank">
                        <Image
                          alt={image.filename}
                          height={360}
                          src={conversationImageUrl(conversationKey, message.id, image.id, image.previewUrl)}
                          unoptimized
                          width={480}
                        />
                      </a>
                    ))}
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
                      <button disabled={sending || disabled} key={option} onClick={() => onOptionSelect(option)} type="button">{option}</button>
                    ))}
                  </div>
                ) : null}
              </div>
            </article>
          );
          }) : !agentProgress?.running ? (
            <div className="conversation-box-empty">
              <PlusIcon />
              <b>{emptyTitle ?? text("开始新的项目会话", "START A PROJECT CONVERSATION")}</b>
              <p>{emptyDescription ?? text("讨论玩法，或告诉 DeviLudo 下一步要做什么。", "Discuss the gameplay or tell DeviLudo what to build next.")}</p>
            </div>
          ) : null}
          {agentProgress?.running ? <AgentProgressPanel progress={agentProgress} /> : null}
          {sending && showSendingReply && !PROJECT_AGENT_ROLES.some(role => Boolean(streamingReplies[role])) ? (
            <article className="conversation-box-message assistant is-thinking role-intent">
              <span className="message-avatar">IN</span>
              <div>
                <header>
                  <b>{text("Intent Agent", "Intent Agent")}</b>
                  <span className="conversation-agent-working">{text("正在识别意图", "Identifying intent")}</span>
                </header>
                <p><TypingDots /></p>
              </div>
            </article>
          ) : null}
          {sending && showSendingReply ? (
            PROJECT_AGENT_ROLES.filter(role => Boolean(streamingReplies[role])).map(role => {
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
                        {reply.content}
                        {streamingConversationReplyIsActive(reply) ? <TypingDots /> : null}
                      </p>
                    </div>
                  </article>
                );
              })
          ) : null}
        </div>
      ) : null}

      <form
        className={`conversation-box-composer${imageDropActive ? " is-image-dragover" : ""}`}
        onDragEnter={handleImageDragEnter}
        onDragLeave={handleImageDragLeave}
        onDragOver={handleImageDragOver}
        onDrop={handleImageDrop}
        onSubmit={event => {
          followLatestMessage.current = true;
          onSubmit(event);
        }}
      >
        <span aria-hidden={!imageDropActive} className="conversation-image-drop-hint">
          {text("松开以添加图片", "Drop to attach images")}
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
          <div className="conversation-composer-images" aria-label={text("待发送图片", "Images to send")}>
            {attachments.map(image => (
              <figure key={image.id}>
                <Image alt={image.filename} height={144} src={image.previewUrl} unoptimized width={192} />
                <figcaption>{image.filename}</figcaption>
                <button
                  aria-label={text(`移除 ${image.filename}`, `Remove ${image.filename}`)}
                  disabled={sending || disabled}
                  onClick={() => onAttachmentsChange(Object.freeze(attachments.filter(candidate => candidate.id !== image.id)))}
                  type="button"
                ><CloseIcon /></button>
              </figure>
            ))}
          </div>
        ) : null}
        {imageError ? <p className="conversation-image-error" role="alert">{imageError}</p> : null}
        <footer>
          <input
            accept="image/png,image/jpeg,image/webp"
            aria-label={text("选择会话图片", "Choose conversation images")}
            disabled={sending || disabled}
            hidden
            multiple
            onChange={handleImages}
            ref={imageInput}
            type="file"
          />
          <button
            aria-label={text("添加图片", "Attach images")}
            className="conversation-image-button"
            disabled={sending || disabled || attachments.length >= MAX_CONVERSATION_IMAGES}
            onClick={() => imageInput.current?.click()}
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
}: Readonly<{ progress: Readonly<{ running: boolean; events: readonly AgentProgressEvent[] }> }>) {
  const { locale, text } = useLanguage();
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const followLatest = useRef(true);
  const rows = useMemo(() => agentProgressDisplayRows(progress.events), [progress.events]);
  const jobId = progress.events.at(-1)?.jobId ?? null;

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
    <article aria-live="polite" className="conversation-box-message assistant agent-generation-progress">
      <span className="message-avatar">RUN</span>
      <div>
        <header>
          <b>{text("游戏生成进度", "Game generation progress")}</b>
          <span className="conversation-box-applied">{text("生成中", "RUNNING")}</span>
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
          <TypingDots />
        </div>
      </div>
    </article>
  );
}

function isConversationImageType(value: string): value is ConversationImageDraft["contentType"] {
  return value === "image/png" || value === "image/jpeg" || value === "image/webp";
}

function hasDraggedFiles(event: DragEvent<HTMLElement>): boolean {
  return [...event.dataTransfer.types].includes("Files");
}

function readConversationImage(file: File): Promise<ConversationImageDraft> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Image read failed"));
    reader.onload = () => {
      if (typeof reader.result !== "string" || !isConversationImageType(file.type)) return reject(new Error("Image read failed"));
      const marker = reader.result.indexOf(",");
      if (marker < 0) return reject(new Error("Image read failed"));
      resolve(Object.freeze({
        id: crypto.randomUUID(),
        filename: file.name,
        contentType: file.type,
        sizeBytes: file.size,
        dataBase64: reader.result.slice(marker + 1),
        previewUrl: reader.result,
      }));
    };
    reader.readAsDataURL(file);
  });
}

function conversationImageUrl(conversationId: string | null, messageId: string, imageId: string, previewUrl?: string): string {
  if (previewUrl) return previewUrl;
  if (!conversationId) return "";
  return `/api/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}/images/${encodeURIComponent(imageId)}`;
}

function conversationIntent(metadata: Readonly<Record<string, unknown>>): string | null {
  const decision = metadata.intentDecision;
  if (!decision || typeof decision !== "object" || Array.isArray(decision)) return null;
  const intent = (decision as Record<string, unknown>).intent;
  return ["QUESTION", "CHANGE_REQUEST", "CONFIRM_CHANGE", "REJECT_CHANGE"].includes(String(intent))
    ? String(intent) : null;
}

type ConversationDisplayAgentRole = ProjectAgentRole | "ANALYSIS";

function messageAgentRole(message: ProductConversationMessage): ConversationDisplayAgentRole {
  const role = message.metadata.agentRole;
  if (role === "ANALYSIS" || message.metadata.source === "PROJECT_IMPORT_AGENT") return "ANALYSIS";
  return role === "DEVELOPMENT" || role === "TEST" || role === "DESIGN" ? role : "DESIGN";
}

function agentIdentity(
  role: ConversationDisplayAgentRole,
  text: (chinese: string, english: string) => string,
): Readonly<{ avatar: string; name: string; shortName: string; responsibility: string }> {
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

function conversationOptions(metadata: Readonly<Record<string, unknown>>): readonly string[] {
  if (!Array.isArray(metadata.options)) return Object.freeze([]);
  return Object.freeze(metadata.options.filter((option): option is string => (
    typeof option === "string" && option.trim().length > 0 && option.length <= 160
  )).slice(0, 5));
}
