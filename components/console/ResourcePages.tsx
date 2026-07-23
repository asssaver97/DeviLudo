"use client";

import Link from "next/link";
import { useState } from "react";
import { AppShell } from "./AppShell";
import { CheckIcon, FileIcon, ServerIcon, ShieldIcon } from "./Icons";
import { ProjectScopeSelector } from "./ProjectScopeSelector";
import { useEvidenceCatalog } from "./useEvidenceCatalog";
import { useLocalPlatform } from "./useLocalPlatform";
import { useProjectSelection } from "./useProjectCatalog";
import { useRunnerFleet } from "./useRunnerFleet";

type RunnerView = {
  os: "macOS" | "Windows" | "Linux";
  online: boolean;
  detail: string;
  targetState: string;
};

export function RunnersPage() {
  const [selected, setSelected] = useState<RunnerView["os"]>("macOS");
  const { projects, project, selectedProjectId, selectProject, mode, loading: projectsLoading, error: projectError } = useProjectSelection();
  const { delivery, productionDelivery, health, error: deliveryError } = useLocalPlatform(selectedProjectId);
  const { fleet, error: fleetError } = useRunnerFleet(selectedProjectId, mode === "PRODUCTION");
  const error = projectError || deliveryError || fleetError;
  const productionTargetState = (platform: "linux" | "windows" | "macos") => {
    if (!productionDelivery?.targetMatrix.includes(platform)) return "NOT_SELECTED";
    if (productionDelivery.candidateEvidenceBundleId) return "PASSED";
    return productionDelivery.state === "CROSS_PLATFORM_E2E" ? "RUNNING" : "QUEUED";
  };
  const runnerView = (os: RunnerView["os"], platform: "linux" | "macos" | "windows"): RunnerView => {
    const projected = fleet?.runners.find((runner) => runner.platform === platform);
    if (mode === "PRODUCTION") return {
      os,
      online: projected?.connectivity === "READY",
      detail: projected
        ? `${projected.runnerId} · ${projected.architecture} · ${projected.connectivity}`
        : "尚无该项目的 Runner 租约",
      targetState: productionTargetState(platform),
    };
    return {
      os,
      online: platform === "macos" && health?.dependencies?.fixtureExecutor === "READY",
      detail: platform === "macos" ? health?.dependencies?.localGodot ?? "本机 Godot 未连接" : "等待出站 mTLS Runner 注册",
      targetState: delivery?.targetResults[platform] ?? "NOT_SELECTED",
    };
  };
  const runners: RunnerView[] = [runnerView("macOS", "macos"), runnerView("Windows", "windows"), runnerView("Linux", "linux")];
  const selectedRunner = runners.find((runner) => runner.os === selected) ?? runners[0];
  const onlineCount = runners.filter((runner) => runner.online).length;
  return (
    <AppShell>
      <section className="page-heading resource-heading">
        <div><span className="eyebrow">跨平台执行面 · {mode === "LOCAL_FIXTURE" ? "本地实况" : "生产投影"}</span><h1>运行节点</h1><p>{error ? `状态读取失败：${error}` : project ? `${project.name} 的目标矩阵与已注册 Runner；开发 Agent 不会安装在这些节点。` : projectsLoading ? "正在读取可访问项目…" : "创建或绑定项目后查看目标矩阵。"}</p></div>
        <div className="resource-heading-actions"><ProjectScopeSelector projects={projects} selectedProjectId={selectedProjectId} onChange={selectProject} /><span className="resource-stat"><b>{project ? onlineCount : 0}</b><small>在线节点</small></span></div>
      </section>
      {!project ? <EmptyProjectResource loading={projectsLoading} noun="运行节点" /> : (
      <div className="resource-grid">
        <section className="resource-list">
          {runners.map((runner) => (
            <button className={selected === runner.os ? "selected" : ""} key={runner.os} onClick={() => setSelected(runner.os)} type="button">
              <span className="resource-os">{runner.os.slice(0, 1)}</span>
              <span><b>{runner.os}</b><small>{runner.detail}</small></span>
              <span><i className={runner.online ? "" : "offline"} /> {runner.online ? "1 / 1 在线" : "未连接"}</span>
            </button>
          ))}
        </section>
        <aside className="resource-detail">
          <span className="detail-icon"><ServerIcon /></span><span className="eyebrow">节点详情</span><h2>{selectedRunner.os} {selectedRunner.online ? "本机节点" : "目标集群"}</h2>
          <dl><div><dt>连接状态</dt><dd>{selectedRunner.online ? "READY" : "NOT_CONNECTED"}</dd></div><div><dt>运行时</dt><dd>{selectedRunner.detail}</dd></div><div><dt>目标门禁</dt><dd>{selectedRunner.targetState}</dd></div><div><dt>注册模式</dt><dd>{mode === "LOCAL_FIXTURE" && selectedRunner.os === "macOS" ? "loopback 侧车" : "出站 mTLS"}</dd></div></dl>
          <div className="fencing-note"><ShieldIcon /><span><b>防迟到结果</b><small>attempt_id、fencing_token 和 seq_no 不匹配的结果会被丢弃。</small></span></div>
        </aside>
      </div>
      )}
    </AppShell>
  );
}

