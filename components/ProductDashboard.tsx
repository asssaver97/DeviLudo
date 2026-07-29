"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { ProductProjectSummary, WorkspaceSummary } from "@/lib/product/contracts";
import { WORKFLOW_LABELS } from "@/lib/product/contracts";
import { ProductShell } from "./ProductShell";
import { ArrowIcon, PlusIcon, SparkIcon } from "./console/Icons";

export function ProductDashboard({ creationOnly = false }: { creationOnly?: boolean }) {
  const router = useRouter();
  const conceptRef = useRef<HTMLTextAreaElement>(null);
  const [projects, setProjects] = useState<readonly ProductProjectSummary[]>([]);
  const [name, setName] = useState("");
  const [concept, setConcept] = useState("");
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/projects", { signal: controller.signal }).then(response => response.status === 409 ? { projects: [] } : readJson(response)).then(projectsPayload => {
      setProjects((projectsPayload as { projects: ProductProjectSummary[] }).projects);
    }).catch(reason => {
      if (!controller.signal.aborted) setError(messageFor(reason));
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    if (creationOnly) setTimeout(() => conceptRef.current?.focus(), 0);
    return () => controller.abort();
  }, [creationOnly]);

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
      setError(messageFor(reason));
      setCreating(false);
    }
  }

  if (creationOnly) {
    return (
      <ProductShell>
        <section className="project-page-header">
          <div>
            <div className="breadcrumb"><Link href="/projects">游戏项目</Link><span>/</span><b>开始新构想</b></div>
            <span className="eyebrow">IDEA TO PLAYABLE</span>
            <h1>描述你的新游戏</h1>
          </div>
        </section>
        <section className="repository-onboarding idea-onboarding">
          <div className="repository-onboarding-form">
            <label>游戏名称<input aria-label="游戏名称" maxLength={200} onChange={event => setName(event.target.value)} placeholder="例如：余烬群岛" value={name} /></label>
            <label>游戏构想<textarea ref={conceptRef} aria-label="游戏构想" maxLength={4000} onChange={event => setConcept(event.target.value)} onKeyDown={event => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter") void createProject(); }} placeholder="描述玩法、画面或你想让玩家感受到的体验……" value={concept} /></label>
            <div className="idea-submit-row"><button className="button button-acid" disabled={concept.trim().length < 10 || creating} onClick={() => void createProject()} type="button"><PlusIcon />{creating ? "正在建立项目…" : "生成游戏规格"}</button></div>
          </div>
          {error ? <p className="repository-onboarding-error" role="alert">{error}</p> : null}
        </section>
      </ProductShell>
    );
  }

  return (
    <ProductShell>
      <section className="page-heading project-catalog-heading">
        <div><span className="eyebrow">PROJECTS</span><h1>游戏项目</h1></div>
        <Link className="button button-primary" href="/projects/new"><PlusIcon /> 开始新构想</Link>
      </section>
      {error ? <div className="inline-notice danger" role="alert">{error}</div> : null}
      {loading ? <section className="project-catalog-empty">正在加载项目…</section> : null}
      {!loading && !error && projects.length === 0 ? (
        <section className="project-catalog-empty"><span><SparkIcon /></span><h2>还没有游戏项目</h2><p>先描述第一轮构想，再把自动整理的游戏规格交给 Agent。</p><Link className="button button-acid" href="/projects/new">创建第一个项目</Link></section>
      ) : null}
      {projects.length > 0 ? (
        <section className="project-catalog-grid" aria-label="可访问项目">
          {projects.map(project => (
            <article className="project-catalog-card" key={project.id}>
              <div className="project-catalog-card-top"><span className="project-catalog-glyph">{project.name.slice(0, 1)}</span></div>
              <h2>{project.name}</h2>
              <dl>
                <div><dt>当前阶段</dt><dd>{WORKFLOW_LABELS[project.workflowState] ?? project.workflowState}</dd></div>
                <div><dt>创建时间</dt><dd>{formatDate(project.createdAt)}</dd></div>
              </dl>
              <div className="project-catalog-card-footer"><Link aria-label={`打开${project.name}项目`} href={`/projects/${project.id}`}>进入项目 <ArrowIcon /></Link></div>
            </article>
          ))}
        </section>
      ) : null}
    </ProductShell>
  );
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

function messageFor(reason: unknown): string {
  return reason instanceof Error ? reason.message : "DeviLudo 暂时无法完成请求";
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleDateString("zh-CN") : "—";
}
