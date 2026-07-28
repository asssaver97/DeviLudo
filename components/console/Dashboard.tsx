"use client";

import Link from "next/link";
import { AppShell } from "./AppShell";
import { ArrowIcon, GithubIcon, PlusIcon, ShieldIcon, SparkIcon } from "./Icons";
import { useProjectCatalog } from "./useProjectCatalog";

export function Dashboard() {
  const { projects, mode, loading, error } = useProjectCatalog();
  const recentProjects = projects.slice(0, 6);

  return (
    <AppShell>
      <section className="simple-home-hero">
        <span className="assistant-mark"><SparkIcon /></span>
        <span className="eyebrow">IDEA TO PLAYABLE · 从构想到可玩版本</span>
        <h1>今天想做什么游戏？</h1>
        <p>从一句初步构想开始，DeviLudo 会通过对话补全规格，然后自动开发、测试并交付。</p>
        <Link className="simple-home-prompt" href="/projects/new">
          <span>描述玩法、画面或你想让玩家感受到的体验……</span>
          <i><PlusIcon /> 开始新构想</i>
        </Link>
      </section>

      <section className="simple-home-projects">
        <div className="section-title-row">
          <div><span className="eyebrow">RECENT PROJECTS · 最近项目</span><h2>继续开发</h2></div>
          <Link className="text-link" href="/projects">查看全部 <ArrowIcon /></Link>
        </div>

        {error ? <div className="inline-notice danger" role="alert">{error}</div> : null}
        {loading ? <div className="simple-home-empty">正在读取可访问项目…</div> : null}
        {!loading && !error && recentProjects.length === 0 ? (
          <div className="simple-home-empty">
            <GithubIcon />
            <div><b>还没有可访问的项目</b><p>平台不会用演示项目替代真实租户数据。创建新项目，或先在设置中授权 GitHub App。</p></div>
            <Link className="button button-secondary" href="/settings/connections">连接 GitHub</Link>
          </div>
        ) : null}

        {recentProjects.length > 0 ? (
          <div className="simple-home-project-grid">
            {recentProjects.map((project) => (
              <Link className="simple-home-project" href={`/projects/${encodeURIComponent(project.projectId)}`} key={project.projectId}>
                <span className="project-catalog-glyph">{project.name.slice(0, 1)}</span>
                <div><h3>{project.name}</h3><p>{project.owner}/{project.repositoryName}</p><small>{mode === "LOCAL_FIXTURE" ? "本地隔离项目" : "GitHub App 已绑定"}</small></div>
                <ShieldIcon />
              </Link>
            ))}
          </div>
        ) : null}
      </section>
    </AppShell>
  );
}