export function EvidencePage() {
  const { projects, project, selectedProjectId, selectProject, mode, loading: projectsLoading, error: projectError } = useProjectSelection();
  const { delivery, productionDelivery, error: deliveryError } = useLocalPlatform(selectedProjectId);
  const { catalog, error: catalogError } = useEvidenceCatalog(selectedProjectId, mode === "PRODUCTION");
  const [verification, setVerification] = useState<{ projectId: string; evidenceId: string; message: string; ok: boolean } | null>(null);
  const error = projectError || deliveryError || catalogError;
  const evidence = delivery?.localValidation ?? null;
  const mainEvidence = delivery?.mainValidation ?? null;
  const steamEvidence = delivery?.steamReinstall ?? null;
  const approvalEvidence = delivery?.externalApprovalEvidence ?? [];
  const productionEntries = catalog?.entries ?? [];
  const currentEvidenceIds = new Set([
    productionDelivery?.evidenceBundleId,
    productionDelivery?.candidateEvidenceBundleId,
    productionDelivery?.mainEvidenceBundleId,
    productionDelivery?.steamInstallEvidenceBundleId,
  ].filter((value): value is string => Boolean(value)));
  const validProductionEvidence = productionEntries.filter((entry) => entry.invalidatedAt === null && entry.bundle.status === "PASSED").length;

  async function verifyEvidence() {
    if (!evidence || !selectedProjectId) return;
    try {
      const base = `/api/projects/${encodeURIComponent(selectedProjectId)}/local-validation/evidence`;
      const artifactUrl = evidence.buildArtifact
        ? `/api/projects/${encodeURIComponent(selectedProjectId)}/local-validation/artifact/${evidence.buildArtifact.fileName}`
        : null;
      const [manifestResponse, junitResponse, logResponse, buildResponse] = await Promise.all([
        fetch(`${base}/manifest.json`, { cache: "no-store" }),
        fetch(`${base}/junit.xml`, { cache: "no-store" }),
        fetch(`${base}/godot.log`, { cache: "no-store" }),
        artifactUrl ? fetch(artifactUrl, { cache: "no-store" }) : Promise.resolve(null),
      ]);
      if (!manifestResponse.ok || !junitResponse.ok || !logResponse.ok || (buildResponse && !buildResponse.ok)) throw new Error("无法读取完整证据包与构建物");
      const manifest = JSON.parse(await manifestResponse.text()) as Record<string, unknown> & {
        evidenceId?: string;
        candidateSha?: string;
        bundleDigest?: string;
        targetMatrix?: readonly string[];
        platform?: string;
        fixtureOnly?: boolean;
        sourceAuthority?: unknown;
        artifactDigests?: Record<string, string>;
        buildArtifact?: {
          fileName?: string;
          platform?: string;
          contentType?: string;
          sha256?: string;
          sizeBytes?: number;
        } | null;
      };
      const junit = await junitResponse.text();
      const log = await logResponse.text();
      const buildBytes = buildResponse ? await buildResponse.arrayBuffer() : null;
      const { evidenceId, bundleDigest, ...unsigned } = manifest;
      const ok = manifest.evidenceId === evidence.evidenceId
        && manifest.candidateSha === evidence.candidateSha
        && JSON.stringify(manifest.targetMatrix) === JSON.stringify(delivery?.targetMatrix)
        && JSON.stringify(evidence.targetMatrix) === JSON.stringify(delivery?.targetMatrix)
        && manifest.platform === "macos"
        && manifest.fixtureOnly === evidence.fixtureOnly
        && JSON.stringify(manifest.sourceAuthority) === JSON.stringify(evidence.sourceAuthority)
        && evidence.platform === "macos"
        && bundleDigest === evidence.bundleDigest
        && evidenceId === `EV-LOCAL-${String(bundleDigest).slice(0, 12).toUpperCase()}`
        && bundleDigest === await sha256(JSON.stringify(unsigned))
        && manifest.artifactDigests?.["junit.xml"] === await sha256(junit)
        && manifest.artifactDigests?.["godot.log"] === await sha256(log)
        && (evidence.buildArtifact
          ? !!buildResponse
            && !!buildBytes
            && JSON.stringify(manifest.buildArtifact) === JSON.stringify(evidence.buildArtifact)
            && buildResponse.headers.get("x-deviludo-artifact-sha256") === evidence.buildArtifact.sha256
            && buildBytes.byteLength === evidence.buildArtifact.sizeBytes
            && await sha256(buildBytes) === evidence.buildArtifact.sha256
          : manifest.buildArtifact === null);
      setVerification({ projectId: selectedProjectId, evidenceId: evidence.evidenceId, ok, message: ok ? "清单、Git 提交、bundle、JUnit、日志与游戏构建物摘要一致。" : "证据或构建物摘要不一致，已拒绝验证。" });
    } catch (reason) {
      setVerification({ projectId: selectedProjectId, evidenceId: evidence.evidenceId, ok: false, message: reason instanceof Error ? reason.message : "证据验证失败" });
    }
  }

  return (
    <AppShell>
      <section className="page-heading resource-heading">
        <div><span className="eyebrow">可追溯交付 · {mode === "LOCAL_FIXTURE" ? "本地实况" : "生产投影"}</span><h1>证据中心</h1><p>{error ? `状态读取失败：${error}` : project ? `${project.name} 的证据绑定冻结规格、锁定提交与目标矩阵；Web 进程不读取生产制品库。` : projectsLoading ? "正在读取可访问项目…" : "创建或绑定项目后查看交付证据。"}</p></div>
        <div className="resource-heading-actions"><ProjectScopeSelector projects={projects} selectedProjectId={selectedProjectId} onChange={selectProject} /><span className="resource-stat"><b>{project ? (evidence?.valid ? 1 : 0) + (mainEvidence?.valid ? 1 : 0) + (steamEvidence?.valid ? 1 : 0) + approvalEvidence.filter((item) => item.valid).length || validProductionEvidence : 0}</b><small>有效证据包</small></span></div>
      </section>
      {!project ? <EmptyProjectResource loading={projectsLoading} noun="交付证据" /> : <>
      {verification?.projectId === selectedProjectId ? <div className={`inline-notice ${verification.ok ? "" : "danger"}`}><CheckIcon /> {verification.evidenceId}：{verification.message}</div> : null}
      <section className="evidence-table-panel">
        <div className="evidence-head"><span>证据包</span><span>平台</span><span>提交</span><span>测试</span><span>签名</span><span>生成时间</span><span /></div>
        {evidence ? (<>
          <div className="evidence-row" key={evidence.evidenceId}>
            <span><FileIcon /><b>{evidence.evidenceId}</b></span><span>macOS 本机 Fixture</span><span className="mono" title={evidence.candidateSha}>{evidence.candidateSha.slice(0, 7)}</span><span>{evidence.checks.filter((check) => check.status === "PASSED").length} / {evidence.checks.length}</span><span className={evidence.valid ? "signed" : "invalid"}>{evidence.valid ? "有效" : "已失效"}</span><span>{new Date(evidence.createdAt).toLocaleString("zh-CN")}</span><button disabled={!evidence.valid} onClick={() => void verifyEvidence()} type="button">验证</button>
          </div>
          {mainEvidence ? <div className="evidence-row" key={mainEvidence.evidenceId}>
            <span><FileIcon /><b>{mainEvidence.evidenceId}</b></span><span>macOS main 复验</span><span className="mono" title={mainEvidence.mainSha}>{mainEvidence.mainSha.slice(0, 7)}</span><span>{mainEvidence.checks.filter((check) => check.status === "PASSED").length} / {mainEvidence.checks.length}</span><span className={mainEvidence.valid ? "signed" : "invalid"}>{mainEvidence.valid ? "有效" : "已失效"}</span><span>{new Date(mainEvidence.createdAt).toLocaleString("zh-CN")}</span><button disabled type="button">main 门禁</button>
          </div> : null}
          {steamEvidence ? <div className="evidence-row" key={steamEvidence.evidenceId}>
            <span><FileIcon /><b>{steamEvidence.evidenceId}</b></span><span>macOS 本地 Beta 回装</span><span className="mono" title={steamEvidence.mainSha}>{steamEvidence.mainSha.slice(0, 7)}</span><span>{steamEvidence.checks.filter((check) => check.status === "PASSED").length} / {steamEvidence.checks.length}</span><span className={steamEvidence.valid ? "signed" : "invalid"}>{steamEvidence.valid ? "有效" : "已失效"}</span><span>{new Date(steamEvidence.createdAt).toLocaleString("zh-CN")}</span><button disabled type="button">回装门禁</button>
          </div> : null}
          {approvalEvidence.map((approval) => <div className="evidence-row" key={approval.evidenceId}>
            <span><FileIcon /><b>{approval.evidenceId}</b></span><span>本地外部门禁 {approval.sequence}/3</span><span className="mono" title={approval.mainSha}>{approval.mainSha.slice(0, 7)}</span><span>1 / 1</span><span className={approval.valid ? "signed" : "invalid"}>{approval.valid ? "有效" : "已失效"}</span><span>{new Date(approval.createdAt).toLocaleString("zh-CN")}</span><a href={`/api/projects/${encodeURIComponent(selectedProjectId!)}/external-approvals/${approval.sequence}/evidence/manifest.json`} target="_blank" rel="noreferrer">Manifest</a>
          </div>)}
        </>) : productionEntries.length ? (
          productionEntries.map((entry) => {
          const passed = entry.bundle.platformEvidence.filter((platform) => platform.status === "PASSED").length;
          const valid = entry.invalidatedAt === null && entry.bundle.status === "PASSED";
          return (
            <div className="evidence-row" key={entry.evidenceBundleId}>
              <span title={entry.bundle.bundleDigest}><FileIcon /><b>{entry.evidenceBundleId}</b></span>
              <span>{entry.bundle.platformEvidence.map((platform) => `${platform.platform}:${platform.status}`).join(" / ")}</span>
              <span className="mono" title={entry.bundle.commitSha}>{entry.bundle.commitSha.slice(0, 12)}</span>
              <span>{passed} / {entry.bundle.platformEvidence.length}</span>
              <span className={valid ? "signed" : "invalid"}>{entry.invalidatedAt ? "已失效" : entry.bundle.status === "PASSED" ? "有效" : "失败"}</span>
              <span>{new Date(entry.bundle.createdAt).toLocaleString("zh-CN")}</span>
              <button disabled type="button">{currentEvidenceIds.has(entry.evidenceBundleId) ? "当前门禁" : "历史证据"}</button>
            </div>
          );
          })
        ) : <div className="evidence-empty"><FileIcon /><b>尚无真实证据</b><span>完成锁定目标矩阵后，权威投影会显示证据引用。</span></div>}
      </section>
      {evidence && selectedProjectId ? <div className="evidence-artifacts"><b>{evidence.buildArtifact ? "交付与原始证据" : "原始证据"}</b>{evidence.buildArtifact ? <a href={`/api/projects/${encodeURIComponent(selectedProjectId)}/local-validation/artifact/${evidence.buildArtifact.fileName}`}>下载 macOS 游戏 · {formatBytes(evidence.buildArtifact.sizeBytes)}</a> : null}<a href={`/api/projects/${encodeURIComponent(selectedProjectId)}/local-validation/evidence/manifest.json`} target="_blank" rel="noreferrer">manifest.json</a><a href={`/api/projects/${encodeURIComponent(selectedProjectId)}/local-validation/evidence/junit.xml`} target="_blank" rel="noreferrer">JUnit XML</a><a href={`/api/projects/${encodeURIComponent(selectedProjectId)}/local-validation/evidence/godot.log`} target="_blank" rel="noreferrer">Godot 日志</a><span>{evidence.godotVersion} · {evidence.releaseGate === "WAITING_EXPORT_TEMPLATES" ? "等待导出模板" : "ZIP 内导出应用已启动并正常退出"}</span></div> : null}
      {mainEvidence && selectedProjectId ? <div className="evidence-artifacts"><b>实际 main SHA 复验证据</b>{mainEvidence.valid && mainEvidence.buildArtifact ? <a href={`/api/projects/${encodeURIComponent(selectedProjectId)}/main-validation/artifact/${mainEvidence.buildArtifact.fileName}`}>下载 main 构建 · {formatBytes(mainEvidence.buildArtifact.sizeBytes)}</a> : null}<a href={`/api/projects/${encodeURIComponent(selectedProjectId)}/main-validation/evidence/manifest.json`} target="_blank" rel="noreferrer">manifest.json</a><a href={`/api/projects/${encodeURIComponent(selectedProjectId)}/main-validation/evidence/junit.xml`} target="_blank" rel="noreferrer">JUnit XML</a><a href={`/api/projects/${encodeURIComponent(selectedProjectId)}/main-validation/evidence/godot.log`} target="_blank" rel="noreferrer">Godot 日志</a><span>{mainEvidence.mainSha.slice(0, 12)} · {mainEvidence.releaseGate === "MAIN_VALIDATION_PASSED" ? "重导出应用已启动并正常退出" : "门禁未通过"}</span></div> : null}
      {steamEvidence && selectedProjectId ? <div className="evidence-artifacts"><b>本地私有 Beta 回装证据</b>{steamEvidence.valid && steamEvidence.betaArtifact ? <a href={`/api/projects/${encodeURIComponent(selectedProjectId)}/steam-reinstall/artifact/${steamEvidence.betaArtifact.fileName}`}>下载本地 Beta · {formatBytes(steamEvidence.betaArtifact.sizeBytes)}</a> : null}<a href={`/api/projects/${encodeURIComponent(selectedProjectId)}/steam-reinstall/evidence/manifest.json`} target="_blank" rel="noreferrer">manifest.json</a><a href={`/api/projects/${encodeURIComponent(selectedProjectId)}/steam-reinstall/evidence/reinstall.log`} target="_blank" rel="noreferrer">回装日志</a><span>{steamEvidence.buildId} · {steamEvidence.valid ? "独立目录回装与实际启动通过；未连接 Steam" : "证据已失效"}</span></div> : null}
      {approvalEvidence.length > 0 && selectedProjectId ? <div className="evidence-artifacts"><b>本地外部批准回执链</b>{approvalEvidence.map((approval) => <a key={approval.evidenceId} href={`/api/projects/${encodeURIComponent(selectedProjectId)}/external-approvals/${approval.sequence}/evidence/manifest.json`} target="_blank" rel="noreferrer">{approval.sequence}. {approval.gate}</a>)}<span>{approvalEvidence.filter((approval) => approval.valid).length} / 3 · 逐级绑定 main SHA、BuildID 与前序回执</span></div> : null}
      {!evidence && catalog ? <div className="evidence-artifacts"><b>权威目录</b><span>{catalog.entries.length} 个不可变 manifest</span><span>读取时间 {new Date(catalog.observedAt).toLocaleString("zh-CN")}</span><span>S3 对象键与下载授权保持隔离</span></div> : null}
      </>}
    </AppShell>
  );
}

function EmptyProjectResource({ loading, noun }: { loading: boolean; noun: string }) {
  return <section className="resource-empty-project"><FileIcon /><h2>{loading ? "正在同步项目目录" : `还没有可用于${noun}的项目`}</h2><p>此页面不会以固定演示项目替代当前租户的真实项目。</p>{!loading ? <Link className="button button-acid" href="/projects/new">创建第一个项目</Link> : null}</section>;
}

async function sha256(value: string | ArrayBuffer) {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function formatBytes(value: number) {
  if (value < 1024 * 1024) return `${Math.max(1, Math.round(value / 1024))} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}
