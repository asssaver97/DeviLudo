"use client";

import Link from "next/link";
import { useState } from "react";
import type { LocalDeliverySnapshot, LocalDeliveryStage } from "@/lib/local-delivery/model";
import { activeProject, pipelineStages as demoPipeline, recentActivity } from "@/lib/demo/platform-data";
import { AppShell } from "./AppShell";
import { ArrowIcon, CheckIcon, ClockIcon, PlusIcon, ServerIcon, SparkIcon } from "./Icons";
import { useLocalPlatform } from "./useLocalPlatform";

const stageNames: Record<LocalDeliveryStage, string> = {
  AWAITING_SPEC_APPROVAL: "等待规格批准", AGENT_QUEUED: "Agent 已入队", AGENT_RUNNING: "Agent 开发中",
  WAITING_PROVIDER: "等待 Provider", CANDIDATE_READY: "候选版本就绪", E2E_RUNNING: "目标矩阵 E2E",
  AWAITING_ACCEPTANCE: "等待用户验收", MERGING: "正在合并", MAIN_GATE_RUNNING: "main SHA 门禁",
  MFA_REQUIRED: "等待 MFA", STEAM_BETA_UPLOADING: "Steam 私有 Beta", STEAM_REINSTALL_E2E: "Steam 回装测试",
  EXTERNAL_APPROVAL_REQUIRED: "等待外部批准", RELEASED: "本地闭环完成",
};

const stageOrder: LocalDeliveryStage[] = [
  "AWAITING_SPEC_APPROVAL", "AGENT_QUEUED", "AGENT_RUNNING", "WAITING_PROVIDER", "CANDIDATE_READY",
  "E2E_RUNNING", "AWAITING_ACCEPTANCE", "MERGING", "MAIN_GATE_RUNNING", "MFA_REQUIRED",
  "STEAM_BETA_UPLOADING", "STEAM_REINSTALL_E2E", "EXTERNAL_APPROVAL_REQUIRED", "RELEASED",
];

function pipelineFor(delivery: LocalDeliverySnapshot | null) {
  if (!delivery) return demoPipeline;
  const rank = stageOrder.indexOf(delivery.stage);
  const points = [1, 4, 4, 5, 6, 10];
  const meta = [delivery.specRevisionId, delivery.runId ?? "等待", delivery.localValidation ? "本机已验证" : "等待证据", `${Object.values(delivery.targetResults).filter((value) => value === "PASSED").length} / 3`, delivery.stage === "AWAITING_ACCEPTANCE" ? "待确认" : rank > 6 ? "已确认" : "等待", delivery.stage === "RELEASED" ? "完成" : "门禁"];
  return demoPipeline.map((stage, index) => ({
    ...stage,
    state: rank > points[index] ? "complete" : rank === points[index] ? "active" : "pending",
    meta: meta[index],
  }));
}

