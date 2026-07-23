"use client";

import Link from "next/link";
import { useState } from "react";
import type { LocalDeliverySnapshot, LocalDeliveryStage } from "@/lib/local-delivery/model";
import type { DeliverySnapshot, DeliveryState } from "@/lib/orchestration/game-delivery";
import { AppShell } from "./AppShell";
import { DeliveryRepairNotice } from "./DeliveryRepairNotice";
import { ArrowIcon, CheckIcon, ClockIcon, PlusIcon, ServerIcon, SparkIcon } from "./Icons";
import { ProjectScopeSelector } from "./ProjectScopeSelector";
import { useLocalPlatform } from "./useLocalPlatform";
import { useProjectSelection } from "./useProjectCatalog";
import { useRunnerFleet } from "./useRunnerFleet";

const stageNames: Record<LocalDeliveryStage, string> = {
  AWAITING_SPEC_APPROVAL: "等待规格批准", AGENT_QUEUED: "Agent 已入队", AGENT_RUNNING: "Agent 开发中",
  WAITING_PROVIDER: "等待 Provider", CANDIDATE_READY: "候选版本就绪", E2E_RUNNING: "目标矩阵 E2E",
  AWAITING_ACCEPTANCE: "等待用户验收", MERGING: "正在合并", MAIN_GATE_RUNNING: "main SHA 门禁",
  MFA_REQUIRED: "等待 MFA", STEAM_BETA_UPLOADING: "Steam 私有 Beta", STEAM_REINSTALL_E2E: "Steam 回装测试",
  EXTERNAL_APPROVAL_REQUIRED: "等待外部批准", CANCELLED: "已取消", RELEASED: "本地闭环完成",
};

const stageOrder: LocalDeliveryStage[] = [
  "AWAITING_SPEC_APPROVAL", "AGENT_QUEUED", "AGENT_RUNNING", "WAITING_PROVIDER", "CANDIDATE_READY",
  "E2E_RUNNING", "AWAITING_ACCEPTANCE", "MERGING", "MAIN_GATE_RUNNING", "MFA_REQUIRED",
  "STEAM_BETA_UPLOADING", "STEAM_REINSTALL_E2E", "EXTERNAL_APPROVAL_REQUIRED", "RELEASED", "CANCELLED",
];

const productionStageNames: Record<DeliveryState, string> = {
  IDEATION: "构想对话中", WAITING_SPEC_APPROVAL: "等待规格批准", RESOLVING_AGENT_CONFIGURATION: "解析 Agent 配置",
  DEVELOPMENT_QUEUED: "Agent 已入队", DEVELOPING: "Agent 开发中", WAITING_PROVIDER: "等待 Provider",
  CROSS_PLATFORM_E2E: "目标矩阵 E2E", WAITING_USER_ACCEPTANCE: "等待用户验收", MERGING: "正在合并",
  MAIN_SHA_E2E: "main SHA 门禁", WAITING_MFA: "等待 MFA", STEAM_PRIVATE_BETA: "Steam 私有 Beta",
  STEAM_INSTALL_E2E: "Steam 回装测试", EXTERNAL_APPROVAL_REQUIRED: "等待外部批准",
  READY_TO_PUBLISH: "等待公开发布", RELEASED: "已发布", CANCELLED: "已取消",
};

const productionOrder: DeliveryState[] = [
  "IDEATION", "WAITING_SPEC_APPROVAL", "RESOLVING_AGENT_CONFIGURATION", "DEVELOPMENT_QUEUED",
  "DEVELOPING", "WAITING_PROVIDER", "CROSS_PLATFORM_E2E", "WAITING_USER_ACCEPTANCE", "MERGING",
  "MAIN_SHA_E2E", "WAITING_MFA", "STEAM_PRIVATE_BETA", "STEAM_INSTALL_E2E",
  "EXTERNAL_APPROVAL_REQUIRED", "READY_TO_PUBLISH", "RELEASED", "CANCELLED",
];

const pipelineTemplate = [
  { label: "规格批准", state: "pending", meta: "等待" },
  { label: "Agent 开发", state: "pending", meta: "等待" },
  { label: "安全扫描", state: "pending", meta: "等待" },
  { label: "跨平台 E2E", state: "pending", meta: "等待" },
  { label: "用户验收", state: "pending", meta: "等待" },
  { label: "Steam Beta", state: "pending", meta: "门禁" },
] as const;

