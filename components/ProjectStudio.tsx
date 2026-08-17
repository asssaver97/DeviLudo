"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { cachedValue, clientCacheKeys, expireCached, loadCached, removeCached, storeCached } from "@/lib/product/client-cache";
import type {
  AgentProgressEvent,
  ArtifactRecord,
  ProductConversation,
  ProductConversationSummary,
  ProductProjectDetail,
  ProductProjectSummary,
  ProductWorkflowIterationDetail,
  ProductWorkflowIterationSummary,
  ProjectAgentRole,
} from "@/lib/product/contracts";
import { readAgentProgressStream } from "@/lib/product/agent-progress-stream";
import {
  chronologicalMessages,
  ConversationStreamError,
  failedOptimisticConversation,
  optimisticConversation,
  sendConversationMessageStream,
} from "@/lib/product/conversation-stream";
import { ConversationBox } from "./conversation/ConversationBox";
import { AssetManifestPanel } from "./AssetManifestPanel";
import { ProjectSteamPanel } from "./ProjectSteamPanel";
import { ArrowIcon, PlusIcon, RerunIcon } from "./console/Icons";
import { localeTag, useLanguage } from "./i18n/LanguageProvider";

// The serial delivery chain, in order. Asset generation is shown as a branch off
// Agent generation, but it is a real readiness gate: artifact builds cannot start
// until every planned image is generated/uploaded or auto-generation is disabled.
const PIPELINE = [
  ["AGENT_GENERATION", "Agent 生成", "Agent Generation"],
  ["ARTIFACT_BUILD", "制品构建", "Artifact Build"],
  ["E2E_TEST", "跨平台 E2E", "Cross-platform E2E"],
  ["STEAM_PUBLISH", "Steam 上传", "Steam Upload"],
] as const;
const RERUNNABLE_WORKFLOW_STATES = new Set(["FAILED", "SUCCEEDED", "CANCELLED"]);

type LocalGitState = Readonly<{
  repository: boolean;
  branch: string | null;
}>;

