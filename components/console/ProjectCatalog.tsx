"use client";

import Link from "next/link";
import { AppShell } from "./AppShell";
import { ArrowIcon, GithubIcon, PlusIcon, ShieldIcon } from "./Icons";
import { useProjectCatalog } from "./useProjectCatalog";

export function ProjectCatalog() {
  const { projects, mode, loading, error } = useProjectCatalog();

  return (
    <AppShell>
      <section className="page-heading project-catalog-heading">
        <div>
          <span className="eyebrow">{mode === "LOCAL_FIXTURE" ? "Localhost · 隔离项目目录" : mode === "LOCAL_GITHUB" ? "Localhost · 真实 GitHub App" : "GitHub App · 租户项目目录"}</span>
          <h1>游戏项目</h1>
          <p>这里只展示当前账号经租户和 GitHub App 授权后仍可访问的项目；仓库归属由服务端实时绑定。</p>
        </div>
        <Link className="button button-primary" href="/projects/new"><PlusIcon /> 开始新构想</Link>
      </section>

      {error ? <div className="inline-notice danger" role="alert">{error}</div> : null}
      {loading ? <section className="project-catalog-empty">正在读取权威项目目录…</section> : null}
      {!loading && !error && projects.length === 0 ? (
        <section className="project-catalog-empty">
          <span><GithubIcon /></span>
          <h2>还没有可访问的游戏项目</h2>
          <p>先授权 GitHub App 仓库，再把第一轮构想整理为可批准规格。</p>
          <Link className="button button-acid" href="/projects/new">创建第一个项目</Link>
        </section>
      ) : null}

      {projects.length > 0 ? (
        <section className="project-catalog-grid" aria-label="可访问项目">
          {projects.map((project) => (
            <article className="project-catalog-card" key={project.projectId}>
              <div className="project-catalog-card-top">
                <span className="project-catalog-glyph">{project.name.slice(0, 1)}</span>
                <span className="project-catalog-binding"><i /> GitHub App 已绑定</span>
              </div>
              <small>{project.slug}</small>
              <h2>{project.name}</h2>
              <dl>
                <div><dt>代码仓库</dt><dd>{project.owner}/{project.repositoryName}</dd></div>
                <div><dt>默认分支</dt><dd>{project.defaultBranch}</dd></div>
                <div><dt>创建时间</dt><dd>{formatDate(project.createdAt)}</dd></div>
              </dl>
              <div className="project-catalog-card-footer">
                <span><ShieldIcon /> 租户隔离</span>
                <Link aria-label={`打开${project.name}项目`} href={`/projects/${encodeURIComponent(project.projectId)}`}>进入工作区 <ArrowIcon /></Link>
              </div>
            </article>
          ))}
        </section>
      ) : null}
    </AppShell>
  );
}

function formatDate(value: string): string {
  const time = new Date(value);
  return Number.isFinite(time.getTime()) ? time.toLocaleDateString("zh-CN") : "—";
}