export function Dashboard() {
  const [activityFilter, setActivityFilter] = useState<"全部" | "运行" | "测试">("全部");
  const { delivery, health, error } = useLocalPlatform();
  const localActivity = delivery?.events.map((event) => ({
    id: event.id,
    title: event.message,
    kind: event.type.includes("E2E") || event.type.includes("GODOT") ? "测试" : "运行",
    agent: event.type.includes("GODOT") ? "Godot TestKit" : delivery.lockedProfile.agent === "claude-code" ? "Claude Code" : "平台",
    status: event.type.includes("FAILED") ? "失败" : "已记录",
    tone: event.type.includes("FAILED") ? "danger" : event.type.includes("E2E") || event.type.includes("GODOT") ? "green" : "blue",
    time: new Date(event.at).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }),
  })) ?? recentActivity;
  const visibleActivity = localActivity.filter((item) => {
    if (activityFilter === "运行") return item.kind === "运行";
    if (activityFilter === "测试") return item.kind === "测试";
    return true;
  });
  const pipelineStages = pipelineFor(delivery);
  const passedTargets = delivery ? Object.values(delivery.targetResults).filter((value) => value === "PASSED").length : 0;

  return (
    <AppShell>
      <section className="page-heading dashboard-heading">
        <div>
          <span className="eyebrow">本地控制面 · 持久状态</span>
          <h1>早上好，天扬。</h1>
          <p>{error ? `本地状态暂不可用：${error}` : delivery ? `${stageNames[delivery.stage]}，${passedTargets} / 3 个目标已通过。` : "正在读取本地交付状态…"}</p>
        </div>
        <Link className="button button-primary" href="/projects/new"><PlusIcon /> 开始新构想</Link>
      </section>

      <section className="dashboard-grid">
        <article className="focus-project">
          <div className="focus-project-topline">
            <span className="live-label"><i /> {delivery ? stageNames[delivery.stage] : "读取状态"}</span>
            <span>{delivery ? new Date(delivery.updatedAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }) : activeProject.updatedAt} 更新</span>
          </div>
          <div className="focus-project-title">
            <div className="project-glyph" aria-hidden="true"><span>岛</span></div>
            <div>
              <p>{delivery?.specRevisionId ?? activeProject.specRevision} · {activeProject.genre}</p>
              <h2>{activeProject.name}</h2>
            </div>
            <Link aria-label="打开余烬群岛项目" className="round-arrow" href={`/projects/${activeProject.id}`}><ArrowIcon /></Link>
          </div>

          <div className="build-summary">
            <div>
              <span>当前阶段</span>
              <strong>{delivery ? stageNames[delivery.stage] : activeProject.currentStage}</strong>
            </div>
            <div>
              <span>锁定 Agent</span>
              <strong>{activeProject.agent} <small>v{activeProject.agentVersion}</small></strong>
            </div>
            <div>
              <span>候选提交</span>
              <strong className="mono">{delivery?.mainSha ?? delivery?.candidateSha ?? "等待产出"}</strong>
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
            {(delivery ? (["linux", "windows", "macos"] as const).map((id) => ({ id, label: id === "linux" ? "Linux" : id === "windows" ? "Windows" : "macOS", state: delivery.targetResults[id] })) : activeProject.platforms.map((item) => ({ id: item.id, label: item.label, state: item.status.toUpperCase() }))).map((platform) => (
              <div className={`platform-status ${platform.state === "PASSED" ? "passed" : platform.state === "RUNNING" ? "running" : "queued"}`} key={platform.id}>
                <span className="os-mark">{platform.label.slice(0, 1)}</span>
                <span><b>{platform.label}</b><small>{platform.label === "macOS" && delivery?.localValidation?.valid ? `本机 ${delivery.localValidation.godotVersion}` : "锁定目标"}</small></span>
                <i>{platform.state === "PASSED" ? "通过" : platform.state === "RUNNING" ? "测试中" : platform.state === "INVALIDATED" ? "已失效" : "排队"}</i>
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
            <div><b>{delivery?.localValidation?.status === "FAILED" ? "本机 Godot 验证失败" : delivery?.localValidation?.releaseGate === "WAITING_EXPORT_TEMPLATES" ? "等待 Godot macOS 导出模板" : "目标 Runner 门禁"}</b><p>{delivery?.localValidation?.status === "FAILED" ? "失败证据已保留，修复后需创建新的锁定运行。" : delivery?.localValidation ? "真实 headless 测试已有证据，生产导出仍保持阻塞。" : "运行本机 Git + Godot 验证以生成首份真实证据。"}</p></div>
          </div>
          <div className="attention-item">
            <span className="attention-icon violet"><SparkIcon /></span>
            <div><b>{health?.dependencies?.steam === "GUARD_REQUIRED" ? "Steam Guard 尚未连接" : "Steam 发布门禁"}</b><p>本地流程不会保存主密码，也不会伪造真实上传。</p></div>
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
          {[{ os: "macOS 本机", online: health?.dependencies?.fixtureExecutor === "READY", detail: health?.dependencies?.localGodot ?? "Godot 未连接", load: delivery?.localValidation ? 100 : 10 }, { os: "Windows", online: false, detail: "等待 mTLS Runner", load: 0 }, { os: "Linux", online: false, detail: "等待 mTLS Runner", load: 0 }].map((runner) => (
            <div className="fleet-row" key={runner.os}>
              <div className="fleet-row-head"><span><i className={runner.online ? "" : "offline"} /> <b>{runner.os}</b></span><small>{runner.online ? "1/1 在线" : "未连接"}</small></div>
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
