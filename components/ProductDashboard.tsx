"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type InputHTMLAttributes } from "react";
import { cachedValue, clientCacheKeys, expireCached, loadCached, storeCached } from "@/lib/product/client-cache";
import type { ProductProjectSummary, WorkspaceSummary } from "@/lib/product/contracts";
import { createStoredZip, shouldIncludeProjectPath } from "@/lib/product/source-archive";
import { ArrowIcon, FileIcon, PlusIcon, SparkIcon } from "./console/Icons";
import { localeTag, useLanguage } from "./i18n/LanguageProvider";
import { useProductSession } from "./ProductShell";

export function ProductDashboard({
  creationOnly = false,
  initialMode = "IDEA",
}: {
  creationOnly?: boolean;
  initialMode?: "IDEA" | "IMPORT";
}) {
  const { locale, text } = useLanguage();
  const session = useProductSession();
  const router = useRouter();
  const conceptRef = useRef<HTMLTextAreaElement>(null);
  const operationKey = useRef<string | null>(null);
  const initialProjects = cachedValue<readonly ProductProjectSummary[]>(clientCacheKeys.projects);
  const initialRepositories = cachedValue<readonly { id: string; fullName: string; private: boolean }[]>(clientCacheKeys.githubRepositories);
  const [projects, setProjects] = useState<readonly ProductProjectSummary[]>(initialProjects ?? []);
  const [name, setName] = useState("");
  const [concept, setConcept] = useState("");
  const [creationMode, setCreationMode] = useState(initialMode);
  const [folderFiles, setFolderFiles] = useState<readonly File[]>([]);
  const [archiveFile, setArchiveFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(!initialProjects);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [githubRepositories, setGitHubRepositories] = useState<readonly { id: string; fullName: string; private: boolean }[]>(initialRepositories ?? []);
  const [selectedGitHubRepositoryId, setSelectedGitHubRepositoryId] = useState(initialRepositories?.[0]?.id ?? "");
  const platformManaged = session.authMode === "PLATFORM";

  useEffect(() => {
    let active = true;
    void loadCached(clientCacheKeys.projects, 10_000, async () => {
      const response = await fetch("/api/projects");
      const payload = response.status === 409 ? { projects: [] } : await readJson(response);
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
  }, [creationOnly, initialMode, text]);

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
      const payload = await readJson(response) as { workspace: WorkspaceSummary; project: ProductProjectSummary };
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

  async function importProject() {
    if (creating || (!archiveFile && folderFiles.length === 0)) return;
    setCreating(true);
    setError(null);
    operationKey.current ??= `project-import:${crypto.randomUUID()}`;
    try {
      const local = await localProjectArchive(archiveFile, folderFiles, text);
      const response = await fetch(`/api/projects/import/archive?name=${encodeURIComponent(local.name)}`, {
        method: "POST",
        headers: { "content-type": "application/zip", "idempotency-key": operationKey.current },
        body: local.bytes,
      });
      const payload = await readJson(response) as { workspace: WorkspaceSummary; project: ProductProjectSummary };
      operationKey.current = null;
      cacheProjectSummary(payload.project);
      router.push(`/projects/${payload.project.id}`);
    } catch (reason) {
      if (reason instanceof ApiError && reason.code === "AGENT_CONFIG_REQUIRED") {
        router.push("/settings?required=project-import");
        return;
      }
      setError(messageFor(reason, text));
      setCreating(false);
    }
  }

  async function loadGitHubRepositories() {
    if (creating) return;
    setCreating(true); setError(null);
    try {
      const repositories = await loadCached(clientCacheKeys.githubRepositories, 120_000, async () => {
        const response = await fetch("/api/github/repositories?perPage=100", { cache: "no-store" });
        const payload = await readPlatformJson(response) as { data: { id: string; fullName: string; private: boolean }[] };
        return payload.data;
      });
      setGitHubRepositories(repositories);
      setSelectedGitHubRepositoryId(repositories[0]?.id ?? "");
    } catch (reason) { setError(platformRepositoryMessage(reason, text)); }
    finally { setCreating(false); }
  }

  async function importGitHubProject() {
    if (creating || !selectedGitHubRepositoryId) return;
    setCreating(true); setError(null);
    try {
      const response = await fetch("/api/projects/import/github", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ repositoryId: selectedGitHubRepositoryId }),
      });
      const payload = await readPlatformJson(response) as { data?: { project?: { project?: { id?: string } } } };
      const projectId = payload.data?.project?.project?.id;
      if (!projectId) throw new Error(text("GitHub 导入响应无效", "GitHub import returned an invalid project"));
      expireCached(clientCacheKeys.projects);
      router.push(`/projects/${projectId}`);
    } catch (reason) { setError(platformRepositoryMessage(reason, text)); setCreating(false); }
  }

  if (creationOnly) {
    return (
      <>
        <section className="project-page-header">
          <div>
            <div className="breadcrumb"><Link href="/projects">{text("游戏项目", "GAME PROJECTS")}</Link><span>/</span><b>{creationMode === "IDEA" ? text("开始新构想", "NEW CONCEPT") : text("导入已有项目", "IMPORT PROJECT")}</b></div>
            <span className="eyebrow">{creationMode === "IDEA" ? "IDEA TO PLAYABLE" : "SOURCE TO PLAYABLE"}</span>
            <h1>{creationMode === "IDEA" ? text("描述你的新游戏", "DESCRIBE YOUR GAME") : text("导入已有项目", "IMPORT A PROJECT")}</h1>
          </div>
        </section>
        <section className="repository-onboarding idea-onboarding">
          <div className="creation-mode-switch" role="tablist">
            <button aria-selected={creationMode === "IDEA"} className={creationMode === "IDEA" ? "is-active" : ""} onClick={() => { setCreationMode("IDEA"); setError(null); }} role="tab" type="button"><SparkIcon /> {text("新构想", "NEW CONCEPT")}</button>
            <button aria-selected={creationMode === "IMPORT"} className={creationMode === "IMPORT" ? "is-active" : ""} onClick={() => { setCreationMode("IMPORT"); setError(null); }} role="tab" type="button"><FileIcon /> {text("导入项目", "IMPORT")}</button>
          </div>
          {creationMode === "IDEA" ? (
            <div className="repository-onboarding-form">
              <label>{text("游戏名称", "Game name")}<input aria-label={text("游戏名称", "Game name")} maxLength={200} onChange={event => setName(event.target.value)} placeholder={text("例如：余烬群岛", "e.g. Ember Archipelago")} value={name} /></label>
              <label>{text("游戏构想", "Game concept")}<textarea ref={conceptRef} aria-label={text("游戏构想", "Game concept")} maxLength={4000} onChange={event => setConcept(event.target.value)} onKeyDown={event => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter") void createProject(); }} placeholder={text("描述玩法、画面或你想让玩家感受到的体验……", "Describe the gameplay, visuals, or the experience you want players to have…")} value={concept} /></label>
              <div className="idea-submit-row"><button className="button button-acid" disabled={concept.trim().length < 10 || creating} onClick={() => void createProject()} type="button"><PlusIcon />{creating ? text("正在建立项目…", "CREATING PROJECT…") : text("创建项目", "CREATE PROJECT")}</button></div>
            </div>
          ) : (
            <div className="repository-onboarding-form project-import-form">
              <p>{text("Core 只从本地目录或 ZIP 导入源码；GitHub 导入由 DeviLudo Platform 完成。", "Core imports source only from a local folder or ZIP; GitHub imports are handled by DeviLudo Platform.")}</p>
              <div className="local-project-inputs">
                <label className="project-file-picker">{text("选择项目文件夹", "Choose project folder")}<input aria-label={text("本地项目文件夹", "Local project folder")} multiple onChange={event => { setArchiveFile(null); setFolderFiles(Array.from(event.target.files ?? [])); }} type="file" {...({ webkitdirectory: "" } as InputHTMLAttributes<HTMLInputElement>)} /></label>
                <span>{text("或", "OR")}</span>
                <label className="project-file-picker">{text("选择 ZIP", "Choose ZIP")}<input accept=".zip,application/zip" aria-label={text("项目 ZIP", "Project ZIP")} onChange={event => { setFolderFiles([]); setArchiveFile(event.target.files?.[0] ?? null); }} type="file" /></label>
                {archiveFile ? <b>{archiveFile.name}</b> : folderFiles.length ? <b>{text(`已选择 ${folderFiles.length} 个文件`, `${folderFiles.length} files selected`)}</b> : null}
              </div>
              <div className="idea-submit-row"><button className="button button-acid" disabled={creating || (!archiveFile && folderFiles.length === 0)} onClick={() => void importProject()} type="button"><FileIcon />{creating ? text("Agent 正在解析项目…", "AGENT IS ANALYZING…") : text("导入并解析", "IMPORT & ANALYZE")}</button></div>
              {platformManaged ? <div className="platform-github-import"><span className="eyebrow">GITHUB IMPORT</span><p>{text("只列出当前 GitHub 账号具有 push 权限的仓库。导入后会绑定来源仓库。", "Only repositories your GitHub account can push to are listed. The imported project is bound to its source repository.")}</p>{githubRepositories.length ? <div className="platform-repository-picker"><select aria-label={text("选择 GitHub 仓库", "Select GitHub repository")} value={selectedGitHubRepositoryId} onChange={event => setSelectedGitHubRepositoryId(event.target.value)}>{githubRepositories.map(repository => <option key={repository.id} value={repository.id}>{repository.fullName}{repository.private ? " · private" : ""}</option>)}</select><button className="button button-primary" disabled={creating || !selectedGitHubRepositoryId} onClick={() => void importGitHubProject()} type="button">{text("从 GitHub 导入", "IMPORT FROM GITHUB")}</button></div> : <div className="platform-repository-actions"><button className="button button-secondary" disabled={creating} onClick={() => void loadGitHubRepositories()} type="button">{text("选择 GitHub 仓库", "CHOOSE GITHUB REPOSITORY")}</button><Link className="button button-secondary" href="/account">{text("连接 GitHub", "CONNECT GITHUB")}</Link></div>}</div> : null}
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
        <div className="project-catalog-actions"><Link className="button button-secondary" href="/projects/import"><FileIcon /> {text("导入项目", "IMPORT")}</Link><Link className="button button-primary" href="/projects/new"><PlusIcon /> {text("开始新构想", "NEW CONCEPT")}</Link></div>
      </section>
      {error ? <div className="inline-notice danger" role="alert">{error}</div> : null}
      {loading ? <section className="project-catalog-empty">{text("正在加载项目…", "LOADING PROJECTS…")}</section> : null}
      {!loading && !error && projects.length === 0 ? (
        <section className="project-catalog-empty"><span><SparkIcon /></span><h2>{text("还没有游戏项目", "NO GAME PROJECTS YET")}</h2><div className="project-catalog-actions"><Link className="button button-secondary" href="/projects/import">{text("导入已有项目", "IMPORT PROJECT")}</Link><Link className="button button-acid" href="/projects/new">{text("创建第一个项目", "CREATE FIRST PROJECT")}</Link></div></section>
      ) : null}
      {projects.length > 0 ? (
        <section className="project-catalog-grid" aria-label={text("可访问项目", "Accessible projects")}>
          {projects.map(project => (
            <Link
              aria-label={text(`打开${project.name}项目`, `Open ${project.name} project`)}
              className="project-catalog-card"
              href={`/projects/${project.id}`}
              key={project.id}
            >
              <div className="project-catalog-card-top"><span className="project-catalog-glyph">{project.name.slice(0, 1)}</span></div>
              <h2>{project.name}</h2>
              <dl>
                <div><dt>{text("当前阶段", "Stage")}</dt><dd>{workflowLabel(project.workflowState, text)}</dd></div>
                <div><dt>{text("创建时间", "Created")}</dt><dd>{formatDate(project.createdAt, localeTag(locale))}</dd></div>
                <div><dt>{text("源码修订", "Source revision")}</dt><dd>{project.source ? `r${project.source.revision}` : "—"}</dd></div>
                <div><dt>{text("源码大小", "Source size")}</dt><dd>{project.source ? `${project.source.fileCount} files` : "—"}</dd></div>
              </dl>
              <div className="project-catalog-card-footer"><span>{text("进入项目", "OPEN PROJECT")} <ArrowIcon /></span></div>
            </Link>
          ))}
        </section>
      ) : null}
    </>
  );
}

function cacheProjectSummary(project: ProductProjectSummary): void {
  const current = cachedValue<readonly ProductProjectSummary[]>(clientCacheKeys.projects) ?? [];
  storeCached(clientCacheKeys.projects, Object.freeze([project, ...current.filter(item => item.id !== project.id)]), 10_000);
}

async function localProjectArchive(
  archiveFile: File | null,
  folderFiles: readonly File[],
  text: (chinese: string, english: string) => string,
): Promise<Readonly<{ name: string; bytes: ArrayBuffer }>> {
  if (archiveFile) {
    if (archiveFile.size > 64 * 1024 * 1024) throw new Error(text("ZIP 项目超过 64 MiB 导入上限", "ZIP project exceeds the 64 MiB import limit"));
    return Object.freeze({ name: archiveFile.name.replace(/\.zip$/i, "") || text("本地项目", "Local project"), bytes: await archiveFile.arrayBuffer() });
  }
  const entries = [];
  let projectName = text("本地项目", "Local project");
  for (const file of folderFiles) {
    const browserPath = file.webkitRelativePath || file.name;
    const segments = browserPath.replaceAll("\\", "/").split("/").filter(Boolean);
    if (segments.length > 1) projectName = segments[0];
    const path = segments.length > 1 ? segments.slice(1).join("/") : segments.join("/");
    if (!path || !shouldIncludeProjectPath(path)) continue;
    entries.push(Object.freeze({ path, bytes: new Uint8Array(await file.arrayBuffer()) }));
  }
  if (!entries.length) throw new Error(text("所选文件夹中没有可导入的项目文件", "The selected folder has no importable project files"));
  const bytes = createStoredZip(entries);
  if (bytes.length > 64 * 1024 * 1024) throw new Error(text("本地项目超过 64 MiB 导入上限", "Local project exceeds the 64 MiB import limit"));
  return Object.freeze({ name: projectName, bytes: Uint8Array.from(bytes).buffer });
}

async function readJson(response: Response): Promise<unknown> {
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw new ApiError(
    typeof payload.code === "string" ? payload.code : "REQUEST_FAILED",
    typeof payload.message === "string" ? payload.message : `请求失败 (${response.status})`,
  );
  return payload;
}

async function readPlatformJson(response: Response): Promise<unknown> {
  const payload = await response.json().catch(() => ({})) as { error?: { code?: string } };
  if (!response.ok) throw new ApiError(payload.error?.code ?? "REQUEST_FAILED", payload.error?.code ?? `请求失败 (${response.status})`);
  return payload;
}

function platformRepositoryMessage(reason: unknown, text: (chinese: string, english: string) => string): string {
  const code = reason instanceof ApiError ? reason.code : "";
  if (code === "GITHUB_REAUTHORIZE_REQUIRED") return text("请先在账号设置中连接或重新授权 GitHub", "Connect or reauthorize GitHub in Account settings first");
  if (code === "GITHUB_PERMISSION_OR_RATE_LIMIT") return text("GitHub 权限、组织 SSO 或限流阻止了本次操作", "GitHub permissions, organization SSO, or rate limits blocked this operation");
  return reason instanceof Error ? reason.message : text("GitHub 操作失败", "GitHub operation failed");
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
    ARTIFACT_BUILDING: ["制品构建中", "Building artifacts"], E2E_TESTING: ["跨平台测试中", "Cross-platform testing"],
    SIGNING: ["平台签名中", "Signing"], STEAM_PUBLISHING: ["Steam 发布中", "Publishing to Steam"],
    CLEAN_INSTALL_VERIFYING: ["干净回装验证中", "Clean-install verification"], SUCCEEDED: ["交付完成", "Delivered"],
    FAILED: ["流程失败", "Failed"], CANCELLED: ["已取消", "Cancelled"],
  };
  const label = labels[state];
  return label ? text(label[0], label[1]) : state;
}