function pipelineFor(delivery: LocalDeliverySnapshot) {
  const rank = delivery.stage === "CANCELLED" ? -1 : stageOrder.indexOf(delivery.stage);
  const points = [1, 4, 4, 5, 6, 10];
  const meta = [delivery.specRevisionId, delivery.runId ?? "等待", delivery.localValidation ? "本机已验证" : "等待证据", `${Object.values(delivery.targetResults).filter((value) => value === "PASSED").length} / ${delivery.targetMatrix.length}`, delivery.stage === "AWAITING_ACCEPTANCE" ? "待确认" : rank > 6 ? "已确认" : "等待", delivery.stage === "RELEASED" ? "完成" : "门禁"];
  return pipelineTemplate.map((stage, index) => ({
    ...stage,
    state: rank > points[index] ? "complete" : rank === points[index] ? "active" : "pending",
    meta: meta[index],
  }));
}

function productionPipelineFor(delivery: DeliverySnapshot) {
  const rank = delivery.state === "CANCELLED" ? -1 : productionOrder.indexOf(delivery.state);
  const points = [1, 4, 6, 6, 7, 15];
  const meta = [
    delivery.specRevisionId ?? "草稿",
    delivery.runId ?? "等待",
    delivery.candidateCommitSha?.slice(0, 7) ?? "等待候选",
    `${delivery.candidateEvidenceBundleId ? delivery.targetMatrix.length : 0} / ${delivery.targetMatrix.length}`,
    delivery.state === "WAITING_USER_ACCEPTANCE" ? "待确认" : rank > 7 ? "已确认" : "等待",
    delivery.state === "RELEASED" ? "完成" : "门禁",
  ];
  return pipelineTemplate.map((stage, index) => ({
    ...stage,
    state: rank > points[index]! ? "complete" : rank === points[index] ? "active" : "pending",
    meta: meta[index],
  }));
}

