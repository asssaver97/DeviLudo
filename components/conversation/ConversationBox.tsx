"use client";

import {
  useLayoutEffect,
  useMemo,
  useRef,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import {
  PROJECT_AGENT_ROLES,
  type AgentProgressEvent,
  type ProductConversationMessage,
  type ProjectAgentRole,
} from "@/lib/product/contracts";
import { agentProgressDisplayRows, localizedAgentProgressContent } from "@/lib/product/agent-progress";
import { PlusIcon, SendIcon } from "../console/Icons";
import { TypingDots } from "../console/TypingDots";
import { useLanguage } from "../i18n/LanguageProvider";

type ConversationBoxProps = Readonly<{
  conversationKey: string | null;
  messages: readonly ProductConversationMessage[];
  sending: boolean;
  streamingReplies: Readonly<Partial<Record<ProjectAgentRole, string>>>;
  agentProgress?: Readonly<{ running: boolean; events: readonly AgentProgressEvent[] }>;
  showSendingReply?: boolean;
  value: string;
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
  const progressViewport = useRef<HTMLDivElement | null>(null);
  const textarea = useRef<HTMLTextAreaElement | null>(null);
  const followLatestMessage = useRef(true);
  const followLatestProgress = useRef(true);
  const progressRows = useMemo(
    () => agentProgressDisplayRows(agentProgress?.events ?? Object.freeze([])),
    [agentProgress?.events],
  );
  const progressJobId = agentProgress?.events.at(-1)?.jobId ?? null;
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
  }, [agentProgress, messages, sending, showMessages, streamingReplies]);

  useLayoutEffect(() => {
    followLatestProgress.current = true;
    const viewport = progressViewport.current;
    if (viewport) viewport.scrollTop = viewport.scrollHeight;
  }, [progressJobId]);

  useLayoutEffect(() => {
    const viewport = progressViewport.current;
    if (!viewport || !followLatestProgress.current) return;
    viewport.scrollTop = viewport.scrollHeight;
  }, [agentProgress?.running, progressRows]);

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
                <p>{message.content}</p>
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
          }) : (
            <div className="conversation-box-empty">
              <PlusIcon />
              <b>{emptyTitle ?? text("开始新的项目会话", "START A PROJECT CONVERSATION")}</b>
              <p>{emptyDescription ?? text("讨论玩法，或告诉 DeviLudo 下一步要做什么。", "Discuss the gameplay or tell DeviLudo what to build next.")}</p>
            </div>
          )}
          {agentProgress?.running || agentProgress?.events.length ? (
            <article className="conversation-box-message assistant agent-generation-progress">
              <span className="message-avatar">AI</span>
              <div>
                <header>
                  <b>{text("DeviLudo 开发 Agent", "DeviLudo Development Agent")}</b>
                  {agentProgress.running ? <span className="conversation-box-applied">{text("生成中", "RUNNING")}</span> : null}
                </header>
                <div
                  className="agent-generation-progress-events"
                  onScroll={event => {
                    const viewport = event.currentTarget;
                    followLatestProgress.current = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= 24;
                  }}
                  ref={progressViewport}
                >
                  {progressRows.map(row => (
                    <p className={`progress-${row.kind.toLowerCase()}`} key={row.sequence}>{localizedAgentProgressContent(row, locale)}</p>
                  ))}
                  {agentProgress.running ? <TypingDots /> : null}
                </div>
              </div>
            </article>
          ) : null}
          {sending && showSendingReply ? (
            (PROJECT_AGENT_ROLES.filter(role => Boolean(streamingReplies[role])).length
              ? PROJECT_AGENT_ROLES.filter(role => Boolean(streamingReplies[role]))
              : ["DESIGN" as const]).map(role => {
                const identity = agentIdentity(role, text);
                return (
                  <article className={`conversation-box-message assistant is-thinking role-${role.toLowerCase()}`} key={`stream-${role}`}>
                    <span className="message-avatar">{identity.avatar}</span>
                    <div>
                      <header><b>{identity.name}</b><span className="conversation-agent-working">{text("正在回复", "RESPONDING")}</span></header>
                      <p>{streamingReplies[role] || <TypingDots />}</p>
                    </div>
                  </article>
                );
              })
          ) : null}
        </div>
      ) : null}

      <form
        className="conversation-box-composer"
        onSubmit={event => {
          followLatestMessage.current = true;
          onSubmit(event);
        }}
      >
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
        <footer>
          <span><kbd>⌘</kbd><kbd>↵</kbd> {text("发送 · Enter 换行", "SEND · ENTER FOR NEW LINE")}</span>
          <span className="conversation-box-count">{value.length}/4000</span>
          {disabled ? null : primaryAction}
          <button aria-label={sendButtonLabel} className="button button-acid" disabled={value.trim().length < 2 || sending || disabled} type="submit">
            {sending ? <TypingDots /> : <>{text("发送", "SEND")}<SendIcon /></>}
          </button>
        </footer>
      </form>
    </div>
  );
}

function messageAgentRole(message: ProductConversationMessage): ProjectAgentRole {
  const role = message.metadata.agentRole;
  return role === "DEVELOPMENT" || role === "TEST" || role === "DESIGN" ? role : "DESIGN";
}

function agentIdentity(
  role: ProjectAgentRole,
  text: (chinese: string, english: string) => string,
): Readonly<{ avatar: string; name: string; shortName: string; responsibility: string }> {
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
