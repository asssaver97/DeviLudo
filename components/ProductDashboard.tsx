"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type InputHTMLAttributes } from "react";
import type { ProductProjectSummary, WorkspaceSummary } from "@/lib/product/contracts";
import { createStoredZip, shouldIncludeProjectPath } from "@/lib/product/source-archive";
import { ProductShell } from "./ProductShell";
import { ArrowIcon, FileIcon, GithubIcon, PlusIcon, SparkIcon } from "./console/Icons";
import { localeTag, useLanguage } from "./i18n/LanguageProvider";

export function ProductDashboard({
  creationOnly = false,
  initialMode = "IDEA",
}: {
  creationOnly?: boolean;
  initialMode?: "IDEA" | "IMPORT";
}) {
  const { locale, text } = useLanguage();
  const router = useRouter();
  const conceptRef = useRef<HTMLTextAreaElement>(null);
  const operationKey = useRef<string | null>(null);
  const [projects, setProjects] = useState<readonly ProductProjectSummary[]>([]);
  const [name, setName] = useState("");
  const [concept, setConcept] = useState("");
  const [creationMode, setCreationMode] = useState(initialMode);
  const [importKind, setImportKind] = useState<"GIT" | "LOCAL">("GIT");
  const [repositoryUrl, setRepositoryUrl] = useState("");
  const [folderFiles, setFolderFiles] = useState<readonly File[]>([]);
  const [archiveFile, setArchiveFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/projects", { signal: controller.signal }).then(response => response.status === 409 ? { projects: [] } : readJson(response)).then(projectsPayload => {
      setProjects((projectsPayload as { projects: ProductProjectSummary[] }).projects);
    }).catch(reason => {
      if (!controller.signal.aborted) setError(messageFor(reason, text));
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    if (creationOnly && initialMode === "IDEA") setTimeout(() => conceptRef.current?.focus(), 0);
    return () => controller.abort();
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
      window.dispatchEvent(new CustomEvent("deviludo:workspace-changed", { detail: payload.workspace }));
      router.push(`/projects/${payload.project.id}`);
    } catch (reason) {
      if (reason instanceof ApiError && (reason.code === "AGENT_CONFIG_REQUIRED" || reason.code === "AGENT_NAMING_FAILED")) {
        window.location.assign("/settings?required=project-name");
        return;
      }
      setError(messageFor(reason, text));
      setCreating(false);
    }
  }

  async function importProject() {
    if (creating || (importKind === "GIT" ? repositoryUrl.trim().length < 10 : (!archiveFile && folderFiles.length === 0))) return;
    setCreating(true);
    setError(null);
    operationKey.current ??= `project-import:${crypto.randomUUID()}`;
    try {
      let response: Response;
      if (importKind === "GIT") {
        response = await fetch("/api/projects/import/git", {
          method: "POST",
          headers: { "content-type": "application/json", "idempotency-key": operationKey.current },
          body: JSON.stringify({ repositoryUrl: repositoryUrl.trim() }),
        });
      } else {
        const local = await localProjectArchive(archiveFile, folderFiles, text);
        response = await fetch(`/api/projects/import/archive?name=${encodeURIComponent(local.name)}`, {
          method: "POST",
          headers: { "content-type": "application/zip", "idempotency-key": operationKey.current },
          body: local.bytes,
        });
      }
      const payload = await readJson(response) as { workspace: WorkspaceSummary; project: ProductProjectSummary };
      operationKey.current = null;
      window.dispatchEvent(new CustomEvent("deviludo:workspace-changed", { detail: payload.workspace }));
      router.push(`/projects/${payload.project.id}`);
    } catch (reason) {
      if (reason instanceof ApiError && reason.code === "AGENT_CONFIG_REQUIRED") {
        window.location.assign("/settings?required=project-import");
        return;
      }
      setError(messageFor(reason, text));
      setCreating(false);
    }
  }

  if (creationOnly) {
    return (
      <ProductShell>
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
              <div className="import-source-switch" role="tablist">
                <button aria-selected={importKind === "GIT"} className={importKind === "GIT" ? "is-active" : ""} onClick={() => { setImportKind("GIT"); setError(null); }} role="tab" type="button"><GithubIcon /> {text("Git 仓库", "GIT REPOSITORY")}</button>
                <button aria-selected={importKind === "LOCAL"} className={importKind === "LOCAL" ? "is-active" : ""} onClick={() => { setImportKind("LOCAL"); setError(null); }} role="tab" type="button"><FileIcon /> {text("本地项目", "LOCAL PROJECT")}</button>
              </div>
              {importKind === "GIT" ? (
                <label>{text("Git 仓库地址", "Git repository URL")}<input aria-label={text("Git 仓库地址", "Git repository URL")} autoCapitalize="none" autoCorrect="off" onChange={event => setRepositoryUrl(event.target.value)} placeholder="https://github.com/owner/game.git" spellCheck={false} value={repositoryUrl} /></label>
              ) : (
                <div className="local-project-inputs">
                  <label className="project-file-picker">{text("选择项目文件夹", "Choose project folder")}<input aria-label={text("本地项目文件夹", "Local project folder")} multiple onChange={event => { setArchiveFile(null); setFolderFiles(Array.from(event.target.files ?? [])); }} type="file" {...({ webkitdirectory: "" } as InputHTMLAttributes<HTMLInputElement>)} /></label>
                  <span>{text("或", "OR")}</span>
                  <label className="project-file-picker">{text("选择 ZIP", "Choose ZIP")}<input accept=".zip,application/zip" aria-label={text("项目 ZIP", "Project ZIP")} onChange={event => { setFolderFiles([]); setArchiveFile(event.target.files?.[0] ?? null); }} type="file" /></label>
                  {archiveFile ? <b>{archiveFile.name}</b> : folderFiles.length ? <b>{text(`已选择 ${folderFiles.length} 个文件`, `${folderFiles.length} files selected`)}</b> : null}
                </div>
              )}
              <div className="idea-submit-row"><button className="button button-acid" disabled={creating || (importKind === "GIT" ? repositoryUrl.trim().length < 10 : (!archiveFile && folderFiles.length === 0))} onClick={() => void importProject()} type="button"><FileIcon />{creating ? text("Agent 正在解析项目…", "AGENT IS ANALYZING…") : text("导入并解析", "IMPORT & ANALYZE")}</button></div>
            </div>
          )}
          {error ? <p className="repository-onboarding-error" role="alert">{error}</p> : null}
        </section>
      </ProductShell>
    );
  }

  return (
    <ProductShell>
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
            <article className="project-catalog-card" key={project.id}>
              <div className="project-catalog-card-top"><span className="project-catalog-glyph">{project.name.slice(0, 1)}</span></div>
              <h2>{project.name}</h2>
              <dl>
                <div><dt>{text("当前阶段", "Stage")}</dt><dd>{workflowLabel(project.workflowState, text)}</dd></div>
                <div><dt>{text("创建时间", "Created")}</dt><dd>{formatDate(project.createdAt, localeTag(locale))}</dd></div>
              </dl>
              <div className="project-catalog-card-footer"><Link aria-label={text(`打开${project.name}项目`, `Open ${project.name} project`)} href={`/projects/${project.id}`}>{text("进入项目", "OPEN PROJECT")} <ArrowIcon /></Link></div>
            </article>
          ))}
        </section>
      ) : null}
    </ProductShell>
  );
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
