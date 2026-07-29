"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import type { ProductConversation, ProductProjectSummary, WorkspaceSummary } from "@/lib/product/contracts";
import { WORKFLOW_LABELS } from "@/lib/product/contracts";
import { ProductShell } from "./ProductShell";
import { GamepadIcon, PlusIcon, SendIcon, SparkIcon } from "./console/Icons";

const STARTERS = Object.freeze([
  "我想做一款能在十分钟内完成一局的合作游戏",
  "设计一个以时间循环为核心的像素冒险游戏",
  "帮我梳理一款轻量策略游戏的核心玩法",
]);

export function HomeChat() {
  const [projects, setProjects] = useState<readonly ProductProjectSummary[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [conversation, setConversation] = useState<ProductConversation | null>(null);
  const [content, setContent] = useState("");
  const [loadingProjects, setLoadingProjects] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const threadEnd = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/projects", { signal: controller.signal })
      .then(async response => {
        if (response.status === 409) return [];
        if (!response.ok) throw new Error("项目列表加载失败");
        return (await response.json() as { projects: readonly ProductProjectSummary[] }).projects;
      })
      .then(value => { if (!controller.signal.aborted) setProjects(value); })
      .catch(() => { if (!controller.signal.aborted) setError("暂时无法加载现有项目，但仍可开始新游戏对话。"); })
      .finally(() => { if (!controller.signal.aborted) setLoadingProjects(false); });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (conversation) threadEnd.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [conversation]);

  const activeProjectId = conversation?.projectId || selectedProjectId;
  const activeProject = useMemo(
    () => projects.find(project => project.id === activeProjectId) ?? null,
    [activeProjectId, projects],
  );
  const placeholder = activeProject
    ? `告诉我想如何继续开发或修改《${activeProject.name}》…`
    : "描述你想做的游戏、玩家体验，或任何还没有想清楚的细节…";

  async function sendMessage(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    const message = content.trim();
    if (message.length < 2 || sending) return;
    setSending(true);
    setError(null);
    try {
      const body = conversation
        ? { conversationId: conversation.id, content: message }
        : { projectId: selectedProjectId || null, content: message };
      const response = await fetch("/api/conversations/messages", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": `conversation:${crypto.randomUUID()}` },
        body: JSON.stringify(body),
      });
      const result = await response.json() as {
        code?: string;
        message?: string;
        workspace?: WorkspaceSummary;
        project?: ProductProjectSummary;
        conversation?: ProductConversation;
      };
      if (!response.ok || !result.conversation) {
        if (result.code === "AGENT_CONFIG_REQUIRED" || result.code === "AGENT_NAMING_FAILED") {
          window.location.assign("/settings?required=project-name");
          return;
        }
        throw new Error(response.status === 404 ? "所选项目或对话已不存在" : result.message ?? "消息发送失败");
      }
      if (result.workspace) window.dispatchEvent(new CustomEvent("deviludo:workspace-changed", { detail: result.workspace }));
      if (result.project) setProjects(current => current.some(project => project.id === result.project!.id) ? current : Object.freeze([result.project!, ...current]));
      setConversation(result.conversation);
      setSelectedProjectId(result.conversation.projectId);
      setContent("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "消息发送失败，请稍后重试");
    } finally {
      setSending(false);
    }
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  }

  function startFreshConversation() {
    setConversation(null);
    setSelectedProjectId("");
    setContent("");
    setError(null);
  }

  return (
    <ProductShell>
      <section className={`homeChat ${conversation ? "homeChat-active" : ""}`}>
        {conversation ? (
          <div className="conversation-panel homeChat-threadShell">
            <header className="conversation-header homeChat-threadHeader">
              <div>
                <span className="assistant-mark"><SparkIcon /></span>
                <span>
                  <b>{conversation.title}</b>
                  <small>{activeProject ? `正在继续开发《${activeProject.name}》` : "正在梳理一个全新的游戏方向"}</small>
                </span>
              </div>
              <div className="homeChat-threadActions">
                {activeProject ? <Link className="button button-secondary" href={`/projects/${activeProject.id}`}>打开项目</Link> : null}
                <button className="button button-secondary" onClick={startFreshConversation} type="button"><PlusIcon />新对话</button>
              </div>
            </header>

            <div aria-live="polite" className="conversation-stream homeChat-messages">
              <div className="conversation-date"><span>设计会话</span></div>
              {conversation.messages.map(message => (
                <article className={`message ${message.role === "USER" ? "user" : "assistant"} homeChat-message`} key={message.id}>
                  {message.role === "ASSISTANT" ? <span className="message-avatar">DL</span> : null}
                  <div>
                    <header>
                      <b>{message.role === "ASSISTANT" ? "DeviLudo 设计搭档" : "你"}</b>
                      {message.role === "ASSISTANT" && message.metadata.appliedToDraft === true
                        ? <span className="homeChat-applied">已写入规格草案</span>
                        : null}
                    </header>
                    <p>{message.content}</p>
                  </div>
                </article>
              ))}
              {sending ? (
                <article className="message assistant homeChat-message homeChat-thinking">
                  <span className="message-avatar">DL</span>
                  <div><header><b>DeviLudo 设计搭档</b></header><p>正在整理你的想法<span>...</span></p></div>
                </article>
              ) : null}
              <div ref={threadEnd} />
            </div>
          </div>
        ) : (
          <header className="simple-home-hero homeChat-hero">
            <span className="assistant-mark"><SparkIcon /></span>
            <span className="eyebrow">FROM IDEA TO PLAYABLE / 从想法到可玩</span>
            <h1>今天想做什么游戏？</h1>
          </header>
        )}

        <form className="homeChat-composer" onSubmit={sendMessage}>
          <div className="homeChat-contextRow">
            <label>
              <GamepadIcon />
              <span>关联项目</span>
              <select
                aria-label="关联项目"
                disabled={Boolean(conversation) || loadingProjects}
                onChange={event => setSelectedProjectId(event.target.value)}
                value={activeProjectId}
              >
                <option value="">创建新项目</option>
                {projects.map(project => (
                  <option key={project.id} value={project.id}>
                    {project.name} · {WORKFLOW_LABELS[project.workflowState] ?? project.workflowState}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <textarea
            aria-label="游戏想法或修改意见"
            autoFocus={!conversation}
            disabled={sending}
            maxLength={4000}
            onChange={event => setContent(event.target.value)}
            onKeyDown={handleComposerKeyDown}
            placeholder={placeholder}
            rows={conversation ? 3 : 5}
            value={content}
          />
          <footer>
            <span><kbd>⌘</kbd><kbd>↵</kbd> 发送 · Enter 换行</span>
            <span className="homeChat-count">{content.length}/4000</span>
            <button aria-label="发送消息" className="button button-acid" disabled={content.trim().length < 2 || sending} type="submit">
              {sending ? "整理中" : "发送"}<SendIcon />
            </button>
          </footer>
        </form>

        {!conversation ? (
          <div aria-label="灵感示例" className="homeChat-starters">
            {STARTERS.map(starter => <button key={starter} onClick={() => setContent(starter)} type="button">{starter}</button>)}
          </div>
        ) : null}
        {error ? <p className="homeChat-error" role="alert">{error}</p> : null}
      </section>
    </ProductShell>
  );
}