export function ProjectStudio({ projectId }: { projectId: string }) {
  const { errorText, locale, text } = useLanguage();
  const router = useRouter();
  const initialProject = cachedValue<ProductProjectDetail>(clientCacheKeys.project(projectId));
  const initialConversations = cachedValue<readonly ProductConversationSummary[]>(clientCacheKeys.conversations(projectId));
  const initialConversationId = initialConversations?.[0]?.id ?? null;
  const initialConversation = initialConversationId ? cachedValue<ProductConversation>(clientCacheKeys.conversation(initialConversationId)) : undefined;
  const initialArtifacts = cachedValue<readonly ArtifactRecord[]>(clientCacheKeys.artifacts(projectId));
  const [project, setProject] = useState<ProductProjectDetail | null>(initialProject ?? null);
  const [conversations, setConversations] = useState<readonly ProductConversationSummary[]>(initialConversations ?? []);
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(initialConversationId);
  const [conversation, setConversation] = useState<ProductConversation | null>(initialConversation ?? null);
  const [conversationInput, setConversationInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [sendingMessage, setSendingMessage] = useState(false);
  const [streamingReplies, setStreamingReplies] = useState<Partial<Record<ProjectAgentRole, string>>>({});
  const [agentProgress, setAgentProgress] = useState<readonly AgentProgressEvent[]>([]);
  const [artifacts, setArtifacts] = useState<readonly ArtifactRecord[]>(initialArtifacts ?? []);
  const [iterations, setIterations] = useState<readonly ProductWorkflowIterationSummary[]>([]);
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string | null>(null);
  const [historicalIteration, setHistoricalIteration] = useState<ProductWorkflowIterationDetail | null>(null);
  const [conversationFocusKey, setConversationFocusKey] = useState(0);
  const [openingArtifactId, setOpeningArtifactId] = useState<string | null>(null);
  const agentProgressCursor = useRef(0);
  const [deleting, setDeleting] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleteLocalDirectory, setDeleteLocalDirectory] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editingDocument, setEditingDocument] = useState(false);
  const [documentDraft, setDocumentDraft] = useState({ introduction: "", gameplay: "", categories: "", features: "" });
  const [assetPanelExpanded, setAssetPanelExpanded] = useState(false);
  const [localGit, setLocalGit] = useState<LocalGitState | null>(null);
  const [localGitError, setLocalGitError] = useState<string | null>(null);
  const [newBranchName, setNewBranchName] = useState("");
  const [editingLocalBranch, setEditingLocalBranch] = useState(false);
  const [branchBusy, setBranchBusy] = useState(false);

  const loadProject = useCallback(async (force = false) => {
    const value = await loadCached(clientCacheKeys.project(projectId), 5_000, async () => {
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}`, { cache: "no-store" });
      const payload = await response.json() as { project?: ProductProjectDetail; message?: string };
      if (!response.ok || !payload.project) throw new Error(errorText(payload.message, `项目读取失败 (${response.status})`, `Unable to load project (${response.status})`));
      return payload.project;
    }, { force });
    setProject(current => {
      const next = newestProjectSnapshot(current, value);
      storeCached(clientCacheKeys.project(projectId), next, 5_000);
      return next;
    });
  }, [errorText, projectId]);

  const loadConversations = useCallback(async () => {
    const values = await loadCached(clientCacheKeys.conversations(projectId), 30_000, async () => {
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/conversations`, { cache: "no-store" });
      const payload = await response.json() as { conversations?: readonly ProductConversationSummary[]; message?: string };
      if (!response.ok || !payload.conversations) throw new Error(errorText(payload.message, `历史会话读取失败 (${response.status})`, `Unable to load conversation history (${response.status})`));
      return payload.conversations;
    });
    setConversations(values);
    const initialId = values[0]?.id ?? null;
    setSelectedConversationId(initialId);
    if (!initialId) {
      setConversation(null);
      return;
    }
    const value = await loadCached(clientCacheKeys.conversation(initialId), 30_000, async () => {
      const conversationResponse = await fetch(`/api/conversations/${encodeURIComponent(initialId)}`, { cache: "no-store" });
      const conversationPayload = await conversationResponse.json() as { conversation?: ProductConversation; message?: string };
      if (!conversationResponse.ok || !conversationPayload.conversation) throw new Error(errorText(conversationPayload.message, `会话读取失败 (${conversationResponse.status})`, `Unable to load conversation (${conversationResponse.status})`));
      return conversationPayload.conversation;
    });
    setConversation(value);
  }, [errorText, projectId]);

  const loadArtifacts = useCallback(async (force = false) => {
    const values = await loadCached(clientCacheKeys.artifacts(projectId), 10_000, async () => {
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/artifacts`, { cache: "no-store" });
      const payload = await response.json() as { artifacts?: readonly ArtifactRecord[]; message?: string };
      if (!response.ok || !payload.artifacts) throw new Error(errorText(payload.message, `制品读取失败 (${response.status})`, `Unable to load artifacts (${response.status})`));
      return payload.artifacts;
    }, { force });
    setArtifacts(values);
  }, [errorText, projectId]);

  const loadIterations = useCallback(async () => {
    const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/iterations`, { cache: "no-store" });
    const payload = await response.json().catch(() => ({})) as {
      iterations?: readonly ProductWorkflowIterationSummary[];
      message?: string;
    };
    if (!response.ok || !payload.iterations) {
      throw new Error(errorText(payload.message, `迭代历史读取失败 (${response.status})`, `Unable to load iteration history (${response.status})`));
    }
    setIterations(payload.iterations);
  }, [errorText, projectId]);

  useEffect(() => {
    let active = true;
    const initial = setTimeout(() => {
      void Promise.all([loadProject(), loadConversations(), loadArtifacts(), loadIterations()]).catch(reason => {
        if (active) setError(reason instanceof Error ? reason.message : text("项目读取失败", "Unable to load project"));
      });
    }, 0);
    return () => { active = false; clearTimeout(initial); };
  }, [loadArtifacts, loadConversations, loadIterations, loadProject, text]);

  const localDirectoryBindingId = project?.localDirectory?.bindingId ?? null;
  useEffect(() => {
    if (!localDirectoryBindingId) return;
    let active = true;
    void readLocalGitStatus(localDirectoryBindingId, text, errorText).then(value => {
      if (active) {
        setLocalGit(value);
        setLocalGitError(null);
      }
    }).catch(reason => {
      if (active) setLocalGitError(localGitMessage(reason, text));
    });
    return () => { active = false; };
  }, [errorText, localDirectoryBindingId, text]);

  const workflowState = project?.workflowState;
  const projectAnalysisInProgress = project?.analysisStatus === "PENDING" || project?.analysisStatus === "ANALYZING";
  useEffect(() => {
    if ((!workflowState || !workflowNeedsPolling(workflowState)) && !projectAnalysisInProgress) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      if (document.visibilityState === "visible") {
        await Promise.all([loadProject(true), loadArtifacts(true), loadIterations()]).catch(() => undefined);
      }
      if (!stopped) timer = setTimeout(poll, 3_000);
    };
    timer = setTimeout(poll, 3_000);
    return () => { stopped = true; if (timer) clearTimeout(timer); };
  }, [loadArtifacts, loadIterations, loadProject, projectAnalysisInProgress, workflowState]);

  async function createLocalBranch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const branchName = newBranchName.trim();
    if (!project?.localDirectory || !branchName || branchBusy
      || selectedWorkflowId !== null
      || !["DRAFT", "SUCCEEDED", "FAILED", "CANCELLED"].includes(project.workflowState)) return;
    setBranchBusy(true);
    setLocalGitError(null);
    try {
      const bridgeUrl = await localProjectBridgeUrl(text);
      const response = await fetch(`${bridgeUrl}/directory/git/branch`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ bindingId: project.localDirectory.bindingId, branchName }),
      });
      const payload = await response.json().catch(() => ({})) as Partial<LocalGitState> & { code?: string; message?: string };
      if (!response.ok || payload.repository !== true || typeof payload.branch !== "string") {
        throw new LocalGitError(payload.code ?? "LOCAL_GIT_OPERATION_FAILED", errorText(payload.message, "本地 Git 操作失败", "Local Git operation failed"));
      }
      setLocalGit(Object.freeze({ repository: true, branch: payload.branch }));
      setNewBranchName("");
      setEditingLocalBranch(false);
    } catch (reason) {
      setLocalGitError(localGitMessage(reason, text));
    } finally {
      setBranchBusy(false);
    }
  }

  const activeAgentJobId = project?.jobs
    .filter(job => job.kind === "AGENT_GENERATION")
    .at(-1)?.id ?? null;
  const agentRunning = project?.workflowState === "AGENT_RUNNING";
  const activeAgentProgress = useMemo(
    () => activeAgentJobId
      ? Object.freeze(agentProgress.filter(event => event.jobId === activeAgentJobId))
      : Object.freeze([]),
    [activeAgentJobId, agentProgress],
  );

  useEffect(() => {
    if (!agentRunning || !activeAgentJobId) return;
    const controller = new AbortController();
    let active = true;
    agentProgressCursor.current = 0;
    void (async () => {
      while (active && !controller.signal.aborted) {
        try {
          agentProgressCursor.current = await readAgentProgressStream(
            projectId,
            agentProgressCursor.current,
            controller.signal,
            event => {
              if (!active || event.jobId !== activeAgentJobId) return;
              setAgentProgress(current => {
                const activeEvents = current.filter(item => item.jobId === activeAgentJobId);
                return activeEvents.some(item => item.sequence === event.sequence)
                  ? current
                  : Object.freeze([...activeEvents, event].slice(-200));
              });
            },
          );
        } catch (reason) {
          if (controller.signal.aborted) break;
          console.error(reason);
          await new Promise(resolve => setTimeout(resolve, 1_000));
        }
      }
    })();
    return () => {
      active = false;
      controller.abort();
    };
  }, [activeAgentJobId, agentRunning, projectId]);

  async function openConversation(conversationId: string) {
    if (conversationId === selectedConversationId && conversation) return;
    setError(null);
    setSelectedConversationId(conversationId);
    try {
      const value = await loadCached(clientCacheKeys.conversation(conversationId), 30_000, async () => {
        const response = await fetch(`/api/conversations/${encodeURIComponent(conversationId)}`, { cache: "no-store" });
        const payload = await response.json() as { conversation?: ProductConversation; message?: string };
        if (!response.ok || !payload.conversation) throw new Error(errorText(payload.message, `会话读取失败 (${response.status})`, `Unable to load conversation (${response.status})`));
        return payload.conversation;
      });
      setConversation(value);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : text("会话读取失败", "Unable to load conversation"));
    }
  }

  function startConversation() {
    setSelectedConversationId(null);
    setConversation(null);
    setConversationInput("");
    setError(null);
  }

  async function selectIteration(workflowId: string) {
    if (!project || busy) return;
    setEditingDocument(false);
    if (workflowId === project.workflowId) {
      setSelectedWorkflowId(null);
      setHistoricalIteration(null);
      setAssetPanelExpanded(false);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/projects/${encodeURIComponent(projectId)}/iterations/${encodeURIComponent(workflowId)}`,
        { cache: "no-store" },
      );
      const payload = await response.json().catch(() => ({})) as {
        iteration?: ProductWorkflowIterationDetail;
        message?: string;
      };
      if (!response.ok || !payload.iteration) {
        throw new Error(errorText(payload.message, `迭代详情读取失败 (${response.status})`, `Unable to load iteration details (${response.status})`));
      }
      setSelectedWorkflowId(workflowId);
      setHistoricalIteration(payload.iteration);
      setAssetPanelExpanded(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : text("迭代详情读取失败", "Unable to load iteration details"));
    } finally {
      setBusy(false);
    }
  }

  async function createNextIteration() {
    if (!project || busy || selectedWorkflowId !== null || !RERUNNABLE_WORKFLOW_STATES.has(project.workflowState)) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/iterations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ baseWorkflowId: project.workflowId }),
      });
      const payload = await response.json().catch(() => ({})) as {
        project?: ProductProjectDetail;
        message?: string;
      };
      if (!response.ok || !payload.project) {
        throw new Error(errorText(payload.message, `新一轮创建失败 (${response.status})`, `Unable to create the next iteration (${response.status})`));
      }
      setProject(payload.project);
      storeCached(clientCacheKeys.project(projectId), payload.project, 5_000);
      const projectList = cachedValue<readonly ProductProjectSummary[]>(clientCacheKeys.projects);
      if (projectList) {
        storeCached(clientCacheKeys.projects, Object.freeze([
          payload.project,
          ...projectList.filter(item => item.id !== projectId),
        ]), 10_000);
      }
      setSelectedWorkflowId(null);
      setHistoricalIteration(null);
      setArtifacts([]);
      setAssetPanelExpanded(false);
      startConversation();
      setConversationFocusKey(value => value + 1);
      expireCached(clientCacheKeys.artifacts(projectId));
      await Promise.all([loadIterations(), loadArtifacts(true)]);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : text("新一轮创建失败", "Unable to create the next iteration"));
    } finally {
      setBusy(false);
    }
  }

  async function sendConversationMessage(event?: FormEvent<HTMLFormElement>, selectedOption?: string) {
    event?.preventDefault();
    const content = (selectedOption ?? conversationInput).trim();
    if (content.length < 2 || sendingMessage || selectedWorkflowId !== null) return;
    const previousConversation = conversation;
    const pendingConversation = optimisticConversation(previousConversation, projectId, content, project?.name ?? text("项目会话", "Project conversation"));
    setSendingMessage(true);
    setError(null);
    setStreamingReplies({});
    setConversation(pendingConversation);
    setSelectedConversationId(pendingConversation.id);
    setConversationInput("");
    try {
      const payload = await sendConversationMessageStream(
        previousConversation && !previousConversation.id.startsWith("pending-")
          ? { conversationId: previousConversation.id, content }
          : { projectId, content },
        `conversation:${crypto.randomUUID()}`,
        (agentRole, delta) => setStreamingReplies(current => ({
          ...current,
          [agentRole]: `${current[agentRole] ?? ""}${delta}`,
        })),
        updatedProject => setProject(current => {
          const next = newestProjectSnapshot(current, updatedProject);
          storeCached(clientCacheKeys.project(projectId), next, 5_000);
          return next;
        }),
      );
      const nextConversation = payload.conversation;
      setConversation(nextConversation);
      storeCached(clientCacheKeys.conversation(nextConversation.id), nextConversation, 30_000);
      setSelectedConversationId(nextConversation.id);
      setProject(current => {
        const next = newestProjectSnapshot(current, payload.project);
        storeCached(clientCacheKeys.project(projectId), next, 5_000);
        return next;
      });
      setConversations(current => {
        const summary = conversationSummary(nextConversation);
        const next = Object.freeze([summary, ...current.filter(item => item.id !== summary.id)]);
        storeCached(clientCacheKeys.conversations(projectId), next, 30_000);
        return next;
      });
    } catch (reason) {
      const failureMessage = reason instanceof ConversationStreamError
        ? errorText(reason.message, "消息发送失败，请稍后重试", "Message failed. Please try again.")
        : text("消息发送失败，请稍后重试", "Message failed. Please try again.");
      const failedConversation = failedOptimisticConversation(pendingConversation, failureMessage);
      setConversation(failedConversation);
      setSelectedConversationId(failedConversation.id);
      setConversationInput(content);
      setError(failureMessage);
      if (reason instanceof ConversationStreamError && reason.code === "AGENT_CONFIG_REQUIRED") {
        router.push("/settings?required=conversation");
        return;
      }
    } finally {
      setStreamingReplies({});
      setSendingMessage(false);
    }
  }

  async function mutate(path: string, body?: Record<string, unknown>) {
    if (selectedWorkflowId !== null) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          // A rerun keys on the chosen stage: repeated clicks on one node collapse
          // into a single signal, while switching nodes is a genuinely new request.
          ...(path === "rerun-stage" ? { "idempotency-key": `stage-rerun:${String(body?.stage)}:${crypto.randomUUID()}` } : {}),
          ...(path === "cancel" ? { "idempotency-key": `cancel:${crypto.randomUUID()}` } : {}),
        },
        body: JSON.stringify(body ?? {}),
      });
      const payload = await response.json().catch(() => ({})) as { code?: string; message?: string };
      if (payload.code === "AGENT_CONFIG_REQUIRED") {
        router.push("/settings?required=agent-retry");
        return;
      }
      if (!response.ok) throw new Error(errorText(payload.message, `操作失败 (${response.status})`, `Operation failed (${response.status})`));
      await loadProject(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : text("操作失败", "Operation failed"));
    } finally {
      setBusy(false);
    }
  }

  function beginDocumentEdit() {
    if (!project || selectedWorkflowId !== null) return;
    setDocumentDraft({
      introduction: project.document.content.introduction,
      gameplay: project.document.content.gameplay,
      categories: project.document.content.categories.join("\n"),
      features: project.document.content.features.join("\n"),
    });
    setEditingDocument(true);
  }

  async function saveDocument() {
    if (!project || selectedWorkflowId !== null) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/document`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expectedRevision: project.document.revision,
          content: {
            introduction: documentDraft.introduction.trim(),
            gameplay: documentDraft.gameplay.trim(),
            categories: documentLines(documentDraft.categories),
            features: documentLines(documentDraft.features),
          },
        }),
      });
      const payload = await response.json().catch(() => ({})) as { message?: string };
      if (!response.ok) throw new Error(errorText(payload.message, `说明文档保存失败 (${response.status})`, `Unable to save project document (${response.status})`));
      setEditingDocument(false);
      await loadProject(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : text("说明文档保存失败", "Unable to save project document"));
    } finally {
      setBusy(false);
    }
  }

  async function deleteProject() {
    if (!project || deleting || selectedWorkflowId !== null) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deleteLocalDirectory }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({})) as { message?: string };
        throw new Error(errorText(payload.message, `项目删除失败 (${response.status})`, `Unable to delete project (${response.status})`));
      }
      removeCached(clientCacheKeys.project(projectId));
      removeCached(clientCacheKeys.conversations(projectId));
      removeCached(clientCacheKeys.artifacts(projectId));
      const projectList = cachedValue<readonly ProductProjectSummary[]>(clientCacheKeys.projects);
      if (projectList) storeCached(clientCacheKeys.projects, projectList.filter(item => item.id !== projectId), 10_000);
      setConfirmingDelete(false);
      router.replace("/projects");
      router.refresh();
    } catch (reason) {
      setDeleteError(reason instanceof Error ? reason.message : text("项目删除失败", "Unable to delete project"));
    } finally {
      setDeleting(false);
    }
  }

  async function accessArtifact(artifact: ArtifactRecord) {
    if (openingArtifactId) return;
    // Self-hosted artifacts already live in the local object store. Hand all
    // of them to the host bridge so reports and snapshots open in their default
    // macOS application instead of taking an unnecessary browser download path.
    const opensOnHost = true;
    setOpeningArtifactId(artifact.id);
    setError(null);
    try {
      const [response, bridgeUrl] = await Promise.all([
        fetch(
          `/api/projects/${encodeURIComponent(projectId)}/artifacts/${encodeURIComponent(artifact.id)}/download`,
          { method: "POST" },
        ),
        opensOnHost ? localProjectBridgeUrl(text) : Promise.resolve(null),
      ]);
      const payload = await response.json() as { url?: string; filename?: string; message?: string };
      if (!response.ok || !payload.url || !payload.filename) {
        throw new Error(errorText(payload.message, `制品下载授权失败 (${response.status})`, `Unable to authorize download (${response.status})`));
      }
      if (opensOnHost && bridgeUrl) {
        const openResponse = await fetch(`${bridgeUrl}/artifact/open`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            artifactId: artifact.id,
            kind: artifact.kind,
            targetPlatform: artifact.targetPlatform,
            url: payload.url,
            filename: payload.filename,
            sha256: artifact.object.sha256,
            sizeBytes: artifact.object.sizeBytes,
          }),
        });
        const openResult = await openResponse.json().catch(() => ({})) as { opened?: boolean; message?: string };
        if (!openResponse.ok || openResult.opened !== true) {
          throw new Error(errorText(openResult.message, "本地制品打开失败", "Unable to open the local artifact"));
        }
        return;
      }
      const link = document.createElement("a");
      link.href = payload.url;
      link.download = payload.filename;
      link.rel = "noopener";
      document.body.append(link);
      link.click();
      link.remove();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : text("制品打开失败", "Unable to access artifact"));
    } finally {
      setOpeningArtifactId(null);
    }
  }

  const activeConversation = useMemo(
    () => conversation?.id === selectedConversationId ? conversation : null,
    [conversation, selectedConversationId],
  );
  const orderedMessages = useMemo(
    () => chronologicalMessages(activeConversation?.messages ?? Object.freeze([])),
    [activeConversation],
  );
  const latestConversationMessage = orderedMessages.at(-1);
  const requirementsReady = project?.workflowState === "DRAFT"
    && latestConversationMessage?.role === "ASSISTANT"
    && latestConversationMessage.metadata.readyForDevelopment === true;

  if (!project) {
    return <section className="project-catalog-empty product-studio-loading">{error ?? text("正在进入项目…", "LOADING PROJECT…")}</section>;
  }

  const viewingHistoricalIteration = selectedWorkflowId !== null
    && selectedWorkflowId !== project.workflowId
    && historicalIteration?.workflowId === selectedWorkflowId;
  const viewedWorkflowState = viewingHistoricalIteration ? historicalIteration.state : project.workflowState;
  const viewedJobs = viewingHistoricalIteration ? historicalIteration.jobs : project.jobs;
  const viewedEvents = viewingHistoricalIteration ? historicalIteration.events : project.events;
  const viewedArtifacts = latestArtifactsByKindAndPlatform(
    viewingHistoricalIteration ? historicalIteration.artifacts : artifacts,
  );
  const artifactsByStage = groupArtifactsByPipelineStage(viewedArtifacts);
  const discoveryStage = discoveryStageView({
    imported: project.localDirectory !== null,
    analysisStatus: project.analysisStatus,
    requirementsReady,
    historical: viewingHistoricalIteration,
    workflowState: viewedWorkflowState,
    questionCount: project.discovery?.questions.length ?? 0,
  }, text);
  const viewedIterationNumber = viewingHistoricalIteration
    ? historicalIteration.iterationNumber
    : project.iterationNumber;
  const discoveryFinishedAt = discoveryStage.view.kind === "completed"
    ? pipelineEventFinishedAt(viewedEvents, "SPEC_APPROVED")
    : null;
  const deliveryActive = !["DRAFT", "RELEASE_DECISION_PENDING", "SUCCEEDED", "FAILED", "CANCELLED"].includes(project.workflowState);
  const viewedDeliveryActive = !["DRAFT", "RELEASE_DECISION_PENDING", "SUCCEEDED", "FAILED", "CANCELLED"].includes(viewedWorkflowState);
  const latestFailedJob = viewedWorkflowState === "FAILED"
    ? latestPipelineJobs(viewedJobs).find(job => job.state === "FAILED") ?? null
    : null;
  const pipelineFailure = latestFailedJob ? jobFailurePresentation(latestFailedJob, text) : null;
  const profileStages = new Set<string>(PIPELINE.map(([kind]) => kind));
  // Reruns supersede downstream jobs, which would race executors still holding
  // leases, so they only open up once the workflow has come to rest. A DRAFT has
  // nothing to rerun yet.
  const canRerunStages = !viewingHistoricalIteration
    && RERUNNABLE_WORKFLOW_STATES.has(project.workflowState)
    && project.jobs.length > 0;
  const rerunnableFailedStage = latestFailedJob && profileStages.has(latestFailedJob.kind)
    ? latestFailedJob.kind
    : null;

  return (
    <>
      <section className="project-page-header product-studio-header">
        <div>
          <div className="breadcrumb"><Link href="/projects">{text("游戏项目", "GAME PROJECTS")}</Link><span>/</span><b>{project.name}</b></div>
          <span className="eyebrow">{text("PROJECT · 项目", "PROJECT")}</span>
          <h1>{project.name}</h1>
          <p>{viewingHistoricalIteration ? historicalIteration.concept : project.concept}</p>
        </div>
        <div className="product-studio-header-actions">
          <button className="button project-delete-button" disabled={viewingHistoricalIteration} onClick={() => { setDeleteLocalDirectory(false); setDeleteError(null); setConfirmingDelete(true); }} type="button">{text("删除项目", "DELETE PROJECT")}</button>
        </div>
      </section>
      {error ? <div className="inline-notice danger">{error}</div> : null}

      <section aria-label={text("交付流程", "Delivery pipeline")} className="product-delivery-pipeline">
        <header className="product-delivery-pipeline-header">
          <div className="product-delivery-pipeline-title">
            <div><span className="eyebrow">DELIVERY PIPELINE</span><h2>{text(`交付流程 · 第 ${viewedIterationNumber} 轮`, `DELIVERY PIPELINE · ITERATION ${viewedIterationNumber}`)}</h2></div>
          </div>
          <div className="product-delivery-pipeline-actions">
            <label className="product-iteration-selector">
              <span>{text("查看轮次", "ITERATION")}</span>
              <select
                aria-label={text("选择交付轮次", "Select delivery iteration")}
                disabled={busy}
                onChange={event => void selectIteration(event.target.value)}
                value={selectedWorkflowId ?? project.workflowId}
              >
                {(iterations.length ? iterations : [Object.freeze({
                  workflowId: project.workflowId,
                  iterationNumber: project.iterationNumber,
                  state: project.workflowState,
                })]).map(iteration => (
                  <option key={iteration.workflowId} value={iteration.workflowId}>
                    {text(`第 ${iteration.iterationNumber} 轮`, `Iteration ${iteration.iterationNumber}`)} · {workflowLabel(iteration.state, text)}
                  </option>
                ))}
              </select>
            </label>
            {viewingHistoricalIteration || !viewedDeliveryActive ? (
              <span className="revision-badge">
                {viewingHistoricalIteration ? text("历史只读", "READ ONLY") : workflowLabel(viewedWorkflowState, text)}
              </span>
            ) : null}
            {!viewingHistoricalIteration && deliveryActive ? (
              <button className="button button-secondary" disabled={busy} onClick={() => void mutate("cancel")} type="button">
                {text("取消本次交付", "CANCEL DELIVERY")}
              </button>
            ) : null}
            {!viewingHistoricalIteration && RERUNNABLE_WORKFLOW_STATES.has(project.workflowState) ? (
              <button className="button button-primary" disabled={busy} onClick={() => void createNextIteration()} type="button">
                {busy
                  ? text("正在创建新一轮…", "CREATING ITERATION…")
                  : project.workflowState === "SUCCEEDED"
                    ? text("继续修改", "CONTINUE EDITING")
                    : text("调整需求并重新开发", "REVISE & DEVELOP AGAIN")}
              </button>
            ) : null}
          </div>
        </header>
        <div className="product-delivery-canvas">
          <ol className="product-delivery-track">
            <li className={`product-delivery-stage status-${discoveryStage.view.kind}`} data-stage-status={discoveryStage.view.kind}>
              <div className="product-delivery-stage-marker" aria-hidden="true">{discoveryStage.view.symbol}</div>
              <b>{discoveryStage.title}</b>
              <strong>{discoveryStage.view.label}</strong>
              <small>{discoveryStage.detail}</small>
              {discoveryFinishedAt ? (
                <time className="product-delivery-stage-finished-at" dateTime={discoveryFinishedAt}>
                  {text("运行结束", "Finished")} · {formatConversationTime(discoveryFinishedAt, localeTag(locale), text)}
                </time>
              ) : null}
            </li>
            {PIPELINE.map(([kind, chineseLabel, englishLabel]) => {
              const jobs = latestPipelineJobs(viewedJobs.filter(job => job.kind === kind));
              const stageArtifacts = artifactsByStage.get(kind) ?? Object.freeze([]);
              const inProfile = profileStages.has(kind);
              const state = aggregateJobState(jobs.map(job => job.state));
              const view = inProfile ? pipelineStageView(state, text) : OUT_OF_PROFILE_STAGE_VIEW(text);
              const finishedAt = inProfile ? pipelineStageFinishedAt(jobs) : null;
              return (
                <li className={`product-delivery-stage status-${view.kind}`} data-stage-status={view.kind} key={kind}>
                  <div className="product-delivery-stage-marker" aria-hidden="true">{view.symbol}</div>
                  <b>{text(chineseLabel, englishLabel)}</b>
                  <strong>{view.label}</strong>
                  <small>{inProfile
                    ? pipelineJobDetails(jobs, text)
                    : text("当前为验证流程，不含此阶段", "Not part of the current VALIDATE run")}</small>
                  {finishedAt ? (
                    <time className="product-delivery-stage-finished-at" dateTime={finishedAt}>
                      {text("运行结束", "Finished")} · {formatConversationTime(finishedAt, localeTag(locale), text)}
                    </time>
                  ) : null}
                  {stageArtifacts.length ? (
                    <div className="product-delivery-stage-artifacts">
                      {stageArtifacts.map(artifact => (
                        <button
                          aria-label={text(`打开${artifactLabel(artifact, text)}`, `Open ${artifactLabel(artifact, text)}`)}
                          disabled={openingArtifactId !== null}
                          key={artifact.id}
                          onClick={() => void accessArtifact(artifact)}
                          title={`${artifactLabel(artifact, text)} · ${artifact.targetPlatform ?? text("通用", "COMMON")} · ${formatArtifactSize(artifact.object.sizeBytes)}`}
                          type="button"
                        >
                          <span>{artifact.targetPlatform ?? text("通用", "ALL")}</span>
                          <b>{artifactLabel(artifact, text)}</b>
                          <strong>{openingArtifactId === artifact.id
                            ? text("打开中…", "OPENING…")
                            : text("打开", "OPEN")}</strong>
                        </button>
                      ))}
                    </div>
                  ) : null}
                  {canRerunStages && inProfile && (kind !== "STEAM_PUBLISH" || project.workflowState === "FAILED") ? (
                    <button
                      aria-label={text(
                        `从「${chineseLabel}」重新执行，之后的阶段都会重跑`,
                        `Re-run from ${englishLabel}; every later stage runs again`,
                      )}
                      className="product-delivery-stage-rerun-icon"
                      disabled={busy}
                      onClick={() => void mutate("rerun-stage", { stage: kind })}
                      type="button"
                    >
                      <RerunIcon />
                    </button>
                  ) : null}
                  {/* The asset readiness branch hangs off this stage rather than
                      being absolutely positioned in the canvas: the Agent plans the
                      manifest, so the branch belongs to that node and follows it
                      wherever the flex track puts it. */}
                  {kind === "AGENT_GENERATION" && !viewingHistoricalIteration ? (
                    <div className="product-delivery-async-branch">
                      <span aria-hidden="true" className="product-delivery-branch-line" />
                      <button
                        aria-expanded={assetPanelExpanded}
                        className={`product-delivery-async-node ${assetPanelExpanded ? "is-expanded" : ""}`}
                        onClick={() => setAssetPanelExpanded(!assetPanelExpanded)}
                        type="button"
                      >
                        <span aria-hidden="true" className="product-delivery-async-marker">◈</span>
                        <span className="product-delivery-async-copy">
                          <b>{text("图片素材", "ASSET GEN")}</b>
                          <small>{assetPanelExpanded
                            ? text("收起素材清单", "Hide asset list")
                            : text("构建前门禁 · 查看清单", "Pre-build gate · view list")}</small>
                        </span>
                        <ArrowIcon aria-hidden="true" className="product-delivery-async-chevron" />
                      </button>
                    </div>
                  ) : kind === "AGENT_GENERATION" ? (
                    <div className="product-delivery-async-branch">
                      <span aria-hidden="true" className="product-delivery-branch-line" />
                      <div className="product-delivery-async-node is-read-only">
                        <span aria-hidden="true" className="product-delivery-async-marker">◈</span>
                        <span className="product-delivery-async-copy">
                          <b>{text("图片素材", "ASSET GEN")}</b>
                          <small>{text("历史轮不展示当前素材规划", "Current asset plan hidden in history")}</small>
                        </span>
                      </div>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ol>
        </div>
        {canRerunStages ? (
          <p className="product-delivery-rerun-hint">
            {text(
              "选择任意节点重跑，该节点之后的阶段会作废并重新执行。",
              "Pick any node to re-run: that stage and everything after it are superseded and run again.",
            )}
          </p>
        ) : null}
        {pipelineFailure && latestFailedJob ? (
          <section aria-label={text("交付失败原因", "Delivery failure reason")} className="product-delivery-failure" role="alert">
            <div className="product-delivery-failure-icon" aria-hidden="true">!</div>
            <div className="product-delivery-failure-copy">
              <div>
                <strong>{pipelineFailure.title}</strong>
                <span>{text(`已尝试 ${latestFailedJob.attempt} 次`, `${latestFailedJob.attempt} attempts`)}</span>
              </div>
              <p>{pipelineFailure.reason}</p>
              <small>{pipelineFailure.action}</small>
              {latestFailedJob.lastError ? (
                <details>
                  <summary>{text("技术详情", "TECHNICAL DETAILS")}</summary>
                  <code>{technicalFailureDetail(latestFailedJob.lastError)}</code>
                </details>
              ) : null}
            </div>
            {/* The failed stage is the natural retry point; any other node stays
                reachable from the track above. */}
            {rerunnableFailedStage ? (
              <button
                className="button button-primary product-delivery-retry"
                disabled={busy}
                onClick={() => void mutate("rerun-stage", { stage: rerunnableFailedStage })}
                type="button"
              >
                {busy ? text("正在重新执行…", "RE-RUNNING…") : text("重跑失败阶段", "RE-RUN FAILED STAGE")}
              </button>
            ) : null}
          </section>
        ) : null}
        {viewingHistoricalIteration ? (
          <section aria-label={text("历史轮次摘要", "Historical iteration summary")} className="product-iteration-history-summary">
            <header className="section-heading">
              <div><span className="eyebrow">ITERATION HISTORY</span><h3>{text(`第 ${historicalIteration.iterationNumber} 轮记录`, `ITERATION ${historicalIteration.iterationNumber} RECORD`)}</h3></div>
              <span className="revision-badge">{workflowLabel(historicalIteration.state, text)}</span>
            </header>
            <dl>
              <div><dt>{text("基础源码", "Base source")}</dt><dd>{historicalIteration.baseSourceRevision ? `r${historicalIteration.baseSourceRevision}` : "—"}</dd></div>
              <div><dt>{text("产出源码", "Output source")}</dt><dd>{historicalIteration.outputSourceRevision ? `r${historicalIteration.outputSourceRevision}` : "—"}</dd></div>
              <div><dt>{text("基础文档", "Base document")}</dt><dd>R{historicalIteration.baseDocumentRevision}</dd></div>
              <div><dt>{text("批准文档", "Approved document")}</dt><dd>{historicalIteration.approvedDocumentRevision ? `R${historicalIteration.approvedDocumentRevision}` : "—"}</dd></div>
            </dl>
            {historicalIteration.events.length ? (
              <details>
                <summary>{text(`查看 ${historicalIteration.events.length} 条工作流事件`, `View ${historicalIteration.events.length} workflow events`)}</summary>
                <ol>{historicalIteration.events.map(event => <li key={event.id}><code>{event.kind}</code><time>{formatConversationTime(event.createdAt, localeTag(locale), text)}</time></li>)}</ol>
              </details>
            ) : null}
          </section>
        ) : null}
        {assetPanelExpanded && !viewingHistoricalIteration ? (
          <div className="product-delivery-inline-assets"><AssetManifestPanel onRerunStarted={() => void loadProject(true)} projectId={projectId} /></div>
        ) : null}
        <details className="product-delivery-configuration">
          <summary>
            <span className="product-delivery-config-copy">
              <span aria-hidden="true" className="product-delivery-config-marker">CFG</span>
              <span><b>{text("项目交付配置", "PROJECT DELIVERY SETTINGS")}</b><small>{text("Git 分支、代码仓库与 SteamPipe", "Git branch, repository, and SteamPipe")}</small></span>
            </span>
            <span className="product-delivery-config-summary-meta">
              <span className="product-delivery-config-branch">{localGit?.repository ? localGit.branch ?? "DETACHED HEAD" : text("未绑定 Git", "NO GIT")}</span>
              <span className="product-delivery-config-toggle">
                <span className="product-delivery-config-toggle-closed">{text("点击展开", "OPEN SETTINGS")}</span>
                <span className="product-delivery-config-toggle-open">{text("点击收起", "CLOSE SETTINGS")}</span>
                <ArrowIcon aria-hidden="true" />
              </span>
            </span>
          </summary>
          <div className="product-delivery-configuration-grid">
            <section aria-label={text("Git 配置", "Git settings")} className="project-delivery-git-settings">
              <header><span className="eyebrow">GIT</span><h3>{text("代码仓库与分支", "REPOSITORY & BRANCH")}</h3></header>
              {project.localDirectory ? <div className="local-git-branch-panel">
                <div className="local-git-branch-toolbar">
                  <div className="local-git-branch-status">
                    <span>{text(project.localDirectory.sourceKind === "GIT" ? "本地 GitHub 工作目录" : "本地项目工作目录", project.localDirectory.sourceKind === "GIT" ? "LOCAL GITHUB WORKTREE" : "LOCAL PROJECT WORKTREE")}</span>
                    {localGit?.repository ? <strong><span>{text("当前分支", "Current branch")}</span><code>{localGit.branch ?? "DETACHED HEAD"}</code></strong> : null}
                  </div>
                  {localGit?.repository && !editingLocalBranch ? <button className="button button-secondary" disabled={deliveryActive || viewingHistoricalIteration} onClick={() => { setNewBranchName(""); setEditingLocalBranch(true); }} type="button">{text("修改分支", "CHANGE BRANCH")}</button> : null}
                </div>
                {localGit?.repository && editingLocalBranch ? <form className="local-git-branch-form" onSubmit={event => void createLocalBranch(event)}>
                  <label><span>{text("新分支名称", "New branch name")}</span><input aria-label={text("新建 Git 分支", "New Git branch")} autoCapitalize="none" autoComplete="off" autoFocus disabled={branchBusy || deliveryActive || viewingHistoricalIteration} onChange={event => setNewBranchName(event.target.value)} placeholder="codex/my-feature" spellCheck={false} value={newBranchName} /></label>
                  <div><button className="button button-secondary" disabled={branchBusy} onClick={() => { setNewBranchName(""); setEditingLocalBranch(false); }} type="button">{text("取消", "CANCEL")}</button><button className="button button-primary" disabled={branchBusy || deliveryActive || viewingHistoricalIteration || !newBranchName.trim()} type="submit">{branchBusy ? text("正在创建…", "CREATING…") : text("新建并切换", "CREATE & SWITCH")}</button></div>
                </form> : null}
                {localGit === null && !localGitError ? <small>{text("正在读取本地 Git 状态…", "Reading local Git status…")}</small> : null}
                {localGit && !localGit.repository ? <small>{text("该项目目录尚未初始化为 Git 仓库。", "This project directory is not a Git repository yet.")}</small> : null}
                {deliveryActive && localGit?.repository ? <small>{text("交付进行中不能切换分支。", "Branches cannot be switched during delivery.")}</small> : null}
                {viewingHistoricalIteration && localGit?.repository ? <small>{text("历史轮次为只读视图。", "Historical iterations are read-only.")}</small> : null}
                {localGitError ? <p aria-live="polite" className="repository-onboarding-error">{localGitError}</p> : null}
              </div> : null}
              {!project.localDirectory ? <p className="project-delivery-config-empty">{text("当前项目没有可配置的 Git 工作目录。", "This project has no configurable Git worktree.")}</p> : null}
            </section>
            <ProjectSteamPanel
              compact
              iterationNumber={viewedIterationNumber}
              onChanged={async () => { await Promise.all([loadProject(true), loadIterations(), loadArtifacts(true)]); }}
              projectId={projectId}
              readOnly={viewingHistoricalIteration}
              workflowId={viewingHistoricalIteration ? historicalIteration.workflowId : project.workflowId}
              workflowState={viewedWorkflowState}
            />
          </div>
        </details>
      </section>

      <div className="project-collaboration-layout">
      <section className="project-primary-section project-conversations-section" aria-label={text("项目会话", "Project conversations")}>
        <div className="project-primary-section-heading"><div><b>{text("项目会话", "PROJECT CONVERSATIONS")}</b><small>{text("设计、开发与测试 Agent 的协作记录", "Design, Development, and Test Agent collaboration")}</small></div></div>
        <section className="conversation-panel project-conversation-panel">
            <div className="conversation-header product-panel-heading">
              <div><span><h2>{text("会话记录", "CONVERSATION HISTORY")}</h2><small>{conversations.length ? text(`${conversations.length} 个历史会话`, `${conversations.length} saved conversation${conversations.length === 1 ? "" : "s"}`) : text("还没有历史会话", "No conversation history")}</small></span></div>
              <button className="button button-secondary project-new-conversation" disabled={viewingHistoricalIteration} onClick={startConversation} type="button"><PlusIcon />{text("新对话", "NEW CHAT")}</button>
            </div>
            {viewingHistoricalIteration ? <p className="product-iteration-readonly-notice">{text("正在查看历史轮次。会话和项目说明仅供参考；切回当前轮后才能修改。", "You are viewing a historical iteration. Conversations and the project document are reference-only until you return to the current iteration.")}</p> : null}
            <div className="project-conversation-layout">
              <nav aria-label={text("历史会话", "Conversation history")} className="project-conversation-history">
                <span className="project-conversation-history-title">{text("历史会话", "HISTORY")}</span>
                {conversations.length ? conversations.map(item => (
                  <button
                    aria-pressed={selectedConversationId === item.id}
                    className={selectedConversationId === item.id ? "is-active" : ""}
                    key={item.id}
                    onClick={() => void openConversation(item.id)}
                    type="button"
                  >
                    <b>{item.preview}</b>
                    <small>{conversationActivityLabel(item.userMessageCount, item.systemGenerated, text)} · {formatConversationTime(item.updatedAt, localeTag(locale), text)}</small>
                  </button>
                )) : <p>{text("发送第一条消息后，会话会保存在这里。", "Your conversations will appear here after the first message.")}</p>}
              </nav>

              <ConversationBox
                agentProgress={{
                  running: !viewingHistoricalIteration && agentRunning,
                  events: viewingHistoricalIteration ? Object.freeze([]) : activeAgentProgress,
                }}
                className="project-conversation-box"
                conversationKey={activeConversation?.id ?? null}
                disabled={viewingHistoricalIteration}
                focusKey={conversationFocusKey}
                messages={orderedMessages}
                onOptionSelect={option => void sendConversationMessage(undefined, option)}
                onSubmit={sendConversationMessage}
                onValueChange={setConversationInput}
                placeholder={agentRunning
                  ? text("向正在生成的 Agent 发送引导…", "Guide the Agent while it is generating…")
                  : activeConversation ? text("继续这段会话…", "Continue this conversation…") : text("开始一个新的项目会话…", "Start a new project conversation…")}
                primaryAction={!viewingHistoricalIteration && requirementsReady && !sendingMessage ? (
                  <button
                    className="button button-secondary conversation-box-develop"
                    disabled={busy}
                    onClick={() => void mutate("approve")}
                    type="button"
                  >{busy ? text("正在开始开发…", "STARTING…") : text("按照当前需求开发", "BUILD CURRENT REQUIREMENTS")}</button>
                ) : null}
                sendButtonLabel={text("发送项目消息", "Send project message")}
                sending={sendingMessage}
                showSendingReply={!agentRunning}
                streamingReplies={streamingReplies}
                textareaLabel={text("继续项目会话", "Continue project conversation")}
                value={conversationInput}
              />
            </div>
        </section>
      </section>

      <section className="project-primary-section project-document-section" aria-label={text("项目说明", "Project document")}>
        <div className="project-primary-section-heading"><div><b>{text("项目说明", "PROJECT DOCUMENT")}</b><small>{text("由需求会话持续维护的当前设计规格", "The current design specification maintained by project conversations")}</small></div></div>
        <aside className="product-document-sidebar">
          <header className="product-document-sidebar-header">
            <div><span><b>{text("当前项目说明", "CURRENT PROJECT DOCUMENT")}</b><small>{text("Agent 随需求对话实时维护", "Updated by Agent from the conversation")}</small></span></div>
          </header>
          <>
              <div className="product-document-sidebar-actions">
                <span className="revision-badge">R{project.document.revision} · {documentMaintainer(project.document.maintainedBy, text)}</span>
                {editingDocument ? (
                  <div><button className="button button-secondary" disabled={busy} onClick={() => setEditingDocument(false)}>{text("取消", "CANCEL")}</button><button className="button button-primary" disabled={busy} onClick={() => void saveDocument()}>{text("保存", "SAVE")}</button></div>
                ) : <button className="button button-secondary" disabled={busy || viewingHistoricalIteration} onClick={beginDocumentEdit}>{text("编辑", "EDIT")}</button>}
              </div>
              {editingDocument ? (
                <div className="product-document-sidebar-editor">
                  <label><span>{text("游戏介绍", "Game introduction")}</span><textarea value={documentDraft.introduction} onChange={event => setDocumentDraft(current => ({ ...current, introduction: event.target.value }))} /></label>
                  <label><span>{text("玩法", "Gameplay")}</span><textarea value={documentDraft.gameplay} onChange={event => setDocumentDraft(current => ({ ...current, gameplay: event.target.value }))} /></label>
                  <label><span>{text("游戏分类", "Categories")}</span><textarea value={documentDraft.categories} onChange={event => setDocumentDraft(current => ({ ...current, categories: event.target.value }))} /></label>
                  <label><span>{text("主要特性", "Key features")}</span><textarea value={documentDraft.features} onChange={event => setDocumentDraft(current => ({ ...current, features: event.target.value }))} /></label>
                </div>
              ) : (
                <div
                  aria-label={text("项目说明内容", "Project document content")}
                  className="product-document-sidebar-content"
                  role="region"
                  tabIndex={0}
                >
                  <article><span className="document-section-label">{text("游戏介绍", "GAME INTRODUCTION")}</span><p>{project.document.content.introduction}</p></article>
                  <article><span className="document-section-label">{text("玩法", "GAMEPLAY")}</span><p>{project.document.content.gameplay}</p></article>
                  <article><span className="document-section-label">{text("游戏分类", "CATEGORIES")}</span><div className="product-document-tags">{project.document.content.categories.map(category => <span key={category}>{category}</span>)}</div></article>
                  <article><span className="document-section-label">{text("主要特性", "KEY FEATURES")}</span><ul>{project.document.content.features.map(feature => <li key={feature}>{feature}</li>)}</ul></article>
                </div>
              )}
            </>
        </aside>
      </section>
      </div>

      {confirmingDelete ? (
        <div className="workspace-dialog-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !deleting) { setDeleteLocalDirectory(false); setDeleteError(null); setConfirmingDelete(false); } }}>
          <section aria-labelledby="project-delete-title" aria-modal="true" className="workspace-dialog project-delete-dialog" role="dialog">
            <span className="eyebrow">DELETE PROJECT</span>
            <h2 id="project-delete-title">{text(`删除《${project.name}》？`, `DELETE “${project.name}”?`)}</h2>
            <p>{deliveryActive ? text("正在执行的任务会先被停止；随后删除历史会话、说明文档、工作流、对象制品和 Core 源码快照。", "Active tasks will be stopped first; conversations, documents, workflows, object artifacts, and Core source snapshots will then be deleted.") : text("历史会话、说明文档、工作流、对象制品和 Core 源码快照都会永久删除。", "Conversations, documents, workflows, object artifacts, and Core source snapshots will be deleted permanently.")}</p>
            <label className="project-delete-local-option">
              <input checked={deleteLocalDirectory} disabled={deleting} onChange={event => setDeleteLocalDirectory(event.target.checked)} type="checkbox" />
              <span aria-hidden="true" className="project-delete-checkbox-indicator" />
              <span className="project-delete-local-copy"><b>{text("同时删除本地项目目录", "ALSO DELETE LOCAL PROJECT DIRECTORY")}</b><small>{project.localDirectory ? text("将永久删除已绑定的项目文件夹及其中所有文件，无法恢复。", "Permanently deletes the bound project folder and every file inside it. This cannot be undone.") : text("该项目使用 DeviLudo 本机托管源码；勾选后会一并清理，不会删除工作区之外的目录。", "This project uses DeviLudo-managed local source; selecting this cleans it without deleting any directory outside the workspace.")}</small></span>
            </label>
            {deleteError ? <p aria-live="assertive" className="project-delete-error" role="alert">{deleteError}</p> : null}
            <div><button className="button button-secondary" disabled={deleting} onClick={() => { setDeleteLocalDirectory(false); setDeleteError(null); setConfirmingDelete(false); }} type="button">{text("返回", "BACK")}</button><button className="button project-delete-confirm" disabled={deleting} onClick={() => void deleteProject()} type="button">{deleting ? text("正在删除…", "DELETING…") : deleteLocalDirectory ? text("删除项目和目录", "DELETE PROJECT & DIRECTORY") : text("确认删除", "CONFIRM DELETE")}</button></div>
          </section>
        </div>
      ) : null}
    </>
  );
}

async function readLocalGitStatus(
  bindingId: string,
  text: (chinese: string, english: string) => string,
  errorText: (message: unknown, chineseFallback: string, englishFallback: string) => string,
): Promise<LocalGitState> {
  const bridgeUrl = await localProjectBridgeUrl(text);
  const response = await fetch(`${bridgeUrl}/directory/git/status`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ bindingId }),
  });
  const payload = await response.json().catch(() => ({})) as Partial<LocalGitState> & { code?: string; message?: string };
  if (!response.ok || typeof payload.repository !== "boolean"
    || (payload.branch !== null && typeof payload.branch !== "string")) {
    throw new LocalGitError(payload.code ?? "LOCAL_GIT_STATUS_FAILED", errorText(payload.message, "本地 Git 状态读取失败", "Unable to read local Git status"));
  }
  return Object.freeze({ repository: payload.repository, branch: payload.branch ?? null });
}

async function localProjectBridgeUrl(text: (chinese: string, english: string) => string): Promise<string> {
  const response = await fetch("/api/local-git-import/config", { cache: "no-store" });
  const configuration = await response.json() as { available?: boolean; url?: string };
  if (!response.ok || !configuration.available || !configuration.url) {
    throw new LocalGitError("LOCAL_PROJECT_BRIDGE_UNAVAILABLE", text(
      "本地项目服务未启动，请运行 npm run local:up",
      "The local project service is not running. Run npm run local:up.",
    ));
  }
  return configuration.url;
}

class LocalGitError extends Error {
  constructor(readonly code: string, message?: string) { super(message); }
}

function localGitMessage(reason: unknown, text: (chinese: string, english: string) => string): string {
  if (!(reason instanceof LocalGitError)) {
    return reason instanceof Error ? reason.message : text("本地 Git 操作失败", "Local Git operation failed");
  }
  if (reason.code === "INVALID_GIT_BRANCH") return text("请输入有效的新分支名称", "Enter a valid new branch name");
  if (reason.code === "GIT_BRANCH_EXISTS") return reason.message || text("该分支已存在，请输入新的分支名称", "That branch already exists. Enter a new branch name.");
  if (reason.code === "NOT_A_GIT_REPOSITORY") return text("当前项目目录不是 Git 仓库，不能创建分支", "The current project directory is not a Git repository, so a branch cannot be created");
  if (["DIRECTORY_BINDING_NOT_FOUND", "DIRECTORY_BINDING_CHANGED"].includes(reason.code)) {
    return text("本地项目目录绑定已失效，请重新导入项目", "The local project directory binding is no longer valid. Import the project again.");
  }
  if (reason.code === "LOCAL_PROJECT_BUSY") return text("已有本地项目操作正在进行，请稍后重试", "Another local project operation is in progress. Try again shortly.");
  if (reason.code === "LOCAL_PROJECT_BRIDGE_UNAVAILABLE") return reason.message || text("本地项目服务不可用", "The local project service is unavailable");
  return reason.message || text("本地 Git 操作失败", "Local Git operation failed");
}

function newestProjectSnapshot(
  current: ProductProjectDetail | null,
  incoming: ProductProjectDetail,
): ProductProjectDetail {
  if (!current || current.id !== incoming.id || current.document.revision <= incoming.document.revision) return incoming;
  return Object.freeze({ ...incoming, document: current.document });
}

function aggregateJobState(states: readonly string[]): string {
  if (!states.length) return "PENDING";
  if (states.some(state => state === "FAILED")) return "FAILED";
  if (states.some(state => state === "RUNNING")) return "RUNNING";
  if (states.every(state => state === "SUCCEEDED")) return "SUCCEEDED";
  if (states.some(state => state === "QUEUED" || state === "RETRY")) return "QUEUED";
  return states[0];
}

type PipelineStageView = Readonly<{
  kind: "completed" | "active" | "pending" | "failed" | "cancelled";
  label: string;
  symbol: string;
}>;

function discoveryStageView(
  input: Readonly<{
    imported: boolean;
    analysisStatus: ProductProjectDetail["analysisStatus"];
    requirementsReady: boolean;
    historical: boolean;
    workflowState: string;
    questionCount: number;
  }>,
  text: (chinese: string, english: string) => string,
): Readonly<{ title: string; detail: string; view: PipelineStageView }> {
  const title = input.imported
    ? text("已有项目分析", "PROJECT ANALYSIS")
    : text("需求沟通", "REQUIREMENTS");
  if (input.historical || input.workflowState !== "DRAFT") {
    return {
      title,
      detail: input.imported
        ? text("现状、缺口与开发计划已确认", "Current state, gaps, and plan confirmed")
        : text("本轮批准需求已冻结", "Approved requirements frozen for this iteration"),
      view: pipelineStageView("SUCCEEDED", text),
    };
  }
  if (input.imported) {
    if (input.analysisStatus === "FAILED") {
      return { title, detail: text("源码分析失败，请先重试", "Source analysis failed; retry it first"), view: pipelineStageView("FAILED", text) };
    }
    if (input.analysisStatus === "NEEDS_INPUT") {
      return {
        title,
        detail: text(
          `请在项目会话中回答 ${input.questionCount || "待确认"} 个分析问题`,
          `Answer ${input.questionCount || "the"} analysis question${input.questionCount === 1 ? "" : "s"} in project chat`,
        ),
        view: { kind: "active", label: text("等待用户确认", "AWAITING INPUT"), symbol: "?" },
      };
    }
    if (input.analysisStatus === "PENDING" || input.analysisStatus === "ANALYZING") {
      return {
        title,
        detail: text("正在检查游戏内容、完成度、启动流程与开发缺口", "Inspecting game content, completion, startup flow, and gaps"),
        view: pipelineStageView("RUNNING", text),
      };
    }
    return {
      title,
      detail: text("现状、缺口与建议开发计划已生成", "Current state, gaps, and development plan generated"),
      view: pipelineStageView("SUCCEEDED", text),
    };
  }
  if (input.requirementsReady) {
    return {
      title,
      detail: text("需求已明确，可以批准开发", "Requirements are clear and ready for approval"),
      view: pipelineStageView("SUCCEEDED", text),
    };
  }
  return {
    title,
    detail: text("在项目会话中明确目标、玩法与验收标准", "Clarify goals, gameplay, and acceptance criteria in project chat"),
    view: { kind: "active", label: text("沟通需求中", "DISCUSSING"), symbol: "…" },
  };
}

function pipelineStageView(state: string, text: (chinese: string, english: string) => string): PipelineStageView {
  if (state === "SUCCEEDED") return { kind: "completed", label: text("已完成", "COMPLETED"), symbol: "✓" };
  if (state === "RUNNING" || state === "QUEUED" || state === "RETRY") return { kind: "active", label: text("进行中", "IN PROGRESS"), symbol: "●" };
  if (state === "FAILED") return { kind: "failed", label: text("失败", "FAILED"), symbol: "!" };
  if (state === "CANCELLED") return { kind: "cancelled", label: text("已取消", "CANCELLED"), symbol: "×" };
  return { kind: "pending", label: text("未开始", "NOT STARTED"), symbol: "○" };
}

/**
 * A stage the current profile never reaches. It stays on the track so the chain
 * reads as a whole, but it is not "not started" — this run will never run it.
 */
function OUT_OF_PROFILE_STAGE_VIEW(text: (chinese: string, english: string) => string): PipelineStageView {
  return { kind: "pending", label: text("不适用", "NOT APPLICABLE"), symbol: "–" };
}

function pipelineJobDetails(jobs: ProductProjectDetail["jobs"], text: (chinese: string, english: string) => string): string {
  if (!jobs.length) return text("等待上一步", "Waiting for previous stage");
  return jobs.map(job => `${job.targetOperatingSystem ?? "core"} · ${jobStateLabel(job.state, text)}`).join(" / ");
}

function latestPipelineJobs(jobs: ProductProjectDetail["jobs"]): ProductProjectDetail["jobs"] {
  const latest = new Map<string, ProductProjectDetail["jobs"][number]>();
  for (const job of jobs) {
    const key = `${job.kind}:${job.targetOperatingSystem ?? "core"}`;
    const current = latest.get(key);
    if (!current || Date.parse(current.createdAt) <= Date.parse(job.createdAt)) latest.set(key, job);
  }
  return Object.freeze([...latest.values()]);
}

export function pipelineStageFinishedAt(jobs: ProductProjectDetail["jobs"]): string | null {
  if (!jobs.length || jobs.some(job => !["SUCCEEDED", "FAILED", "CANCELLED"].includes(job.state))) return null;
  const timestamps = jobs.map(job => Date.parse(job.updatedAt));
  if (timestamps.some(value => !Number.isFinite(value))) return null;
  return new Date(Math.max(...timestamps)).toISOString();
}

export function pipelineEventFinishedAt(
  events: ProductProjectDetail["events"],
  eventKind: string,
): string | null {
  const timestamps = events
    .filter(event => event.kind === eventKind)
    .map(event => Date.parse(event.createdAt))
    .filter(Number.isFinite);
  return timestamps.length ? new Date(Math.max(...timestamps)).toISOString() : null;
}

type JobFailurePresentation = Readonly<{ title: string; reason: string; action: string }>;

export function jobFailurePresentation(
  job: ProductProjectDetail["jobs"][number],
  text: (chinese: string, english: string) => string,
): JobFailurePresentation {
  const raw = job.lastError ?? "";
  const stageLabel = pipelineKindLabels(job.kind);
  const title = job.kind === "AGENT_GENERATION"
    ? text("Agent 生成失败", "AGENT GENERATION FAILED")
    : text(`${stageLabel[0]}失败`, `${stageLabel[1]} failed`);
  const infrastructure = raw.match(/^E2E_INFRASTRUCTURE\/(NODE|VM|GODOT_RUNTIME|NETWORK):\s*(.*)$/s);
  if (job.kind === "E2E_TEST" && infrastructure) {
    const labels: Record<string, readonly [string, string]> = {
      NODE: ["E2E 节点", "E2E node"],
      VM: ["隔离虚拟机", "isolated VM"],
      GODOT_RUNTIME: ["Godot 运行时", "Godot runtime"],
      NETWORK: ["节点网络", "node network"],
    };
    const label = labels[infrastructure[1]] ?? labels.NODE;
    return {
      title,
      reason: text(`${label[0]}发生基础设施故障，游戏内容尚未被判定为失败。`, `The ${label[1]} had an infrastructure failure; the game content has not been marked as failed.`),
      action: text("修复对应基础设施后重新测试；无需重新生成游戏。", "Repair the affected infrastructure and rerun E2E; the game does not need to be regenerated."),
    };
  }
  if (job.kind === "E2E_TEST" && /^E2E_PRODUCT:/i.test(raw)) {
    return {
      title: text("游戏制品未通过 E2E", "GAME ARTIFACT FAILED E2E"),
      reason: text("平台已确认问题来自游戏制品内容，自动 Agent 修复次数已用尽或全局 Agent 当前不可用。", "The platform confirmed a game-artifact issue, but automatic Agent repairs were exhausted or the global Agent is unavailable."),
      action: text("检查 Agent 配置后重新生成；E2E 报告已保留在项目制品中。", "Check the Agent settings and regenerate; the E2E report remains available in Project Artifacts."),
    };
  }
  if (/allowlist|not in the signed release|no such image/i.test(raw)) {
    return {
      title,
      reason: text("任务引用的运行环境已被本地更新替换，旧镜像无法再安全启动。", "The task referenced a runtime image that was replaced by a local update and can no longer be started safely."),
      action: text("使用当前已验证的 Agent 运行环境重新生成。", "Retry with the currently verified Agent runtime."),
    };
  }
  if (/401|403|unauthori[sz]ed|invalid.*(?:key|token)|authentication/i.test(raw)) {
    return {
      title,
      reason: text("Provider 拒绝了 Agent 凭据。", "The provider rejected the Agent credential."),
      action: text("请在设置中检查 API Key、Base URL 和模型后重试。", "Check the API key, base URL, and model in Settings, then retry."),
    };
  }
  if (/source revision is already published with different content/i.test(raw)) {
    return {
      title,
      reason: text("上一次 Agent 已写入源码，但后续登记没有完成，遗留的未登记 revision 阻塞了自动重试。", "The previous Agent wrote source files but did not finish registration, so an unregistered revision blocked the retry."),
      action: text("重新执行 Agent；系统会先回收未登记 revision，再安全生成。", "Rerun the Agent; the unregistered revision will be reclaimed before generation starts."),
    };
  }
  if (/deviludo-executor\/executor\.sock|sandbox executor unavailable|docker executor operation failed|ECONNREFUSED.*executor\.sock/i.test(raw)) {
    return {
      title,
      reason: text("Core 的 Agent 隔离执行器当前不可用，任务尚未连接到 Provider。", "The Core Agent sandbox executor is unavailable; the task did not reach the provider."),
      action: text("恢复 Core 执行器后重新生成；本地环境请重新运行 npm run local:up。", "Restore the Core executor and retry; for local deployments, run npm run local:up again."),
    };
  }
  if (/timed? out|timeout|ECONN|ENOTFOUND|network|socket hang up/i.test(raw)) {
    return {
      title,
      reason: text("Agent 运行时未能连接 Provider，或执行超过了时限。", "The Agent runtime could not reach the provider or exceeded its time limit."),
      action: text("检查网络与 Provider 状态后重新生成。", "Check network and provider availability, then retry."),
    };
  }
  if (/vault|secret|credential|EACCES|permission denied/i.test(raw)) {
    return {
      title,
      reason: text("Agent 无法读取受保护的运行凭据。", "The Agent could not read its protected runtime credential."),
      action: text("重新保存 Agent 配置；若问题仍存在，请检查 Core 与 Vault 状态。", "Save the Agent configuration again; if it persists, check Core and Vault."),
    };
  }
  if (job.kind === "ARTIFACT_BUILD" && /export_presets\.cfg|export preset/i.test(raw)) {
    return {
      title,
      reason: text("Builder 缺少受控的 Godot 导出预设，无法生成目标平台制品。", "The Builder did not have a controlled Godot export preset for the target platform."),
      action: text("使用修复后的 Builder 重新构建；无需重新运行 Agent。", "Retry with the corrected Builder; the Agent does not need to run again."),
    };
  }
  if (job.kind === "E2E_TEST" && /env:\s*node:\s*No such file|ENOENT.*node/i.test(raw)) {
    return {
      title,
      reason: text("E2E 节点未能启动受控测试运行器。", "The E2E node could not start its controlled test runner."),
      action: text("使用修复后的节点运行时重新测试；无需重新生成或构建。", "Retry with the corrected node runtime; generation and build do not need to run again."),
    };
  }
  if (/DEVILUDO_PROGRESS:/i.test(raw)) {
    return {
      title,
      reason: text("旧执行器把正常进度混入了失败日志，导致真实原因被截断。", "The previous executor mixed normal progress into the failure log, truncating the real cause."),
      action: text("使用修复后的执行器重新生成；后续失败将直接显示真实原因。", "Retry with the corrected executor; subsequent failures will show the actual cause."),
    };
  }
  return {
    title,
    reason: text("该阶段在多次重试后仍未完成。", "This stage did not complete after multiple attempts."),
    action: job.kind === "AGENT_GENERATION"
      ? text("可重新生成；技术详情可用于进一步排查。", "Retry the Agent; technical details are available for diagnosis.")
      : text("请展开技术详情排查后再继续。", "Expand the technical details before continuing."),
  };
}

function pipelineKindLabels(kind: string): readonly [string, string] {
  const stage = PIPELINE.find(([candidate]) => candidate === kind);
  return stage ? [stage[1], stage[2]] : [kind, kind];
}

export function technicalFailureDetail(raw: string): string {
  const withoutProgress = raw
    .replace(/(?:Sandbox executor failed:\s*)?DEVILUDO_PROGRESS:[^\n]*(?:\n|$)/g, "")
    .trim();
  if (!withoutProgress && raw.includes("DEVILUDO_PROGRESS:")) {
    return "EXECUTOR_DIAGNOSTIC_TRUNCATED: The previous executor did not preserve the actual failure reason";
  }
  const detail = withoutProgress || raw;
  const jsonStart = detail.indexOf("{");
  if (jsonStart >= 0) {
    try {
      const value = JSON.parse(detail.slice(jsonStart)) as { code?: unknown; message?: unknown };
      const code = typeof value.code === "string" ? value.code : "EXECUTION_FAILED";
      const message = typeof value.message === "string" ? value.message : detail;
      return `${code}: ${message}`;
    } catch { /* retain the bounded original detail */ }
  }
  return detail.slice(-800);
}

function jobStateLabel(state: string, text: (chinese: string, english: string) => string): string {
  if (state === "SUCCEEDED") return text("完成", "Complete");
  if (state === "RUNNING") return text("执行中", "Running");
  if (state === "QUEUED") return text("排队中", "Queued");
  if (state === "RETRY") return text("等待重试", "Retry pending");
  if (state === "FAILED") return text("失败", "Failed");
  if (state === "CANCELLED") return text("已取消", "Cancelled");
  return state;
}

function documentLines(value: string): string[] {
  return value.split(/\n|，|,/).map(item => item.trim()).filter(Boolean);
}

function artifactLabel(
  artifact: ArtifactRecord,
  text: (chinese: string, english: string) => string,
): string {
  const labels: Record<ArtifactRecord["kind"], readonly [string, string]> = {
    SPECIFICATION: ["需求快照", "REQUIREMENTS SNAPSHOT"],
    PROJECT_DOCUMENT: ["项目说明", "PROJECT DOCUMENT"],
    BUILD: ["游戏构建", "GAME BUILD"],
    E2E_REPORT: ["E2E 报告", "E2E REPORT"],
    E2E_REGRESSION: ["当前回归轨迹", "CURRENT REGRESSION TRACE"],
    SIGNED_BUILD: ["签名构建", "SIGNED BUILD"],
    PUBLISH_RECEIPT: ["发布回执", "PUBLISH RECEIPT"],
    CLEAN_INSTALL_REPORT: ["回装报告", "CLEAN-INSTALL REPORT"],
  };
  const label = labels[artifact.kind];
  return text(label[0], label[1]);
}

function latestArtifactsByKindAndPlatform(values: readonly ArtifactRecord[]): readonly ArtifactRecord[] {
  const latest = new Map<string, ArtifactRecord>();
  for (const artifact of values) {
    // Regression traces are internal inputs for the next E2E job, not user-facing downloads.
    if (artifact.kind === "E2E_REGRESSION") continue;
    const key = `${artifact.kind}:${artifact.targetPlatform ?? "common"}`;
    const current = latest.get(key);
    if (!current || artifact.createdAt > current.createdAt
      || (artifact.createdAt === current.createdAt && artifact.id > current.id)) {
      latest.set(key, artifact);
    }
  }
  return Object.freeze([...latest.values()].sort((left, right) =>
    right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id)));
}

function groupArtifactsByPipelineStage(
  values: readonly ArtifactRecord[],
): ReadonlyMap<(typeof PIPELINE)[number][0], readonly ArtifactRecord[]> {
  const grouped = new Map<(typeof PIPELINE)[number][0], ArtifactRecord[]>();
  for (const artifact of values) {
    const stage = artifactPipelineStage(artifact.kind);
    const stageArtifacts = grouped.get(stage) ?? [];
    stageArtifacts.push(artifact);
    grouped.set(stage, stageArtifacts);
  }
  return grouped;
}

function artifactPipelineStage(kind: ArtifactRecord["kind"]): (typeof PIPELINE)[number][0] {
  if (kind === "BUILD" || kind === "SIGNED_BUILD") return "ARTIFACT_BUILD";
  if (kind === "E2E_REPORT" || kind === "CLEAN_INSTALL_REPORT") return "E2E_TEST";
  if (kind === "PUBLISH_RECEIPT") return "STEAM_PUBLISH";
  return "AGENT_GENERATION";
}

function formatArtifactSize(sizeBytes: number): string {
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  if (sizeBytes < 1024 ** 2) return `${(sizeBytes / 1024).toFixed(1)} KiB`;
  if (sizeBytes < 1024 ** 3) return `${(sizeBytes / 1024 ** 2).toFixed(1)} MiB`;
  return `${(sizeBytes / 1024 ** 3).toFixed(1)} GiB`;
}

function documentMaintainer(value: ProductProjectDetail["document"]["maintainedBy"], text: (chinese: string, english: string) => string): string {
  if (value === "AGENT") return text("Agent 维护", "Agent maintained");
  if (value === "USER") return text("协作者维护", "Contributor maintained");
  return text("初始文档", "Initial document");
}

function conversationSummary(conversation: ProductConversation): ProductConversationSummary {
  const firstUserMessage = conversation.messages.find(message => message.role === "USER");
  return Object.freeze({
    id: conversation.id,
    projectId: conversation.projectId,
    mode: conversation.mode,
    title: conversation.title,
    preview: firstUserMessage?.content ?? conversation.title,
    messageCount: conversation.messages.length,
    userMessageCount: conversation.messages.filter(message => message.role === "USER").length,
    systemGenerated: conversation.messages.some(message => message.metadata.source === "PROJECT_IMPORT_AGENT"),
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
  });
}

function conversationActivityLabel(
  userMessageCount: number,
  systemGenerated: boolean,
  text: (chinese: string, english: string) => string,
): string {
  if (systemGenerated) return text("系统分析", "SYSTEM ANALYSIS");
  const count = Math.max(1, userMessageCount);
  return text(`${count} 次用户发言`, `${count} user message${count === 1 ? "" : "s"}`);
}

function formatConversationTime(value: string, locale: string, text: (chinese: string, english: string) => string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return text("刚刚", "Just now");
  return new Intl.DateTimeFormat(locale, {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function workflowLabel(state: string, text: (chinese: string, english: string) => string): string {
  const labels: Record<string, readonly [string, string]> = {
    DRAFT: ["需求讨论中", "Requirements discussion"], AGENT_RUNNING: ["Agent 生成中", "Agent running"],
    ASSET_GENERATING: ["图片素材生成中", "Generating image assets"],
    ARTIFACT_BUILDING: ["制品构建中", "Building artifacts"], E2E_TESTING: ["跨平台测试中", "Cross-platform testing"],
    RELEASE_DECISION_PENDING: ["等待发布决策", "Awaiting release decision"],
    SIGNING: ["平台签名中（历史）", "Signing (legacy)"], RELEASE_APPROVAL_PENDING: ["等待发布批准（历史）", "Awaiting release approval (legacy)"], STEAM_PUBLISHING: ["Steam 发布中", "Publishing to Steam"],
    CLEAN_INSTALL_VERIFYING: ["干净回装验证中", "Clean-install verification"], SUCCEEDED: ["交付完成", "Delivered"],
    FAILED: ["流程失败", "Failed"], CANCELLED: ["已取消", "Cancelled"],
  };
  const label = labels[state];
  return label ? text(label[0], label[1]) : state;
}

function workflowNeedsPolling(state: string): boolean {
  return ["AGENT_RUNNING", "ASSET_GENERATING", "ARTIFACT_BUILDING", "E2E_TESTING", "STEAM_PUBLISHING"].includes(state);
}