export function Dashboard() {
  const [activityFilter, setActivityFilter] = useState<"全部" | "运行" | "测试">("全部");
  const { projects, project, selectedProjectId, selectProject, mode, loading: projectsLoading, error: projectError } = useProjectSelection();
  const { delivery, productionDelivery, projectionMeta, health, error: deliveryError } = useLocalPlatform(selectedProjectId);
  const { fleet, error: fleetError } = useRunnerFleet(selectedProjectId, mode === "PRODUCTION");
  const error = projectError || deliveryError;
  const localActivity = delivery?.events.map((event) => ({
    id: event.id,
    title: event.message,
    kind: event.type.includes("E2E") || event.type.includes("GODOT") ? "测试" : "运行",
    agent: event.type.includes("GODOT") ? "Godot TestKit" : delivery.lockedProfile.agent === "claude-code" ? "Claude Code" : "Codex CLI",
    status: event.type.includes("FAILED") ? "失败" : "已记录",
    tone: event.type.includes("FAILED") ? "danger" : event.type.includes("E2E") || event.type.includes("GODOT") ? "green" : "blue",
    time: new Date(event.at).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }),
  })) ?? productionDelivery?.history.slice().reverse().map((event) => ({
    id: event.signal.signalId,
    title: `${event.signal.type} → ${productionStageNames[event.resultingState]}`,
    kind: event.signal.type.includes("E2E") ? "测试" : "运行",
    agent: "Temporal",
    status: "已投影",
    tone: event.signal.type.includes("E2E") ? "green" : "blue",
    time: `#${event.sequence}`,
  })) ?? [];
  const visibleActivity = localActivity.filter((item) => {
    if (activityFilter === "运行") return item.kind === "运行";
    if (activityFilter === "测试") return item.kind === "测试";
    return true;
  });
  const pipelineStages = delivery ? pipelineFor(delivery)
    : productionDelivery ? productionPipelineFor(productionDelivery) : pipelineTemplate;
  const passedTargets = delivery
    ? Object.values(delivery.targetResults).filter((value) => value === "PASSED").length
    : productionDelivery?.candidateEvidenceBundleId ? productionDelivery.targetMatrix.length : 0;
  const targetCount = delivery ? delivery.targetMatrix.length : productionDelivery?.targetMatrix.length ?? 0;
  const stageName = delivery ? stageNames[delivery.stage]
    : productionDelivery ? productionStageNames[productionDelivery.state] : null;
  const platforms = delivery
    ? delivery.targetMatrix.map((id) => ({ id, label: id === "linux" ? "Linux" : id === "windows" ? "Windows" : "macOS", state: delivery.targetResults[id] ?? "INVALIDATED" }))
    : productionDelivery ? productionDelivery.targetMatrix.map((id) => ({
      id, label: id === "linux" ? "Linux" : id === "windows" ? "Windows" : "macOS",
      state: productionDelivery.candidateEvidenceBundleId ? "PASSED" : productionDelivery.state === "CROSS_PLATFORM_E2E" ? "RUNNING" : "QUEUED",
    })) : [];
  const fleetRows = mode === "PRODUCTION"
    ? (["macos", "windows", "linux"] as const).map((platform) => {
      const runner = fleet?.runners.find((candidate) => candidate.platform === platform);
      return {
        os: platform === "macos" ? "macOS" : platform === "windows" ? "Windows" : "Linux",
        online: runner?.connectivity === "READY",
        detail: runner ? `${runner.runnerId} · ${runner.architecture} · ${runner.connectivity}` : fleetError || "尚无项目 Runner 租约",
        load: runner?.leaseState === "RUNNING" ? 100 : runner ? 35 : 0,
      };
    })
    : [{ os: "macOS 本机", online: health?.dependencies?.fixtureExecutor === "READY", detail: health?.dependencies?.localGodot ?? "Godot 未连接", load: delivery?.localValidation ? 100 : 10 }, { os: "Windows", online: false, detail: "等待 mTLS Runner", load: 0 }, { os: "Linux", online: false, detail: "等待 mTLS Runner", load: 0 }];

  if (!project) {
    return (
      <AppShell>
        <section className="page-heading dashboard-heading">
          <div><span className="eyebrow">项目控制面</span><h1>游戏开发工作台</h1><p>{error || (projectsLoading ? "正在读取可访问项目…" : "创建或绑定一个 GitHub App 项目后开始构想。")}</p></div>
          <Link className="button button-primary" href="/projects/new"><PlusIcon /> 开始新构想</Link>
        </section>
        <section className="dashboard-empty-project">
          <SparkIcon /><h2>{projectsLoading ? "正在同步项目目录" : "还没有可访问的项目"}</h2>
          <p>平台不会用演示项目替代真实租户数据。</p>
          {!projectsLoading ? <Link className="button button-acid" href="/projects/new">创建第一个项目</Link> : null}
        </section>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <section className="page-heading dashboard-heading">
        <div>
          <span className="eyebrow">{mode === "LOCAL_FIXTURE" ? "本地控制面 · 持久状态" : "生产控制面 · Temporal 投影"}</span>
          <h1>游戏开发工作台</h1>
          <p>{error ? `交付状态暂不可用：${error}` : stageName ? `${project.name}：${stageName}，${passedTargets} / ${targetCount} 个目标已通过。` : `正在读取 ${project.name} 的交付状态…`}</p>
        </div>
        <div className="dashboard-heading-actions">
          <ProjectScopeSelector projects={projects} selectedProjectId={selectedProjectId} onChange={selectProject} />
          <Link className="button button-primary" href="/projects/new"><PlusIcon /> 开始新构想</Link>
        </div>
      </section>

      <section className="dashboard-grid">
        <article className="focus-project">
          <div className="focus-project-topline">
            <span className="live-label"><i /> {stageName ?? "读取状态"}</span>
            <span>{delivery ? new Date(delivery.updatedAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }) : projectionMeta ? new Date(projectionMeta.projectedAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }) : "等待投影"} 更新</span>
          </div>
          <div className="focus-project-title">
            <div className="project-glyph" aria-hidden="true"><span>{project.name.slice(0, 1)}</span></div>
            <div>
              <p>{delivery?.specRevisionId ?? productionDelivery?.specRevisionId ?? "规格尚未冻结"} · {project.owner}/{project.repositoryName}</p>
              <h2>{project.name}</h2>
            </div>
            <Link aria-label={`打开${project.name}项目`} className="round-arrow" href={`/projects/${encodeURIComponent(project.projectId)}`}><ArrowIcon /></Link>
          </div>

          <div className="build-summary">
            <div>
              <span>当前阶段</span>
              <strong>{stageName ?? "等待交付投影"}</strong>
            </div>
            <div>
              <span>锁定 Agent</span>
              <strong>{productionDelivery ? productionDelivery.lockedRunConfigurationId ?? "等待锁定" : delivery ? <>{delivery.lockedProfile.agent === "claude-code" ? "Claude Code" : delivery.lockedProfile.agent} <small>v{delivery.lockedProfile.exactAgentVersion}</small></> : "等待锁定"}</strong>
            </div>
            <div>
              <span>候选提交</span>
              <strong className="mono">{delivery?.mainSha ?? delivery?.candidateSha ?? productionDelivery?.mainCommitSha ?? productionDelivery?.candidateCommitSha ?? "等待产出"}</strong>
            </div>
          </div>

          {productionDelivery ? <DeliveryRepairNotice compact snapshot={productionDelivery} /> : null}

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
            {platforms.map((platform) => (
              <div className={`platform-status ${platform.state === "PASSED" ? "passed" : platform.state === "RUNNING" ? "running" : "queued"}`} key={platform.id}>
                <span className="os-mark">{platform.label.slice(0, 1)}</span>
                <span><b>{platform.label}</b><small>{platform.label === "macOS" && delivery?.localValidation?.valid ? `本机 ${delivery.localValidation.godotVersion}` : "锁定目标"}</small></span>
                <i>{platform.state === "PASSED" ? "通过" : platform.state === "RUNNING" ? "测试中" : platform.state === "INVALIDATED" ? "已失效" : "排队"}</i>
              </div>
            ))}
            {platforms.length === 0 ? <div className="dashboard-data-loading">等待权威目标矩阵投影</div> : null}
          </div>
        </article>

        <aside className="attention-panel">
          <div className="section-title-row">
            <div><span className="eyebrow">需要关注</span><h2>今日门禁</h2></div>
            <span className="counter">2</span>
          </div>
          <div className="attention-item">
            <span className="attention-icon amber"><ClockIcon /></span>
            <div><b>{productionDelivery ? productionStageNames[productionDelivery.state] : delivery?.localValidation?.status === "FAILED" ? "本机 Godot 验证失败" : delivery?.localValidation?.releaseGate === "WAITING_EXPORT_TEMPLATES" ? "等待 Godot macOS 导出模板" : "目标 Runner 门禁"}</b><p>{productionDelivery ? `权威投影序号 ${productionDelivery.history.length}；所有推进必须来自对应业务服务。` : delivery?.localValidation?.status === "FAILED" ? "失败证据已保留，修复后需创建新的锁定运行。" : delivery?.localValidation ? "真实 headless 测试已有证据，生产导出仍保持阻塞。" : "运行本机 Git + Godot 验证以生成首份真实证据。"}</p></div>
          </div>
          <div className="attention-item">
            <span className="attention-icon violet"><SparkIcon /></span>
            <div><b>{health?.dependencies?.steam === "GUARD_REQUIRED" ? "Steam Guard 尚未连接" : "Steam 发布门禁"}</b><p>本地流程不会保存主密码，也不会伪造真实上传。</p></div>
          </div>
          <Link className="text-link" href={`/evidence?project=${encodeURIComponent(project.projectId)}`}>查看所有门禁 <ArrowIcon /></Link>
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
            {visibleActivity.length === 0 ? <div className="activity-empty">等待该项目的首个权威事件。</div> : null}
          </div>
        </article>

        <aside className="fleet-panel">
          <div className="section-title-row">
            <div><span className="eyebrow">mTLS 节点</span><h2>Runner 集群</h2></div>
            <ServerIcon />
          </div>
          {fleetRows.map((runner) => (
            <div className="fleet-row" key={runner.os}>
              <div className="fleet-row-head"><span><i className={runner.online ? "" : "offline"} /> <b>{runner.os}</b></span><small>{runner.online ? "1/1 在线" : "未连接"}</small></div>
              <p>{runner.detail}</p>
              <div className="load-track"><span style={{ width: `${runner.load}%` }} /></div>
            </div>
          ))}
          <Link className="text-link" href={`/runners?project=${encodeURIComponent(project.projectId)}`}>管理运行节点 <ArrowIcon /></Link>
        </aside>
      </section>
    </AppShell>
  );
}
