"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { cachedValue, clientCacheKeys, loadCached, storeCached } from "@/lib/product/client-cache";
import type { ProductConversation, ProductProjectSummary, ProjectAgentRole } from "@/lib/product/contracts";
import {
  chronologicalMessages,
  ConversationStreamError,
  failedOptimisticConversation,
  optimisticConversation,
  sendConversationMessageStream,
} from "@/lib/product/conversation-stream";
import { ConversationBox } from "./conversation/ConversationBox";
import { GamepadIcon, PlusIcon, SparkIcon } from "./console/Icons";
import { useLanguage } from "./i18n/LanguageProvider";

const STARTERS_ZH = Object.freeze([
  "我想做一款能在十分钟内完成一局的合作游戏",
  "设计一个以时间循环为核心的像素冒险游戏",
  "帮我梳理一款轻量策略游戏的核心玩法",
]);
const STARTERS_EN = Object.freeze([
  "Design a co-op game that takes ten minutes per run",
  "Design a pixel adventure built around a time loop",
  "Help me shape the core loop of a lightweight strategy game",
]);
const IMPORT_PROJECT_VALUE = "__import_existing_project__";

export function HomeChat() {
  const { errorText, locale, text } = useLanguage();
  const router = useRouter();
  const initialProjects = cachedValue<readonly ProductProjectSummary[]>(clientCacheKeys.projects);
  const [projects, setProjects] = useState<readonly ProductProjectSummary[]>(initialProjects ?? []);
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [conversation, setConversation] = useState<ProductConversation | null>(null);
  const [content, setContent] = useState("");
  const [loadingProjects, setLoadingProjects] = useState(!initialProjects);
  const [sending, setSending] = useState(false);
  const [startingDevelopment, setStartingDevelopment] = useState(false);
  const [streamingReplies, setStreamingReplies] = useState<Partial<Record<ProjectAgentRole, string>>>({});
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void loadCached(clientCacheKeys.projects, 10_000, async () => {
        const response = await fetch("/api/projects");
        if (response.status === 409) return [];
        if (!response.ok) throw new Error(text("项目列表加载失败", "Unable to load projects"));
        return (await response.json() as { projects: readonly ProductProjectSummary[] }).projects;
      })
      .then(value => { if (active) setProjects(value); })
      .catch(() => { if (active) setError(text("暂时无法加载现有项目，但仍可开始新游戏对话。", "Existing projects could not be loaded, but you can still start a new game conversation.")); })
      .finally(() => { if (active) setLoadingProjects(false); });
    return () => { active = false; };
  }, [text]);

  const activeProjectId = conversation?.projectId || selectedProjectId;
  const activeProject = useMemo(
    () => projects.find(project => project.id === activeProjectId) ?? null,
    [activeProjectId, projects],
  );
  const placeholder = activeProject
    ? text(`告诉我想如何继续开发或修改《${activeProject.name}》…`, `Tell me how you want to continue or change “${activeProject.name}”…`)
    : text("描述你想做的游戏、玩家体验，或任何还没有想清楚的细节…", "Describe the game, player experience, or any idea you have not fully worked out yet…");
  const starters = locale === "en" ? STARTERS_EN : STARTERS_ZH;
  const orderedMessages = useMemo(
    () => chronologicalMessages(conversation?.messages ?? Object.freeze([])),
    [conversation],
  );
  const latestConversationMessage = orderedMessages.at(-1);
  const requirementsReady = activeProject?.workflowState === "DRAFT"
    && latestConversationMessage?.role === "ASSISTANT"
    && latestConversationMessage.metadata.readyForDevelopment === true;

  async function sendMessage(event?: FormEvent<HTMLFormElement>, selectedOption?: string) {
    event?.preventDefault();
    const message = (selectedOption ?? content).trim();
    if (message.length < 2 || sending) return;
    const previousConversation = conversation;
    const projectId = previousConversation?.projectId || selectedProjectId;
    const pendingConversation = optimisticConversation(
      previousConversation,
      projectId,
      message,
      activeProject?.name ?? text("新游戏构想", "New game concept"),
    );
    setSending(true);
    setError(null);
    setStreamingReplies({});
    setConversation(pendingConversation);
    setContent("");
    try {
      const body = previousConversation && !previousConversation.id.startsWith("pending-")
        ? { conversationId: previousConversation.id, content: message }
        : { projectId: selectedProjectId || null, content: message };
      const result = await sendConversationMessageStream(
        body,
        `conversation:${crypto.randomUUID()}`,
        (agentRole, delta) => setStreamingReplies(current => ({
          ...current,
          [agentRole]: `${current[agentRole] ?? ""}${delta}`,
        })),
      );
      setProjects(current => {
        const next = current.some(project => project.id === result.project.id)
          ? current.map(project => project.id === result.project.id ? result.project : project)
          : Object.freeze([result.project, ...current]);
        storeCached(clientCacheKeys.projects, next, 10_000);
        return next;
      });
      setConversation(result.conversation);
      setSelectedProjectId(result.conversation.projectId);
      if ((activeProject?.workflowState ?? "DRAFT") === "DRAFT" && result.project.workflowState !== "DRAFT") {
        router.push(`/projects/${result.project.id}`);
      }
    } catch (cause) {
      const failureMessage = cause instanceof ConversationStreamError
        ? errorText(cause.message, "消息发送失败，请稍后重试", "Message failed. Please try again.")
        : text("消息发送失败，请稍后重试", "Message failed. Please try again.");
      setConversation(failedOptimisticConversation(pendingConversation, failureMessage));
      setContent(message);
      setError(failureMessage);
      if (cause instanceof ConversationStreamError && cause.code === "AGENT_CONFIG_REQUIRED") {
        router.push("/settings?required=conversation");
        return;
      }
    } finally {
      setStreamingReplies({});
      setSending(false);
    }
  }

  function startFreshConversation() {
    setConversation(null);
    setSelectedProjectId("");
    setContent("");
    setError(null);
  }

  async function startDevelopment() {
    if (!activeProject || activeProject.workflowState !== "DRAFT" || !requirementsReady || startingDevelopment) return;
    setStartingDevelopment(true);
    setError(null);
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(activeProject.id)}/approve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      const payload = await response.json().catch(() => ({})) as { message?: string };
      if (!response.ok) throw new Error(errorText(payload.message, `操作失败 (${response.status})`, `Operation failed (${response.status})`));
      router.push(`/projects/${activeProject.id}`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : text("暂时无法开始开发", "Unable to start development"));
      setStartingDevelopment(false);
    }
  }

  const projectSelector = (
    <div className="homeChat-contextRow">
      <label>
        <GamepadIcon />
        <span>{text("关联项目", "PROJECT")}</span>
        <select
          aria-label={text("关联项目", "Related project")}
          disabled={Boolean(conversation) || loadingProjects}
          onChange={event => {
            if (event.target.value === IMPORT_PROJECT_VALUE) {
              router.push("/projects/import");
              return;
            }
            setSelectedProjectId(event.target.value);
          }}
          value={activeProjectId}
        >
          <option value="">{text("创建新项目", "Create new project")}</option>
          <option value={IMPORT_PROJECT_VALUE}>{text("关联已有项目…", "Link existing project…")}</option>
          {projects.map(project => (
            <option disabled={project.analysisStatus !== "READY" && project.analysisStatus !== "NEEDS_INPUT"} key={project.id} value={project.id}>
              {project.name} · {project.analysisStatus === "PENDING" || project.analysisStatus === "ANALYZING"
                ? text("正在分析", "Analyzing")
                : project.analysisStatus === "FAILED"
                  ? text("分析失败", "Analysis failed")
                  : project.analysisStatus === "NEEDS_INPUT"
                    ? text("待确认分析问题", "Needs clarification")
                  : workflowLabel(project.workflowState, text)}
            </option>
          ))}
        </select>
      </label>
    </div>
  );

  const developmentAction = requirementsReady && !sending ? (
    <button className="button button-secondary conversation-box-develop" disabled={startingDevelopment} onClick={() => void startDevelopment()} type="button">
      {startingDevelopment ? text("正在开始开发…", "STARTING…") : text("按照当前需求开发", "BUILD CURRENT REQUIREMENTS")}
    </button>
  ) : null;

  const conversationBox = (
    <ConversationBox
      autoFocus={!conversation}
      className="home-conversation-box"
      composerPrefix={projectSelector}
      conversationKey={conversation?.id ?? null}
      intro={conversation ? <div className="conversation-date"><span>{text("项目群聊", "PROJECT GROUP CHAT")}</span></div> : null}
      messages={orderedMessages}
      onOptionSelect={option => void sendMessage(undefined, option)}
      onSubmit={sendMessage}
      onValueChange={setContent}
      placeholder={placeholder}
      primaryAction={developmentAction}
      sendButtonLabel={text("发送消息", "Send message")}
      sending={sending}
      showMessages={Boolean(conversation)}
      streamingReplies={streamingReplies}
      textareaLabel={text("游戏想法或修改意见", "Game idea or feedback")}
      value={content}
    />
  );

  return (
      <section className={`homeChat ${conversation ? "homeChat-active" : ""}`}>
        {conversation ? (
          <div className="conversation-panel homeChat-threadShell">
            <header className="conversation-header homeChat-threadHeader">
              <div>
                <span className="assistant-mark"><SparkIcon /></span>
                <span>
                  <b>{conversation.title}</b>
                  <small>{activeProject ? text(`正在继续开发《${activeProject.name}》`, `Continuing “${activeProject.name}”`) : text("正在梳理一个全新的游戏方向", "Shaping a new game direction")}</small>
                </span>
              </div>
              <div className="homeChat-threadActions">
                {activeProject ? <Link className="button button-secondary" href={`/projects/${activeProject.id}`}>{text("打开项目", "OPEN PROJECT")}</Link> : null}
                <button className="button button-secondary" onClick={startFreshConversation} type="button"><PlusIcon />{text("新对话", "NEW CHAT")}</button>
              </div>
            </header>
            {conversationBox}
          </div>
        ) : (
          <header className="simple-home-hero homeChat-hero">
            <span className="assistant-mark"><SparkIcon /></span>
            <span className="eyebrow">{text("FROM IDEA TO PLAYABLE / 从想法到可玩", "FROM IDEA TO PLAYABLE")}</span>
            <h1>{text("今天想做什么游戏？", "WHAT WILL YOU BUILD TODAY?")}</h1>
          </header>
        )}
        {!conversation ? conversationBox : null}

        {!conversation ? (
          <div aria-label={text("灵感示例", "Idea starters")} className="homeChat-starters">
            {starters.map(starter => <button key={starter} onClick={() => setContent(starter)} type="button">{starter}</button>)}
          </div>
        ) : null}
        {error ? <p className="homeChat-error" role="alert">{error}</p> : null}
      </section>
  );
}

function workflowLabel(state: string, text: (chinese: string, english: string) => string): string {
  const labels: Record<string, readonly [string, string]> = {
    DRAFT: ["需求讨论中", "Requirements discussion"],
    AGENT_RUNNING: ["Agent 生成中", "Agent running"],
    ASSET_GENERATING: ["图片素材生成中", "Generating image assets"],
    ARTIFACT_BUILDING: ["制品构建中", "Building artifacts"],
    E2E_TESTING: ["跨平台测试中", "Cross-platform testing"],
    RELEASE_DECISION_PENDING: ["等待发布决策", "Awaiting release decision"],
    SIGNING: ["平台签名中", "Signing"],
    RELEASE_APPROVAL_PENDING: ["等待发布批准", "Awaiting release approval"],
    STEAM_PUBLISHING: ["Steam 发布中", "Publishing to Steam"],
    CLEAN_INSTALL_VERIFYING: ["干净回装验证中", "Clean-install verification"],
    SUCCEEDED: ["交付完成", "Delivered"],
    FAILED: ["流程失败", "Failed"],
    CANCELLED: ["已取消", "Cancelled"],
  };
  const label = labels[state];
  return label ? text(label[0], label[1]) : state;
}
