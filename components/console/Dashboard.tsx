"use client";

import Link from "next/link";
import { useState } from "react";
import { activeProject, pipelineStages, recentActivity, runnerFleet } from "@/lib/demo/platform-data";
import { AppShell } from "./AppShell";
import { ArrowIcon, CheckIcon, ClockIcon, PlusIcon, ServerIcon, SparkIcon } from "./Icons";

export function Dashboard() {
  const [activityFilter, setActivityFilter] = useState<"全部" | "运行" | "测试">("全部");
  const visibleActivity = recentActivity.filter((item) => {
    if (activityFilter === "运行") return item.id.startsWith("RUN");
    if (activityFilter === "测试") return item.id.startsWith("E2E");
    return true;
  });

  return (
    <AppShell>
      <section className="page-heading dashboard-heading">
        <div>
          <span className="eyebrow">星期五 · 7 月 17 日</span>
          <h1>早上好，天扬。</h1>
          <p>一个候选版本正在跨平台验证，暂时没有需要你处理的阻塞项。</p>
        </div>
        <Link className="button button-primary" href="/projects/new"><PlusIcon /> 开始新构想</Link>
      </section>

      <section className="dashboard-grid">
        <article className="focus-project">
          <div className="focus-project-topline">
            <span className="live-label"><i /> 正在构建</span>
            <span>{activeProject.updatedAt}更新</span>
          </div>
          <div className="focus-project-title">
            <div className="project-glyph" aria-hidden="true"><span>岛</span></div>
            <div>
              <p>{activeProject.specRevision} · {activeProject.genre}</p>
              <h2>{activeProject.name}</h2>
            </div>
            <Link aria-label="打开余烬群岛项目" className="round-arrow" href={`/projects/${activeProject.id}`}><ArrowIcon /></Link>
          </div>

          <div className="build-summary">
            <div>
              <span>当前阶段</span>
              <strong>{activeProject.currentStage}</strong>
            </div>
            <div>
              <span>锁定 Agent</span>
              <strong>{activeProject.agent} <small>v{activeProject.agentVersion}</small></strong>
            </div>
            <div>
              <span>候选提交</span>
              <strong className="mono">{activeProject.commit}</strong>
            </div>
          </div>

          <div className="pipeline" aria-label="交付进度">
            {pipelineStages.map((stage, index) => (
              <div className={`pipeline-step ${stage.state}`} key={stage.label}>
                <div className="pipeline-node">
                  {stage.state === "complete" ? <CheckIcon /> : <span>{index + 1}</span>}
                </div>
                <b>{stage.label}</b>
                <small>{stage.meta}</small>
              </div>
            ))}
          </div>

          <div className="platform-row">
            {activeProject.platforms.map((platform) => (
              <div className={`platform-status ${platform.status}`} key={platform.id}>
                <span className="os-mark">{platform.label.slice(0, 1)}</span>
                <span><b>{platform.label}</b><small>{platform.detail}</small></span>
                <i>{platform.status === "passed" ? "通过" : platform.status === "running" ? "测试中" : "排队"}</i>
              </div>
            ))}
          </div>
        </article>

        <aside className="attention-panel">
          <div className="section-title-row">
            <div><span className="eyebrow">需要关注</span><h2>今日门禁</h2></div>
            <span className="counter">2</span>
          </div>
          <div className="attention-item">
            <span className="attention-icon amber"><ClockIcon /></span>
            <div><b>Windows 测试进行中</b><p>已完成 31 / 42 项，预计 9 分钟。</p></div>
          </div>
          <div className="attention-item">
            <span className="attention-icon violet"><SparkIcon /></span>
            <div><b>Steam 会话将在 12 天后过期</b><p>发布前需要重新完成一次 Guard 登录。</p></div>
          </div>
          <Link className="text-link" href="/evidence">查看所有门禁 <ArrowIcon /></Link>
        </aside>
      </section>

      <section className="dashboard-lower-grid">
        <article className="activity-panel">
          <div className="section-title-row">
            <div><span className="eyebrow">实时审计流</span><h2>最近活动</h2></div>
            <div className="segment-control" aria-label="筛选活动">
              {(["全部", "运行", "测试"] as const).map((filter) => (
                <button className={activityFilter === filter ? "active" : ""} key={filter} onClick={() => setActivityFilter(filter)} type="button">{filter}</button>
              ))}
            </div>
          </div>
          <div className="activity-table">
            <div className="activity-table-head"><span>任务</span><span>执行者</span><span>结果</span><span>时间</span></div>
            {visibleActivity.map((item) => (
              <div className="activity-table-row" key={item.id}>
                <span><i className={`activity-dot ${item.tone}`} /><span><b>{item.title}</b><small>{item.id} · {item.kind}</small></span></span>
                <span>{item.agent}</span>
                <span><em className={`status-text ${item.tone}`}>{item.status}</em></span>
                <span className="mono">{item.time}</span>
              </div>
            ))}
          </div>
        </article>

        <aside className="fleet-panel">
          <div className="section-title-row">
            <div><span className="eyebrow">mTLS 节点</span><h2>Runner 集群</h2></div>
            <ServerIcon />
          </div>
          {runnerFleet.map((runner) => (
            <div className="fleet-row" key={runner.os}>
              <div className="fleet-row-head"><span><i /> <b>{runner.os}</b></span><small>{runner.online}/{runner.count} 在线</small></div>
              <p>{runner.detail}</p>
              <div className="load-track"><span style={{ width: `${runner.load}%` }} /></div>
            </div>
          ))}
          <Link className="text-link" href="/runners">管理运行节点 <ArrowIcon /></Link>
        </aside>
      </section>
    </AppShell>
  );
}
