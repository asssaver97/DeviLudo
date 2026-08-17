"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { cachedValue, clientCacheKeys, loadCached, storeCached } from "@/lib/product/client-cache";
import type { ProductProjectSummary, WorkspaceSummary } from "@/lib/product/contracts";
import { ArrowIcon, FileIcon, PlusIcon, SparkIcon } from "./console/Icons";
import { localeTag, useLanguage } from "./i18n/LanguageProvider";

export function ProductDashboard({
  creationOnly = false,
  initialMode = "IDEA",
}: {
  creationOnly?: boolean;
  initialMode?: "IDEA" | "IMPORT";
}) {
  const { errorText, locale, text } = useLanguage();
  const router = useRouter();
  const conceptRef = useRef<HTMLTextAreaElement>(null);
  const operationKey = useRef<string | null>(null);
  const initialProjects = cachedValue<readonly ProductProjectSummary[]>(clientCacheKeys.projects);
  const [projects, setProjects] = useState<readonly ProductProjectSummary[]>(initialProjects ?? []);
  const [name, setName] = useState("");
  const [concept, setConcept] = useState("");
  const [importSource, setImportSource] = useState<"LOCAL" | "GITHUB">("LOCAL");
  const [githubRepositoryUrl, setGitHubRepositoryUrl] = useState("");
  const [loading, setLoading] = useState(!initialProjects);
  const [creating, setCreating] = useState(false);
  const [retryingProjectId, setRetryingProjectId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    // Resolve the host bridge while the import page is rendering so a click can
    // invoke the native folder chooser immediately instead of paying a Web API
    // round trip first.
    if (creationOnly && initialMode === "IMPORT") void preloadLocalProjectBridgeUrl();
    void loadCached(clientCacheKeys.projects, 10_000, async () => {
      const response = await fetch("/api/projects");
      const payload = response.status === 409 ? { projects: [] } : await readJson(response, errorText);
      return (payload as { projects: readonly ProductProjectSummary[] }).projects;
    }).then(value => {
      if (active) setProjects(value);
    }).catch(reason => {
      if (active) setError(messageFor(reason, text));
    }).finally(() => {
      if (active) setLoading(false);
    });
    if (creationOnly && initialMode === "IDEA") setTimeout(() => conceptRef.current?.focus(), 0);
    return () => { active = false; };
  }, [creationOnly, errorText, initialMode, text]);

  const hasProjectAnalysisInProgress = projects.some(project =>
    project.analysisStatus === "PENDING" || project.analysisStatus === "ANALYZING",
  );
  useEffect(() => {
    if (creationOnly || !hasProjectAnalysisInProgress) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      if (document.visibilityState === "visible") {
        try {
          const response = await fetch("/api/projects", { cache: "no-store" });
          const payload = await readJson(response, errorText) as { projects: readonly ProductProjectSummary[] };
          if (!stopped) {
            setProjects(payload.projects);
            storeCached(clientCacheKeys.projects, payload.projects, 10_000);
          }
        } catch {
          // A later poll can recover from a transient refresh failure; the
          // durable analysis task continues independently in Core.
        }
      }
      if (!stopped) timer = setTimeout(poll, 1_500);
    };
    timer = setTimeout(poll, 600);
    return () => { stopped = true; if (timer) clearTimeout(timer); };
  }, [creationOnly, errorText, hasProjectAnalysisInProgress]);

  async function createProject() {
    if (concept.trim().length < 10 || creating) return;
    setCreating(true);
    setError(null);
    try {
      const response = await fetch("/api/projects", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": `project:${crypto.randomUUID()}` },
        body: JSON.stringify({ name: name.trim(), concept: concept.trim() }),
      });
      const payload = await readJson(response, errorText) as { workspace: WorkspaceSummary; project: ProductProjectSummary };
      cacheProjectSummary(payload.project);
      router.push(`/projects/${payload.project.id}`);
    } catch (reason) {
      if (reason instanceof ApiError && (reason.code === "AGENT_CONFIG_REQUIRED" || reason.code === "AGENT_NAMING_FAILED")) {
        router.push("/settings?required=project-name");
        return;
      }
      setError(messageFor(reason, text));
      setCreating(false);
    }
  }

  async function bindLocalProject() {
    if (creating) return;
    setCreating(true);
    setError(null);
    operationKey.current ??= `project-bind:${crypto.randomUUID()}`;
    try {
      const bridgeUrl = await localProjectBridgeUrl(text);
      const selectionResponse = await fetch(`${bridgeUrl}/directory/select`, {
        method: "POST",
      });
      const local = await bridgeProjectBinding(selectionResponse, text, errorText);
      const response = await fetch("/api/projects/bind/local-directory", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": operationKey.current },
        body: JSON.stringify({
          name: local.name,
          bindingId: local.bindingId,
          ...(local.gitBranch ? { gitBranch: local.gitBranch } : {}),
        }),
      });
      const payload = await readJson(response, errorText) as { workspace: WorkspaceSummary; project: ProductProjectSummary };
      operationKey.current = null;
      cacheProjectSummary(payload.project);
      router.push("/projects");
    } catch (reason) {
      if (reason instanceof ApiError && reason.code === "DIRECTORY_SELECTION_CANCELLED") {
        setCreating(false);
        return;
      }
      if (reason instanceof ApiError && reason.code === "AGENT_CONFIG_REQUIRED") {
        router.push("/settings?required=project-import");
        return;
      }
      setError(messageFor(reason, text));
      setCreating(false);
    }
  }

  async function cloneAndBindGitHubProject() {
    const repositoryUrl = githubRepositoryUrl.trim();
    if (creating || !repositoryUrl) return;
    setCreating(true);
    setError(null);
    operationKey.current ??= `project-bind:${crypto.randomUUID()}`;
    try {
      const bridgeUrl = await localProjectBridgeUrl(text);
      const cloneResponse = await fetch(`${bridgeUrl}/github/clone`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ repositoryUrl }),
      });
      const local = await bridgeProjectBinding(cloneResponse, text, errorText);
      const response = await fetch("/api/projects/bind/github", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": operationKey.current },
        body: JSON.stringify({
          name: local.name,
          repositoryUrl,
          bindingId: local.bindingId,
          ...(local.gitBranch ? { gitBranch: local.gitBranch } : {}),
        }),
      });
      const payload = await readJson(response, errorText) as { workspace: WorkspaceSummary; project: ProductProjectSummary };
      operationKey.current = null;
      cacheProjectSummary(payload.project);
      router.push("/projects");
    } catch (reason) {
      if (reason instanceof ApiError && reason.code === "DIRECTORY_SELECTION_CANCELLED") {
        setCreating(false);
        return;
      }
      if (reason instanceof ApiError && reason.code === "AGENT_CONFIG_REQUIRED") {
        router.push("/settings?required=project-import");
        return;
      }
      setError(messageFor(reason, text));
      setCreating(false);
    }
  }

  async function retryProjectAnalysis(projectId: string) {
    if (retryingProjectId) return;
    setRetryingProjectId(projectId);
    setError(null);
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/analysis/retry`, {
        method: "POST",
      });
      const payload = await readJson(response, errorText) as { project: ProductProjectSummary };
      setProjects(current => {
        const next = current.map(project => project.id === projectId ? payload.project : project);
        storeCached(clientCacheKeys.projects, next, 10_000);
        return next;
      });
    } catch (reason) {
      setError(messageFor(reason, text));
    } finally {
      setRetryingProjectId(null);
    }
  }

  if (creationOnly) {
    return (
      <>
        <section className="project-page-header">
          <div>
            <div className="breadcrumb"><Link href="/projects">{text("游戏项目", "GAME PROJECTS")}</Link><span>/</span><b>{initialMode === "IDEA" ? text("开始新构想", "NEW CONCEPT") : text("关联已有项目", "LINK PROJECT")}</b></div>
            <span className="eyebrow">{initialMode === "IDEA" ? "IDEA TO PLAYABLE" : "SOURCE TO PLAYABLE"}</span>
            <h1>{initialMode === "IDEA" ? text("描述你的新游戏", "DESCRIBE YOUR GAME") : text("关联已有项目", "LINK AN EXISTING PROJECT")}</h1>
          </div>
        </section>
        <section className="repository-onboarding idea-onboarding">
          {initialMode === "IDEA" ? (
            <div className="repository-onboarding-form">
              <label>{text("游戏名称", "Game name")}<input aria-label={text("游戏名称", "Game name")} maxLength={200} onChange={event => setName(event.target.value)} placeholder={text("例如：余烬群岛", "e.g. Ember Archipelago")} value={name} /></label>
              <label>{text("游戏构想", "Game concept")}<textarea ref={conceptRef} aria-label={text("游戏构想", "Game concept")} maxLength={4000} onChange={event => setConcept(event.target.value)} onKeyDown={event => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter") void createProject(); }} placeholder={text("描述玩法、画面或你想让玩家感受到的体验……", "Describe the gameplay, visuals, or the experience you want players to have…")} value={concept} /></label>
              <div className="idea-submit-row"><button className="button button-acid" disabled={concept.trim().length < 10 || creating} onClick={() => void createProject()} type="button"><PlusIcon />{creating ? text("正在建立项目…", "CREATING PROJECT…") : text("创建项目", "CREATE PROJECT")}</button></div>
            </div>
          ) : (
            <div className="repository-onboarding-form project-import-form">
              <div aria-label={text("项目来源", "Project source")} className="import-source-switch" role="tablist">
                <button aria-controls="local-project-import" aria-selected={importSource === "LOCAL"} className={importSource === "LOCAL" ? "is-active" : ""} onClick={() => { setImportSource("LOCAL"); setError(null); }} role="tab" type="button"><FileIcon /> {text("本地项目", "LOCAL PROJECT")}</button>
                <button aria-controls="github-project-import" aria-selected={importSource === "GITHUB"} className={importSource === "GITHUB" ? "is-active" : ""} onClick={() => { setImportSource("GITHUB"); setError(null); }} role="tab" type="button">GITHUB</button>
              </div>
              {importSource === "LOCAL" ? (
                <div id="local-project-import" role="tabpanel">
                  <p>{text("选择本地 Godot 项目目录后，DeviLudo 只记录目录关联，不上传、不复制项目。Agent 始终读取原目录的最新源码，并把成功修改直接写回原目录。", "Choose a local Godot project directory and DeviLudo only records the directory link—it does not upload or copy the project. The Agent always reads and writes the original directory.")}</p>
                  <small>{text("如果目录是 Git 仓库，关联后可在项目页新建并切换分支。", "If the directory is a Git repository, you can create and switch branches from the project page after linking it.")}</small>
                  <div className="idea-submit-row"><button className="button button-acid" disabled={creating} onClick={() => void bindLocalProject()} type="button"><FileIcon />{creating ? text("正在选择并关联目录…", "SELECTING & LINKING…") : text("选择项目文件夹并关联", "CHOOSE FOLDER & LINK")}</button></div>
                </div>
              ) : (
                <div className="local-github-import" id="github-project-import" role="tabpanel">
                  <p>{text("输入 GitHub 仓库地址并选择本地保存位置。DeviLudo 使用本机 Git 凭证直接克隆到该位置，随后只关联这个工作目录；项目内容和凭证都不会经浏览器上传。", "Enter a GitHub repository URL and choose a local destination. DeviLudo clones there with the host's Git credentials, then only links that working directory; neither project contents nor credentials are uploaded through the browser.")}</p>
                  <label>{text("GitHub 仓库地址", "GitHub repository URL")}<input aria-label={text("GitHub 仓库地址", "GitHub repository URL")} autoCapitalize="none" autoComplete="off" onChange={event => setGitHubRepositoryUrl(event.target.value)} placeholder="https://github.com/owner/repository.git" spellCheck={false} value={githubRepositoryUrl} /></label>
                  <small>{text("支持 HTTPS 和 git@github.com SSH 地址，包括本地凭证可访问的私有仓库；关联后可在项目页新建分支。", "Supports HTTPS and git@github.com SSH URLs, including private repositories available to your local credentials; create branches from the project page after linking it.")}</small>
                  <div className="idea-submit-row"><button className="button button-acid" disabled={creating || !githubRepositoryUrl.trim()} onClick={() => void cloneAndBindGitHubProject()} type="button">{creating ? text("正在选择位置并克隆…", "SELECTING & CLONING…") : text("选择保存位置、克隆并关联", "CHOOSE, CLONE & LINK")}</button></div>
                </div>
              )}
            </div>
          )}
          {error ? <p className="repository-onboarding-error" role="alert">{error}</p> : null}
        </section>
      </>
    );
  }

  return (
    <>
      <section className="page-heading project-catalog-heading">
        <div><span className="eyebrow">PROJECTS</span><h1>{text("游戏项目", "GAME PROJECTS")}</h1></div>
        <div className="project-catalog-actions"><Link className="button button-secondary" href="/projects/import"><FileIcon /> {text("关联项目", "LINK PROJECT")}</Link><Link className="button button-primary" href="/projects/new"><PlusIcon /> {text("开始新构想", "NEW CONCEPT")}</Link></div>
      </section>
      {error ? <div className="inline-notice danger" role="alert">{error}</div> : null}
      {loading ? <section className="project-catalog-empty">{text("正在加载项目…", "LOADING PROJECTS…")}</section> : null}
      {!loading && !error && projects.length === 0 ? (
        <section className="project-catalog-empty"><span><SparkIcon /></span><h2>{text("还没有游戏项目", "NO GAME PROJECTS YET")}</h2><div className="project-catalog-actions"><Link className="button button-secondary" href="/projects/import">{text("关联已有项目", "LINK PROJECT")}</Link><Link className="button button-acid" href="/projects/new">{text("创建第一个项目", "CREATE FIRST PROJECT")}</Link></div></section>
      ) : null}
      {projects.length > 0 ? (
        <section className="project-catalog-grid" aria-label={text("可访问项目", "Accessible projects")}>
          {projects.map(project => {
            const analyzing = project.analysisStatus === "PENDING" || project.analysisStatus === "ANALYZING";
            const needsInput = project.analysisStatus === "NEEDS_INPUT";
            const analysisFailed = project.analysisStatus === "FAILED";
            const contents = <>
              <div className="project-catalog-card-top"><span className="project-catalog-glyph">{project.name.slice(0, 1)}</span></div>
              <h2>{project.name}</h2>
              <dl>
                <div><dt>{text("当前阶段", "Stage")}</dt><dd>{text(`第 ${project.iterationNumber} 轮`, `Iteration ${project.iterationNumber}`)} · {analyzing ? text("正在分析项目", "ANALYZING PROJECT") : needsInput ? text("等待确认分析问题", "AWAITING CLARIFICATION") : analysisFailed ? text("分析失败", "ANALYSIS FAILED") : workflowLabel(project.workflowState, text)}</dd></div>
                <div><dt>{text("创建时间", "Created")}</dt><dd>{formatDate(project.createdAt, localeTag(locale))}</dd></div>
                <div><dt>{text("源码修订", "Source revision")}</dt><dd>{project.source ? `r${project.source.revision}` : "—"}</dd></div>
                <div><dt>{text("源码大小", "Source size")}</dt><dd>{project.source ? `${project.source.fileCount} files` : "—"}</dd></div>
              </dl>
              <div className="project-catalog-card-footer">
                <span>{analyzing ? <><i aria-hidden="true" className="project-analysis-spinner" /> {text("后台分析中", "ANALYZING")}</> : analysisFailed ? text("分析未完成", "ANALYSIS INCOMPLETE") : needsInput ? <>{text("回答分析问题", "ANSWER QUESTIONS")} <ArrowIcon /></> : <>{text("进入项目", "OPEN PROJECT")} <ArrowIcon /></>}</span>
                {analysisFailed ? <button className="button button-secondary project-analysis-retry" disabled={retryingProjectId !== null} onClick={() => void retryProjectAnalysis(project.id)} type="button">{retryingProjectId === project.id ? text("正在重试…", "RETRYING…") : text("重试分析", "RETRY ANALYSIS")}</button> : null}
              </div>
              {analysisFailed && project.analysisError ? <small className="project-analysis-error">{project.analysisError}</small> : null}
            </>;
            return analyzing || analysisFailed ? (
              <article
                aria-label={analyzing ? text(`${project.name}正在分析`, `${project.name} is being analyzed`) : text(`${project.name}分析失败`, `${project.name} analysis failed`)}
                aria-live="polite"
                className={`project-catalog-card is-disabled ${analyzing ? "is-analyzing" : "is-analysis-failed"}`}
                key={project.id}
              >{contents}</article>
            ) : (
              <Link
                aria-label={text(`打开${project.name}项目`, `Open ${project.name} project`)}
                className="project-catalog-card"
                href={`/projects/${project.id}`}
                key={project.id}
              >{contents}</Link>
            );
          })}
        </section>
      ) : null}
    </>
  );
}

function cacheProjectSummary(project: ProductProjectSummary): void {
  const current = cachedValue<readonly ProductProjectSummary[]>(clientCacheKeys.projects) ?? [];
  storeCached(clientCacheKeys.projects, Object.freeze([project, ...current.filter(item => item.id !== project.id)]), 10_000);
}

async function localProjectBridgeUrl(
  text: (chinese: string, english: string) => string,
): Promise<string> {
  const url = await preloadLocalProjectBridgeUrl();
  if (!url) {
    throw new ApiError("LOCAL_PROJECT_BRIDGE_UNAVAILABLE", text(
      "本地项目服务未启动，请运行 npm run local:up",
      "The local project service is not running. Run npm run local:up.",
    ));
  }
  return url;
}

let cachedLocalProjectBridgeUrl: string | null = null;
let localProjectBridgeRequest: Promise<string | null> | null = null;

function preloadLocalProjectBridgeUrl(): Promise<string | null> {
  if (cachedLocalProjectBridgeUrl) return Promise.resolve(cachedLocalProjectBridgeUrl);
  localProjectBridgeRequest ??= fetch("/api/local-git-import/config", { cache: "no-store" })
    .then(async response => {
      const configuration = await response.json() as { available?: boolean; url?: string };
      if (!response.ok || !configuration.available || !configuration.url) return null;
      cachedLocalProjectBridgeUrl = configuration.url;
      return cachedLocalProjectBridgeUrl;
    })
    .catch(() => null)
    .then(url => {
      if (!url) localProjectBridgeRequest = null;
      return url;
    });
  return localProjectBridgeRequest;
}

async function bridgeProjectBinding(
  response: Response,
  text: (chinese: string, english: string) => string,
  errorText: (message: unknown, chineseFallback: string, englishFallback: string) => string,
): Promise<Readonly<{ name: string; bindingId: string; gitBranch: string | null }>> {
  if (!response.ok) {
    const failure = await response.json().catch(() => ({})) as { code?: string; message?: string };
    throw new ApiError(failure.code ?? "LOCAL_PROJECT_OPERATION_FAILED", localProjectOperationMessage(failure.code, failure.message, text, errorText));
  }
  const result = await response.json().catch(() => ({})) as { bindingId?: unknown; displayName?: unknown; gitBranch?: unknown };
  const bindingId = typeof result.bindingId === "string" ? result.bindingId : "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(bindingId)) {
    throw new ApiError("INVALID_DIRECTORY_BINDING", text("本地项目目录绑定无效", "The local project directory binding is invalid"));
  }
  const name = typeof result.displayName === "string" && result.displayName.trim()
    ? result.displayName.trim()
    : text("本地项目", "Local project");
  const branch = typeof result.gitBranch === "string" ? result.gitBranch.trim() : "";
  return Object.freeze({ name, bindingId, gitBranch: branch || null });
}

async function readJson(
  response: Response,
  errorText: (message: unknown, chineseFallback: string, englishFallback: string) => string,
): Promise<unknown> {
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw new ApiError(
    typeof payload.code === "string" ? payload.code : "REQUEST_FAILED",
    errorText(payload.message, `请求失败 (${response.status})`, `Request failed (${response.status})`),
  );
  return payload;
}

function localProjectOperationMessage(
  code: string | undefined,
  fallback: string | undefined,
  text: (chinese: string, english: string) => string,
  errorText: (message: unknown, chineseFallback: string, englishFallback: string) => string,
): string {
  if (code === "GIT_CREDENTIALS_REQUIRED") return text(
    "本地 Git 凭证无法访问该仓库，请先在终端确认 git clone 可用",
    "Local Git credentials cannot access this repository. Confirm that git clone works in a terminal.",
  );
  if (code === "GIT_IMPORT_BUSY") return text("已有 GitHub 项目正在克隆，请稍后重试", "Another GitHub project is being cloned. Try again shortly.");
  if (code === "INVALID_GITHUB_REPOSITORY") return text("请输入有效的 GitHub 仓库地址", "Enter a valid GitHub repository URL");
  if (code === "GITHUB_TARGET_EXISTS") return errorText(fallback, "目标目录已存在，请改从本地项目关联", "The destination already exists. Link it as a local project instead.");
  if (code === "NOT_A_GODOT_PROJECT") return text("请选择包含 project.godot 的项目根目录", "Choose the project root containing project.godot");
  if (code === "LOCAL_PROJECT_CHANGED") return text("本地项目在 Agent 运行期间已变化，为避免覆盖，本次写回已停止", "The local project changed while the Agent was running, so write-back was stopped to prevent overwriting it");
  if (code === "LOCAL_PROJECT_BUSY") return text("已有本地项目正在处理，请稍后重试", "Another local project is being processed. Try again shortly.");
  return errorText(fallback, "本地项目操作失败", "Local project operation failed");
}

class ApiError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

function messageFor(reason: unknown, text: (chinese: string, english: string) => string): string {
  return reason instanceof Error ? reason.message : text("DeviLudo 暂时无法完成请求", "DeviLudo could not complete the request");
}

function formatDate(value: string, locale: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleDateString(locale) : "—";
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
