"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { ProductProjectSummary, ProductSession } from "@/lib/product/contracts";
import { WORKFLOW_LABELS } from "@/lib/product/contracts";
import { ProductShell } from "./ProductShell";
import { ArrowIcon, PlusIcon, ShieldIcon, SparkIcon } from "./console/Icons";

export function ProductDashboard({ creationOnly = false }: { creationOnly?: boolean }) {
  const router = useRouter();
  const conceptRef = useRef<HTMLTextAreaElement>(null);
  const [projects, setProjects] = useState<readonly ProductProjectSummary[]>([]);
  const [session, setSession] = useState<ProductSession | null>(null);
  const [name, setName] = useState("");
  const [concept, setConcept] = useState("");
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    Promise.all([
      fetch("/api/session", { signal: controller.signal }).then(readJson),
      fetch("/api/projects", { signal: controller.signal }).then(readJson),
    ]).then(([sessionPayload, projectsPayload]) => {
      setSession((sessionPayload as { session: ProductSession }).session);
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
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: name.trim(), concept: concept.trim() }),
      });
      const payload = await readJson(response) as { project: ProductProjectSummary };
      router.push(`/projects/${payload.project.id}`);
    } catch (reason) {
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
            <span className="eyebrow">IDEA TO PLAYABLE · 规格生成入口</span>
            <h1>描述你的新游戏</h1>
            <p>从一句构想开始，DeviLudo 会整理玩法规格，再由你批准是否启动 Agent。</p>
          </div>
        </section>
        <section className="repository-onboarding idea-onboarding">
          <div className="repository-onboarding-title"><span><SparkIcon /></span><div><b>本地隔离项目</b><p>项目写入当前租户的 PostgreSQL 工作区，不使用演示数据替代。</p></div></div>
          <div className="repository-onboarding-form">
            <label>游戏名称<input aria-label="游戏名称" maxLength={200} onChange={event => setName(event.target.value)} placeholder="例如：余烬群岛" value={name} /></label>
            <label>游戏构想<textarea ref={conceptRef} aria-label="游戏构想" maxLength={4000} onChange={event => setConcept(event.target.value)} onKeyDown={event => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter") void createProject(); }} placeholder="描述玩法、画面或你想让玩家感受到的体验……" value={concept} /></label>
            <div className="idea-submit-row"><small>⌘ ↵ 提交 · 规格生成后由你批准</small><button className="button button-acid" disabled={concept.trim().length < 10 || creating} onClick={() => void createProject()} type="button"><PlusIcon />{creating ? "正在建立项目…" : "生成游戏规格"}</button></div>
          </div>
          {error ? <p className="repository-onboarding-error" role="alert">{error}</p> : null}
        </section>
      </ProductShell>
    );
  }

  return (
    <ProductShell>
      <section className="page-heading project-catalog-heading">
        <div><span className="eyebrow">LOCALHOST · 隔离项目目录</span><h1>游戏项目</h1><p>这里只展示当前账号经租户隔离后可访问的真实项目；工作流状态由 Core 实时提供。</p></div>
        <Link className="button button-primary" href="/projects/new"><PlusIcon /> 开始新构想</Link>
      </section>
      {error ? <div className="inline-notice danger" role="alert">{error}</div> : null}
      {loading ? <section className="project-catalog-empty">正在读取权威项目目录…</section> : null}
      {!loading && !error && projects.length === 0 ? (
        <section className="project-catalog-empty"><span><SparkIcon /></span><h2>还没有游戏项目</h2><p>先描述第一轮构想，再把自动整理的游戏规格交给 Agent。</p><Link className="button button-acid" href="/projects/new">创建第一个项目</Link></section>
      ) : null}
      {projects.length > 0 ? (
        <section className="project-catalog-grid" aria-label="可访问项目">
          {projects.map(project => (
            <article className="project-catalog-card" key={project.id}>
              <div className="project-catalog-card-top"><span className="project-catalog-glyph">{project.name.slice(0, 1)}</span><span className="project-catalog-binding"><i /> CORE 工作流已绑定</span></div>
              <small>project-{project.id.slice(0, 8)}</small>
              <h2>{project.name}</h2>
              <dl>
                <div><dt>隔离命名空间</dt><dd>tenant/{session?.tenantId.slice(0, 8) ?? "local"}</dd></div>
                <div><dt>当前阶段</dt><dd>{WORKFLOW_LABELS[project.workflowState] ?? project.workflowState}</dd></div>
                <div><dt>创建时间</dt><dd>{formatDate(project.createdAt)}</dd></div>
              </dl>
              <div className="project-catalog-card-footer"><span><ShieldIcon /> 租户隔离</span><Link aria-label={`打开${project.name}项目`} href={`/projects/${project.id}`}>进入工作区 <ArrowIcon /></Link></div>
            </article>
          ))}
        </section>
      ) : null}
    </ProductShell>
  );
}

async function readJson(response: Response): Promise<unknown> {
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw new Error(typeof payload.message === "string" ? payload.message : `请求失败 (${response.status})`);
  return payload;
}

function messageFor(reason: unknown): string {
  return reason instanceof Error ? reason.message : "DeviLudo 暂时无法完成请求";
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleDateString("zh-CN") : "—";
}
