"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { cachedValue, clientCacheKeys, loadCached, storeCached } from "@/lib/product/client-cache";
import { isDevelopmentAuthorization, type ImplementationChangeRequest, type ProductConversation, type ProductProjectDetail, type ProductProjectSummary } from "@/lib/product/contracts";
import {
  appendStreamingConversationProcess,
  appendStreamingConversationReply,
  appendStreamingDevelopmentLog,
  chronologicalMessages,
  completeStreamingConversationReply,
  ConversationStreamError,
  failedOptimisticConversation,
  initialStreamingConversationReplies,
  optimisticConversation,
  recoverConversationAfterDisconnect,
  replaceStreamingConversationReply,
  sendConversationMessageStream,
  startStreamingConversationReply,
  updateStreamingConversationActivity,
  type ConversationAttachmentDraft,
  type ConversationStreamPhase,
  type StreamingConversationReplies,
} from "@/lib/product/conversation-stream";
import { ConversationBox } from "./conversation/ConversationBox";
import { GamepadIcon, PlusIcon, SparkIcon } from "./console/Icons";
import { useLanguage } from "./i18n/LanguageProvider";
import { useLocalInstance } from "./ProductShell";

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
  const managed = useLocalInstance().mode === "MANAGED";
  const router = useRouter();
  const initialProjects = cachedValue<readonly ProductProjectSummary[]>(clientCacheKeys.projects);
  const [projects, setProjects] = useState<readonly ProductProjectSummary[]>(initialProjects ?? []);
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [conversation, setConversation] = useState<ProductConversation | null>(null);
  const [content, setContent] = useState("");
  const [attachments, setAttachments] = useState<readonly ConversationAttachmentDraft[]>(Object.freeze([]));
  const [loadingProjects, setLoadingProjects] = useState(!initialProjects);
  const [sending, setSending] = useState(false);
  const [startingDevelopment, setStartingDevelopment] = useState(false);
  const [pendingChange, setPendingChange] = useState<ImplementationChangeRequest | null>(null);
  const [streamingReplies, setStreamingReplies] = useState<StreamingConversationReplies>({});
  const [streamPhase, setStreamPhase] = useState<ConversationStreamPhase | null>(null);
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
    const messageAttachments = attachments;
    if ((message.length < 2 && messageAttachments.length === 0) || sending) return;
    const displayedMessage = message || text("请查看随附附件。", "Please review the attached file.");
    const previousConversation = conversation;
    const projectId = previousConversation?.projectId || selectedProjectId;
    const pendingConversation = optimisticConversation(
      previousConversation,
      projectId,
      displayedMessage,
      activeProject?.name ?? text("新游戏构想", "New game concept"),
      messageAttachments,
    );
    setSending(true);
    setError(null);
    setStreamingReplies(initialStreamingConversationReplies());
    setStreamPhase("PREPARING");
    setConversation(pendingConversation);
    setContent("");
    setAttachments(Object.freeze([]));
    let agentStarted = false;
    try {
      const body = previousConversation && !previousConversation.id.startsWith("pending-")
        ? { conversationId: previousConversation.id, content: message, responseLanguage: locale, attachments: conversationAttachmentPayload(messageAttachments) }
        : { projectId: selectedProjectId || null, content: message, responseLanguage: locale, attachments: conversationAttachmentPayload(messageAttachments) };
      const result = await sendConversationMessageStream(
        body,
        `conversation:${crypto.randomUUID()}`,
        {
          onStatus: setStreamPhase,
          onAgentStart: agentRole => {
            agentStarted = true;
            setStreamingReplies(current => startStreamingConversationReply(current, agentRole));
          },
          onAgentProcess: (agentRole, processEvent) => setStreamingReplies(current => appendStreamingConversationProcess(current, agentRole, processEvent)),
          onAgentDelta: (agentRole, delta) => setStreamingReplies(current => appendStreamingConversationReply(current, agentRole, delta)),
          onAgentReplace: (agentRole, replyContent) => setStreamingReplies(current => replaceStreamingConversationReply(current, agentRole, replyContent)),
          onAgentActivity: (agentRole, activity) => setStreamingReplies(current => updateStreamingConversationActivity(current, agentRole, activity)),
          onAgentDevelopmentLog: (agentRole, line) => setStreamingReplies(current => appendStreamingDevelopmentLog(current, agentRole, line)),
          onAgentComplete: agentRole => setStreamingReplies(current => completeStreamingConversationReply(current, agentRole)),
        },
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
      setPendingChange(result.project.pendingImplementationChange);
      if ((activeProject?.workflowState ?? "DRAFT") === "DRAFT" && result.project.workflowState !== "DRAFT") {
        router.push(`/projects/${result.project.id}`);
      }
    } catch (cause) {
      const disconnected = !(cause instanceof ConversationStreamError)
        || cause.code === "EMPTY_STREAM"
        || cause.code === "INCOMPLETE_STREAM";
      if (agentStarted && disconnected && previousConversation && !previousConversation.id.startsWith("pending-")) {
        const recovered = await recoverConversationAfterDisconnect({
          conversationId: previousConversation.id,
          baselineMessageId: previousConversation.messages.at(-1)?.id ?? null,
          submittedContent: message,
        });
        if (recovered) {
          setConversation(recovered);
          const projectResponse = await fetch(`/api/projects/${encodeURIComponent(recovered.projectId)}`, { cache: "no-store" }).catch(() => null);
          const projectPayload = projectResponse?.ok
            ? await projectResponse.json() as { project?: ProductProjectDetail }
            : null;
          if (projectPayload?.project) {
            setProjects(current => {
              const next = current.some(project => project.id === projectPayload.project!.id)
                ? current.map(project => project.id === projectPayload.project!.id ? projectPayload.project! : project)
                : Object.freeze([projectPayload.project!, ...current]);
              storeCached(clientCacheKeys.projects, next, 10_000);
              return next;
            });
            setPendingChange(projectPayload.project.pendingImplementationChange);
          }
          return;
        }
      }
      const failureMessage = cause instanceof ConversationStreamError
        ? errorText(cause.message, "消息发送失败，请稍后重试", "Message failed. Please try again.")
        : text("消息发送失败，请稍后重试", "Message failed. Please try again.");
      setConversation(failedOptimisticConversation(pendingConversation, failureMessage));
      setContent(message);
      setError(failureMessage);
      if (!managed && cause instanceof ConversationStreamError && cause.code === "AGENT_CONFIG_REQUIRED") {
        router.push("/settings?required=conversation");
        return;
      }
    } finally {
      setStreamingReplies({});
      setStreamPhase(null);
      setSending(false);
    }
  }

  function startFreshConversation() {
    setConversation(null);
    setSelectedProjectId("");
    setContent("");
    setAttachments(Object.freeze([]));
    setPendingChange(null);
    setError(null);
  }

  async function confirmPendingChange() {
    if (!activeProject || !pendingChange || startingDevelopment) return;
    setStartingDevelopment(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/projects/${encodeURIComponent(activeProject.id)}/change-requests/${encodeURIComponent(pendingChange.id)}/decision`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            decision: "CONFIRM",
            idempotencyKey: `change-decision:${crypto.randomUUID()}`,
            responseLanguage: locale,
          }),
        },
      );
      const payload = await response.json().catch(() => ({})) as { project?: ProductProjectSummary; message?: string };
      if (!response.ok || !payload.project) {
        throw new Error(errorText(payload.message, `操作失败 (${response.status})`, `Operation failed (${response.status})`));
      }
      setPendingChange(null);
      setProjects(current => current.map(project => project.id === payload.project?.id ? payload.project : project));
      router.push(`/projects/${activeProject.id}`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : text("变更确认失败", "Unable to confirm the change"));
      setStartingDevelopment(false);
    }
  }

  async function startDevelopment() {
    if (!activeProject || activeProject.workflowState !== "DRAFT" || !requirementsReady || startingDevelopment) return;
    setStartingDevelopment(true);
    setError(null);
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(activeProject.id)}/approve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ responseLanguage: locale }),
      });
      const payload = await response.json().catch(() => ({})) as { message?: string };
      if (!response.ok) throw new Error(errorText(payload.message, `操作失败 (${response.status})`, `Operation failed (${response.status})`));
      router.push(`/projects/${activeProject.id}`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : text("暂时无法开始开发", "Unable to start development"));
      setStartingDevelopment(false);
    }
  }

  function selectConversationOption(option: string) {
    if (isDevelopmentAuthorization(option)) {
      if (pendingChange) {
        void confirmPendingChange();
        return;
      }
      if (requirementsReady) {
        void startDevelopment();
        return;
      }
    }
    void sendMessage(undefined, option);
  }

  const projectSelector = (
    <div className="homeChat-contextRow">
      <label>
        <GamepadIcon />
        <span>{text("导入已有项目", "IMPORT EXISTING PROJECT")}</span>
        <select
          aria-label={text("导入已有项目", "Import existing project")}
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
          <option value={IMPORT_PROJECT_VALUE}>{text("导入已有项目…", "Import existing project…")}</option>
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

  const developmentAction = pendingChange && !sending ? (
    <button className="button button-secondary conversation-box-develop" disabled={startingDevelopment} onClick={() => void confirmPendingChange()} type="button">
      {startingDevelopment ? text("正在开始开发…", "STARTING…") : text("确认修改并重跑", "CONFIRM & RERUN")}
    </button>
  ) : requirementsReady && !sending ? (
    <button className="button button-secondary conversation-box-develop" disabled={startingDevelopment} onClick={() => void startDevelopment()} type="button">
      {startingDevelopment ? text("正在开始开发…", "STARTING…") : text("按照当前计划开发", "BUILD CURRENT PLAN")}
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
      attachments={attachments}
      onAttachmentsChange={setAttachments}
      onOptionSelect={selectConversationOption}
      onSubmit={sendMessage}
      onValueChange={setContent}
      placeholder={placeholder}
      primaryAction={developmentAction}
      sendButtonLabel={text("发送消息", "Send message")}
      sending={sending}
      streamPhase={streamPhase}
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

function conversationAttachmentPayload(attachments: readonly ConversationAttachmentDraft[]) {
  return attachments.map(attachment => Object.freeze({
    filename: attachment.filename,
    contentType: attachment.contentType,
    dataBase64: attachment.dataBase64,
  }));
}

function workflowLabel(state: string, text: (chinese: string, english: string) => string): string {
  const labels: Record<string, readonly [string, string]> = {
    DRAFT: ["需求讨论中", "Requirements discussion"],
    ANALYZING: ["项目分析中", "Analyzing project"],
    DESIGNING: ["游戏设计中", "Designing game"],
    UI_DESIGNING: ["UI 设计中", "Designing UI"],
    DEVELOPING: ["游戏生成中", "Developing game"],
    BUILDING: ["制品构建中", "Building artifacts"],
    TEST_PLANNING: ["测试规划中", "Planning tests"],
    TESTING: ["跨平台测试中", "Cross-platform testing"],
    RELEASE_APPROVAL_PENDING: ["等待发布批准", "Awaiting release approval"],
    STEAM_PUBLISHING: ["Steam 发布中", "Publishing to Steam"],
    SUCCEEDED: ["交付完成", "Delivered"],
    BLOCKED: ["等待配置", "Blocked"],
    STOPPED: ["已停止", "Stopped"],
    FAILED: ["流程失败", "Failed"],
    CANCELLED: ["已取消", "Cancelled"],
  };
  const label = labels[state];
  return label ? text(label[0], label[1]) : state;
}
