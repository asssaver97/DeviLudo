"use client";

import {
  useLayoutEffect,
  useMemo,
  useRef,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import type { AgentProgressEvent, ProductConversationMessage } from "@/lib/product/contracts";
import { agentProgressDisplayRows } from "@/lib/product/agent-progress";
import { PlusIcon, SendIcon } from "../console/Icons";
import { TypingDots } from "../console/TypingDots";
import { useLanguage } from "../i18n/LanguageProvider";

type ConversationBoxProps = Readonly<{
  conversationKey: string | null;
  messages: readonly ProductConversationMessage[];
  sending: boolean;
  streamingReply: string;
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
  streamingReply,
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
  const { text } = useLanguage();
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

  useLayoutEffect(() => {
    followLatestMessage.current = true;
    const viewport = messageViewport.current;
    if (viewport) viewport.scrollTop = viewport.scrollHeight;
  }, [conversationKey]);

  useLayoutEffect(() => {
    const viewport = messageViewport.current;
    if (!showMessages || !viewport || !followLatestMessage.current) return;
    viewport.scrollTop = viewport.scrollHeight;
  }, [agentProgress, messages, sending, showMessages, streamingReply]);

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
          {intro}
          {messages.length ? messages.map((message, index) => {
            const failed = message.role === "USER" && message.metadata.failed === true;
            const options = index === messages.length - 1 && message.role === "ASSISTANT" && !sending
              ? conversationOptions(message.metadata)
              : Object.freeze([]);
            return (
            <article className={`conversation-box-message ${message.role === "USER" ? "user" : "assistant"}${failed ? " is-failed" : ""}`} key={message.id}>
              {message.role === "ASSISTANT" ? <span className="message-avatar">DL</span> : null}
              <div>
                <header>
                  <b>{message.role === "ASSISTANT" ? text("DeviLudo 设计搭档", "DeviLudo Design Partner") : text("你", "You")}</b>
                  {message.role === "ASSISTANT" && message.metadata.appliedToDraft === true
                    ? <span className="conversation-box-applied">{text("已同步项目", "PROJECT SYNCED")}</span>
                    : null}
                  {failed ? (
                    <span
                      className="conversation-box-failed"
                      title={typeof message.metadata.failureMessage === "string" ? message.metadata.failureMessage : undefined}
                    >
                      {text("未保存 · 可重试", "NOT SAVED · RETRY")}
                    </span>
                  ) : null}
                </header>
                <p>{message.content}</p>
                {failed && typeof message.metadata.failureMessage === "string" ? (
                  <small className="conversation-box-failure-detail">{message.metadata.failureMessage}</small>
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
                    <p className={`progress-${row.kind.toLowerCase()}`} key={row.sequence}>{row.content}</p>
                  ))}
                  {agentProgress.running ? <TypingDots /> : null}
                </div>
              </div>
            </article>
          ) : null}
          {sending && showSendingReply ? (
            <article className="conversation-box-message assistant is-thinking">
              <span className="message-avatar">DL</span>
              <div>
                <header><b>{text("DeviLudo 设计搭档", "DeviLudo Design Partner")}</b></header>
                <p>{streamingReply || <TypingDots />}</p>
              </div>
            </article>
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

function conversationOptions(metadata: Readonly<Record<string, unknown>>): readonly string[] {
  if (!Array.isArray(metadata.options)) return Object.freeze([]);
  return Object.freeze(metadata.options.filter((option): option is string => (
    typeof option === "string" && option.trim().length > 0 && option.length <= 160
  )).slice(0, 5));
}
